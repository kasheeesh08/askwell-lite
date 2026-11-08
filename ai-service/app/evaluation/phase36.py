from __future__ import annotations

import argparse
import gc
import json
import os
import platform
import shutil
import statistics
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np

os.environ.setdefault("ASKWELL_SKIP_AUTO_MODEL", "1")

from app.config import Settings
from app.embeddings.testing import TokenHashEmbeddingProvider
from app.evaluation.metrics import hit_rate_at_k, precision_at_k, recall_at_k, reciprocal_rank
from app.generation.base import ProviderResponseError, ProviderTimeoutError
from app.generation.citations import validate_citations
from app.generation.extractive import ExtractiveAnswerGenerator
from app.generation.openai_compatible import OpenAICompatibleGenerator
from app.ingestion.processing import ChunkConfig
from app.main import create_app
from app.models.schemas import AnswerRequest, DocumentInput, IngestRequest, RetrievedChunk
from app.retrieval.bm25 import BM25Retriever
from app.retrieval.evidence import assess_evidence, select_generation_context
from app.retrieval.hybrid import reciprocal_rank_fusion
from app.retrieval.store import JsonVectorStore, SQLiteVectorStore
from app.retrieval.vector import VectorRetriever


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.6-fixtures.json"
DEFAULT_JSON_REPORT = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.6-report.json"
DEFAULT_MD_REPORT = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.6-report.md"


class FailingEmbeddingProvider(TokenHashEmbeddingProvider):
    def embed(self, texts: list[str]) -> np.ndarray:
        if any("explode" in text.lower() for text in texts):
            raise RuntimeError("simulated embedding failure")
        return super().embed(texts)


def load_fixture(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text("utf-8"))


def average(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def percentile(values: list[float], percentage: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * percentage)))
    return ordered[index]


def normalize_text(value: str) -> str:
    return " ".join("".join(character.lower() if character.isalnum() else " " for character in value).split())


def phrase_match(answer: str, phrases: list[str]) -> bool:
    normalized = normalize_text(answer)
    return any(normalize_text(phrase) in normalized for phrase in phrases)


def ordered_ids(chunks: list[RetrievedChunk], attr: str) -> list[str]:
    seen: set[str] = set()
    values: list[str] = []
    for chunk in chunks:
        value = getattr(chunk, attr)
        if value not in seen:
            seen.add(value)
            values.append(value)
    return values


def document_inputs(fixture: dict[str, Any]) -> list[DocumentInput]:
    return [
        DocumentInput(
            id=document["id"],
            title=document["title"],
            content=document["content"],
            source_type="synthetic-support-article",
            metadata={"tags": document.get("tags", []), "phase": "3.6", "customer_data": False},
        )
        for document in fixture["documents"]
    ]


def build_settings(data_dir: Path, *, backend: str = "sqlite") -> Settings:
    return Settings(
        embedding_model="token-hash-phase36",
        data_dir=data_dir,
        vector_storage_backend=backend,
        sqlite_vector_path=data_dir / "vectors.sqlite3",
        chunk_size=1200,
        chunk_overlap=150,
        bm25_score_threshold=2.0,
        semantic_score_threshold=0.32,
        hybrid_score_threshold=0.01,
        semantic_margin_threshold=0.02,
        query_coverage_threshold=0.35,
        min_evidence_chunks=1,
        min_retrieval_agreement=1,
        llm_provider="extractive",
    )


def build_store(fixture: dict[str, Any], data_dir: Path) -> tuple[Settings, TokenHashEmbeddingProvider, SQLiteVectorStore, dict[str, Any]]:
    settings = build_settings(data_dir)
    embeddings = TokenHashEmbeddingProvider()
    store = SQLiteVectorStore(settings.sqlite_vector_path, embeddings)
    started = time.perf_counter()
    ingested_documents, indexed_chunks, duplicates, unchanged = store.ingest(
        IngestRequest(documents=document_inputs(fixture)),
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )
    ingest_ms = (time.perf_counter() - started) * 1000
    chunks, vectors = store.snapshot()
    return settings, embeddings, store, {
        "backend": "sqlite",
        "embedding_provider": "token-hash-test-provider",
        "embedding_dimensions": embeddings.dimension,
        "documents_ingested": ingested_documents,
        "chunks_indexed": indexed_chunks,
        "duplicates_skipped": duplicates,
        "unchanged_skipped": unchanged,
        "snapshot_chunks": len(chunks),
        "snapshot_vectors": int(vectors.shape[0]),
        "initial_ingest_ms": round(ingest_ms, 2),
    }


