from __future__ import annotations

import json
import shutil
import uuid
import os
import builtins
import threading
from concurrent.futures import ThreadPoolExecutor
import pytest
from pathlib import Path

import numpy as np
from fastapi import HTTPException
from fastapi.testclient import TestClient

os.environ.setdefault("ASKWELL_SKIP_AUTO_MODEL", "1")

from app.config import Settings
from app.embeddings.testing import TokenHashEmbeddingProvider
from app.evaluation.metrics import hit_rate_at_k, precision_at_k, recall_at_k, reciprocal_rank
from app.generation.extractive import ExtractiveAnswerGenerator
from app.ingestion.processing import ChunkConfig
from app.models.schemas import EncodedDocumentInput
from app.embeddings.sentence_transformers import SentenceTransformerEmbeddingProvider
from app.main import create_app
from app.models.schemas import IngestRequest
from app.retrieval.bm25 import BM25Retriever
from app.retrieval.hybrid import reciprocal_rank_fusion
from app.retrieval.store import JsonVectorStore, SQLiteVectorStore, build_vector_store
from app.retrieval.vector import VectorRetriever


class NamedTokenHashEmbeddingProvider(TokenHashEmbeddingProvider):
    def __init__(self, model_name: str, dimension: int = 64):
        super().__init__(dimension)
        self.model_name = model_name


class BlockingTokenHashEmbeddingProvider(TokenHashEmbeddingProvider):
    def __init__(self):
        super().__init__()
        self.block = False
        self.started = threading.Event()
        self.release = threading.Event()

    def embed(self, texts: list[str]) -> np.ndarray:
        if self.block:
            self.started.set()
            assert self.release.wait(timeout=5)
        return super().embed(texts)


class FailingEmbeddingProvider(TokenHashEmbeddingProvider):
    def embed(self, texts: list[str]) -> np.ndarray:
        if any("explode" in text for text in texts):
            raise RuntimeError("embedding failure")
        return super().embed(texts)


def build_store(tmp_path: Path) -> tuple[Settings, TokenHashEmbeddingProvider, JsonVectorStore]:
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    if workspace_tmp.exists():
        shutil.rmtree(workspace_tmp)
    workspace_tmp.mkdir(parents=True)
    embeddings = TokenHashEmbeddingProvider()
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        chunk_size=220,
        chunk_overlap=20,
        insufficient_score_threshold=0.001,
    )
    return settings, embeddings, JsonVectorStore(workspace_tmp / "vectors.json", embeddings)


def build_sqlite_store(tmp_path: Path) -> tuple[Settings, TokenHashEmbeddingProvider, SQLiteVectorStore]:
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    if workspace_tmp.exists():
        shutil.rmtree(workspace_tmp)
    workspace_tmp.mkdir(parents=True)
    embeddings = TokenHashEmbeddingProvider()
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        sqlite_vector_path=workspace_tmp / "vectors.sqlite3",
        vector_storage_backend="sqlite",
        chunk_size=220,
        chunk_overlap=20,
        insufficient_score_threshold=0.001,
    )
    return settings, embeddings, SQLiteVectorStore(settings.sqlite_vector_path, embeddings)


def single_article_request(article_id: str, title: str, content: str) -> IngestRequest:
    return IngestRequest(
        articles=[
            {
                "id": article_id,
                "title": title,
                "tags": [article_id],
                "content": content,
            },
        ],
    )


def vector_by_chunk_id(store: JsonVectorStore) -> dict[str, np.ndarray]:
    chunks, vectors = store.snapshot()
    return {chunk.id: vectors[index].copy() for index, chunk in enumerate(chunks)}


def valid_storage_payload(embeddings: TokenHashEmbeddingProvider) -> dict:
    chunk = {
        "id": "doc:chunk-0",
        "document_id": "doc",
        "document_title": "Doc",
        "text": "alpha beta",
        "hash": "hash",
        "metadata": {},
    }
    vector = embeddings.embed(["alpha beta"])[0].tolist()
    return {
        "manifest": {
            "storage_schema_version": 1,
            "embedding": {
                "provider": embeddings.__class__.__name__,
                "model": getattr(embeddings, "model_name", embeddings.__class__.__name__),
                "dimension": embeddings.dimension,
                "normalized": True,
            },
            "chunking": {"size": 220, "overlap": 20},
            "created_at": "2026-01-01T00:00:00+00:00",
            "updated_at": "2026-01-01T00:00:00+00:00",
        },
        "chunks": [chunk],
        "vectors": [vector],
        "document_hashes": {"doc": "content-hash"},
        "embedding_dimension": embeddings.dimension,
    }


def ingest_fixture(store: JsonVectorStore, settings: Settings):
    return store.ingest(
        IngestRequest(
            articles=[
                {
                    "id": "trial",
                    "title": "Start a free trial",
                    "tags": ["billing", "trial"],
                    "content": "Trials last 14 days and do not require a card.",
                },
                {
                    "id": "widget",
                    "title": "Install the widget",
                    "tags": ["setup", "widget"],
                    "content": "Paste the widget script before the closing body tag.",
                },
            ],
        ),
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )


