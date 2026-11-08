from __future__ import annotations

import argparse

from app.evaluation.live_provider_report import DEFAULT_FIXTURE, build_live_report, phrase_matches


TRIAL_CARD_EXPECTED = [
    "payment card is not required",
    "card is not required",
    "no credit card",
    "without adding a card",
]


def test_live_provider_report_does_not_require_credentials(tmp_path, monkeypatch):
    monkeypatch.delenv("ASKWELL_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("ASKWELL_LLM_MODEL", raising=False)
    monkeypatch.delenv("ASKWELL_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("ASKWELL_LLM_API_KEY", raising=False)

    report = build_live_report(
        argparse.Namespace(
            fixture=DEFAULT_FIXTURE,
            output=tmp_path / "report.json",
            before_report=tmp_path / "missing-before.json",
            top_k=3,
            embedding_provider="test",
            chunk_size=420,
            chunk_overlap=80,
            live_scenario_limit=5,
        ),
    )

    assert report["actual_provider_observations"]["status"] == "not_run"
    assert report["environment"]["credentials_exposed"] is False
    assert report["model_configuration"]["llm_credentials_present"] is False
    assert report["mocked_contract_tests"]["checks"]["invalid_citations"] == "pass"
    assert "ASKWELL_LLM_API_KEY" not in str(report["actual_provider_observations"].get("results", []))


def test_relevance_matcher_accepts_current_trial_card_answer():
    answer = "No, you do not need to add a credit card before testing AskWell. The 14-day trial does not require a payment card."

    assert phrase_matches(answer, TRIAL_CARD_EXPECTED) is True


def test_relevance_matcher_rejects_incorrect_trial_card_answer():
    answer = "Yes, you need to add a credit card before testing AskWell."

    assert phrase_matches(answer, TRIAL_CARD_EXPECTED) is False


def test_relevance_matcher_normalizes_case_and_punctuation():
    answer = "NO -- payment-card is NOT required during the trial!"

    assert phrase_matches(answer, ["Payment card is not required."]) is True


def test_relevance_matcher_uses_alternative_expected_phrases_with_or_semantics():
    answer = "You can test AskWell with no credit card."

    assert phrase_matches(answer, TRIAL_CARD_EXPECTED) is True