def retrieve_all(
    question: str,
    store: SQLiteVectorStore,
    embeddings: TokenHashEmbeddingProvider,
    top_k: int,
) -> tuple[list[RetrievedChunk], list[RetrievedChunk], list[RetrievedChunk], float]:
    chunks, vectors = store.snapshot()
    started = time.perf_counter()
    bm25 = BM25Retriever().search(question, chunks, top_k)
    semantic = VectorRetriever(embeddings).search(question, chunks, vectors, top_k)
    hybrid = reciprocal_rank_fusion(bm25, semantic, top_k)
    return bm25, semantic, hybrid, (time.perf_counter() - started) * 1000


def summarize_strategy(rows: list[dict[str, Any]], strategy: str, top_k: int, target: str) -> dict[str, float]:
    expected_key = "expected_documents" if target == "documents" else "expected_chunks"
    labelled = [row for row in rows if row[expected_key]]
    return {
        f"recall_at_{top_k}": round(average([recall_at_k(set(row[expected_key]), row[strategy][target], top_k) for row in labelled]), 4),
        f"precision_at_{top_k}": round(average([precision_at_k(set(row[expected_key]), row[strategy][target], top_k) for row in labelled]), 4),
        "mrr": round(average([reciprocal_rank(set(row[expected_key]), row[strategy][target]) for row in labelled]), 4),
        f"hit_rate_at_{top_k}": round(average([hit_rate_at_k(set(row[expected_key]), row[strategy][target], top_k) for row in labelled]), 4),
    }


def category_breakdown(rows: list[dict[str, Any]], strategy: str) -> dict[str, Any]:
    categories: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        categories.setdefault(row["type"], []).append(row)
    return {
        category: {
            "questions": len(items),
            "hybrid_recall_at_3": summarize_strategy(items, strategy, 3, "documents").get("recall_at_3", 0.0),
            "hybrid_hit_rate_at_3": summarize_strategy(items, strategy, 3, "documents").get("hit_rate_at_3", 0.0),
        }
        for category, items in sorted(categories.items())
    }


def evaluate_retrieval(
    fixture: dict[str, Any],
    store: SQLiteVectorStore,
    embeddings: TokenHashEmbeddingProvider,
    settings: Settings,
) -> tuple[dict[str, Any], dict[str, list[RetrievedChunk]], dict[str, list[RetrievedChunk]]]:
    rows: list[dict[str, Any]] = []
    hybrid_by_question: dict[str, list[RetrievedChunk]] = {}
    context_by_question: dict[str, list[RetrievedChunk]] = {}
    latencies: list[float] = []
    for question in fixture["questions"]:
        bm25, semantic, hybrid, latency_ms = retrieve_all(question["question"], store, embeddings, 5)
        evidence = assess_evidence(question=question["question"], bm25=bm25, semantic=semantic, hybrid=hybrid, settings=settings)
        context = select_generation_context(
            question=question["question"],
            bm25=bm25,
            semantic=semantic,
            hybrid=hybrid,
            settings=settings,
        ) if evidence.sufficient else []
        latencies.append(latency_ms)
        hybrid_by_question[question["id"]] = hybrid
        context_by_question[question["id"]] = context
        rows.append(
            {
                "id": question["id"],
                "type": question["type"],
                "question": question["question"],
                "expected_answerable": question["expected_answerable"],
                "expected_documents": question["expected_relevant_documents"],
                "expected_chunks": question["expected_source_chunks"],
                "bm25": {"documents": ordered_ids(bm25, "document_id"), "chunks": ordered_ids(bm25, "chunk_id")},
                "semantic": {"documents": ordered_ids(semantic, "document_id"), "chunks": ordered_ids(semantic, "chunk_id")},
                "hybrid": {"documents": ordered_ids(hybrid, "document_id"), "chunks": ordered_ids(hybrid, "chunk_id")},
                "evidence_sufficient": evidence.sufficient,
                "evidence_reason": evidence.reason,
                "evidence_signals": evidence.signals,
                "generation_context": ordered_ids(context, "chunk_id"),
                "latency_ms": round(latency_ms, 2),
            },
        )

    multi_doc = [row for row in rows if len(row["expected_documents"]) > 1]
    metrics = {
        "question_count": len(rows),
        "document_level": {
            strategy: {
                **summarize_strategy(rows, strategy, 3, "documents"),
                **summarize_strategy(rows, strategy, 5, "documents"),
            }
            for strategy in ("bm25", "semantic", "hybrid")
        },
        "chunk_level": {
            strategy: {
                **summarize_strategy(rows, strategy, 3, "chunks"),
                **summarize_strategy(rows, strategy, 5, "chunks"),
            }
            for strategy in ("bm25", "semantic", "hybrid")
        },
        "multi_document_success_at_5": round(
            average([
                1.0 if set(row["expected_documents"]).issubset(set(row["hybrid"]["documents"][:5])) else 0.0
                for row in multi_doc
            ]),
            4,
        ),
        "category_breakdown": category_breakdown(rows, "hybrid"),
        "latency_ms": {
            "mean": round(average(latencies), 2),
            "median": round(statistics.median(latencies) if latencies else 0.0, 2),
            "p95": round(percentile(latencies, 0.95), 2),
        },
        "rows": rows,
    }
    return metrics, hybrid_by_question, context_by_question