def test_fastapi_service_can_be_constructed_with_injected_embeddings(tmp_path):
    settings, embeddings, store = build_store(tmp_path)
    app = create_app(settings, embeddings, store)

    assert app.title == "AskWell AI Service"
    assert any(route.path == "/ingest" for route in app.routes)
    assert any(route.path == "/answer" for route in app.routes)
    assert any(route.path == "/documents" for route in app.routes)
    assert any(route.path == "/documents/{document_id}" for route in app.routes)


def test_fastapi_service_token_protects_non_health_routes(tmp_path):
    settings, embeddings, store = build_store(tmp_path)
    settings = Settings(
        embedding_model=settings.embedding_model,
        data_dir=settings.data_dir,
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        insufficient_score_threshold=settings.insufficient_score_threshold,
        api_token="service-token-123456",
        require_api_token=True,
    )
    app = create_app(settings, embeddings, store)
    client = TestClient(app)

    assert client.get("/health").status_code == 200

    unauthorized = client.get("/documents")
    assert unauthorized.status_code == 401
    assert unauthorized.json()["detail"] == "Missing or invalid AI service token"

    authorized = client.get(
        "/documents",
        headers={"x-askwell-ai-token": "service-token-123456"},
    )
    assert authorized.status_code == 200
    assert authorized.json() == []

    config = client.get(
        "/config",
        headers={"x-askwell-ai-token": "service-token-123456"},
    )
    assert config.status_code == 200
    body = config.json()
    assert body["api_token_required"] is True
    assert body["api_token_configured"] is True
    assert "service-token-123456" not in str(body)


def test_fastapi_service_refuses_required_token_without_secret(tmp_path):
    settings, embeddings, store = build_store(tmp_path)
    settings = Settings(
        embedding_model=settings.embedding_model,
        data_dir=settings.data_dir,
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
        insufficient_score_threshold=settings.insufficient_score_threshold,
        api_token="",
        require_api_token=True,
    )

    with pytest.raises(RuntimeError, match="ASKWELL_AI_SERVICE_TOKEN is required"):
        create_app(settings, embeddings, store)


def test_ingestion_generates_and_persists_embeddings(tmp_path):
    settings, _embeddings, store = build_store(tmp_path)
    documents, chunks, duplicates, unchanged = store.ingest(
        IngestRequest(
            articles=[
                {
                    "id": "trial",
                    "title": "Start a free trial",
                    "tags": ["billing", "trial"],
                    "content": "Trials last 14 days and do not require a card.",
                }
            ],
        ),
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )

    assert documents == 1
    assert chunks == 1
    assert duplicates == 0
    assert unchanged == 0
    assert (settings.data_dir / "vectors.json").exists()

    _documents, _chunks, _duplicates, unchanged = store.ingest(
        IngestRequest(
            articles=[
                {
                    "id": "trial",
                    "title": "Start a free trial",
                    "tags": ["billing", "trial"],
                    "content": "Trials last 14 days and do not require a card.",
                }
            ],
        ),
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )
    assert unchanged == 1


def test_updating_middle_document_preserves_unrelated_vector_alignment(tmp_path):
    settings, _embeddings, store = build_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    for article_id, content in [
        ("alpha", "alpha setup guide"),
        ("bravo", "bravo billing guide"),
        ("charlie", "charlie export guide"),
    ]:
        store.ingest(single_article_request(article_id, article_id.title(), content), chunk_config)
    before = vector_by_chunk_id(store)

    store.ingest(
        single_article_request("bravo", "Bravo", "bravo updated payment workflow"),
        chunk_config,
    )

    after = vector_by_chunk_id(store)
    assert len(store.chunks) == len(store.vectors) == 3
    assert np.allclose(after["alpha:chunk-0"], before["alpha:chunk-0"])
    assert np.allclose(after["charlie:chunk-0"], before["charlie:chunk-0"])
    assert "bravo:chunk-0" in after
    assert not np.allclose(after["bravo:chunk-0"], before["bravo:chunk-0"])


def test_multiple_consecutive_updates_keep_one_current_document_vector(tmp_path):
    settings, _embeddings, store = build_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "trial lasts fourteen days"), chunk_config)
    first_vector = vector_by_chunk_id(store)["trial:chunk-0"]

    store.ingest(single_article_request("trial", "Trial", "trial requires no card"), chunk_config)
    second_vector = vector_by_chunk_id(store)["trial:chunk-0"]
    store.ingest(single_article_request("trial", "Trial", "trial can be canceled anytime"), chunk_config)
    third_vector = vector_by_chunk_id(store)["trial:chunk-0"]

    assert len(store.chunks) == len(store.vectors) == 1
    assert "canceled anytime" in store.chunks[0].text
    assert not np.allclose(first_vector, second_vector)
    assert not np.allclose(second_vector, third_vector)


