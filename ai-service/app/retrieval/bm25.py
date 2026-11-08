from __future__ import annotations

import math
import re
from collections import Counter

from app.models.schemas import Chunk, RetrievedChunk


STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "do",
    "does",
    "how",
    "is",
    "of",
    "or",
    "the",
    "to",
}


def tokenize(value: str) -> list[str]:
    return [
        token
        for token in re.findall(r"[a-z0-9]+", value.lower())
        if token not in STOPWORDS and len(token) > 1
    ]


class BM25Retriever:
    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b

    def search(self, question: str, chunks: list[Chunk], top_k: int) -> list[RetrievedChunk]:
        query = tokenize(question)
        if not query or not chunks:
            return []

        documents = [tokenize(chunk.text) for chunk in chunks]
        average_length = sum(len(document) for document in documents) / max(len(documents), 1)
        document_frequency = Counter(
            token for document in documents for token in set(document)
        )

        scored = []
        for chunk, document in zip(chunks, documents):
            counts = Counter(document)
            score = 0.0
            for token in query:
                if token not in counts:
                    continue
                idf = math.log(1 + (len(chunks) - document_frequency[token] + 0.5) / (document_frequency[token] + 0.5))
                numerator = counts[token] * (self.k1 + 1)
                denominator = counts[token] + self.k1 * (1 - self.b + self.b * len(document) / max(average_length, 1))
                score += idf * (numerator / denominator)
            if score > 0:
                scored.append((score, chunk))

        return [
            RetrievedChunk(
                chunk_id=chunk.id,
                document_id=chunk.document_id,
                document_title=chunk.document_title,
                text=chunk.text,
                score=float(score),
                strategy="bm25",
                metadata=chunk.metadata,
            )
            for score, chunk in sorted(scored, key=lambda item: item[0], reverse=True)[:top_k]
        ]
