from __future__ import annotations

import argparse
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

from app.config import Settings
from app.embeddings.sentence_transformers import SentenceTransformerEmbeddingProvider
from app.embeddings.testing import TokenHashEmbeddingProvider
from app.evaluation.metrics import hit_rate_at_k, precision_at_k, recall_at_k, reciprocal_rank
from app.generation.base import (
    ProviderConfigurationError,
    ProviderRateLimitError,
    ProviderResponseError,
    ProviderTimeoutError,
)
from app.generation.extractive import ExtractiveAnswerGenerator
from app.generation.openai_compatible import OpenAICompatibleGenerator
from app.ingestion.processing import ChunkConfig
from app.models.schemas import DocumentInput, IngestRequest, RetrievedChunk
from app.retrieval.bm25 import BM25Retriever
from app.retrieval.evidence import assess_evidence
from app.retrieval.hybrid import reciprocal_rank_fusion
from app.retrieval.store import JsonVectorStore
from app.retrieval.vector import VectorRetriever


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE = PROJECT_ROOT / "ai-service" / "evaluation" / "fixtures.json"
DEFAULT_REPORT = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.2.2-report.json"
DEFAULT_BASELINE = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.2.1-report.json"
DEFAULT_TOP_K = 3


def load_fixture(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text("utf-8"))


def ordered_unique_document_ids(chunks: list[RetrievedChunk]) -> list[str]:
    seen = set()
    document_ids = []
    for chunk in chunks:
        if chunk.document_id in seen:
            continue
        seen.add(chunk.document_id)
        document_ids.append(chunk.document_id)
    return document_ids


def average(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def summarize_metrics(rows: list[dict[str, Any]], strategy: str, top_k: int) -> dict[str, float]:
    labelled = [row for row in rows if row["expected_documents"]]
    return {
        f"recall_at_{top_k}": round(
            average([recall_at_k(set(row["expected_documents"]), row[strategy], top_k) for row in labelled]),
            4,
        ),
        f"precision_at_{top_k}": round(
            average([precision_at_k(set(row["expected_documents"]), row[strategy], top_k) for row in labelled]),
            4,
        ),
        "mrr": round(
            average([reciprocal_rank(set(row["expected_documents"]), row[strategy]) for row in labelled]),
            4,
        ),
        f"hit_rate_at_{top_k}": round(
            average([hit_rate_at_k(set(row["expected_documents"]), row[strategy], top_k) for row in labelled]),
            4,
        ),
    }


def build_store(
    fixture: dict[str, Any],
    settings: Settings,
    *,
    embedding_provider: str,
) -> tuple[JsonVectorStore, Any, dict[str, Any]]:
    run_dir = PROJECT_ROOT / ".tmp-ai-eval" / uuid.uuid4().hex
    run_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    if embedding_provider == "real":
        embeddings = SentenceTransformerEmbeddingProvider(settings.embedding_model)
        provider_name = settings.embedding_model
    else:
        embeddings = TokenHashEmbeddingProvider()
        provider_name = "token-hash-test-provider"
    load_ms = (time.perf_counter() - started) * 1000

    store = JsonVectorStore(run_dir / "vectors.json", embeddings)
    documents = [
        DocumentInput(
            id=document["id"],
            title=document["title"],
            content=document["content"],
            source_type="synthetic-evaluation",
            metadata={"tags": document.get("tags", []), "customer_data": False},
        )
        for document in fixture["documents"]
    ]
    ingest_started = time.perf_counter()
    ingested_documents, indexed_chunks, duplicates, unchanged = store.ingest(
        IngestRequest(documents=documents),
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )
    ingest_ms = (time.perf_counter() - ingest_started) * 1000

    metadata = {
        "run_dir": str(run_dir),
        "provider": provider_name,
        "dimension": embeddings.dimension,
        "load_ms": round(load_ms, 2),
        "ingest_ms": round(ingest_ms, 2),
        "ingested_documents": ingested_documents,
        "indexed_chunks": indexed_chunks,
        "duplicates_skipped": duplicates,
        "unchanged_skipped": unchanged,
    }
    return store, embeddings, metadata


def evaluate_retrieval(
    fixture: dict[str, Any],
    store: JsonVectorStore,
    embeddings: Any,
    settings: Settings,
    *,
    top_k: int,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, list[RetrievedChunk]]]:
    bm25 = BM25Retriever()
    semantic = VectorRetriever(embeddings)
    rows = []
    hybrid_by_question = {}
    started = time.perf_counter()

    for question in fixture["questions"]:
        keyword_results = bm25.search(question["question"], store.chunks, top_k)
        semantic_results = semantic.search(question["question"], store.chunks, store.vectors, top_k)
        hybrid_results = reciprocal_rank_fusion(keyword_results, semantic_results, top_k)
        evidence = assess_evidence(
            question=question["question"],
            bm25=keyword_results,
            semantic=semantic_results,
            hybrid=hybrid_results,
            settings=settings,
        )
        hybrid_by_question[question["id"]] = hybrid_results
        rows.append(
            {
                "id": question["id"],
                "type": question["type"],
                "question": question["question"],
                "expected_documents": question.get("expected_relevant_documents", []),
                "bm25": ordered_unique_document_ids(keyword_results),
                "semantic": ordered_unique_document_ids(semantic_results),
                "hybrid": ordered_unique_document_ids(hybrid_results),
                "evidence_sufficient": evidence.sufficient,
                "evidence_scores": {
                    "best_bm25": round(evidence.best_bm25, 6),
                    "best_semantic": round(evidence.best_semantic, 6),
                    "best_hybrid": round(evidence.best_hybrid, 6),
                    "semantic_margin": round(evidence.semantic_margin, 6),
                    "query_coverage": round(evidence.query_coverage, 6),
                    "evidence_chunks": evidence.evidence_chunks,
                    "retrieval_agreement": evidence.retrieval_agreement,
                },
                "evidence_signals": evidence.signals,
            },
        )

    elapsed_ms = (time.perf_counter() - started) * 1000
    unanswerable = [row for row in rows if not row["expected_documents"]]
    metrics = {
        "top_k": top_k,
        "latency_ms_total": round(elapsed_ms, 2),
        "bm25": summarize_metrics(rows, "bm25", top_k),
        "semantic": summarize_metrics(rows, "semantic", top_k),
        "hybrid": summarize_metrics(rows, "hybrid", top_k),
        "unanswerable_abstention_rate": round(
            average([0.0 if row["evidence_sufficient"] else 1.0 for row in unanswerable]),
            4,
        ),
        "unanswerable_false_positive_rate": round(
            average([1.0 if row["evidence_sufficient"] else 0.0 for row in unanswerable]),
            4,
        ),
    }
    return metrics, rows, hybrid_by_question