def test_empty_document_update_removes_old_chunks_without_stale_vectors(tmp_path):
    settings, _embeddings, store = build_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("alpha", "Alpha", "alpha content"), chunk_config)
    store.ingest(single_article_request("empty", "Empty", "content to remove"), chunk_config)
    store.ingest(single_article_request("charlie", "Charlie", "charlie content"), chunk_config)

    documents, chunks, duplicates, unchanged = store.ingest(
        IngestRequest(documents=[{"id": "empty", "title": "Empty", "content": "   "}]),
        chunk_config,
    )

    assert (documents, chunks, duplicates, unchanged) == (1, 0, 0, 0)
    assert len(store.chunks) == len(store.vectors) == 2
    assert {chunk.document_id for chunk in store.chunks} == {"alpha", "charlie"}
    assert "empty" in store.document_hashes


def test_duplicate_ingestion_remains_idempotent(tmp_path):
    settings, _embeddings, store = build_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    request = single_article_request("trial", "Trial", "trial lasts fourteen days")

    store.ingest(request, chunk_config)
    before = vector_by_chunk_id(store)
    _documents, chunks, duplicates, unchanged = store.ingest(request, chunk_config)

    assert chunks == 0
    assert duplicates == 0
    assert unchanged == 1
    assert len(store.chunks) == len(store.vectors) == 1
    assert np.allclose(vector_by_chunk_id(store)["trial:chunk-0"], before["trial:chunk-0"])


def test_bm25_semantic_and_hybrid_retrieval_return_real_chunks(tmp_path):
    settings, embeddings, store = build_store(tmp_path)
    ingest_fixture(store, settings)

    question = "trial card"
    bm25 = BM25Retriever().search(question, store.chunks, top_k=3)
    semantic = VectorRetriever(embeddings).search(
        question,
        store.chunks,
        store.vectors,
        top_k=3,
    )
    hybrid = reciprocal_rank_fusion(bm25, semantic, top_k=3)

    assert bm25[0].document_id == "trial"
    assert semantic[0].document_id == "trial"
    assert hybrid[0].document_id == "trial"
    assert hybrid[0].chunk_id.startswith("trial:chunk-")
    assert hybrid[0].strategy == "hybrid"


def test_extractive_generation_uses_actual_chunk_citations(tmp_path):
    settings, embeddings, store = build_store(tmp_path)
    ingest_fixture(store, settings)
    question = "trial card"
    retrieved = reciprocal_rank_fusion(
        BM25Retriever().search(question, store.chunks, top_k=3),
        VectorRetriever(embeddings).search(
            question,
            store.chunks,
            store.vectors,
            top_k=3,
        ),
        top_k=3,
    )

    result = ExtractiveAnswerGenerator().generate(question, retrieved)

    assert "14 days" in result.answer
    assert result.citations[0].document_id == "trial"
    assert result.citations[0].chunk_id.startswith("trial:chunk-")


def test_insufficient_context_fallback_condition(tmp_path):
    _settings, embeddings, store = build_store(tmp_path)
    retrieved = reciprocal_rank_fusion(
        BM25Retriever().search("Tell me about enterprise SSO", store.chunks, top_k=3),
        VectorRetriever(embeddings).search(
            "Tell me about enterprise SSO",
            store.chunks,
            store.vectors,
            top_k=3,
        ),
        top_k=3,
    )

    assert retrieved == []


def test_invalid_encoded_document_is_rejected(tmp_path):
    settings, _embeddings, store = build_store(tmp_path)

    with pytest.raises(ValueError, match="valid base64"):
        store.ingest(
            IngestRequest(
                encoded_documents=[
                    EncodedDocumentInput(
                        id="bad",
                        title="Bad upload",
                        filename="bad.txt",
                        content_base64="not base64",
                    ),
                ],
            ),
            ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
        )


def test_corrupted_vector_storage_reports_recovery_error(tmp_path):
    settings, embeddings, _store = build_store(tmp_path)
    vector_path = settings.data_dir / "corrupted.json"
    vector_path.write_text("{broken json", "utf-8")

    with pytest.raises(RuntimeError, match="Vector storage is corrupted"):
        JsonVectorStore(vector_path, embeddings)


def test_missing_required_storage_fields_are_rejected(tmp_path):
    settings, embeddings, _store = build_store(tmp_path)
    vector_path = settings.data_dir / "missing-fields.json"
    vector_path.write_text(json.dumps({"chunks": [], "vectors": []}), "utf-8")

    with pytest.raises(RuntimeError, match="missing required fields"):
        JsonVectorStore(vector_path, embeddings)


def test_chunk_vector_count_mismatch_is_rejected(tmp_path):
    settings, embeddings, _store = build_store(tmp_path)
    payload = valid_storage_payload(embeddings)
    payload["vectors"] = []
    vector_path = settings.data_dir / "mismatch.json"
    vector_path.write_text(json.dumps(payload), "utf-8")

    with pytest.raises(RuntimeError, match="two-dimensional matrix"):
        JsonVectorStore(vector_path, embeddings)


