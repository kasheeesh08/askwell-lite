from __future__ import annotations

import os
import shutil
import uuid
from pathlib import Path

import pytest

os.environ.setdefault("ASKWELL_SKIP_AUTO_MODEL", "1")

from app.config import Settings
from app.embeddings.testing import TokenHashEmbeddingProvider
from app.generation.base import (
    ProviderConfigurationError,
    ProviderRateLimitError,
    ProviderResponseError,
    ProviderTimeoutError,
)
from app.generation.openai_compatible import OpenAICompatibleGenerator
from app.ingestion.processing import ChunkConfig
from app.main import create_app
from app.models.schemas import IngestRequest, RetrievedChunk
from app.retrieval.store import JsonVectorStore


def workspace_tmp(name: str) -> Path:
    path = Path.cwd() / ".tmp-ai-tests" / f"{name}-{uuid.uuid4().hex}"
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True)
    return path


def chunks() -> list[RetrievedChunk]:
    return [
        RetrievedChunk(
            chunk_id="trial:chunk-0",
            document_id="trial",
            document_title="Start a free trial",
            text="Trials last 14 days and do not require a card.",
            score=0.9,
            strategy="hybrid",
            metadata={"article_id": "trial"},
        ),
        RetrievedChunk(
            chunk_id="billing:chunk-0",
            document_id="billing",
            document_title="Billing policy",
            text="Billing settings include cancellation and downgrade controls.",
            score=0.8,
            strategy="hybrid",
            metadata={"article_id": "billing"},
        ),
    ]


def generator_for(http_post):
    return OpenAICompatibleGenerator(
        api_key="test-key",
        model="test-model",
        base_url="https://llm.example/v1",
        timeout_seconds=1,
        retries=1,
        max_output_tokens=200,
        http_post=http_post,
    )


def provider_body(content: str, usage: dict | None = None):
    return {
        "choices": [{"message": {"content": content}}],
        "usage": usage or {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18},
    }


def test_openai_compatible_generation_validates_multiple_citations():
    seen = {}

    def post(url, payload, headers, timeout):
        seen["url"] = url
        seen["payload"] = payload
        seen["headers"] = headers
        seen["timeout"] = timeout
        return 200, provider_body(
            '{"answer":"Trials last 14 days. Billing can be managed in settings.","citations":["trial:chunk-0","billing:chunk-0"],"insufficient_context":false}',
        )

    result = generator_for(post).generate("How does trial and billing work?", chunks())

    assert result.answer.startswith("Trials last 14 days")
    assert [citation.chunk_id for citation in result.citations] == ["trial:chunk-0", "billing:chunk-0"]
    assert result.provider == "openai-compatible"
    assert result.model == "test-model"
    assert result.token_usage.total_tokens == 18
    assert seen["headers"]["authorization"] == "Bearer test-key"
    assert seen["payload"]["max_tokens"] == 200


def test_generation_rejects_fabricated_citations():
    def post(_url, _payload, _headers, _timeout):
        return 200, provider_body(
            '{"answer":"Made up.","citations":["missing:chunk-9"],"insufficient_context":false}',
        )

    with pytest.raises(ProviderResponseError, match="fabricated citation"):
        generator_for(post).generate("Question", chunks())


def test_generation_rejects_malformed_provider_response():
    def post(_url, _payload, _headers, _timeout):
        return 200, provider_body("not json")

    with pytest.raises(ProviderResponseError, match="malformed JSON"):
        generator_for(post).generate("Question", chunks())


def test_generation_handles_rate_limits_and_retries():
    calls = 0

    def post(_url, _payload, _headers, _timeout):
        nonlocal calls
        calls += 1
        return 429, {"error": "rate limit"}

    with pytest.raises(ProviderRateLimitError):
        generator_for(post).generate("Question", chunks())
    assert calls == 2


def test_generation_handles_timeout():
    def post(_url, _payload, _headers, _timeout):
        raise TimeoutError("too slow")

    with pytest.raises(ProviderTimeoutError):
        generator_for(post).generate("Question", chunks())


def test_invalid_api_credentials_are_structured_configuration_errors():
    def post(_url, _payload, _headers, _timeout):
        return 401, {"error": "bad key"}

    with pytest.raises(ProviderConfigurationError, match="credentials"):
        generator_for(post).generate("Question", chunks())


def test_answer_endpoint_skips_llm_when_evidence_is_insufficient(tmp_path):
    embeddings = TokenHashEmbeddingProvider()
    data_dir = workspace_tmp(tmp_path.name)
    settings = Settings(
        embedding_model="test",
        llm_provider="openai-compatible",
        llm_api_key="test-key",
        llm_model="test-model",
        data_dir=data_dir,
        bm25_score_threshold=10,
        semantic_score_threshold=10,
        hybrid_score_threshold=10,
    )
    store = JsonVectorStore(data_dir / "vectors.json", embeddings)
    store.ingest(
        IngestRequest(
            articles=[
                {
                    "id": "trial",
                    "title": "Trial",
                    "tags": ["trial"],
                    "content": "Trials last 14 days.",
                }
            ],
        ),
        ChunkConfig(size=200, overlap=20),
    )
    app = create_app(settings, embeddings, store)
    route = next(route for route in app.routes if route.path == "/answer")
    response = route.endpoint(type("Request", (), {"question": "enterprise sso", "top_k": 3})())

    assert response.insufficient_context is True
    assert response.fallback_reason == "insufficient_retrieval_evidence"


def test_answer_endpoint_returns_generation_metadata(tmp_path, monkeypatch):
    embeddings = TokenHashEmbeddingProvider()
    data_dir = workspace_tmp(tmp_path.name)
    settings = Settings(
        embedding_model="test",
        llm_provider="openai-compatible",
        llm_api_key="test-key",
        llm_model="test-model",
        data_dir=data_dir,
        bm25_score_threshold=0.01,
        semantic_score_threshold=0.01,
        hybrid_score_threshold=0.001,
    )
    store = JsonVectorStore(data_dir / "vectors.json", embeddings)
    store.ingest(
        IngestRequest(
            articles=[
                {
                    "id": "trial",
                    "title": "Trial",
                    "tags": ["trial"],
                    "content": "Trials last 14 days.",
                }
            ],
        ),
        ChunkConfig(size=200, overlap=20),
    )

    def fake_build_generator(_settings):
        return generator_for(
            lambda _url, _payload, _headers, _timeout: (
                200,
                provider_body(
                    '{"answer":"Trials last 14 days.","citations":["trial:chunk-0"],"insufficient_context":false}',
                ),
            ),
        )

    import app.main as main_module

    monkeypatch.setattr(main_module, "build_generator", fake_build_generator)
    app = create_app(settings, embeddings, store)
    route = next(route for route in app.routes if route.path == "/answer")
    response = route.endpoint(type("Request", (), {"question": "trial", "top_k": 3})())

    assert response.insufficient_context is False
    assert response.generation.provider == "openai-compatible"
    assert response.generation.model == "test-model"
    assert response.generation.token_usage.total_tokens == 18
    assert response.source_chunk_ids == ["trial:chunk-0"]