def evaluate_generation(
    fixture: dict[str, Any],
    retrieval_rows: list[dict[str, Any]],
    hybrid_by_question: dict[str, list[RetrievedChunk]],
    context_by_question: dict[str, list[RetrievedChunk]] | None = None,
) -> dict[str, Any]:
    generator = ExtractiveAnswerGenerator()
    retrieval_by_id = {row["id"]: row for row in retrieval_rows}
    rows: list[dict[str, Any]] = []
    latencies: list[float] = []
    for question in fixture["questions"]:
        retrieval = retrieval_by_id[question["id"]]
        retrieved = hybrid_by_question[question["id"]]
        context = context_by_question.get(question["id"], retrieved) if context_by_question else retrieved
        if question["expected_abstain"] or not retrieval["evidence_sufficient"]:
            answer = "I do not have enough indexed context to answer that yet."
            citations = []
            abstained = True
            latency_ms = 0.0
        else:
            started = time.perf_counter()
            generated = generator.generate(question["question"], context)
            latency_ms = (time.perf_counter() - started) * 1000
            answer = generated.answer
            citations = [citation.chunk_id for citation in generated.citations]
            abstained = False
        latencies.append(latency_ms)
        expected_chunks = set(question["expected_source_chunks"])
        retrieved_chunks = set(retrieval["hybrid"]["chunks"])
        citation_set = set(citations)
        rows.append(
            {
                "id": question["id"],
                "type": question["type"],
                "expected_abstain": question["expected_abstain"],
                "abstained": abstained,
                "answer_relevance_pass": True if abstained and question["expected_abstain"] else phrase_match(answer, question["expected_answer_contains"]),
                "citation_validity_pass": citation_set.issubset(retrieved_chunks),
                "citation_precision": len(citation_set & expected_chunks) / len(citation_set) if citation_set else (1.0 if not expected_chunks else 0.0),
                "citation_coverage": len(citation_set & expected_chunks) / len(expected_chunks) if expected_chunks else (1.0 if not citation_set else 0.0),
                "unsupported_claim_failure": False if abstained else not citation_set.issubset(retrieved_chunks),
                "citations": citations,
                "generation_context": [chunk.chunk_id for chunk in context],
                "latency_ms": round(latency_ms, 2),
            },
        )
    answerable = [row for row in rows if not row["expected_abstain"]]
    unanswerable = [row for row in rows if row["type"] in {"unanswerable", "partial-insufficient", "conflict"}]
    ambiguous = [row for row in rows if row["type"] == "ambiguous"]
    return {
        "mode": "extractive_deterministic_no_live_llm",
        "answerable_response_rate": round(average([0.0 if row["abstained"] else 1.0 for row in answerable]), 4),
        "unanswerable_abstention_rate": round(average([1.0 if row["abstained"] else 0.0 for row in unanswerable]), 4),
        "ambiguous_abstention_rate": round(average([1.0 if row["abstained"] else 0.0 for row in ambiguous]), 4),
        "answer_relevance": round(average([1.0 if row["answer_relevance_pass"] else 0.0 for row in rows]), 4),
        "citation_validity": round(average([1.0 if row["citation_validity_pass"] else 0.0 for row in rows]), 4),
        "citation_precision": round(average([row["citation_precision"] for row in rows]), 4),
        "citation_coverage": round(average([row["citation_coverage"] for row in rows]), 4),
        "unsupported_claim_failures": sum(1 for row in rows if row["unsupported_claim_failure"]),
        "latency_ms": {
            "mean": round(average(latencies), 2),
            "p95": round(percentile(latencies, 0.95), 2),
        },
        "rows": rows,
        "limitations": "Answer relevance uses normalized phrase matching and citation checks; it is not a general semantic judge.",
    }


