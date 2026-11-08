from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from app.config import Settings, get_settings
from app.embeddings.sentence_transformers import SentenceTransformerEmbeddingProvider
from app.generation.base import GenerationError
from app.generation.providers import build_generator
from app.ingestion.processing import ChunkConfig, UnsupportedDocumentError
from app.models.schemas import AnswerRequest, AnswerResponse, DeleteDocumentResponse, DocumentInfo, GenerationMetadata, HealthResponse, IngestRequest, IngestResponse, StorageDiagnostics
from app.retrieval.bm25 import BM25Retriever
from app.retrieval.hybrid import reciprocal_rank_fusion
from app.retrieval.evidence import assess_evidence, select_generation_context
from app.retrieval.rerank import NoopReranker
from app.retrieval.store import VectorStore, build_vector_store, failed_document_statuses, safe_diagnostic_error
from app.retrieval.vector import VectorRetriever


def create_app(
    settings: Settings | None = None,
    embedding_provider=None,
    vector_store: VectorStore | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    if settings.require_api_token and not settings.api_token:
        raise RuntimeError("ASKWELL_AI_SERVICE_TOKEN is required when ASKWELL_AI_REQUIRE_TOKEN=1")
    embeddings = embedding_provider or SentenceTransformerEmbeddingProvider(settings.embedding_model)
    store = vector_store or build_vector_store(settings, embeddings)
    bm25 = BM25Retriever()
    vector = VectorRetriever(embeddings)
    reranker = NoopReranker()
    app = FastAPI(title="AskWell AI Service", version="0.1.0")

    @app.middleware("http")
    async def require_service_token(request: Request, call_next):
        if request.url.path == "/health" or not settings.require_api_token:
            return await call_next(request)
        if request.headers.get("x-askwell-ai-token") != settings.api_token:
            return JSONResponse(
                status_code=401,
                content={"detail": "Missing or invalid AI service token"},
            )
        return await call_next(request)

    @app.get("/health", response_model=HealthResponse)
    def health():
        return HealthResponse(
            ok=True,
            embedding_model=settings.embedding_model,
            llm_provider=settings.llm_provider,
            chunks=store.chunk_count(),
        )

    @app.get("/config")
    def config():
        return {
            "embedding_model": settings.embedding_model,
            "llm_provider": settings.llm_provider,
            "vector_storage_backend": settings.vector_storage_backend,
            "api_token_required": settings.require_api_token,
            "api_token_configured": bool(settings.api_token),
            "data_dir_configured": bool(settings.data_dir),
        }

    @app.post("/ingest", response_model=IngestResponse)
    def ingest(request: IngestRequest):
        if not request.articles and not request.documents and not request.encoded_documents:
            raise HTTPException(status_code=400, detail="No documents provided")
        try:
            documents, chunks, duplicates, unchanged = store.ingest(
                request,
                ChunkConfig(size=settings.chunk_size, overlap=settings.chunk_overlap),
            )
        except (ValueError, UnsupportedDocumentError) as error:
            store.last_document_statuses = failed_document_statuses(request, error)
            raise HTTPException(status_code=400, detail=safe_diagnostic_error(error)) from error
        except RuntimeError as error:
            store.last_document_statuses = failed_document_statuses(request, error)
            raise HTTPException(status_code=500, detail=safe_diagnostic_error(error)) from error
        return IngestResponse(
            ingested_documents=documents,
            chunks_indexed=chunks,
            duplicates_skipped=duplicates,
            unchanged_skipped=unchanged,
            document_statuses=getattr(store, "last_document_statuses", []),
            status="ok",
        )

    @app.get("/documents", response_model=list[DocumentInfo])
    def documents():
        return store.list_documents()

    @app.get("/diagnostics", response_model=StorageDiagnostics)
    def diagnostics():
        try:
            return store.diagnostics()
        except Exception as error:
            raise HTTPException(status_code=500, detail=safe_diagnostic_error(error)) from error

    @app.delete("/documents/{document_id}", response_model=DeleteDocumentResponse)
    def delete_document(document_id: str):
        deleted, chunks_deleted = store.delete_document(document_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Document not found")
        return DeleteDocumentResponse(
            document_id=document_id,
            deleted=True,
            chunks_deleted=chunks_deleted,
            status="deleted",
        )

    @app.post("/answer", response_model=AnswerResponse)
    def answer(request: AnswerRequest):
        chunks, vectors = store.snapshot()
        keyword = bm25.search(request.question, chunks, request.top_k)
        semantic = vector.search(request.question, chunks, vectors, request.top_k)
        retrieved = reranker.rerank(
            request.question,
            reciprocal_rank_fusion(keyword, semantic, request.top_k),
        )
        evidence = assess_evidence(
            question=request.question,
            bm25=keyword,
            semantic=semantic,
            hybrid=retrieved,
            settings=settings,
        )

        if not retrieved or not evidence.sufficient:
            return AnswerResponse(
                answer="I do not have enough indexed context to answer that yet.",
                citations=[],
                sources=[],
                source_document_ids=[],
                source_chunk_ids=[],
                chunks=retrieved,
                insufficient_context=True,
                mode=settings.llm_provider,
                fallback_reason=evidence.reason or "no_retrieved_context",
            )

        try:
            generator = build_generator(settings)
            context = select_generation_context(
                question=request.question,
                bm25=keyword,
                semantic=semantic,
                hybrid=retrieved,
                settings=settings,
            )
            generated = generator.generate(request.question, context)
        except GenerationError as error:
            raise HTTPException(status_code=error.status_code, detail=str(error)) from error

        citation_coverage = len({citation.chunk_id for citation in generated.citations}) / max(len(context), 1)

        return AnswerResponse(
            answer=generated.answer,
            citations=generated.citations,
            sources=[citation.title for citation in generated.citations],
            source_document_ids=[citation.document_id for citation in generated.citations],
            source_chunk_ids=[citation.chunk_id for citation in generated.citations],
            chunks=context,
            insufficient_context=False,
            mode=generator.mode,
            retrieval_strategy="hybrid",
            generation=GenerationMetadata(
                provider=generated.provider,
                model=generated.model,
                latency_ms=round(generated.latency_ms, 2),
                token_usage=generated.token_usage,
                citation_coverage=round(citation_coverage, 4),
            ),
        )

    app.state.vector_store = store
    return app


try:
    if os.getenv("ASKWELL_SKIP_AUTO_MODEL") == "1":
        raise RuntimeError("Auto-loading the production embedding model is disabled.")
    app = create_app()
except RuntimeError as error:
    startup_error = str(error)
    app = FastAPI(title="AskWell AI Service", version="0.1.0")

    @app.get("/health")
    def unavailable_health():
        return {
            "ok": False,
            "service": "askwell-ai",
            "error": startup_error,
            "chunks": 0,
        }
