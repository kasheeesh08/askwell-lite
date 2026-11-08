from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from app.models.schemas import Citation, RetrievedChunk, TokenUsage


class GenerationError(RuntimeError):
    status_code = 503


class ProviderConfigurationError(GenerationError):
    status_code = 503


class ProviderTimeoutError(GenerationError):
    status_code = 504


class ProviderRateLimitError(GenerationError):
    status_code = 429


class ProviderResponseError(GenerationError):
    status_code = 502


@dataclass(frozen=True)
class GenerationResult:
    answer: str
    citations: list[Citation]
    provider: str
    model: str
    latency_ms: float
    token_usage: TokenUsage | None = None
    raw_response: dict | None = None


class AnswerGenerator(ABC):
    mode: str

    @abstractmethod
    def generate(self, question: str, chunks: list[RetrievedChunk]) -> GenerationResult:
        raise NotImplementedError
