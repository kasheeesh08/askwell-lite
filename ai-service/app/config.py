from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    embedding_model: str = os.getenv(
        "ASKWELL_EMBEDDING_MODEL",
        "sentence-transformers/all-MiniLM-L6-v2",
    )
    llm_provider: str = os.getenv("ASKWELL_LLM_PROVIDER", "extractive")
    llm_model: str = os.getenv("ASKWELL_LLM_MODEL", "gpt-4o-mini")
    llm_api_key: str = os.getenv("ASKWELL_LLM_API_KEY", "")
    llm_base_url: str = os.getenv("ASKWELL_LLM_BASE_URL", "https://api.openai.com/v1")
    llm_timeout_seconds: float = float(os.getenv("ASKWELL_LLM_TIMEOUT_SECONDS", "20"))
    llm_retries: int = int(os.getenv("ASKWELL_LLM_RETRIES", "2"))
    llm_max_output_tokens: int = int(os.getenv("ASKWELL_LLM_MAX_OUTPUT_TOKENS", "350"))
    data_dir: Path = Path(os.getenv("ASKWELL_AI_DATA_DIR", "ai-service/data"))
    vector_storage_backend: str = os.getenv("ASKWELL_VECTOR_STORAGE_BACKEND", "auto")
    sqlite_vector_path: Path | None = (
        Path(os.environ["ASKWELL_SQLITE_VECTOR_PATH"])
        if os.getenv("ASKWELL_SQLITE_VECTOR_PATH")
        else None
    )
    chunk_size: int = int(os.getenv("ASKWELL_CHUNK_SIZE", "700"))
    chunk_overlap: int = int(os.getenv("ASKWELL_CHUNK_OVERLAP", "120"))
    top_k: int = int(os.getenv("ASKWELL_TOP_K", "5"))
    insufficient_score_threshold: float = float(
        os.getenv("ASKWELL_INSUFFICIENT_SCORE_THRESHOLD", "0.01"),
    )
    bm25_score_threshold: float = float(os.getenv("ASKWELL_BM25_SCORE_THRESHOLD", "3.0"))
    semantic_score_threshold: float = float(os.getenv("ASKWELL_SEMANTIC_SCORE_THRESHOLD", "0.38"))
    hybrid_score_threshold: float = float(os.getenv("ASKWELL_HYBRID_SCORE_THRESHOLD", "0.02"))
    semantic_margin_threshold: float = float(os.getenv("ASKWELL_SEMANTIC_MARGIN_THRESHOLD", "0.08"))
    query_coverage_threshold: float = float(os.getenv("ASKWELL_QUERY_COVERAGE_THRESHOLD", "0.45"))
    min_evidence_chunks: int = int(os.getenv("ASKWELL_MIN_EVIDENCE_CHUNKS", "1"))
    min_retrieval_agreement: int = int(os.getenv("ASKWELL_MIN_RETRIEVAL_AGREEMENT", "1"))
    api_token: str = os.getenv("ASKWELL_AI_SERVICE_TOKEN", "")
    require_api_token: bool = os.getenv("ASKWELL_AI_REQUIRE_TOKEN", "0") == "1"


def get_settings() -> Settings:
    return Settings()
