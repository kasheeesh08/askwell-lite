# AskWell Phase 3.6 End-to-End Integration and Evaluation

Generated: `2026-11-08T05:28:11Z`

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
- Answerable response rate: 0.5263
- Unanswerable abstention rate: 1.0
- Ambiguous abstention rate: 1.0
- Answer relevance: 0.6
- Citation validity: 1.0
- Citation precision: 0.3037
- Citation coverage: 0.5667

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
- Ingestion: 40.18 ms
- Retrieval mean: 1.27 ms
- Answer generation mean: 0.0 ms
- Diagnostics: 6.82 ms

## Frontend Validation
- Browser automation: not_available
- Claim level: frontend integration tests only; not full browser-level validation

## Known Limits
- No live OpenAI-compatible provider calls were made.
- No real customer or workspace data was used.
- TokenHash embeddings make the run deterministic but are not equivalent to all-MiniLM-L6-v2 quality.
- Browser automation is unavailable in this repo, so frontend validation is Node VM integration coverage.
- Metrics on synthetic support data are regression evidence, not production proof.

No live LLM/API calls were made, and no real project data was modified.
