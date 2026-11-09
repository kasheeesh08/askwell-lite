# Phase 5A - Knowledge Base Indexing and Onboarding

## Summary

Phase 5A improves the Knowledge page onboarding path for turning existing workspace articles into indexed RAG documents. The implementation keeps the existing Node/FastAPI local workflow and the hosted Vercel/Turso workflow intact. It reuses the current `AskWellApi.ingestDocuments()` client, which means hosted requests continue to use the HttpOnly private-demo session cookie and CSRF header handling already built into the API layer.

## Implementation

- Added an `Index all articles` action to the Knowledge page header.
- Added per-article `Index`, `Re-index`, and `Retry index` controls.
- Added per-article status display:
  - `Not indexed`
  - `Indexing`
  - `Indexed`
  - `Failed`
- Reused stable article IDs as document IDs, preserving document identity across indexing and re-indexing.
- Reused existing storage behavior for unchanged content, so unchanged documents are reported as `unchanged` by the backend instead of being reprocessed.
- Added transient frontend indexing results in `documentStatus.indexResults` so failed and partial indexing outcomes can be shown next to the affected article.
- Prevented duplicate indexing requests by filtering out articles already present in `pendingIds`.
- Preserved existing document-management deletion, update, diagnostics, and retry behavior.

## Existing Functionality Reused

- `AskWellApi.ingestDocuments()` for all indexing requests.
- Hosted browser embedding payload construction in hosted mode.
- Local article ingestion payload support in local mode.
- Existing adapter unchanged-content detection based on content hash and embedding/indexing profile.
- Existing SQLite and Turso document/chunk/embedding cascade behavior.
- Existing private-demo session and CSRF handling for hosted state-changing requests.

## Testing

Added smoke coverage for:

- Bulk indexing of existing articles.
- Stable article/document IDs in indexing payloads.
- Avoiding synthetic document IDs during indexing.
- Created and unchanged indexing summaries.
- Duplicate indexing prevention while an article is pending.
- Partial indexing failure display.
- Retry of a failed article indexing operation.

Existing regression coverage continues to verify:

- Article update and re-indexing.
- Document deletion.
- Local and hosted API route behavior.
- SQLite and Turso document deletion cascade behavior.
- Hosted authentication and CSRF enforcement.
- Hosted retrieval/deletion consistency.

## Limitations

- The UI uses request-level progress states, not background jobs.
- A full ingest request that fails before returning per-document statuses marks all candidate articles as failed.
- The frontend does not persist historical indexing attempts beyond the current saved workspace state.
- No production data was indexed or modified as part of this phase.

## Verification

- `npm run check`: passed.
- `npm test`: passed, 138 tests.