def test_invalid_vector_values_are_rejected(tmp_path):
    settings, embeddings, _store = build_store(tmp_path)
    payload = valid_storage_payload(embeddings)
    payload["vectors"][0][0] = float("nan")
    vector_path = settings.data_dir / "invalid-values.json"
    vector_path.write_text(json.dumps(payload), "utf-8")

    with pytest.raises(RuntimeError, match="NaN or infinite"):
        JsonVectorStore(vector_path, embeddings)


def test_invalid_vector_dimensions_are_rejected(tmp_path):
    settings, embeddings, _store = build_store(tmp_path)
    payload = valid_storage_payload(embeddings)
    payload["vectors"] = [[0.1, 0.2]]
    vector_path = settings.data_dir / "invalid-dimensions.json"
    vector_path.write_text(json.dumps(payload), "utf-8")

    with pytest.raises(RuntimeError, match="shape"):
        JsonVectorStore(vector_path, embeddings)


def test_embedding_configuration_mismatch_is_rejected(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    original = NamedTokenHashEmbeddingProvider("model-a")
    payload = valid_storage_payload(original)
    vector_path = workspace_tmp / "vectors.json"
    vector_path.write_text(json.dumps(payload), "utf-8")

    with pytest.raises(RuntimeError, match="does not match configured model"):
        JsonVectorStore(vector_path, NamedTokenHashEmbeddingProvider("model-b"))


def test_legacy_storage_requires_explicit_compatibility_opt_in(tmp_path, monkeypatch):
    settings, embeddings, _store = build_store(tmp_path)
    payload = valid_storage_payload(embeddings)
    payload.pop("manifest")
    vector_path = settings.data_dir / "legacy.json"
    vector_path.write_text(json.dumps(payload), "utf-8")

    monkeypatch.delenv("ASKWELL_ALLOW_LEGACY_VECTOR_STORAGE", raising=False)
    with pytest.raises(RuntimeError, match="created without a manifest"):
        JsonVectorStore(vector_path, embeddings)

    monkeypatch.setenv("ASKWELL_ALLOW_LEGACY_VECTOR_STORAGE", "1")
    legacy_store = JsonVectorStore(vector_path, embeddings)
    assert len(legacy_store.chunks) == 1


def test_failed_atomic_write_preserves_previous_file_and_cleans_temp(tmp_path, monkeypatch):
    settings, _embeddings, store = build_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "trial lasts fourteen days"), chunk_config)
    vector_path = settings.data_dir / "vectors.json"
    previous_file = vector_path.read_text("utf-8")
    previous_vectors = vector_by_chunk_id(store)

    def failing_replace(_source, _target):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(os, "replace", failing_replace)
    with pytest.raises(OSError, match="simulated replace failure"):
        store.ingest(single_article_request("trial", "Trial", "trial changed"), chunk_config)

    assert vector_path.read_text("utf-8") == previous_file
    assert list(settings.data_dir.glob("*.tmp")) == []
    assert np.allclose(vector_by_chunk_id(store)["trial:chunk-0"], previous_vectors["trial:chunk-0"])


def test_concurrent_ingestion_preserves_all_completed_documents(tmp_path):
    settings, _embeddings, store = build_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)

    def ingest_article(index: int):
        return store.ingest(
            single_article_request(f"doc-{index}", f"Doc {index}", f"content token {index}"),
            chunk_config,
        )

    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(ingest_article, range(12)))

    assert sum(result[1] for result in results) == 12
    assert len(store.chunks) == len(store.vectors) == 12
    assert {chunk.document_id for chunk in store.chunks} == {f"doc-{index}" for index in range(12)}


def test_retrieval_snapshot_observes_consistent_old_state_during_ingestion(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        chunk_size=220,
        chunk_overlap=20,
        insufficient_score_threshold=0.001,
    )
    embeddings = BlockingTokenHashEmbeddingProvider()
    store = JsonVectorStore(workspace_tmp / "vectors.json", embeddings)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "old trial content"), chunk_config)

    embeddings.block = True
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            store.ingest,
            single_article_request("trial", "Trial", "new trial content"),
            chunk_config,
        )
        assert embeddings.started.wait(timeout=5)
        chunks, vectors = store.snapshot()
        assert len(chunks) == len(vectors) == 1
        assert "old trial content" in chunks[0].text
        embeddings.release.set()
        future.result(timeout=5)

    chunks, vectors = store.snapshot()
    assert len(chunks) == len(vectors) == 1
    assert "new trial content" in chunks[0].text


def test_sqlite_initializes_schema_and_persists_across_reinitialization(tmp_path):
    settings, embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "trial lasts fourteen days"), chunk_config)

    reloaded = SQLiteVectorStore(settings.sqlite_vector_path, embeddings)
    chunks, vectors = reloaded.snapshot()

    assert settings.sqlite_vector_path.exists()
    assert len(chunks) == len(vectors) == 1
    assert chunks[0].document_id == "trial"


