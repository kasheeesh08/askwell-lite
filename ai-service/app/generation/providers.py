from __future__ import annotations

from app.config import Settings
from app.generation.base import GenerationError
from app.generation.extractive import ExtractiveAnswerGenerator
from app.generation.openai_compatible import OpenAICompatibleGenerator


def build_generator(settings: Settings):
    if settings.llm_provider == "extractive":
        return ExtractiveAnswerGenerator()
    if settings.llm_provider in {"openai", "openai-compatible"}:
        return OpenAICompatibleGenerator(
            api_key=settings.llm_api_key,
            model=settings.llm_model,
            base_url=settings.llm_base_url,
            timeout_seconds=settings.llm_timeout_seconds,
            retries=settings.llm_retries,
            max_output_tokens=settings.llm_max_output_tokens,
        )
    raise GenerationError(
        f"LLM provider '{settings.llm_provider}' is not implemented.",
    )
