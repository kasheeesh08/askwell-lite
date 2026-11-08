from __future__ import annotations

from app.models.schemas import RetrievedChunk


class NoopReranker:
    def rerank(self, question: str, chunks: list[RetrievedChunk]) -> list[RetrievedChunk]:
        return chunks
