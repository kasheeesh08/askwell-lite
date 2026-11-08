from __future__ import annotations

import argparse

from app.evaluation.phase36 import DEFAULT_FIXTURE
from app.evaluation.phase37 import DEFAULT_BASELINE, build_phase37_report, metric_summary


def test_phase37_report_compares_against_phase36_baseline():
    report = build_phase37_report(
        argparse.Namespace(
            fixture=DEFAULT_FIXTURE,
            baseline=DEFAULT_BASELINE,
        ),
    )

    phase = report["phase_3_7"]
    assert phase["baseline_metrics"]["answerable_response_rate"] == 0.5263
    assert phase["current_metrics"]["answerable_response_rate"] >= phase["baseline_metrics"]["answerable_response_rate"]
    assert phase["current_metrics"]["citation_precision"] >= phase["baseline_metrics"]["citation_precision"]
    assert phase["cross_process_integration"]["status"] == "pass"
    assert phase["live_llm_api_calls"] == 0
    assert phase["real_project_data_modified"] is False


def test_phase37_metric_summary_includes_required_fields():
    summary = metric_summary(
        {
            "retrieval": {
                "document_level": {
                    "hybrid": {
                        "recall_at_3": 1.0,
                        "recall_at_5": 1.0,
                        "precision_at_3": 0.5,
                        "precision_at_5": 0.3,
                        "mrr": 1.0,
                        "hit_rate_at_5": 1.0,
                    },
                },
                "multi_document_success_at_5": 0.75,
            },
            "generation": {
                "answerable_response_rate": 0.8,
                "unanswerable_abstention_rate": 1.0,
                "ambiguous_abstention_rate": 1.0,
                "answer_relevance": 0.7,
                "citation_validity": 1.0,
                "citation_precision": 0.6,
                "citation_coverage": 0.5,
            },
        },
    )

    assert summary["multi_document_success_at_5"] == 0.75
    assert summary["citation_coverage"] == 0.5
