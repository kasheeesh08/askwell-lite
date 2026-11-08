from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from app.evaluation.phase36 import DEFAULT_FIXTURE, PROJECT_ROOT, build_report, write_markdown


DEFAULT_BASELINE = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.6-rerun-for-3.7.json"
FALLBACK_BASELINE = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.6-report.json"
DEFAULT_JSON_REPORT = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.7-report.json"
DEFAULT_MD_REPORT = PROJECT_ROOT / "ai-service" / "evaluation" / "phase-3.7-report.md"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def http_json(url: str, *, method: str = "GET", payload: dict[str, Any] | None = None, timeout: float = 5.0) -> tuple[int, Any]:
    data = None
    headers = {"accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            text = response.read().decode("utf-8")
            return response.status, json.loads(text) if text else {}
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8")
        try:
            body = json.loads(text) if text else {}
        except json.JSONDecodeError:
            body = {"error": text}
        return error.code, body


def wait_for_json(url: str, timeout_seconds: float = 10.0) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            status, _body = http_json(url, timeout=1.0)
            if status < 500:
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def terminate(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_cross_process_integration() -> dict[str, Any]:
    node_port = free_port()
    ai_port = free_port()
    with tempfile.TemporaryDirectory(prefix="askwell-phase37-stack-") as tmp:
        env = os.environ.copy()
        env["ASKWELL_SKIP_AUTO_MODEL"] = "1"
        env["ASKWELL_PHASE37_DATA_DIR"] = tmp
        env["ASKWELL_LLM_PROVIDER"] = "extractive"
        ai = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.evaluation.phase37_service:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(ai_port),
                "--log-level",
                "warning",
            ],
            cwd=PROJECT_ROOT / "ai-service",
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        node_env = env.copy()
        node_env["NODE_ENV"] = "development"
        node_env["PORT"] = str(node_port)
        node_env["ASKWELL_AI_SERVICE_URL"] = f"http://127.0.0.1:{ai_port}"
        node = subprocess.Popen(
            ["node", "server.mjs"],
            cwd=PROJECT_ROOT,
            env=node_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        base = f"http://127.0.0.1:{node_port}"
        try:
            if not wait_for_json(f"{base}/api/ai/health"):
                return {
                    "status": "fail",
                    "stage": "startup",
                    "node_returncode": node.poll(),
                    "fastapi_returncode": ai.poll(),
                }

            document = {
                "id": "phase37-stack",
                "title": "Phase 37 Stack Document",
                "content": "Phase 37 stack validation says the launch code is aurora-731. Updated stack validation says the active launch code is nebula-842.",
                "source_type": "synthetic-integration",
            }
            ingest_status, ingest_body = http_json(f"{base}/api/ai/ingest", method="POST", payload={"documents": [document]})
            docs_status, docs_body = http_json(f"{base}/api/ai/documents")
            answer_status, answer_body = http_json(
                f"{base}/api/ai/answer",
                method="POST",
                payload={"question": "What is the active launch code?", "topK": 5},
            )

            updated = {
                **document,
                "content": "The updated stack validation says the active launch code is comet-915. The retired launch code aurora-731 must not be used.",
            }
            update_status, update_body = http_json(f"{base}/api/ai/ingest", method="POST", payload={"documents": [updated]})
            updated_answer_status, updated_answer = http_json(
                f"{base}/api/ai/answer",
                method="POST",
                payload={"question": "What is the active launch code?", "topK": 5},
            )
            delete_status, delete_body = http_json(f"{base}/api/ai/documents/phase37-stack", method="DELETE")
            deleted_answer_status, deleted_answer = http_json(
                f"{base}/api/ai/answer",
                method="POST",
                payload={"question": "What is the active launch code?", "topK": 5},
            )
            malformed_status, malformed_body = http_json(f"{base}/api/ai/answer", method="POST", payload={"question": ""})
            terminate(ai)
            unavailable_status, unavailable_body = http_json(
                f"{base}/api/ai/answer",
                method="POST",
                payload={"question": "Will the AI service answer?", "topK": 5},
            )

            checks = {
                "static_frontend_served": urllib.request.urlopen(f"{base}/", timeout=5).status == 200,
                "ingest_reaches_fastapi": ingest_status == 200 and ingest_body.get("chunks_indexed", 0) >= 1,
                "document_listing": docs_status == 200 and any(document.get("id") == "phase37-stack" for document in docs_body),
                "answer_has_valid_citation": answer_status == 200 and bool(answer_body.get("citations")),
                "update_preserves_id": update_status == 200 and update_body.get("document_statuses", [{}])[0].get("id") == "phase37-stack",
                "updated_answer_returned": updated_answer_status == 200 and "comet-915" in updated_answer.get("answer", ""),
                "delete_removes_document": delete_status == 200 and delete_body.get("deleted") is True,
                "deleted_content_abstains": deleted_answer_status == 200 and deleted_answer.get("insufficient_context") is True,
                "malformed_answer_rejected": malformed_status == 400,
                "fastapi_unavailable_returns_error": unavailable_status == 503,
            }
            return {
                "status": "pass" if all(checks.values()) else "fail",
                "workflow": "HTTP browser surrogate -> Node.js process -> FastAPI process -> SQLite storage -> retrieval -> extractive generation -> Node.js JSON response",
                "browser_rendering": "not_exercised",
                "checks": checks,
                "sample_answer_citations": answer_body.get("citations", []),
                "failure_response": unavailable_body,
                "malformed_response": malformed_body,
                "live_llm_api_calls": 0,
            }
        finally:
            terminate(node)
            terminate(ai)


def load_baseline(path: Path) -> dict[str, Any]:
    candidate = path if path.exists() else FALLBACK_BASELINE
    return json.loads(candidate.read_text("utf-8"))


def metric_summary(report: dict[str, Any]) -> dict[str, Any]:
    generation = report["generation"]
    hybrid = report["retrieval"]["document_level"]["hybrid"]
    return {
        "recall_at_3": hybrid["recall_at_3"],
        "recall_at_5": hybrid["recall_at_5"],
        "precision_at_3": hybrid["precision_at_3"],
        "precision_at_5": hybrid["precision_at_5"],
        "mrr": hybrid["mrr"],
        "hit_rate_at_5": hybrid["hit_rate_at_5"],
        "multi_document_success_at_5": report["retrieval"]["multi_document_success_at_5"],
        "answerable_response_rate": generation["answerable_response_rate"],
        "unanswerable_abstention_rate": generation["unanswerable_abstention_rate"],
        "ambiguous_abstention_rate": generation["ambiguous_abstention_rate"],
        "answer_relevance": generation["answer_relevance"],
        "citation_validity": generation["citation_validity"],
        "citation_precision": generation["citation_precision"],
        "citation_coverage": generation["citation_coverage"],
    }


def question_outcomes(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        row["id"]: {
            "abstained": row["abstained"],
            "answer_relevance_pass": row["answer_relevance_pass"],
            "citation_precision": row["citation_precision"],
            "citation_coverage": row["citation_coverage"],
            "citations": row["citations"],
            "generation_context": row.get("generation_context", []),
        }
        for row in report["generation"]["rows"]
    }


def compare_questions(baseline: dict[str, Any], current: dict[str, Any]) -> dict[str, list[str]]:
    before = question_outcomes(baseline)
    after = question_outcomes(current)
    improved: list[str] = []
    regressed: list[str] = []
    for question_id, current_row in after.items():
        old = before.get(question_id)
        if not old:
            continue
        old_score = (
            (0 if old["abstained"] else 1)
            + (1 if old["answer_relevance_pass"] else 0)
            + old["citation_precision"]
            + old["citation_coverage"]
        )
        new_score = (
            (0 if current_row["abstained"] else 1)
            + (1 if current_row["answer_relevance_pass"] else 0)
            + current_row["citation_precision"]
            + current_row["citation_coverage"]
        )
        if new_score > old_score:
            improved.append(question_id)
        elif new_score < old_score:
            regressed.append(question_id)
    return {"improved": improved, "regressed": regressed}


def build_phase37_report(args: argparse.Namespace) -> dict[str, Any]:
    baseline = load_baseline(args.baseline)
    current = build_report(args.fixture)
    integration = run_cross_process_integration()
    current["name"] = "AskWell Phase 3.7 RAG Quality and Full-Stack Integration Validation"
    current["phase_3_7"] = {
        "baseline_report": str(args.baseline if args.baseline.exists() else FALLBACK_BASELINE),
        "baseline_metrics": metric_summary(baseline),
        "current_metrics": metric_summary(current),
        "question_outcome_changes": compare_questions(baseline, current),
        "root_causes": [
            "Answerable abstentions were mainly caused by conflict detection treating BM25/semantic top-rank disagreement as decisive even when relevant evidence appeared in both ranked lists.",
            "Citation precision was low because extractive generation cited the first three hybrid chunks, including unrelated but valid retrieved chunks.",
            "Multi-document coverage is still limited when the second required source is not retrieved in the hybrid top five.",
        ],
        "changes": [
            "Evidence conflict detection now tolerates cross-supported rank disagreement instead of failing on every top-document mismatch.",
            "Generation now receives a selected evidence context based on lexical support, BM25 rank, semantic rank, and cross-ranker support.",
            "The Node answer endpoint returns the selected generation context as the cited chunk set.",
        ],
        "cross_process_integration": integration,
        "live_llm_api_calls": 0,
        "real_project_data_modified": False,
    }
    current["known_limits"].append("Phase 3.7 exercised a real Node.js and FastAPI process over HTTP, but browser DOM rendering was not automated.")
    return current


def write_phase37_markdown(report: dict[str, Any], path: Path) -> None:
    write_markdown(report, path)
    lines = path.read_text("utf-8").splitlines()
    if lines:
        lines[0] = "# AskWell Phase 3.7 RAG Quality and Full-Stack Integration Validation"
    phase = report["phase_3_7"]
    lines.extend(
        [
            "",
            "## Phase 3.7 Comparison",
            f"- Baseline answerable response rate: {phase['baseline_metrics']['answerable_response_rate']}",
            f"- Current answerable response rate: {phase['current_metrics']['answerable_response_rate']}",
            f"- Baseline citation precision: {phase['baseline_metrics']['citation_precision']}",
            f"- Current citation precision: {phase['current_metrics']['citation_precision']}",
            f"- Baseline citation coverage: {phase['baseline_metrics']['citation_coverage']}",
            f"- Current citation coverage: {phase['current_metrics']['citation_coverage']}",
            f"- Improved question IDs: {', '.join(phase['question_outcome_changes']['improved']) or 'none'}",
            f"- Regressed question IDs: {', '.join(phase['question_outcome_changes']['regressed']) or 'none'}",
            "",
            "## Cross-Process Integration",
            f"- Status: {phase['cross_process_integration']['status']}",
            f"- Workflow: {phase['cross_process_integration']['workflow']}",
            f"- Browser rendering: {phase['cross_process_integration']['browser_rendering']}",
        ],
    )
    path.write_text("\n".join(lines) + "\n", "utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run AskWell Phase 3.7 quality and integration validation.")
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    parser.add_argument("--json-output", type=Path, default=DEFAULT_JSON_REPORT)
    parser.add_argument("--markdown-output", type=Path, default=DEFAULT_MD_REPORT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    report = build_phase37_report(args)
    args.json_output.parent.mkdir(parents=True, exist_ok=True)
    args.json_output.write_text(json.dumps(report, indent=2) + "\n", "utf-8")
    write_phase37_markdown(report, args.markdown_output)
    print(json.dumps({
        "json_output": str(args.json_output),
        "markdown_output": str(args.markdown_output),
        "answerable_response_rate": report["phase_3_7"]["current_metrics"]["answerable_response_rate"],
        "citation_precision": report["phase_3_7"]["current_metrics"]["citation_precision"],
        "cross_process_integration": report["phase_3_7"]["cross_process_integration"]["status"],
        "live_llm_api_calls": 0,
    }))


if __name__ == "__main__":
    main()