def test_sqlite_storage_supports_bm25_semantic_and_hybrid_retrieval(tmp_path):
    settings, embeddings, store = build_sqlite_store(tmp_path)
    ingest_fixture(store, settings)
    chunks, vectors = store.snapshot()

    bm25 = BM25Retriever().search("trial card", chunks, top_k=3)
    semantic = VectorRetriever(embeddings).search("trial card", chunks, vectors, top_k=3)
    hybrid = reciprocal_rank_fusion(bm25, semantic, top_k=3)

    assert bm25[0].document_id == "trial"
    assert semantic[0].document_id == "trial"
    assert hybrid[0].document_id == "trial"
    assert hybrid[0].chunk_id.startswith("trial:chunk-")


def test_sqlite_updated_document_replaces_only_its_chunks_and_vectors(tmp_path):
    settings, _embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    for article_id, content in [
        ("alpha", "alpha setup guide"),
        ("bravo", "bravo billing guide"),
        ("charlie", "charlie export guide"),
    ]:
        store.ingest(single_article_request(article_id, article_id.title(), content), chunk_config)
    before = vector_by_chunk_id(store)

    store.ingest(
        single_article_request("bravo", "Bravo", "bravo updated payment workflow"),
        chunk_config,
    )

    after = vector_by_chunk_id(store)
    chunks, vectors = store.snapshot()
    assert len(chunks) == len(vectors) == 3
    assert np.allclose(after["alpha:chunk-0"], before["alpha:chunk-0"])
    assert np.allclose(after["charlie:chunk-0"], before["charlie:chunk-0"])
    assert not np.allclose(after["bravo:chunk-0"], before["bravo:chunk-0"])


def test_sqlite_unchanged_ingestion_is_idempotent(tmp_path):
    settings, _embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    request = single_article_request("trial", "Trial", "trial lasts fourteen days")

    store.ingest(request, chunk_config)
    before = vector_by_chunk_id(store)
    _documents, chunks, duplicates, unchanged = store.ingest(request, chunk_config)

    assert chunks == 0
    assert duplicates == 0
    assert unchanged == 1
    assert len(store.snapshot()[0]) == 1
    assert np.allclose(vector_by_chunk_id(store)["trial:chunk-0"], before["trial:chunk-0"])


def test_sqlite_identical_documents_keep_separate_ownership_and_citations(tmp_path):
    settings, _embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(
        IngestRequest(
            documents=[
                {"id": "doc-a", "title": "Doc A", "content": "shared billing answer"},
                {"id": "doc-b", "title": "Doc B", "content": "shared billing answer"},
            ],
        ),
        chunk_config,
    )

    chunks, vectors = store.snapshot()
    assert len(chunks) == len(vectors) == 2
    assert {chunk.document_id for chunk in chunks} == {"doc-a", "doc-b"}
    assert {chunk.id for chunk in chunks} == {"doc-a:chunk-0", "doc-b:chunk-0"}


def test_sqlite_empty_document_replaces_previous_chunks(tmp_path):
    settings, _embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("empty", "Empty", "content to remove"), chunk_config)

    store.ingest(
        IngestRequest(documents=[{"id": "empty", "title": "Empty", "content": " "}]),
        chunk_config,
    )

    chunks, vectors = store.snapshot()
    assert len(chunks) == len(vectors) == 0


def test_sqlite_delete_document_removes_chunks_embeddings_and_retrieval(tmp_path):
    settings, embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    ingest_fixture(store, settings)

    deleted, chunks_deleted = store.delete_document("trial")

    assert deleted is True
    assert chunks_deleted == 1
    chunks, vectors = store.snapshot()
    assert len(chunks) == len(vectors) == 1
    assert {chunk.document_id for chunk in chunks} == {"widget"}
    assert BM25Retriever().search("trial card", chunks, top_k=3) == []
    semantic_results = VectorRetriever(embeddings).search("trial card", chunks, vectors, top_k=3)
    assert {result.document_id for result in semantic_results}.isdisjoint({"trial"})


def test_sqlite_repeated_and_unknown_delete_are_predictable(tmp_path):
    settings, _embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "trial content"), chunk_config)

    assert store.delete_document("trial") == (True, 1)
    assert store.delete_document("trial") == (False, 0)
    assert store.delete_document("missing") == (False, 0)


def test_sqlite_delete_preserves_identical_document_ownership(tmp_path):
    settings, _embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(
        IngestRequest(
            documents=[
                {"id": "doc-a", "title": "Doc A", "content": "same text"},
                {"id": "doc-b", "title": "Doc B", "content": "same text"},
            ],
        ),
        chunk_config,
    )

    assert store.delete_document("doc-a") == (True, 1)
    chunks, vectors = store.snapshot()
    assert len(chunks) == len(vectors) == 1
    assert chunks[0].document_id == "doc-b"
    assert chunks[0].id == "doc-b:chunk-0"


def test_sqlite_documents_persist_after_restart_and_list_metadata(tmp_path):
    settings, embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(
        IngestRequest(
            documents=[
                {
                    "id": "guide",
                    "title": "Guide",
                    "content": "markdown setup notes",
                    "source_type": "markdown",
                    "metadata": {"filename": "guide.md"},
                },
            ],
        ),
        chunk_config,
    )

    reloaded = SQLiteVectorStore(settings.sqlite_vector_path, embeddings)
    documents = reloaded.list_documents()

    assert len(documents) == 1
    assert documents[0].id == "guide"
    assert documents[0].source_type == "markdown"
    assert documents[0].created_at
    assert documents[0].updated_at
    assert documents[0].metadata["filename"] == "guide.md"


