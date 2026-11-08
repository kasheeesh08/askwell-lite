from __future__ import annotations

from app.config import Settings
from app.models.schemas import RetrievedChunk
from app.retrieval.evidence import assess_evidence, select_generation_context


def chunk(document_id: str, score: float, strategy: str = "hybrid") -> RetrievedChunk:
    return RetrievedChunk(
        chunk_id=f"{document_id}:chunk-0",
        document_id=document_id,
        document_title=document_id.title(),
        text=f"{document_id} support text",
        score=score,
        strategy=strategy,
    )


def settings(**overrides) -> Settings:
    values = {
        "embedding_model": "test",
        "bm25_score_threshold": 3.0,
        "semantic_score_threshold": 0.38,
        "hybrid_score_threshold": 0.02,
        "semantic_margin_threshold": 0.05,
        "query_coverage_threshold": 0.45,
        "min_evidence_chunks": 1,
        "min_retrieval_agreement": 1,
    }
    values.update(overrides)
    return Settings(**values)


def test_strong_keyword_evidence_passes_with_retrieval_agreement():
    decision = assess_evidence(
        bm25=[chunk("trial", 4.2, "bm25")],
        semantic=[chunk("trial", 0.31, "semantic")],
        hybrid=[chunk("trial", 0.032, "hybrid")],
        settings=settings(),
    )

    assert decision.sufficient is True
    assert "strong_bm25" in decision.signals


def test_strong_semantic_evidence_passes_with_margin():
    decision = assess_evidence(
        bm25=[],
        semantic=[chunk("trial", 0.62, "semantic"), chunk("billing", 0.44, "semantic")],
        hybrid=[chunk("trial", 0.02, "hybrid")],
        settings=settings(),
    )

    assert decision.sufficient is True
    assert "strong_semantic" in decision.signals


def test_weak_semantic_evidence_is_insufficient():
    decision = assess_evidence(
        bm25=[],
        semantic=[chunk("billing", 0.32, "semantic"), chunk("trial", 0.29, "semantic")],
        hybrid=[chunk("billing", 0.016, "hybrid")],
        settings=settings(),
    )

    assert decision.sufficient is False
    assert decision.reason == "insufficient_retrieval_evidence"


def test_irrelevant_low_keyword_match_is_insufficient():
    decision = assess_evidence(
        bm25=[chunk("widget", 2.0, "bm25")],
        semantic=[chunk("ai", 0.22, "semantic"), chunk("widget", 0.21, "semantic")],
        hybrid=[chunk("widget", 0.032, "hybrid")],
        settings=settings(),
    )

    assert decision.sufficient is False


def test_ambiguous_evidence_without_clear_margin_is_insufficient():
    decision = assess_evidence(
        bm25=[],
        semantic=[chunk("billing", 0.41, "semantic"), chunk("trial", 0.39, "semantic")],
        hybrid=[chunk("billing", 0.016, "hybrid"), chunk("trial", 0.016, "hybrid")],
        settings=settings(),
    )

    assert decision.sufficient is False


def test_conflicting_evidence_requires_enough_supporting_chunks():
    decision = assess_evidence(
        bm25=[chunk("trial-current", 4.1, "bm25")],
        semantic=[chunk("trial-legacy", 0.61, "semantic")],
        hybrid=[chunk("trial-current", 0.016, "hybrid"), chunk("trial-legacy", 0.016, "hybrid")],
        settings=settings(min_evidence_chunks=2),
    )

    assert decision.sufficient is False
    assert decision.reason == "conflicting_retrieval_evidence"


def test_cross_supported_top_disagreement_can_still_pass():
    decision = assess_evidence(
        question="Can I change billing?",
        bm25=[chunk("billing", 4.1, "bm25"), chunk("account", 2.2, "bm25")],
        semantic=[chunk("account", 0.61, "semantic"), chunk("billing", 0.55, "semantic")],
        hybrid=[chunk("account", 0.032, "hybrid"), chunk("billing", 0.031, "hybrid")],
        settings=settings(),
    )

    assert decision.sufficient is True
    assert decision.reason is None


def test_insufficient_multi_source_coverage_is_configurable():
    decision = assess_evidence(
        bm25=[chunk("billing", 5.1, "bm25")],
        semantic=[chunk("billing", 0.49, "semantic")],
        hybrid=[chunk("billing", 0.032, "hybrid")],
        settings=settings(min_evidence_chunks=2),
    )

    assert decision.sufficient is False


def test_partial_relevance_without_query_coverage_is_insufficient():
    decision = assess_evidence(
        question="Can the widget send Slack notifications after a chat?",
        bm25=[chunk("widget", 5.4, "bm25")],
        semantic=[chunk("widget", 0.49, "semantic"), chunk("inbox", 0.42, "semantic")],
        hybrid=[chunk("widget", 0.032, "hybrid"), chunk("inbox", 0.016, "hybrid")],
        settings=settings(semantic_margin_threshold=0.08),
    )

    assert decision.sufficient is False


def test_generation_context_prefers_relevant_supported_chunks():
    selected = select_generation_context(
        question="Where do I paste the widget script?",
        bm25=[
            RetrievedChunk(
                chunk_id="widget:chunk-0",
                document_id="widget",
                document_title="Widget",
                text="Paste the widget script before the closing body tag.",
                score=4.0,
                strategy="bm25",
            ),
            chunk("billing", 2.2, "bm25"),
        ],
        semantic=[
            RetrievedChunk(
                chunk_id="widget:chunk-0",
                document_id="widget",
                document_title="Widget",
                text="Paste the widget script before the closing body tag.",
                score=0.6,
                strategy="semantic",
            ),
            chunk("billing", 0.4, "semantic"),
        ],
        hybrid=[
            RetrievedChunk(
                chunk_id="widget:chunk-0",
                document_id="widget",
                document_title="Widget",
                text="Paste the widget script before the closing body tag.",
                score=0.032,
                strategy="hybrid",
            ),
            chunk("billing", 0.02, "hybrid"),
        ],
        settings=settings(),
    )

    assert [chunk.chunk_id for chunk in selected] == ["widget:chunk-0"]
