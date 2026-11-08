from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class ArticleInput(BaseModel):
    id: str
    title: str
    content: str
    tags: list[str] = Field(default_factory=list)


class DocumentInput(BaseModel):
    id: str
    title: str
    content: str
    source_type: str = "text"
    metadata: dict[str, Any] = Field(default_factory=dict)


class EncodedDocumentInput(BaseModel):
    id: str
    title: str
    filename: str
    content_base64: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class IngestRequest(BaseModel):
    articles: list[ArticleInput] = Field(default_factory=list)
    documents: list[DocumentInput] = Field(default_factory=list)
    encoded_documents: list[EncodedDocumentInput] = Field(default_factory=list)


class Chunk(BaseModel):
    id: str
    document_id: str
    document_title: str
    text: str
    hash: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class IngestResponse(BaseModel):
    ingested_documents: int
    chunks_indexed: int
    duplicates_skipped: int
    unchanged_skipped: int
    status: str
    document_statuses: list[dict[str, Any]] = Field(default_factory=list)


class DocumentInfo(BaseModel):
    id: str
    title: str
    source_type: str
    content_hash: str
    chunk_count: int
    created_at: str | None = None
    updated_at: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class DeleteDocumentResponse(BaseModel):
    document_id: str
    deleted: bool
    chunks_deleted: int
    status: str


class StorageDiagnostics(BaseModel):
    backend: str
    status: str
    readable: bool
    writable: bool
    integrity_check: str
    document_count: int
    chunk_count: int
    embedding_count: int
    vector_dimension: int
    dimension_consistent: bool
    manifest_compatible: bool
    last_error: str | None = None
    documents: list[dict[str, Any]] = Field(default_factory=list)
    unsupported_checks: list[str] = Field(default_factory=list)


class RetrievedChunk(BaseModel):
    chunk_id: str
    document_id: str
    document_title: str
    text: str
    score: float
    strategy: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class AnswerRequest(BaseModel):
    question: str = Field(min_length=1, max_length=800)
    top_k: int = Field(default=5, ge=1, le=12)


class Citation(BaseModel):
    document_id: str
    chunk_id: str
    title: str


class TokenUsage(BaseModel):
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None


class GenerationMetadata(BaseModel):
    provider: str
    model: str
    latency_ms: float
    token_usage: TokenUsage | None = None
    citation_coverage: float | None = None


class AnswerResponse(BaseModel):
    answer: str
    citations: list[Citation] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    source_document_ids: list[str] = Field(default_factory=list)
    source_chunk_ids: list[str] = Field(default_factory=list)
    chunks: list[RetrievedChunk] = Field(default_factory=list)
    insufficient_context: bool = False
    mode: str
    retrieval_strategy: str = "hybrid"
    fallback_reason: str | None = None
    generation: GenerationMetadata | None = None


class HealthResponse(BaseModel):
    ok: bool
    service: str = "askwell-ai"
    embedding_model: str
    llm_provider: str
    chunks: int