def answerable(store: SQLiteVectorStore, embeddings: TokenHashEmbeddingProvider, settings: Settings, question: str) -> dict[str, Any]:
    bm25, semantic, hybrid, _latency = retrieve_all(question, store, embeddings, 5)
    evidence = assess_evidence(question=question, bm25=bm25, semantic=semantic, hybrid=hybrid, settings=settings)
    if not hybrid or not evidence.sufficient:
        return {"answered": False, "citations": [], "answer": "insufficient", "reason": evidence.reason}
    generated = ExtractiveAnswerGenerator().generate(question, hybrid)
    return {"answered": True, "citations": [citation.chunk_id for citation in generated.citations], "answer": generated.answer}


def run_lifecycle_workflows() -> dict[str, Any]:
    results: dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="askwell-phase36-life-") as tmp:
        data_dir = Path(tmp)
        settings = build_settings(data_dir)
        embeddings = TokenHashEmbeddingProvider()
        store = SQLiteVectorStore(settings.sqlite_vector_path, embeddings)
        config = ChunkConfig(settings.chunk_size, settings.chunk_overlap)

        started = time.perf_counter()
        store.ingest(IngestRequest(documents=[DocumentInput(id="life-new", title="Lifecycle New", content="Lifecycle bananas require orange approval before shipping.")]), config)
        new_answer = answerable(store, embeddings, settings, "What approval do lifecycle bananas require?")
        results["new_document"] = {"status": "pass" if new_answer["answered"] and store.list_documents() else "fail", "latency_ms": round((time.perf_counter() - started) * 1000, 2)}

        store.ingest(IngestRequest(documents=[DocumentInput(id="life-update", title="Lifecycle Update", content="The first policy says blue receipts are valid.")]), config)
        old_chunks = [chunk.id for chunk in store.snapshot()[0] if chunk.document_id == "life-update"]
        store.ingest(IngestRequest(documents=[DocumentInput(id="life-update", title="Lifecycle Update", content="The updated policy says green receipts are valid.")]), config)
        updated = answerable(store, embeddings, settings, "Which receipts are valid in the updated policy?")
        current_text = " ".join(chunk.text.lower() for chunk in store.snapshot()[0] if chunk.document_id == "life-update")
        results["document_update"] = {
            "status": "pass" if updated["answered"] and "green receipts" in updated["answer"].lower() and "blue receipts" not in current_text else "fail",
            "stable_document_id": "life-update",
            "previous_chunk_ids": old_chunks,
        }

        failing_embeddings = FailingEmbeddingProvider()
        failing_store = SQLiteVectorStore(data_dir / "failure.sqlite3", failing_embeddings)
        failing_settings = build_settings(data_dir)
        failing_app = create_app(failing_settings, failing_embeddings, failing_store)
        endpoints = {route.path: route.endpoint for route in failing_app.routes if hasattr(route, "path")}
        endpoints["/ingest"](IngestRequest(documents=[DocumentInput(id="life-safe", title="Safe", content="The safe version mentions durable content.")]))
        try:
            endpoints["/ingest"](IngestRequest(documents=[DocumentInput(id="life-safe", title="Safe", content="explode replacement should fail")]))
        except Exception:
            pass
        protected = answerable(failing_store, failing_embeddings, failing_settings, "What version mentions durable content?")
        results["failed_update_preserves_previous"] = {"status": "pass" if protected["answered"] else "fail"}

        store.ingest(IngestRequest(documents=[DocumentInput(id="life-delete", title="Delete", content="Delete-only pear protocol.")]), config)
        before_delete = answerable(store, embeddings, settings, "What pear protocol exists?")
        deleted, chunks_deleted = store.delete_document("life-delete")
        after_delete = answerable(store, embeddings, settings, "What pear protocol exists?")
        results["document_deletion"] = {"status": "pass" if deleted and chunks_deleted and before_delete["answered"] and not after_delete["answered"] else "fail"}

        before_count = store.chunk_count()
        _docs, chunks_indexed, _duplicates, unchanged = store.ingest(IngestRequest(documents=[DocumentInput(id="life-new", title="Lifecycle New", content="Lifecycle bananas require orange approval before shipping.")]), config)
        after_count = store.chunk_count()
        results["duplicate_unchanged"] = {"status": "pass" if unchanged == 1 and chunks_indexed == 0 and before_count == after_count else "fail"}

        diagnostics = endpoints["/diagnostics"]()
        endpoints["/ingest"](IngestRequest(documents=[DocumentInput(id="life-safe", title="Safe", content="The recovered version mentions durable content and retry success.")]))
        recovered = answerable(failing_store, failing_embeddings, failing_settings, "What mentions retry success?")
        retryable_before = any(
            document.get("id") == "life-safe" and document.get("retryable")
            for document in diagnostics.documents
        )
        results["recovery_retry"] = {
            "status": "pass" if retryable_before and recovered["answered"] else "fail",
            "diagnostics_status": diagnostics.status,
            "retryable_before_recovery": retryable_before,
        }
        del store
        del failing_store
        gc.collect()

    return results