def test_sqlite_diagnostics_report_counts_integrity_and_dimensions(tmp_path):
    settings, _embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "trial content"), chunk_config)

    diagnostics = store.diagnostics()

    assert diagnostics.backend == "sqlite"
    assert diagnostics.status == "healthy"
    assert diagnostics.readable is True
    assert diagnostics.writable is True
    assert diagnostics.integrity_check == "ok"
    assert diagnostics.document_count == 1
    assert diagnostics.chunk_count == 1
    assert diagnostics.embedding_count == 1
    assert diagnostics.dimension_consistent is True
    assert diagnostics.documents[0]["status"] == "Indexed"


def test_json_diagnostics_report_healthy_store_and_unsupported_sqlite_check(tmp_path):
    settings, _embeddings, store = build_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "trial content"), chunk_config)

    diagnostics = store.diagnostics()

    assert diagnostics.backend == "json"
    assert diagnostics.status == "healthy"
    assert diagnostics.document_count == 1
    assert diagnostics.chunk_count == 1
    assert diagnostics.embedding_count == 1
    assert diagnostics.integrity_check == "unavailable"
    assert "sqlite_integrity_check" in diagnostics.unsupported_checks


def test_diagnostics_detect_sqlite_vector_dimension_inconsistency(tmp_path):
    settings, _embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "trial content"), chunk_config)

    import sqlite3

    with sqlite3.connect(settings.sqlite_vector_path) as connection:
        connection.execute("UPDATE embeddings SET dimension = dimension + 1")

    diagnostics = store.diagnostics()

    assert diagnostics.status == "needs_attention"
    assert diagnostics.dimension_consistent is False
    assert diagnostics.last_error == "Chunk/vector count or dimension mismatch"


def test_failed_ingestion_is_exposed_in_diagnostics_without_replacing_content(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        sqlite_vector_path=workspace_tmp / "vectors.sqlite3",
        vector_storage_backend="sqlite",
        chunk_size=220,
        chunk_overlap=20,
        insufficient_score_threshold=0.001,
    )
    store = SQLiteVectorStore(settings.sqlite_vector_path, FailingEmbeddingProvider())
    app = create_app(settings, FailingEmbeddingProvider(), store)
    endpoints = {route.path: route.endpoint for route in app.routes if hasattr(route, "path")}

    endpoints["/ingest"](single_article_request("trial", "Trial", "old trial content"))
    with pytest.raises(HTTPException):
        endpoints["/ingest"](single_article_request("trial", "Trial", "explode new content"))

    chunks, _vectors = store.snapshot()
    diagnostics = endpoints["/diagnostics"]()

    assert "old trial content" in chunks[0].text
    failed = [document for document in diagnostics.documents if document["id"] == "trial"]
    assert failed
    assert failed[0]["status"] == "Needs attention"
    assert failed[0]["indexed"] is True
    assert failed[0]["retryable"] is True
    assert "embedding failure" in failed[0]["last_error"]


def test_sqlite_failed_embedding_update_preserves_previous_content(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        sqlite_vector_path=workspace_tmp / "vectors.sqlite3",
        vector_storage_backend="sqlite",
        chunk_size=220,
        chunk_overlap=20,
        insufficient_score_threshold=0.001,
    )
    store = SQLiteVectorStore(settings.sqlite_vector_path, FailingEmbeddingProvider())
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "old trial content"), chunk_config)

    with pytest.raises(RuntimeError, match="embedding failure"):
        store.ingest(single_article_request("trial", "Trial", "explode new content"), chunk_config)

    chunks, vectors = store.snapshot()
    assert len(chunks) == len(vectors) == 1
    assert "old trial content" in chunks[0].text


def test_ai_document_api_lists_and_deletes_documents(tmp_path):
    settings, embeddings, store = build_sqlite_store(tmp_path)
    app = create_app(settings, embeddings, store)
    endpoints = {route.path: route.endpoint for route in app.routes if hasattr(route, "path")}

    ingest_response = endpoints["/ingest"](
        IngestRequest(
            articles=[
                {
                    "id": "trial",
                    "title": "Trial",
                    "tags": ["trial"],
                    "content": "trial content",
                },
            ],
        ),
    )
    assert ingest_response.document_statuses[0]["status"] == "created"

    documents = endpoints["/documents"]()
    assert documents[0].id == "trial"

    deleted = endpoints["/documents/{document_id}"]("trial")
    assert deleted.chunks_deleted == 1

    with pytest.raises(HTTPException) as missing:
        endpoints["/documents/{document_id}"]("trial")
    assert missing.value.status_code == 404


