from __future__ import annotations

from app.evaluation.phase36 import DEFAULT_FIXTURE, build_report, load_fixture, phrase_match


def test_phase36_fixture_is_synthetic_and_labeled():
    fixture = load_fixture(DEFAULT_FIXTURE)

    assert fixture["customer_data"] is False
    assert 15 <= len(fixture["documents"]) <= 20
    assert 40 <= len(fixture["questions"]) <= 50
    assert all("expected_answerable" in question for question in fixture["questions"])
    assert all("expected_source_chunks" in question for question in fixture["questions"])
    assert any(len(question["expected_relevant_documents"]) > 1 for question in fixture["questions"])
    assert {"ambiguous", "unanswerable", "partial-insufficient", "multi-doc"}.issubset(
        {question["type"] for question in fixture["questions"]},
    )


def test_phase36_phrase_match_normalizes_case_and_punctuation():
    assert phrase_match("No, PAYMENT-card is not required during the trial.", ["payment card is not required"])
    assert not phrase_match("Yes, a card is mandatory.", ["payment card is not required"])


def test_phase36_report_runs_without_live_api_calls():
    report = build_report(DEFAULT_FIXTURE)

    assert report["dataset"]["documents"] >= 15
    assert report["dataset"]["questions"] >= 40
    assert report["environment"]["live_llm_api_calls"] == 0
    assert report["real_project_data_modified"] is False
    assert "recall_at_5" in report["retrieval"]["document_level"]["hybrid"]
    assert report["storage_diagnostics"]["backend"] == "sqlite"
    assert report["lifecycle_workflows"]["new_document"]["status"] == "pass"
    assert report["lifecycle_workflows"]["duplicate_unchanged"]["status"] == "pass"
    assert report["failure_handling"]["llm_timeout_mock"] == "pass"
    assert report["frontend_validation"]["browser_automation"] == "not_available"