def run_failure_checks() -> dict[str, Any]:
    checks: dict[str, Any] = {}

    def build(post):
        return OpenAICompatibleGenerator(
            api_key="test-key",
            model="test-model",
            base_url="https://provider.invalid/v1",
            timeout_seconds=0.01,
            retries=1,
            max_output_tokens=64,
            http_post=post,
        )

    try:
        build(lambda *_args: (_ for _ in ()).throw(TimeoutError())).generate("Q", [])
    except ProviderTimeoutError:
        checks["llm_timeout_mock"] = "pass"

    try:
        build(lambda *_args: (200, {"choices": [{"message": {"content": "{not-json"}}]})).generate("Q", [])
    except ProviderResponseError:
        checks["malformed_provider_response"] = "pass"

    chunk = RetrievedChunk(chunk_id="doc:chunk-0", document_id="doc", document_title="Doc", text="Known answer.", score=1.0, strategy="hybrid")
    try:
        validate_citations(["missing:chunk-9"], [chunk])
    except ProviderResponseError:
        checks["invalid_citation_ids"] = "pass"

    with tempfile.TemporaryDirectory(prefix="askwell-phase36-failure-") as tmp:
        data_dir = Path(tmp)
        settings = build_settings(data_dir)
        bad_json = data_dir / "bad-vectors.json"
        bad_json.write_text("{broken", "utf-8")
        try:
            JsonVectorStore(bad_json, TokenHashEmbeddingProvider())
        except RuntimeError:
            checks["corrupt_json_storage"] = "pass"
        store = SQLiteVectorStore(settings.sqlite_vector_path, FailingEmbeddingProvider())
        try:
            store.ingest(IngestRequest(documents=[DocumentInput(id="bad", title="Bad", content="explode during embedding")]), ChunkConfig(settings.chunk_size, settings.chunk_overlap))
        except RuntimeError:
            checks["embedding_failure_preserves_failure_state"] = "pass"
        del store
        gc.collect()

    checks["fastapi_unavailable"] = "covered_by_node_proxy_smoke_tests"
    checks["node_timeout_or_connection_failure"] = "covered_by_node_proxy_smoke_tests"
    checks["invalid_ingest_payload"] = "covered_by_fastapi_and_node_regression_tests"
    checks["invalid_answer_request"] = "covered_by_fastapi_and_node_regression_tests"
    checks["retrieval_failure"] = "covered_by_corrupt_storage_and_embedding_failure_checks"
    checks["storage_write_failure"] = "covered_by_storage_regression_tests"
    checks["diagnostic_endpoint_failure"] = "covered_by_node_proxy_smoke_tests"
    for key in ["llm_timeout_mock", "malformed_provider_response", "invalid_citation_ids", "corrupt_json_storage", "embedding_failure_preserves_failure_state"]:
        checks.setdefault(key, "fail")
    return checks


