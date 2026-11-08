from __future__ import annotations

import json
import math
import os
import shutil
import time
import uuid
from pathlib import Path

import numpy as np
import pytest

if os.getenv("ASKWELL_RUN_REAL_MODEL_TESTS") != "1":
    pytest.skip("Set ASKWELL_RUN_REAL_MODEL_TESTS=1 to run real model tests.", allow_module_level=True)

os.environ.setdefault("HF_HUB_OFFLINE", "1")

from app.config import Settings
from app.embeddings.sentence_transformers import SentenceTransformerEmbeddingProvider
from app.ingestion.processing import ChunkConfig
from app.models.schemas import IngestRequest
from app.retrieval.bm25 import BM25Retriever
from app.retrieval.hybrid import reciprocal_rank_fusion
from app.retrieval.store import JsonVectorStore
from app.retrieval.vector import VectorRetriever


PROJECT_ROOT = Path(__file__).resolve().parents[2]
WORKSPACE_PATH = PROJECT_ROOT / "data" / "workspace.json"


def workspace_articles():
    payload = json.loads(WORKSPACE_PATH.read_text("utf-8"))
    return payload.get("articles", [])


def test_real_sentence_transformer_pipeline():
    model_name = os.getenv(
        "ASKWELL_EMBEDDING_MODEL",
        "sentence-transformers/all-MiniLM-L6-v2",
    )
    run_dir = PROJECT_ROOT / ".tmp-ai-real-tests" / uuid.uuid4().hex
    if run_dir.exists():
        shutil.rmtree(run_dir)
    run_dir.mkdir(parents=True)

    started = time.perf_counter()
    embeddings = SentenceTransformerEmbeddingProvider(model_name)
    load_ms = (time.perf_counter() - started) * 1000
    dimension = embeddings.dimension

    sample_texts = [
        "Saved through the API.",
        "The API saved this workspace data.",
        "Bananas grow best in warm weather.",
    ]
    sample_vectors = embeddings.embed(sample_texts)

    assert dimension > 0
    assert sample_vectors.shape == (3, dimension)
    assert np.allclose(np.linalg.norm(sample_vectors, axis=1), 1.0, atol=1e-5)
    assert np.allclose(embeddings.embed([sample_texts[0]])[0], sample_vectors[0], atol=1e-6)

    similar_score = float(sample_vectors[0] @ sample_vectors[1])
    unrelated_score = float(sample_vectors[0] @ sample_vectors[2])
    assert similar_score > unrelated_score

    settings = Settings(
        embedding_model=model_name,
        data_dir=run_dir,
        chunk_size=700,
        chunk_overlap=120,
        insufficient_score_threshold=0.001,
    )
    store = JsonVectorStore(run_dir / "vectors.json", embeddings)
    articles = workspace_articles()
    assert articles, "Workspace must contain at least one knowledge article."

    ingest_request = IngestRequest(articles=articles)
    ingest_started = time.perf_counter()
    documents, chunks, duplicates, unchanged = store.ingest(
        ingest_request,
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )
    ingest_ms = (time.perf_counter() - ingest_started) * 1000
    assert documents == len(articles)
    assert chunks >= len(articles)
    assert duplicates == 0
    assert unchanged == 0
    assert (run_dir / "vectors.json").exists()
    assert store.chunks[0].metadata.get("article_id") == articles[0]["id"]
    assert store.chunks[0].metadata.get("source_type") == "article"

    _documents, repeated_chunks, _duplicates, repeated_unchanged = store.ingest(
        ingest_request,
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )
    assert repeated_chunks == 0
    assert repeated_unchanged == len(articles)

    duplicate_articles = [
        {
            "id": "duplicate-copy",
            "title": articles[0]["title"],
            "tags": articles[0].get("tags", []),
            "content": articles[0]["content"],
        },
    ]
    _documents, duplicate_chunks, duplicate_count, _unchanged = store.ingest(
        IngestRequest(articles=duplicate_articles),
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )
    assert duplicate_chunks == 0
    assert duplicate_count >= 1

    updated = [dict(article) for article in articles]
    updated[0]["content"] = f"{updated[0]['content']} Updated validation sentence."
    _documents, updated_chunks, _duplicates, _unchanged = store.ingest(
        IngestRequest(articles=updated),
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )
    assert updated_chunks >= 1

    bm25 = BM25Retriever()
    semantic = VectorRetriever(embeddings)
    questions = [
        ("What was saved through the API?", {articles[0]["id"]}),
        ("Tell me about HTTP Article", {articles[0]["id"]}),
        ("Which saved data is available?", {articles[0]["id"]}),
        ("API persistence result?", {articles[0]["id"]}),
        ("How do I install the widget?", set()),
        ("Can I start a free trial?", set()),
        ("How do refunds work?", set()),
        ("What is the billing policy?", set()),
        ("Can I use enterprise SSO?", set()),
        ("How do I connect Slack?", set()),
        ("Where is the customer inbox?", set()),
        ("What model provider is configured?", set()),
        ("How do I export JSON?", set()),
        ("Can I downgrade my plan?", set()),
        ("How do I change brand colors?", set()),
    ]

    evaluated = []
    retrieval_started = time.perf_counter()
    for question, expected in questions:
        keyword_results = bm25.search(question, store.chunks, top_k=3)
        semantic_results = semantic.search(question, store.chunks, store.vectors, top_k=3)
        hybrid_results = reciprocal_rank_fusion(keyword_results, semantic_results, top_k=3)
        evaluated.append(
            {
                "question": question,
                "expected": expected,
                "bm25": [result.document_id for result in keyword_results],
                "semantic": [result.document_id for result in semantic_results],
                "hybrid": [result.document_id for result in hybrid_results],
            },
        )
    retrieval_ms = (time.perf_counter() - retrieval_started) * 1000

    def metrics(strategy: str):
        labelled = [item for item in evaluated if item["expected"]]
        recall = []
        precision = []
        reciprocal_ranks = []
        hits = []
        for item in labelled:
            retrieved = item[strategy]
            expected = item["expected"]
            recall.append(len(expected.intersection(retrieved)) / len(expected))
            precision.append(len(expected.intersection(retrieved)) / 3)
            hits.append(1.0 if expected.intersection(retrieved) else 0.0)
            rr = 0.0
            for index, doc_id in enumerate(retrieved, start=1):
                if doc_id in expected:
                    rr = 1.0 / index
                    break
            reciprocal_ranks.append(rr)
        return {
            "recall_at_3": sum(recall) / len(recall),
            "precision_at_3": sum(precision) / len(precision),
            "mrr": sum(reciprocal_ranks) / len(reciprocal_ranks),
            "hit_rate_at_3": sum(hits) / len(hits),
        }

    report = {
        "model_name": model_name,
        "embedding_dimensions": dimension,
        "load_ms": round(load_ms, 2),
        "ingest_ms": round(ingest_ms, 2),
        "retrieval_ms_total": round(retrieval_ms, 2),
        "indexed_documents": len(articles),
        "indexed_chunks": len(store.chunks),
        "similar_score": round(similar_score, 6),
        "unrelated_score": round(unrelated_score, 6),
        "metrics": {
            "bm25": metrics("bm25"),
            "semantic": metrics("semantic"),
            "hybrid": metrics("hybrid"),
        },
        "evaluated": [
            {
                **item,
                "expected": sorted(item["expected"]),
            }
            for item in evaluated
        ],
    }
    report_path = PROJECT_ROOT / "ai-service" / "evaluation" / "real-model-report.json"
    report_path.write_text(json.dumps(report, indent=2), "utf-8")

    for value in report["metrics"]["hybrid"].values():
        assert math.isfinite(value)
