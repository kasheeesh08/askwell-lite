from __future__ import annotations

import argparse
import json

from app.evaluation.report import DEFAULT_FIXTURE, build_report


def test_evaluation_fixture_contains_separate_synthetic_corpus():
    fixture = json.loads(DEFAULT_FIXTURE.read_text("utf-8"))

    assert fixture["customer_data"] is False
    assert len(fixture["documents"]) >= 10
    assert len(fixture["questions"]) >= 10
    assert {"exact-keyword", "paraphrase", "synonym", "multi-source", "ambiguous", "unanswerable", "partial-insufficient"}.issubset(
        {question["type"] for question in fixture["questions"]},
    )
    assert any(len(question["expected_relevant_documents"]) > 1 for question in fixture["questions"])
    assert any(question["expected_abstain"] for question in fixture["questions"])


def test_evaluation_report_runs_without_live_provider(tmp_path, monkeypatch):
    monkeypatch.delenv("ASKWELL_LLM_API_KEY", raising=False)
    monkeypatch.delenv("ASKWELL_LLM_PROVIDER", raising=False)

    report = build_report(
        argparse.Namespace(
            fixture=DEFAULT_FIXTURE,
            output=tmp_path / "report.json",
            baseline=tmp_path / "missing-baseline.json",
            embedding_provider="test",
            top_k=3,
            chunk_size=420,
            chunk_overlap=80,
            bm25_threshold=3.0,
            semantic_threshold=0.38,
            hybrid_threshold=0.02,
            semantic_margin_threshold=0.08,
            query_coverage_threshold=0.45,
            min_evidence_chunks=1,
            min_retrieval_agreement=1,
            live_llm_limit=1,
        ),
    )

    assert report["dataset"]["documents"] >= 10
    assert report["dataset"]["questions"] >= 10
    assert report["generation"]["live_provider_validation"]["status"] == "not_run"
    assert report["failure_testing"]["invalid_api_key"] == "pass"
    assert report["failure_testing"]["provider_timeout"] == "pass"
    assert report["failure_testing"]["rate_limit"] == "pass"
    assert report["failure_testing"]["invalid_citations"] == "pass"
    assert "recall_at_3" in report["retrieval"]["metrics"]["hybrid"]