def evaluate_extractive_generation(
    fixture: dict[str, Any],
    hybrid_by_question: dict[str, list[RetrievedChunk]],
    retrieval_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    generator = ExtractiveAnswerGenerator()
    retrieval_by_id = {row["id"]: row for row in retrieval_rows}
    rows = []
    for question in fixture["questions"]:
        retrieved = hybrid_by_question[question["id"]]
        retrieval_row = retrieval_by_id[question["id"]]
        expected_documents = set(question.get("expected_relevant_documents", []))
        expected_citations = set(question.get("expected_citations", []))
        retrieved_documents = {chunk.document_id for chunk in retrieved}
        if not retrieved or not retrieval_row["evidence_sufficient"]:
            citations = []
            answer = "I do not have enough indexed context to answer that yet."
            abstained = True
            latency_ms = 0.0
        else:
            started = time.perf_counter()
            generated = generator.generate(question["question"], retrieved)
            latency_ms = (time.perf_counter() - started) * 1000
            citations = [citation.document_id for citation in generated.citations]
            answer = generated.answer
            abstained = False

        expected_phrases = [phrase.lower() for phrase in question.get("expected_answer_contains", [])]
        lowered_answer = answer.lower()
        rows.append(
            {
                "id": question["id"],
                "expected_abstain": bool(question.get("expected_abstain")),
                "abstained": abstained,
                "answer_relevance_pass": (
                    bool(question.get("expected_abstain"))
                    if abstained
                    else any(phrase in lowered_answer for phrase in expected_phrases)
                ),
                "citation_validity_pass": set(citations).issubset(retrieved_documents),
                "expected_citation_precision": (
                    len(expected_citations.intersection(citations)) / len(citations)
                    if citations
                    else (1.0 if not expected_citations else 0.0)
                ),
                "expected_citation_coverage": (
                    len(expected_citations.intersection(citations)) / len(expected_citations)
                    if expected_citations
                    else (1.0 if not citations else 0.0)
                ),
                "appropriate_abstention_pass": abstained == bool(question.get("expected_abstain")),
                "latency_ms": round(latency_ms, 2),
                "citations": citations,
            },
        )

    return {
        "mode": "extractive_deterministic",
        "answer_relevance_pass_rate": round(average([1.0 if row["answer_relevance_pass"] else 0.0 for row in rows]), 4),
        "citation_validity_rate": round(average([1.0 if row["citation_validity_pass"] else 0.0 for row in rows]), 4),
        "expected_citation_precision": round(average([row["expected_citation_precision"] for row in rows]), 4),
        "expected_citation_coverage": round(average([row["expected_citation_coverage"] for row in rows]), 4),
        "appropriate_abstention_rate": round(average([1.0 if row["appropriate_abstention_pass"] else 0.0 for row in rows]), 4),
        "latency_ms_average": round(average([row["latency_ms"] for row in rows]), 2),
        "rows": rows,
        "human_reviewed_examples": {
            "status": "not_performed",
            "reason": "No human reviewer labels were collected during this automated run.",
        },
        "automated_model_judge": {
            "status": "not_configured",
            "reason": "No separate judge model was configured; metrics are deterministic string/citation checks only.",
        },
    }


def answer_rate(rows: list[dict[str, Any]], retrieval_rows: list[dict[str, Any]]) -> float:
    answerable = {
        row["id"]
        for row in retrieval_rows
        if row["expected_documents"]
    }
    if not answerable:
        return 0.0
    answered = [
        row
        for row in rows
        if row["id"] in answerable and not row["abstained"]
    ]
    return round(len(answered) / len(answerable), 4)


def abstention_rate_for_types(rows: list[dict[str, Any]], fixture: dict[str, Any], types: set[str]) -> float:
    by_id = {row["id"]: row for row in rows}
    selected = [
        by_id[question["id"]]
        for question in fixture["questions"]
        if question["type"] in types
    ]
    return round(average([1.0 if row["abstained"] else 0.0 for row in selected]), 4)


def compare_with_baseline(
    baseline_path: Path,
    retrieval_metrics: dict[str, Any],
    generation_metrics: dict[str, Any],
    retrieval_rows: list[dict[str, Any]],
    fixture: dict[str, Any],
) -> dict[str, Any]:
    if not baseline_path.exists():
        return {"status": "not_available", "path": str(baseline_path)}

    baseline = json.loads(baseline_path.read_text("utf-8"))
    baseline_generation = baseline.get("generation", {}).get("deterministic_checks", {})
    baseline_retrieval = baseline.get("retrieval", {}).get("metrics", {})
    current_rows = generation_metrics["rows"]
    baseline_rows = baseline_generation.get("rows", [])

    return {
        "status": "available",
        "path": str(baseline_path),
        "baseline": {
            "answerable_answer_rate": answer_rate(baseline_rows, baseline.get("retrieval", {}).get("rows", [])),
            "unanswerable_abstention_rate": baseline_retrieval.get("unanswerable_abstention_rate"),
            "ambiguous_abstention_rate": abstention_rate_for_types(baseline_rows, fixture, {"ambiguous"}),
            "answer_relevance": baseline_generation.get("answer_relevance_pass_rate"),
            "citation_validity": baseline_generation.get("citation_validity_rate"),
            "citation_precision": baseline_generation.get("expected_citation_precision"),
            "citation_coverage": baseline_generation.get("expected_citation_coverage"),
            "hybrid_recall_at_3": baseline_retrieval.get("hybrid", {}).get("recall_at_3"),
            "hybrid_precision_at_3": baseline_retrieval.get("hybrid", {}).get("precision_at_3"),
        },
        "current": {
            "answerable_answer_rate": answer_rate(current_rows, retrieval_rows),
            "unanswerable_abstention_rate": retrieval_metrics.get("unanswerable_abstention_rate"),
            "ambiguous_abstention_rate": abstention_rate_for_types(current_rows, fixture, {"ambiguous"}),
            "answer_relevance": generation_metrics.get("answer_relevance_pass_rate"),
            "citation_validity": generation_metrics.get("citation_validity_rate"),
            "citation_precision": generation_metrics.get("expected_citation_precision"),
            "citation_coverage": generation_metrics.get("expected_citation_coverage"),
            "hybrid_recall_at_3": retrieval_metrics.get("hybrid", {}).get("recall_at_3"),
            "hybrid_precision_at_3": retrieval_metrics.get("hybrid", {}).get("precision_at_3"),
        },
    }


def run_mocked_failure_checks() -> dict[str, str]:
    def build(post):
        return OpenAICompatibleGenerator(
            api_key="test-key",
            model="test-model",
            base_url="https://provider.example/v1",
            timeout_seconds=0.01,
            retries=1,
            max_output_tokens=64,
            http_post=post,
        )

    checks: dict[str, str] = {}
    try:
        build(lambda _url, _payload, _headers, _timeout: (401, {"error": "bad key"})).generate("Q", [])
    except ProviderConfigurationError:
        checks["invalid_api_key"] = "pass"

    try:
        build(lambda _url, _payload, _headers, _timeout: (_ for _ in ()).throw(TimeoutError())).generate("Q", [])
    except ProviderTimeoutError:
        checks["provider_timeout"] = "pass"

    try:
        build(lambda _url, _payload, _headers, _timeout: (429, {"error": "rate limit"})).generate("Q", [])
    except ProviderRateLimitError:
        checks["rate_limit"] = "pass"

    chunk = RetrievedChunk(
        chunk_id="doc:chunk-0",
        document_id="doc",
        document_title="Doc",
        text="Known answer.",
        score=1.0,
        strategy="hybrid",
    )
    try:
        build(
            lambda _url, _payload, _headers, _timeout: (
                200,
                {
                    "choices": [
                        {
                            "message": {
                                "content": json.dumps(
                                    {
                                        "answer": "Known answer.",
                                        "citations": ["fabricated:chunk-9"],
                                        "insufficient_context": False,
                                    },
                                ),
                            },
                        },
                    ],
                },
            ),
        ).generate("Q", [chunk])
    except ProviderResponseError:
        checks["invalid_citations"] = "pass"

    checks["method"] = "mocked_openai_compatible_provider_contract"
    checks.setdefault("invalid_api_key", "fail")
    checks.setdefault("provider_timeout", "fail")
    checks.setdefault("rate_limit", "fail")
    checks.setdefault("invalid_citations", "fail")
    checks["ai_service_unavailable"] = "covered_by_node_smoke_test"
    checks["unanswerable_questions"] = "covered_by_retrieval_and_generation_metrics"
    checks["insufficient_retrieved_context"] = "covered_by_retrieval_and_generation_metrics"
    return checks


def validate_live_provider(
    fixture: dict[str, Any],
    hybrid_by_question: dict[str, list[RetrievedChunk]],
    *,
    limit: int,
) -> dict[str, Any]:
    provider = os.getenv("ASKWELL_LLM_PROVIDER", "extractive")
    api_key = os.getenv("ASKWELL_LLM_API_KEY", "")
    model = os.getenv("ASKWELL_LLM_MODEL", "gpt-4o-mini")
    base_url = os.getenv("ASKWELL_LLM_BASE_URL", "https://api.openai.com/v1")
    if provider not in {"openai", "openai-compatible"} or not api_key:
        return {
            "status": "not_run",
            "reason": "OpenAI-compatible provider credentials are not configured in the environment.",
            "provider": provider,
            "model": model,
            "credentials_present": bool(api_key),
        }

    generator = OpenAICompatibleGenerator(
        api_key=api_key,
        model=model,
        base_url=base_url,
        timeout_seconds=float(os.getenv("ASKWELL_LLM_TIMEOUT_SECONDS", "20")),
        retries=int(os.getenv("ASKWELL_LLM_RETRIES", "2")),
        max_output_tokens=int(os.getenv("ASKWELL_LLM_MAX_OUTPUT_TOKENS", "350")),
    )
    requests = []
    token_totals = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    questions = [
        question
        for question in fixture["questions"]
        if question.get("expected_relevant_documents") and hybrid_by_question.get(question["id"])
    ][:limit]
    for question in questions:
        started = time.perf_counter()
        try:
            generated = generator.generate(question["question"], hybrid_by_question[question["id"]])
            usage = generated.token_usage.model_dump() if generated.token_usage else None
            if usage:
                for key in token_totals:
                    token_totals[key] += usage.get(key) or 0
            requests.append(
                {
                    "id": question["id"],
                    "status": "ok",
                    "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                    "citations": [citation.chunk_id for citation in generated.citations],
                    "token_usage": usage,
                },
            )
        except Exception as error:
            requests.append(
                {
                    "id": question["id"],
                    "status": "error",
                    "error_type": type(error).__name__,
                    "latency_ms": round((time.perf_counter() - started) * 1000, 2),
                },
            )

    return {
        "status": "completed",
        "provider": generator.provider,
        "model": model,
        "request_count": len(requests),
        "latency_ms_average": round(average([request["latency_ms"] for request in requests]), 2),
        "token_usage_total": token_totals,
        "requests": requests,
        "credentials_present": True,
    }


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    fixture = load_fixture(args.fixture)
    settings = Settings(
        data_dir=PROJECT_ROOT / ".tmp-ai-eval",
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
        bm25_score_threshold=args.bm25_threshold,
        semantic_score_threshold=args.semantic_threshold,
        hybrid_score_threshold=args.hybrid_threshold,
        semantic_margin_threshold=args.semantic_margin_threshold,
        query_coverage_threshold=args.query_coverage_threshold,
        min_evidence_chunks=args.min_evidence_chunks,
        min_retrieval_agreement=args.min_retrieval_agreement,
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
        generation_metrics = evaluate_extractive_generation(fixture, hybrid_by_question, retrieval_rows)
        live_provider = validate_live_provider(fixture, hybrid_by_question, limit=args.live_llm_limit)
        return {
            "name": "AskWell Phase 3.2.2 Evidence Sufficiency and Abstention Calibration",
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "dataset": {
                "name": fixture["name"],
                "customer_data": fixture.get("customer_data", False),
                "documents": len(fixture["documents"]),
                "questions": len(fixture["questions"]),
                "question_types": sorted({question["type"] for question in fixture["questions"]}),
            },
            "model_configuration": {
                "embedding_provider": embedding_metadata["provider"],
                "embedding_dimensions": embedding_metadata["dimension"],
                "llm_provider_env": os.getenv("ASKWELL_LLM_PROVIDER", "extractive"),
                "llm_model": os.getenv("ASKWELL_LLM_MODEL", "gpt-4o-mini"),
                "llm_base_url_configured": bool(os.getenv("ASKWELL_LLM_BASE_URL")),
                "llm_credentials_present": bool(os.getenv("ASKWELL_LLM_API_KEY")),
                "top_k": args.top_k,
                "chunk_size": args.chunk_size,
                "chunk_overlap": args.chunk_overlap,
                "thresholds": {
                    "bm25": args.bm25_threshold,
                    "semantic": args.semantic_threshold,
                    "hybrid": args.hybrid_threshold,
                    "semantic_margin": args.semantic_margin_threshold,
                    "query_coverage": args.query_coverage_threshold,
                    "min_evidence_chunks": args.min_evidence_chunks,
                    "min_retrieval_agreement": args.min_retrieval_agreement,
                },
            },
            "indexing": {
                key: value
                for key, value in embedding_metadata.items()
                if key != "run_dir"
            },
            "retrieval": {
                "metrics": retrieval_metrics,
                "rows": retrieval_rows,
            },
            "generation": {
                "deterministic_checks": generation_metrics,
                "live_provider_validation": live_provider,
            },
            "baseline_comparison": compare_with_baseline(
                args.baseline,
                retrieval_metrics,
                generation_metrics,
                retrieval_rows,
                fixture,
            ),
            "failure_testing": run_mocked_failure_checks(),
            "known_weaknesses": [
                "Synthetic data is useful for regression checks but does not replace production traffic evaluation.",
                "Automated string checks do not prove LLM faithfulness.",
                "No human-reviewed labels were collected in this run.",
                "No model-judge assessment was run unless a separate evaluator is configured later.",
                "Evidence thresholds are calibrated on a small synthetic corpus; treat them as defaults, not proof of production quality.",
                "JSON vector storage remains an MVP persistence layer.",
            ],
        }
    finally:
        shutil.rmtree(Path(embedding_metadata["run_dir"]).parent, ignore_errors=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run AskWell synthetic RAG and LLM validation.")
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--output", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--embedding-provider", choices=["real", "test"], default="real")
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K)
    parser.add_argument("--chunk-size", type=int, default=420)
    parser.add_argument("--chunk-overlap", type=int, default=80)
    parser.add_argument("--bm25-threshold", type=float, default=3.0)
    parser.add_argument("--semantic-threshold", type=float, default=0.38)
    parser.add_argument("--hybrid-threshold", type=float, default=0.02)
    parser.add_argument("--semantic-margin-threshold", type=float, default=0.08)
    parser.add_argument("--query-coverage-threshold", type=float, default=0.45)
    parser.add_argument("--min-evidence-chunks", type=int, default=1)
    parser.add_argument("--min-retrieval-agreement", type=int, default=1)
    parser.add_argument("--live-llm-limit", type=int, default=3)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = build_report(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2), "utf-8")
    print(json.dumps({
        "output": str(args.output),
        "documents": report["dataset"]["documents"],
        "questions": report["dataset"]["questions"],
        "live_provider_status": report["generation"]["live_provider_validation"]["status"],
    }))


if __name__ == "__main__":
    main()