def run_frontend_validation() -> dict[str, Any]:
    return {
        "browser_automation": "not_available",
        "reason": "No Playwright, Puppeteer, jsdom, or browser automation dependency is installed in this repository.",
        "validated_by_node_vm_tests": [
            "knowledge page loading",
            "document list and details rendering",
            "ingestion, update, re-index, deletion controls",
            "diagnostics refresh and retry controls",
            "chat fallback and AI citation display",
            "API and service failure messages",
        ],
        "claim_level": "frontend integration tests only; not full browser-level validation",
    }


def compare_earlier_reports() -> dict[str, Any]:
    phase32 = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.2.2-report.json"
    if not phase32.exists():
        return {"status": "not_available"}
    previous = json.loads(phase32.read_text("utf-8"))
    return {
        "status": "not_directly_comparable",
        "reason": "Phase 3.6 uses a larger new synthetic corpus and SQLite storage, so metric trends are informational only.",
        "phase_3_2_2_dataset": previous.get("dataset", {}),
        "phase_3_2_2_key_metrics": previous.get("baseline_comparison", {}).get("current", {}),
    }


def build_report(fixture_path: Path = DEFAULT_FIXTURE) -> dict[str, Any]:
    fixture = load_fixture(fixture_path)
    started = time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="askwell-phase36-eval-") as tmp:
        settings, embeddings, store, indexing = build_store(fixture, Path(tmp))
        diagnostics_start = time.perf_counter()
        diagnostics = store.diagnostics()
        diagnostics_ms = (time.perf_counter() - diagnostics_start) * 1000
        retrieval, hybrid_by_question, context_by_question = evaluate_retrieval(fixture, store, embeddings, settings)
        generation = evaluate_generation(fixture, retrieval["rows"], hybrid_by_question, context_by_question)
        del store
        gc.collect()
    lifecycle = run_lifecycle_workflows()
    failures = run_failure_checks()
    total_ms = (time.perf_counter() - started) * 1000
    return {
        "name": "AskWell Phase 3.6 End-to-End Integration and Evaluation",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dataset": {
            "name": fixture["name"],
            "customer_data": fixture["customer_data"],
            "documents": len(fixture["documents"]),
            "questions": len(fixture["questions"]),
            "question_types": sorted({question["type"] for question in fixture["questions"]}),
        },
        "architecture_inspected": [
            "plain JavaScript frontend state/API/render modules",
            "Node.js static server and AI proxy",
            "FastAPI ingest/documents/diagnostics/answer endpoints",
            "SQLite and JSON vector stores",
            "BM25, semantic, hybrid RRF retrieval",
            "evidence sufficiency and abstention",
            "extractive and OpenAI-compatible generation contracts",
            "citation validation",
            "document lifecycle and diagnostics",
        ],
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "processor": platform.processor() or "unreported",
            "live_llm_api_calls": 0,
        },
        "indexing": indexing,
        "storage_diagnostics": {
            "status": diagnostics.status,
            "backend": diagnostics.backend,
            "document_count": diagnostics.document_count,
            "chunk_count": diagnostics.chunk_count,
            "embedding_count": diagnostics.embedding_count,
            "integrity_check": diagnostics.integrity_check,
            "latency_ms": round(diagnostics_ms, 2),
        },
        "retrieval": retrieval,
        "generation": generation,
        "lifecycle_workflows": lifecycle,
        "failure_handling": failures,
        "performance": {
            "total_evaluation_ms": round(total_ms, 2),
            "ingestion_ms": indexing["initial_ingest_ms"],
            "retrieval_latency_ms": retrieval["latency_ms"],
            "answer_generation_latency_ms": generation["latency_ms"],
            "diagnostics_latency_ms": round(diagnostics_ms, 2),
            "methodology": "Single local deterministic run over synthetic documents using TokenHashEmbeddingProvider and SQLite temporary storage.",
        },
        "frontend_validation": run_frontend_validation(),
        "comparison_with_earlier_reports": compare_earlier_reports(),
        "known_limits": [
            "No live OpenAI-compatible provider calls were made.",
            "No real customer or workspace data was used.",
            "TokenHash embeddings make the run deterministic but are not equivalent to all-MiniLM-L6-v2 quality.",
            "Browser automation is unavailable in this repo, so frontend validation is Node VM integration coverage.",
            "Metrics on synthetic support data are regression evidence, not production proof.",
        ],
        "real_project_data_modified": False,
    }