def test_sqlite_foreign_keys_are_enforced(tmp_path):
    settings, _embeddings, _store = build_sqlite_store(tmp_path)
    import sqlite3

    with sqlite3.connect(settings.sqlite_vector_path) as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO chunks(id, document_id, position, text, hash, metadata_json, created_at)
                VALUES ('orphan', 'missing', 0, 'text', 'hash', '{}', 'now')
                """,
            )


def test_sqlite_invalid_vector_dimension_is_rejected(tmp_path):
    _settings, embeddings, store = build_sqlite_store(tmp_path)

    with pytest.raises(RuntimeError, match="shape"):
        store._vector_to_blob(np.zeros((embeddings.dimension + 1,), dtype=np.float32))


def test_sqlite_failed_update_rolls_back_previous_document(tmp_path, monkeypatch):
    settings, _embeddings, store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "old trial content"), chunk_config)
    before = store.snapshot()

    original_replace = store._replace_document

    def failing_replace(*args, **kwargs):
        original_replace(*args, **kwargs)
        raise RuntimeError("simulated sqlite commit failure")

    monkeypatch.setattr(store, "_replace_document", failing_replace)
    with pytest.raises(RuntimeError, match="simulated sqlite commit failure"):
        store.ingest(single_article_request("trial", "Trial", "new trial content"), chunk_config)

    after = store.snapshot()
    assert [chunk.text for chunk in after[0]] == [chunk.text for chunk in before[0]]
    assert np.allclose(after[1], before[1])


def test_sqlite_concurrent_ingestion_and_snapshot_consistency(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        sqlite_vector_path=workspace_tmp / "vectors.sqlite3",
        vector_storage_backend="sqlite",
        chunk_size=220,
        chunk_overlap=20,
        insufficient_score_threshold=0.001,
    )
    embeddings = BlockingTokenHashEmbeddingProvider()
    store = SQLiteVectorStore(settings.sqlite_vector_path, embeddings)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    store.ingest(single_article_request("trial", "Trial", "old trial content"), chunk_config)

    embeddings.block = True
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            store.ingest,
            single_article_request("trial", "Trial", "new trial content"),
            chunk_config,
        )
        assert embeddings.started.wait(timeout=5)
        chunks, vectors = store.snapshot()
        assert len(chunks) == len(vectors) == 1
        assert "old trial content" in chunks[0].text
        embeddings.release.set()
        future.result(timeout=5)

    chunks, vectors = store.snapshot()
    assert len(chunks) == len(vectors) == 1
    assert "new trial content" in chunks[0].text


def test_build_vector_store_uses_sqlite_backend_by_default(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        vector_storage_backend="auto",
        chunk_size=220,
        chunk_overlap=20,
    )
    store = build_vector_store(settings, TokenHashEmbeddingProvider())

    assert isinstance(store, SQLiteVectorStore)
    assert (workspace_tmp / "askwell-vectors.sqlite3").exists()


def test_build_vector_store_preserves_explicit_json_backend(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        vector_storage_backend="json",
        chunk_size=220,
        chunk_overlap=20,
    )
    store = build_vector_store(settings, TokenHashEmbeddingProvider())

    assert isinstance(store, JsonVectorStore)


def test_sqlite_migrates_compatible_json_and_preserves_source_file(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    embeddings = TokenHashEmbeddingProvider()
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        vector_storage_backend="auto",
        chunk_size=220,
        chunk_overlap=20,
    )
    json_store = JsonVectorStore(workspace_tmp / "vectors.json", embeddings)
    json_store.ingest(
        IngestRequest(
            documents=[
                {
                    "id": "trial",
                    "title": "Trial",
                    "content": "trial lasts fourteen days",
                    "metadata": {"tier": "free"},
                },
            ],
        ),
        ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
    )
    original_json = (workspace_tmp / "vectors.json").read_text("utf-8")

    migrated = build_vector_store(settings, embeddings)
    chunks, vectors = migrated.snapshot()
    report = json.loads((workspace_tmp / "sqlite-migration-report.json").read_text("utf-8"))

    assert isinstance(migrated, SQLiteVectorStore)
    assert (workspace_tmp / "vectors.json").read_text("utf-8") == original_json
    assert len(chunks) == len(vectors) == 1
    assert chunks[0].id == "trial:chunk-0"
    assert chunks[0].metadata["tier"] == "free"
    assert report["document_count"] == 1
    assert report["chunk_count"] == 1
    assert report["embedding_count"] == 1
    assert report["status"] == "success"


def test_sqlite_migration_rejects_corrupted_json(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    (workspace_tmp / "vectors.json").write_text("{broken json", "utf-8")
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        vector_storage_backend="auto",
    )

    with pytest.raises(RuntimeError, match="Vector storage is corrupted"):
        build_vector_store(settings, TokenHashEmbeddingProvider())

    assert (workspace_tmp / "vectors.json").exists()


def test_sqlite_migration_rejects_chunk_vector_mismatch(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    embeddings = TokenHashEmbeddingProvider()
    payload = valid_storage_payload(embeddings)
    payload["vectors"] = []
    (workspace_tmp / "vectors.json").write_text(json.dumps(payload), "utf-8")
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        vector_storage_backend="auto",
    )

    with pytest.raises(RuntimeError, match="two-dimensional matrix"):
        build_vector_store(settings, embeddings)


def test_sqlite_migration_rejects_embedding_model_mismatch(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    payload = valid_storage_payload(NamedTokenHashEmbeddingProvider("model-a"))
    (workspace_tmp / "vectors.json").write_text(json.dumps(payload), "utf-8")
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        vector_storage_backend="auto",
    )

    with pytest.raises(RuntimeError, match="does not match configured model"):
        build_vector_store(settings, NamedTokenHashEmbeddingProvider("model-b"))


def test_sqlite_migration_refuses_populated_database(tmp_path):
    settings, embeddings, sqlite_store = build_sqlite_store(tmp_path)
    chunk_config = ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap)
    sqlite_store.ingest(single_article_request("existing", "Existing", "existing content"), chunk_config)
    json_store = JsonVectorStore(settings.data_dir / "vectors.json", embeddings)
    json_store.ingest(single_article_request("trial", "Trial", "trial content"), chunk_config)

    with pytest.raises(RuntimeError, match="already populated"):
        sqlite_store.migrate_from_json(
            json_store,
            settings.data_dir / "vectors.json",
            settings.data_dir / "sqlite-migration-report.json",
            chunk_config,
        )

    assert {chunk.document_id for chunk in sqlite_store.snapshot()[0]} == {"existing"}


def test_sqlite_migration_is_idempotent_when_database_exists(tmp_path):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    embeddings = TokenHashEmbeddingProvider()
    settings = Settings(
        embedding_model="test-token-hash",
        data_dir=workspace_tmp,
        vector_storage_backend="auto",
        chunk_size=220,
        chunk_overlap=20,
    )
    json_store = JsonVectorStore(workspace_tmp / "vectors.json", embeddings)
    json_store.ingest(single_article_request("trial", "Trial", "trial content"), ChunkConfig(220, 20))

    first = build_vector_store(settings, embeddings)
    first_snapshot = first.snapshot()
    second = build_vector_store(settings, embeddings)
    second_snapshot = second.snapshot()

    assert isinstance(second, SQLiteVectorStore)
    assert [chunk.id for chunk in first_snapshot[0]] == [chunk.id for chunk in second_snapshot[0]]
    assert np.allclose(first_snapshot[1], second_snapshot[1])


def test_sqlite_migration_failure_rolls_back_and_preserves_json(tmp_path, monkeypatch):
    workspace_tmp = Path.cwd() / ".tmp-ai-tests" / f"{tmp_path.name}-{uuid.uuid4().hex}"
    workspace_tmp.mkdir(parents=True)
    embeddings = TokenHashEmbeddingProvider()
    chunk_config = ChunkConfig(220, 20)
    json_store = JsonVectorStore(workspace_tmp / "vectors.json", embeddings)
    json_store.ingest(single_article_request("trial", "Trial", "trial content"), chunk_config)
    original_json = (workspace_tmp / "vectors.json").read_text("utf-8")
    sqlite_store = SQLiteVectorStore(workspace_tmp / "vectors.sqlite3", embeddings)

    def failing_blob(_vector):
        raise RuntimeError("simulated migration failure")

    monkeypatch.setattr(sqlite_store, "_vector_to_blob", failing_blob)
    with pytest.raises(RuntimeError, match="simulated migration failure"):
        sqlite_store.migrate_from_json(
            json_store,
            workspace_tmp / "vectors.json",
            workspace_tmp / "sqlite-migration-report.json",
            chunk_config,
        )

    assert (workspace_tmp / "vectors.json").read_text("utf-8") == original_json
    assert sqlite_store.snapshot()[0] == []


def test_missing_sentence_transformers_dependency_reports_configuration_error(monkeypatch):
    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        if name == "sentence_transformers":
            raise ImportError("blocked for test")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)

    with pytest.raises(RuntimeError, match="sentence-transformers is not installed"):
        SentenceTransformerEmbeddingProvider("sentence-transformers/all-MiniLM-L6-v2")


def test_model_loading_failure_is_not_silently_faked(monkeypatch):
    original_import = builtins.__import__

    class BrokenSentenceTransformer:
        def __init__(self, _model_name):
            raise RuntimeError("model load failed")

    class FakeSentenceTransformersModule:
        SentenceTransformer = BrokenSentenceTransformer

    def guarded_import(name, *args, **kwargs):
        if name == "sentence_transformers":
            return FakeSentenceTransformersModule
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guarded_import)

    with pytest.raises(RuntimeError, match="model load failed"):
        SentenceTransformerEmbeddingProvider("broken-model")


def test_evaluation_metrics_are_deterministic():
    expected = {"trial"}
    retrieved = ["widget", "trial", "billing"]

    assert recall_at_k(expected, retrieved, 2) == 1.0
    assert precision_at_k(expected, retrieved, 2) == 0.5
    assert hit_rate_at_k(expected, retrieved, 1) == 0.0
    assert reciprocal_rank(expected, retrieved) == 0.5
