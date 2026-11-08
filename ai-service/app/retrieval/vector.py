from __future__ import annotations

import numpy as np

from app.embeddings.base import EmbeddingProvider
from app.models.schemas import Chunk, RetrievedChunk


class VectorRetriever:
    def __init__(self, embeddings: EmbeddingProvider):
        self.embeddings = embeddings

    def search(
        self,
        question: str,
        chunks: list[Chunk],
        vectors: np.ndarray,
        top_k: int,
    ) -> list[RetrievedChunk]:
        if not chunks or vectors.size == 0:
            return []

        query_vector = self.embeddings.embed([question])[0]
        similarities = vectors @ query_vector
        order = np.argsort(similarities)[::-1][:top_k]
        results = []
        for index in order:
            score = float(similarities[index])
            if score <= 0:
                continue
            chunk = chunks[int(index)]
            results.append(
                RetrievedChunk(
                    chunk_id=chunk.id,
                    document_id=chunk.document_id,
                    document_title=chunk.document_title,
                    text=chunk.text,
                    score=score,
                    strategy="semantic",
                    metadata=chunk.metadata,
                ),
            )
        return results