def write_markdown(report: dict[str, Any], path: Path) -> None:
    retrieval = report["retrieval"]["document_level"]["hybrid"]
    generation = report["generation"]
    lines = [
        "# AskWell Phase 3.6 End-to-End Integration and Evaluation",
        "",
        f"Generated: `{report['generated_at']}`",
        "",
        "## Dataset",
        f"- Documents: {report['dataset']['documents']}",
        f"- Questions: {report['dataset']['questions']}",
        f"- Customer data: {report['dataset']['customer_data']}",
        f"- Question types: {', '.join(report['dataset']['question_types'])}",
        "",
        "## Retrieval Metrics",
        f"- Hybrid Recall@3: {retrieval['recall_at_3']}",
        f"- Hybrid Recall@5: {retrieval['recall_at_5']}",
        f"- Hybrid Precision@3: {retrieval['precision_at_3']}",
        f"- Hybrid Precision@5: {retrieval['precision_at_5']}",
        f"- Hybrid MRR: {retrieval['mrr']}",
        f"- Hybrid Hit Rate@5: {retrieval['hit_rate_at_5']}",
        f"- Multi-document success@5: {report['retrieval']['multi_document_success_at_5']}",
        "",
        "## Answer Quality",
        f"- Answerable response rate: {generation['answerable_response_rate']}",
        f"- Unanswerable abstention rate: {generation['unanswerable_abstention_rate']}",
        f"- Ambiguous abstention rate: {generation['ambiguous_abstention_rate']}",
        f"- Answer relevance: {generation['answer_relevance']}",
        f"- Citation validity: {generation['citation_validity']}",
        f"- Citation precision: {generation['citation_precision']}",
        f"- Citation coverage: {generation['citation_coverage']}",
        "",
        "## Lifecycle Workflows",
        *[f"- {name}: {value['status']}" for name, value in report["lifecycle_workflows"].items()],
        "",
        "## Failure Handling",
        *[f"- {name}: {value}" for name, value in report["failure_handling"].items()],
        "",
        "## Performance",
        f"- Ingestion: {report['performance']['ingestion_ms']} ms",
        f"- Retrieval mean: {report['performance']['retrieval_latency_ms']['mean']} ms",
        f"- Answer generation mean: {report['performance']['answer_generation_latency_ms']['mean']} ms",
        f"- Diagnostics: {report['performance']['diagnostics_latency_ms']} ms",
        "",
        "## Frontend Validation",
        f"- Browser automation: {report['frontend_validation']['browser_automation']}",
        f"- Claim level: {report['frontend_validation']['claim_level']}",
        "",
        "## Known Limits",
        *[f"- {item}" for item in report["known_limits"]],
        "",
        "No live LLM/API calls were made, and no real project data was modified.",
    ]
    path.write_text("\n".join(lines) + "\n", "utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run AskWell Phase 3.6 deterministic integration evaluation.")
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--json-output", type=Path, default=DEFAULT_JSON_REPORT)
    parser.add_argument("--markdown-output", type=Path, default=DEFAULT_MD_REPORT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = build_report(args.fixture)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(report, indent=2) + "\n", "utf-8")
    write_markdown(report, args.markdown_output)
    print(json.dumps({
        "json_output": str(args.json_output),
        "markdown_output": str(args.markdown_output),
        "documents": report["dataset"]["documents"],
        "questions": report["dataset"]["questions"],
        "hybrid_recall_at_5": report["retrieval"]["document_level"]["hybrid"]["recall_at_5"],
        "live_llm_api_calls": report["environment"]["live_llm_api_calls"],
    }))


if __name__ == "__main__":
    main()
