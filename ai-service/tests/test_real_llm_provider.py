from __future__ import annotations

import os

import pytest

os.environ.setdefault("ASKWELL_SKIP_AUTO_MODEL", "1")

if os.getenv("ASKWELL_RUN_REAL_LLM_TESTS") != "1":
    pytest.skip("Set ASKWELL_RUN_REAL_LLM_TESTS=1 to run real LLM provider tests.", allow_module_level=True)

from app.generation.openai_compatible import OpenAICompatibleGenerator
from app.models.schemas import RetrievedChunk


def test_real_openai_compatible_provider_generates_grounded_citation():
    api_key = os.getenv("ASKWELL_LLM_API_KEY", "")
    assert api_key, "ASKWELL_LLM_API_KEY is required for real LLM tests"

    generator = OpenAICompatibleGenerator(
        api_key=api_key,
        model=os.getenv("ASKWELL_LLM_MODEL", "gpt-4o-mini"),
        base_url=os.getenv("ASKWELL_LLM_BASE_URL", "https://api.openai.com/v1"),
        timeout_seconds=float(os.getenv("ASKWELL_LLM_TIMEOUT_SECONDS", "20")),
        retries=int(os.getenv("ASKWELL_LLM_RETRIES", "1")),
        max_output_tokens=int(os.getenv("ASKWELL_LLM_MAX_OUTPUT_TOKENS", "120")),
    )
    chunks = [
        RetrievedChunk(
            chunk_id="trial:chunk-0",
            document_id="trial",
            document_title="Trial policy",
            text="AskWell trials last 14 days and do not require a card.",
            score=0.9,
            strategy="hybrid",
            metadata={},
        ),
    ]

    result = generator.generate("How long is the AskWell trial?", chunks)

    assert "14" in result.answer
    assert result.citations[0].chunk_id == "trial:chunk-0"
    assert result.provider == "openai-compatible"
