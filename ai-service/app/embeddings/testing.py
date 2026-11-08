from __future__ import annotations

import hashlib
import re

import numpy as np

from app.embeddings.base import EmbeddingProvider, normalize_vectors


class TokenHashEmbeddingProvider(EmbeddingProvider):
    """Deterministic lexical embedding provider used only by tests."""

    def __init__(self, dimension: int = 64):
        self._dimension = dimension

    @property
    def dimension(self) -> int:
        return self._dimension

    def embed(self, texts: list[str]) -> np.ndarray:
        vectors = np.zeros((len(texts), self._dimension), dtype=np.float32)
        for row, text in enumerate(texts):
            for token in re.findall(r"[a-z0-9]+", text.lower()):
                digest = hashlib.sha256(token.encode("utf-8")).digest()
                index = int.from_bytes(digest[:4], "big") % self._dimension
                vectors[row, index] += 1.0
        return normalize_vectors(vectors)
