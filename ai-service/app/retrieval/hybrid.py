from __future__ import annotations

from app.models.schemas import RetrievedChunk


def reciprocal_rank_fusion(
    bm25_results: list[RetrievedChunk],
    semantic_results: list[RetrievedChunk],
    top_k: int,
    constant: int = 60,
) -> list[RetrievedChunk]:
    by_chunk: dict[str, RetrievedChunk] = {}
    scores: dict[str, float] = {}

    for results in (bm25_results, semantic_results):
        for rank, chunk in enumerate(results, start=1):
            by_chunk.setdefault(chunk.chunk_id, chunk)
            scores[chunk.chunk_id] = scores.get(chunk.chunk_id, 0.0) + 1.0 / (constant + rank)

    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)[:top_k]
    fused = []
    for chunk_id, score in ranked:
        chunk = by_chunk[chunk_id].model_copy(update={"score": float(score), "strategy": "hybrid"})
        fused.append(chunk)
    return fused
