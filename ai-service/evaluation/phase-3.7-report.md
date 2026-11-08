# AskWell Phase 3.7 RAG Quality and Full-Stack Integration Validation

Generated: `2026-11-08T05:40:40Z`

## Dataset
- Documents: 18
- Questions: 45
- Customer data: False
- Question types: ambiguous, conflict, direct, multi-doc, paraphrase, partial-insufficient, synonym, troubleshooting, unanswerable

## Retrieval Metrics
- Hybrid Recall@3: 0.9605
- Hybrid Recall@5: 0.9868
- Hybrid Precision@3: 0.3333
- Hybrid Precision@5: 0.2105
- Hybrid MRR: 0.8509
- Hybrid Hit Rate@5: 1.0
- Multi-document success@5: 0.6667

## Answer Quality
- Answerable response rate: 1.0
- Unanswerable abstention rate: 1.0
- Ambiguous abstention rate: 1.0
- Answer relevance: 0.9556
- Citation validity: 1.0
- Citation precision: 0.863
- Citation coverage: 0.9222

## Lifecycle Workflows
- new_document: pass
- document_update: pass
- failed_update_preserves_previous: pass
- document_deletion: pass
- duplicate_unchanged: pass
- recovery_retry: pass

## Failure Handling
- llm_timeout_mock: pass
- malformed_provider_response: pass
- invalid_citation_ids: pass
- corrupt_json_storage: pass
- embedding_failure_preserves_failure_state: pass
- fastapi_unavailable: covered_by_node_proxy_smoke_tests
- node_timeout_or_connection_failure: covered_by_node_proxy_smoke_tests
- invalid_ingest_payload: covered_by_fastapi_and_node_regression_tests
- invalid_answer_request: covered_by_fastapi_and_node_regression_tests
- retrieval_failure: covered_by_corrupt_storage_and_embedding_failure_checks
- storage_write_failure: covered_by_storage_regression_tests
- diagnostic_endpoint_failure: covered_by_node_proxy_smoke_tests

## Performance
- Ingestion: 33.11 ms
- Retrieval mean: 0.77 ms
- Answer generation mean: 0.0 ms
- Diagnostics: 5.29 ms

## Frontend Validation
- Browser automation: not_available
- Claim level: frontend integration tests only; not full browser-level validation

## Known Limits
- No live OpenAI-compatible provider calls were made.
- No real customer or workspace data was used.
- TokenHash embeddings make the run deterministic but are not equivalent to all-MiniLM-L6-v2 quality.
- Browser automation is unavailable in this repo, so frontend validation is Node VM integration coverage.
- Metrics on synthetic support data are regression evidence, not production proof.
- Phase 3.7 exercised a real Node.js and FastAPI process over HTTP, but browser DOM rendering was not automated.

No live LLM/API calls were made, and no real project data was modified.

## Phase 3.7 Comparison
- Baseline answerable response rate: 0.5263
- Current answerable response rate: 1.0
- Baseline citation precision: 0.3037
- Current citation precision: 0.863
- Baseline citation coverage: 0.5667
- Current citation coverage: 0.9222
- Improved question IDs: q01-trial-length, q02-trial-card, q03-trial-after, q04-free-limits, q05-growth-limits, q06-plan-proration, q07-refund-duplicate, q08-cancel-effect, q09-invoice-tax, q10-past-invoices, q11-widget-install, q12-widget-missing, q13-widget-brand, q14-custom-css, q15-widget-no-answer, q16-local-file-fallback, q17-slack-channel, q18-slack-disconnect, q19-webhook-events, q20-webhook-timeout, q21-export-fields, q22-export-knowledge, q23-retention, q24-backups, q25-owner-permissions, q26-agent-permissions, q27-email-change, q28-old-inbox, q29-reset-expiry, q30-reset-no-email, q31-invite-email, q32-smtp, q33-diagnostics-checks, q34-retry-stable-id, q35-admin-token, q36-static-allowlist, q37-payment-enterprise, q38-payment-card
- Regressed question IDs: none

## Cross-Process Integration
- Status: pass
- Workflow: HTTP browser surrogate -> Node.js process -> FastAPI process -> SQLite storage -> retrieval -> extractive generation -> Node.js JSON response
- Browser rendering: not_exercised
