from __future__ import annotations

import os
from pathlib import Path

from app.config import Settings
from app.embeddings.testing import TokenHashEmbeddingProvider
from app.main import create_app
from app.retrieval.store import SQLiteVectorStore


data_dir = Path(os.environ["ASKWELL_PHASE37_DATA_DIR"])
embeddings = TokenHashEmbeddingProvider()
settings = Settings(
    embedding_model="token-hash-phase37-integration",
    data_dir=data_dir,
    sqlite_vector_path=data_dir / "integration.sqlite3",
    vector_storage_backend="sqlite",
    chunk_size=900,
    chunk_overlap=100,
    bm25_score_threshold=1.5,
    semantic_score_threshold=0.25,
    hybrid_score_threshold=0.01,
    semantic_margin_threshold=0.01,
    query_coverage_threshold=0.25,
    llm_provider="extractive",
)
store = SQLiteVectorStore(settings.sqlite_vector_path, embeddings)
app = create_app(settings, embeddings, store)
