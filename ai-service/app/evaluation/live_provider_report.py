from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

from app.config import Settings
from app.evaluation.report import (
    DEFAULT_FIXTURE,
    PROJECT_ROOT,
    build_store,
    evaluate_extractive_generation,
    evaluate_retrieval,
    load_fixture,
    run_mocked_failure_checks,
)
from app.generation.base import GenerationError
from app.generation.openai_compatible import OpenAICompatibleGenerator


DEFAULT_OUTPUT = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.2.3-live-llm-report.json"
DEFAULT_BEFORE_REPORT = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.2.3-live-llm-report-before-quality-fix.json"
LIVE_SCENARIO_IDS = [
    "trial-length",
    "trial-card-paraphrase",
    "export-and-cancel",
    "ambiguous-account",
    "unanswerable-sso",
]


def env_status() -> dict[str, bool]:
    return {
        "ASKWELL_LLM_PROVIDER": bool(os.getenv("ASKWELL_LLM_PROVIDER")),
        "ASKWELL_LLM_MODEL": bool(os.getenv("ASKWELL_LLM_MODEL")),
        "ASKWELL_LLM_BASE_URL": bool(os.getenv("ASKWELL_LLM_BASE_URL")),
        "ASKWELL_LLM_API_KEY": bool(os.getenv("ASKWELL_LLM_API_KEY")),
    }


def live_provider_configured() -> bool:
    provider = os.getenv("ASKWELL_LLM_PROVIDER", "")
    return (
        provider in {"openai", "openai-compatible"}
        and bool(os.getenv("ASKWELL_LLM_MODEL"))
        and bool(os.getenv("ASKWELL_LLM_BASE_URL"))
        and bool(os.getenv("ASKWELL_LLM_API_KEY"))
    )


def token_totals(results: list[dict[str, Any]]) -> dict[str, int]:
    totals = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    for result in results:
        usage = result.get("token_usage") or {}
        for key in totals:
            totals[key] += usage.get(key) or 0
    return totals


