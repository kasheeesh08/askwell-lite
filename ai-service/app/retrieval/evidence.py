from __future__ import annotations

import re
from dataclasses import dataclass

from app.config import Settings
from app.models.schemas import RetrievedChunk


@dataclass(frozen=True)
class EvidenceDecision:
    sufficient: bool
    reason: str | None
    best_bm25: float
    best_semantic: float
    best_hybrid: float
    semantic_margin: float
    query_coverage: float
    evidence_chunks: int
    retrieval_agreement: int
    signals: list[str]


def best_score(chunks: list[RetrievedChunk]) -> float:
    return max((chunk.score for chunk in chunks), default=0.0)


def score_margin(chunks: list[RetrievedChunk]) -> float:
    if len(chunks) < 2:
        return best_score(chunks)
    ordered = sorted((chunk.score for chunk in chunks), reverse=True)
    return ordered[0] - ordered[1]


def top_document_ids(chunks: list[RetrievedChunk], limit: int = 3) -> set[str]:
    return {chunk.document_id for chunk in chunks[:limit]}


def ranked_document_ids(chunks: list[RetrievedChunk], limit: int = 5) -> list[str]:
    seen: set[str] = set()
    ranked: list[str] = []
    for chunk in chunks[:limit]:
        if chunk.document_id in seen:
            continue
        seen.add(chunk.document_id)
        ranked.append(chunk.document_id)
    return ranked


STOPWORDS = {
    "a",
    "an",
    "and",
    "after",
    "before",
    "can",
    "do",
    "does",
    "from",
    "how",
    "i",
    "if",
    "is",
    "it",
    "my",
    "of",
    "or",
    "should",
    "the",
    "to",
    "what",
    "where",
}


def normalize_token(token: str) -> str:
    for suffix in ("ing", "ed", "s"):
        if len(token) > len(suffix) + 3 and token.endswith(suffix):
            return token[: -len(suffix)]
    return token


def content_tokens(value: str) -> set[str]:
    return {
        normalize_token(token)
        for token in re.findall(r"[a-z0-9]+", value.lower())
        if token not in STOPWORDS and len(token) > 1
    }


def query_coverage(question: str, chunks: list[RetrievedChunk]) -> float:
    query_tokens = content_tokens(question)
    if not query_tokens:
        return 1.0
    evidence_tokens = content_tokens(" ".join(chunk.text for chunk in chunks))
    return len(query_tokens & evidence_tokens) / len(query_tokens)


def chunk_token_overlap(question: str, chunk: RetrievedChunk) -> int:
    return len(content_tokens(question) & content_tokens(chunk.text))


def select_generation_context(
    *,
    question: str,
    bm25: list[RetrievedChunk],
    semantic: list[RetrievedChunk],
    hybrid: list[RetrievedChunk],
    settings: Settings,
    max_chunks: int = 3,
) -> list[RetrievedChunk]:
    if not hybrid:
        return []

    query_tokens = content_tokens(question)
    bm25_rank = {chunk.chunk_id: rank for rank, chunk in enumerate(bm25, start=1)}
    semantic_rank = {chunk.chunk_id: rank for rank, chunk in enumerate(semantic, start=1)}
    bm25_documents = set(ranked_document_ids(bm25))
    semantic_documents = set(ranked_document_ids(semantic))
    cross_supported_documents = bm25_documents & semantic_documents
    scored: list[tuple[float, RetrievedChunk]] = []

    for rank, chunk in enumerate(hybrid, start=1):
        overlap = chunk_token_overlap(question, chunk) if query_tokens else 1
        if overlap <= 0 and chunk.document_id not in cross_supported_documents:
            continue
        rank_bonus = 0.3 / rank
        lexical_bonus = 2.0 * overlap / max(len(query_tokens), 1)
        cross_ranker_bonus = 0.35 if chunk.document_id in cross_supported_documents else 0.0
        bm25_bonus = 1.0 / bm25_rank[chunk.chunk_id] if chunk.chunk_id in bm25_rank else 0.0
        semantic_bonus = 0.05 / semantic_rank[chunk.chunk_id] if chunk.chunk_id in semantic_rank else 0.0
        scored.append((lexical_bonus + cross_ranker_bonus + bm25_bonus + semantic_bonus + rank_bonus, chunk))

    if not scored:
        return hybrid[:1]

    scored.sort(key=lambda item: item[0], reverse=True)
    best_score = scored[0][0]
    selected: list[RetrievedChunk] = []
    for score, chunk in scored:
        if len(selected) >= max_chunks:
            break
        if selected and score < best_score * 0.65 and len(selected) >= settings.min_evidence_chunks:
            continue
        selected.append(chunk)

    if len(selected) < settings.min_evidence_chunks:
        for _score, chunk in scored:
            if chunk.chunk_id not in {item.chunk_id for item in selected}:
                selected.append(chunk)
            if len(selected) >= settings.min_evidence_chunks:
                break

    return selected[:max_chunks]