def average(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def normalize_text(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", " ", value.lower())
    return re.sub(r"\s+", " ", normalized).strip()


NEGATION_TOKENS = {"no", "not", "never", "without"}
REQUIREMENT_TOKENS = {"require", "required", "requires", "need", "needed", "needs"}


def phrase_tokens(value: str) -> set[str]:
    return set(normalize_text(value).split())


def negated_requirement_matches(answer: str, expected_phrase: str) -> bool:
    expected_tokens = phrase_tokens(expected_phrase)
    answer_tokens = phrase_tokens(answer)
    expects_negated_requirement = bool(expected_tokens & NEGATION_TOKENS) and bool(expected_tokens & REQUIREMENT_TOKENS)
    answers_negated_requirement = bool(answer_tokens & NEGATION_TOKENS) and bool(answer_tokens & REQUIREMENT_TOKENS)
    if not expects_negated_requirement or not answers_negated_requirement:
        return False

    expected_subject_tokens = expected_tokens - NEGATION_TOKENS - REQUIREMENT_TOKENS - {"is", "are", "a", "an", "the"}
    if not expected_subject_tokens:
        return False
    return expected_subject_tokens.issubset(answer_tokens)


def phrase_matches(answer: str, expected_phrases: list[str]) -> bool:
    normalized_answer = normalize_text(answer)
    return any(
        normalize_text(phrase) in normalized_answer
        or negated_requirement_matches(answer, phrase)
        for phrase in expected_phrases
    )


def evidence_snapshot(chunks: list[Any]) -> list[dict[str, Any]]:
    return [
        {
            "chunk_id": chunk.chunk_id,
            "document_id": chunk.document_id,
            "title": chunk.document_title,
            "score": round(chunk.score, 6),
            "strategy": chunk.strategy,
            "text": chunk.text,
        }
        for chunk in chunks
    ]


def summarize_live_report(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"status": "not_available", "path": str(path)}
    payload = json.loads(path.read_text("utf-8"))
    observations = payload.get("actual_provider_observations", {})
    return {
        "status": "available",
        "path": str(path),
        "provider_status": observations.get("status"),
        "successful_generation_count": observations.get("successful_generation_count"),
        "abstained_before_provider_call": observations.get("abstained_before_provider_call"),
        "answer_relevance": observations.get("answer_relevance"),
        "citation_validity": observations.get("citation_validity"),
        "citation_coverage": observations.get("citation_coverage"),
        "failed_relevance_ids": [
            result.get("id")
            for result in observations.get("results", [])
            if result.get("status") == "ok" and not result.get("answer_relevance_pass")
        ],
    }


def run_live_scenarios(
    fixture: dict[str, Any],
    retrieval_rows: list[dict[str, Any]],
    hybrid_by_question: dict[str, Any],
    *,
    limit: int,
) -> dict[str, Any]:
    if not live_provider_configured():
        return {
            "status": "not_run",
            "reason": "OpenAI-compatible provider environment variables are not fully configured.",
            "environment_present": env_status(),
            "provider": os.getenv("ASKWELL_LLM_PROVIDER", "missing"),
            "model": os.getenv("ASKWELL_LLM_MODEL", "missing"),
            "credentials_present": bool(os.getenv("ASKWELL_LLM_API_KEY")),
            "results": [],
        }

    generator = OpenAICompatibleGenerator(
        api_key=os.getenv("ASKWELL_LLM_API_KEY", ""),
        model=os.getenv("ASKWELL_LLM_MODEL", ""),
        base_url=os.getenv("ASKWELL_LLM_BASE_URL", ""),
        timeout_seconds=float(os.getenv("ASKWELL_LLM_TIMEOUT_SECONDS", "20")),
        retries=int(os.getenv("ASKWELL_LLM_RETRIES", "1")),
        max_output_tokens=int(os.getenv("ASKWELL_LLM_MAX_OUTPUT_TOKENS", "160")),
    )
    questions_by_id = {question["id"]: question for question in fixture["questions"]}
    retrieval_by_id = {row["id"]: row for row in retrieval_rows}
    selected_ids = LIVE_SCENARIO_IDS[:limit]
    results = []

    for scenario_id in selected_ids:
        question = questions_by_id[scenario_id]
        retrieval = retrieval_by_id[scenario_id]
        if not retrieval["evidence_sufficient"]:
            results.append(
                {
                    "id": scenario_id,
                    "type": question["type"],
                    "question": question["question"],
                    "expected_answer_contains": question.get("expected_answer_contains", []),
                    "retrieved_evidence": evidence_snapshot(hybrid_by_question[scenario_id]),
                    "status": "abstained_before_provider_call",
                    "latency_ms": 0.0,
                    "token_usage": None,
                    "citations": [],
                },
            )
            continue

        started = time.perf_counter()
        try:
            generated = generator.generate(question["question"], hybrid_by_question[scenario_id])
            citation_documents = [citation.document_id for citation in generated.citations]
            expected_citations = set(question.get("expected_citations", []))
            expected_answer_contains = question.get("expected_answer_contains", [])
            results.append(
                {
                    "id": scenario_id,
                    "type": question["type"],
                    "question": question["question"],
                    "expected_answer_contains": expected_answer_contains,
                    "retrieved_evidence": evidence_snapshot(hybrid_by_question[scenario_id]),
                    "status": "ok",
                    "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                    "token_usage": generated.token_usage.model_dump() if generated.token_usage else None,
                    "citations": [citation.chunk_id for citation in generated.citations],
                    "answer": generated.answer,
                    "answer_relevance_pass": phrase_matches(generated.answer, expected_answer_contains),
                    "citation_validity_pass": True,
                    "citation_coverage": (
                        len(expected_citations.intersection(citation_documents)) / len(expected_citations)
                        if expected_citations
                        else 1.0
                    ),
                },
            )
        except GenerationError as error:
            results.append(
                {
                    "id": scenario_id,
                    "type": question["type"],
                    "question": question["question"],
                    "expected_answer_contains": question.get("expected_answer_contains", []),
                    "retrieved_evidence": evidence_snapshot(hybrid_by_question[scenario_id]),
                    "status": "provider_error",
                    "error_type": type(error).__name__,
                    "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                    "token_usage": None,
                    "citations": [],
                },
            )

    successful = [result for result in results if result["status"] == "ok"]
    abstained = [result for result in results if result["status"] == "abstained_before_provider_call"]
    return {
        "status": "completed",
        "provider": generator.provider,
        "model": generator.model,
        "request_count": len(successful),
        "abstained_before_provider_call": len(abstained),
        "successful_generation_count": len(successful),
        "latency_ms_average": round(average([result["latency_ms"] for result in successful]), 2),
        "token_usage_total": token_totals(successful),
        "answer_relevance": round(average([1.0 if result.get("answer_relevance_pass") else 0.0 for result in successful]), 4),
        "citation_validity": round(average([1.0 if result.get("citation_validity_pass") else 0.0 for result in successful]), 4),
        "citation_coverage": round(average([result.get("citation_coverage", 0.0) for result in successful]), 4),
        "results": results,
    }


def build_live_report(args: argparse.Namespace) -> dict[str, Any]:
    fixture = load_fixture(args.fixture)
    settings = Settings(
        data_dir=PROJECT_ROOT / ".tmp-ai-eval",
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
    )
    store, embeddings, embedding_metadata = build_store(fixture, settings, embedding_provider=args.embedding_provider)
    try:
        retrieval_metrics, retrieval_rows, hybrid_by_question = evaluate_retrieval(
            fixture,
            store,
            embeddings,
            settings,
            top_k=args.top_k,
        )
        deterministic_generation = evaluate_extractive_generation(fixture, hybrid_by_question, retrieval_rows)
        live_results = run_live_scenarios(
            fixture,
            retrieval_rows,
            hybrid_by_question,
            limit=args.live_scenario_limit,
        )
        return {
            "name": "AskWell Phase 3.2.3 Live LLM Provider Validation",
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "commands": {
                "report": "python -m app.evaluation.live_provider_report",
                "node_check": "npm run check",
                "node_tests": "npm test",
                "python_tests": "pytest ai-service/tests -q -rs",
                "real_provider_test": "ASKWELL_RUN_REAL_LLM_TESTS=1 pytest ai-service/tests/test_real_llm_provider.py -q -rs",
            },
            "environment": {
                "configured": env_status(),
                "credentials_exposed": False,
            },
            "dataset": {
                "documents": len(fixture["documents"]),
                "questions": len(fixture["questions"]),
                "scenario_ids": LIVE_SCENARIO_IDS[: args.live_scenario_limit],
                "customer_data": fixture.get("customer_data", False),
            },
            "model_configuration": {
                "embedding_provider": embedding_metadata["provider"],
                "embedding_dimensions": embedding_metadata["dimension"],
                "llm_provider": os.getenv("ASKWELL_LLM_PROVIDER", "missing"),
                "llm_model": os.getenv("ASKWELL_LLM_MODEL", "missing"),
                "llm_base_url_configured": bool(os.getenv("ASKWELL_LLM_BASE_URL")),
                "llm_credentials_present": bool(os.getenv("ASKWELL_LLM_API_KEY")),
            },
            "retrieval": {
                "metrics": retrieval_metrics,
                "evidence_gate_rows": [
                    {
                        "id": row["id"],
                        "type": row["type"],
                        "evidence_sufficient": row["evidence_sufficient"],
                        "evidence_scores": row["evidence_scores"],
                        "evidence_signals": row["evidence_signals"],
                    }
                    for row in retrieval_rows
                    if row["id"] in LIVE_SCENARIO_IDS[: args.live_scenario_limit]
                ],
            },
            "actual_provider_observations": live_results,
            "before_after_quality_comparison": {
                "before": summarize_live_report(args.before_report),
                "after": {
                    "provider_status": live_results.get("status"),
                    "successful_generation_count": live_results.get("successful_generation_count"),
                    "abstained_before_provider_call": live_results.get("abstained_before_provider_call"),
                    "answer_relevance": live_results.get("answer_relevance"),
                    "citation_validity": live_results.get("citation_validity"),
                    "citation_coverage": live_results.get("citation_coverage"),
                    "failed_relevance_ids": [
                        result.get("id")
                        for result in live_results.get("results", [])
                        if result.get("status") == "ok" and not result.get("answer_relevance_pass")
                    ],
                },
            },
            "mocked_contract_tests": {
                "status": "covered_by_deterministic_tests",
                "checks": run_mocked_failure_checks(),
                "distinction": "These are mocked OpenAI-compatible provider contract checks, not live provider observations.",
            },
            "deterministic_generation_baseline": {
                "answer_relevance": deterministic_generation["answer_relevance_pass_rate"],
                "citation_validity": deterministic_generation["citation_validity_rate"],
                "citation_precision": deterministic_generation["expected_citation_precision"],
                "citation_coverage": deterministic_generation["expected_citation_coverage"],
                "appropriate_abstention": deterministic_generation["appropriate_abstention_rate"],
            },
            "limitations": [
                "Live provider validation is skipped unless all required provider environment variables are configured.",
                "Successful integration tests do not prove production readiness or answer faithfulness.",
                "The synthetic corpus is small and separate from the user's actual workspace data.",
                "Timeout and rate-limit behavior are covered with mocks because intentionally triggering live provider failures can be noisy or costly.",
            ],
        }
    finally:
        shutil.rmtree(Path(embedding_metadata["run_dir"]).parent, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run AskWell Phase 3.2.3 live LLM provider validation.")
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--before-report", type=Path, default=DEFAULT_BEFORE_REPORT)
    parser.add_argument("--top-k", type=int, default=3)
    parser.add_argument("--embedding-provider", choices=["real", "test"], default="real")
    parser.add_argument("--chunk-size", type=int, default=420)
    parser.add_argument("--chunk-overlap", type=int, default=80)
    parser.add_argument("--live-scenario-limit", type=int, default=len(LIVE_SCENARIO_IDS))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = build_live_report(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), "utf-8")
    print(json.dumps({
        "output": str(args.output),
        "actual_provider_status": report["actual_provider_observations"]["status"],
        "credentials_present": report["model_configuration"]["llm_credentials_present"],
    }))


if __name__ == "__main__":
    main()