def assess_evidence(
    *,
    question: str = "",
    bm25: list[RetrievedChunk],
    semantic: list[RetrievedChunk],
    hybrid: list[RetrievedChunk],
    settings: Settings,
) -> EvidenceDecision:
    best_bm25 = best_score(bm25)
    best_semantic = best_score(semantic)
    best_hybrid = best_score(hybrid)
    semantic_margin = score_margin(semantic)
    coverage = query_coverage(question, hybrid) if question else 1.0
    bm25_documents = top_document_ids(bm25)
    semantic_documents = top_document_ids(semantic)
    hybrid_documents = top_document_ids(hybrid)
    agreed_documents = (bm25_documents & semantic_documents) | (hybrid_documents & bm25_documents) | (hybrid_documents & semantic_documents)
    retrieval_agreement = len(agreed_documents)
    bm25_ranked_documents = set(ranked_document_ids(bm25))
    semantic_ranked_documents = set(ranked_document_ids(semantic))
    top_documents_cross_supported = (
        bool(bm25)
        and bool(semantic)
        and (
            bm25[0].document_id in semantic_ranked_documents
            or semantic[0].document_id in bm25_ranked_documents
            or bool(bm25_ranked_documents & semantic_ranked_documents)
        )
    )

    strong_bm25 = best_bm25 >= settings.bm25_score_threshold and coverage >= settings.query_coverage_threshold
    strong_semantic = (
        best_semantic >= settings.semantic_score_threshold
        and semantic_margin >= settings.semantic_margin_threshold
    )
    conflicting_top_documents = (
        bool(bm25)
        and bool(semantic)
        and bm25[0].document_id != semantic[0].document_id
        and best_bm25 >= settings.bm25_score_threshold
        and best_semantic >= settings.semantic_score_threshold
        and not top_documents_cross_supported
    )
    useful_hybrid = best_hybrid >= settings.hybrid_score_threshold and retrieval_agreement >= settings.min_retrieval_agreement
    evidence_chunks = len([
        chunk
        for chunk in hybrid
        if chunk.document_id in agreed_documents
        and (
            chunk.score >= settings.hybrid_score_threshold
            or chunk.document_id in bm25_documents
            or chunk.document_id in semantic_documents
        )
    ])

    signals = []
    if strong_bm25:
        signals.append("strong_bm25")
    if strong_semantic:
        signals.append("strong_semantic")
    if coverage >= settings.query_coverage_threshold:
        signals.append("query_coverage")
    if useful_hybrid:
        signals.append("retrieval_agreement")

    has_strength = strong_bm25 or strong_semantic
    has_coverage = evidence_chunks >= settings.min_evidence_chunks
    sufficient = has_strength and useful_hybrid and has_coverage and not conflicting_top_documents
    reason = None if sufficient else (
        "conflicting_retrieval_evidence" if conflicting_top_documents else "insufficient_retrieval_evidence"
    )
    return EvidenceDecision(
        sufficient=sufficient,
        reason=reason,
        best_bm25=best_bm25,
        best_semantic=best_semantic,
        best_hybrid=best_hybrid,
        semantic_margin=semantic_margin,
        query_coverage=coverage,
        evidence_chunks=evidence_chunks,
        retrieval_agreement=retrieval_agreement,
        signals=signals,
    )
