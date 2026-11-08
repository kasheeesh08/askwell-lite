# Phase 3.3 Architecture Assessment: Persistent Document and Vector Storage

## Scope

This assessment focuses on AskWell Lite's current AI-service document and vector persistence architecture. It does not propose application rewrites, authentication changes, database migrations, Docker, PostgreSQL, or new external infrastructure for this phase.

Findings below are based on the current source code, especially:

- `ai-service/app/retrieval/store.py`
- `ai-service/app/ingestion/processing.py`
- `ai-service/app/models/schemas.py`
- `ai-service/app/main.py`
- `ai-service/app/retrieval/vector.py`
- `ai-service/app/retrieval/bm25.py`
- `ai-service/app/retrieval/hybrid.py`
- `ai-service/app/embeddings/sentence_transformers.py`
- `ai-service/app/config.py`
- `ai-service/tests/test_rag.py`
- `ai-service/tests/test_real_model_integration.py`
- `ai-service/requirements.txt`

## 1. Current Architecture and Data Flow

AskWell Lite currently uses two persistence layers:

- The Node.js backend persists the main workspace state separately.
- The Python FastAPI AI service persists retrieval chunks and embeddings in a JSON vector store.

The AI-service flow is:

1. `ai-service/app/main.py` creates a singleton `JsonVectorStore` at startup using `settings.data_dir / "vectors.json"`.
2. `/ingest` accepts articles, documents, or base64-encoded documents through `IngestRequest`.
3. `ai-service/app/ingestion/processing.py` normalizes text, extracts PDF/DOCX/text content, computes content hashes, and chunks documents.
4. `JsonVectorStore.ingest()` detects unchanged documents by document id and content hash.
5. New chunks are embedded through the configured embedding provider, currently `sentence-transformers/all-MiniLM-L6-v2`.
6. Chunks, vectors, document hashes, and embedding dimensions are persisted to `vectors.json`.
7. `/answer` reads the in-memory store, runs BM25 retrieval, semantic retrieval, hybrid RRF retrieval, evidence sufficiency checks, and generation.

Current JSON storage shape in `JsonVectorStore.persist()`:

- `chunks`: serialized `Chunk` objects.
- `vectors`: list form of the NumPy embedding matrix.
- `document_hashes`: mapping of document id to content hash.
- `embedding_dimension`: embedding dimension from the configured provider.

## 2. Confirmed Weaknesses

### JSON persistence is only partially atomic

`JsonVectorStore.persist()` writes to `self.path.with_suffix(".tmp")` and then replaces the destination file. This is better than direct writes, but it does not flush the file handle, fsync the file, fsync the parent directory, use a unique temp file, or clean up failed temp files. A crash during write is less likely to corrupt the old file, but durability is not guaranteed.

Reference: `ai-service/app/retrieval/store.py`, `JsonVectorStore.persist()`.

### Corrupt JSON is detected, but schema corruption is not fully validated

`JsonVectorStore.load()` raises a runtime error for invalid JSON. That avoids silently replacing corrupted storage with seed data. However, it does not validate that:

- `len(chunks) == len(vectors)`.
- Stored vectors match the current embedding dimension.
- `embedding_dimension` matches the active embedding provider.
- Required chunk fields and metadata shape are complete beyond basic model construction.

Reference: `ai-service/app/retrieval/store.py`, `JsonVectorStore.load()`.

### Updated documents can misalign chunks and vectors

When re-ingesting an updated document, `JsonVectorStore.ingest()` removes old chunks from `self.chunks` before rebuilding the vector matrix. It then zips the mutated chunk list with the old vector matrix:

```python
for chunk, vector in zip(self.chunks[:-len(new_chunks)], self.vectors)
```

If the updated document was not the last document in storage, remaining chunks can be paired with the wrong old vectors. Retrieval correctness depends on row alignment between `self.chunks` and `self.vectors`, so this is a high-priority correctness issue.

Reference: `ai-service/app/retrieval/store.py`, `JsonVectorStore.ingest()` and `ai-service/app/retrieval/vector.py`.

### No explicit document deletion lifecycle exists

The current store supports initial ingestion and same-id replacement, but there is no delete method, delete endpoint, tombstone handling, or chunk/vector cleanup API for removed documents. If a source document is deleted upstream, the AI vector store has no first-class way to remove its chunks.

Reference: `ai-service/app/retrieval/store.py`, `ai-service/app/main.py`, `ai-service/app/models/schemas.py`.

### Duplicate and unchanged handling are useful but incomplete

The store tracks `document_hashes` by document id. If the same document id and content hash are ingested again, it skips reprocessing. It also uses chunk hashes to avoid duplicate chunk insertion.

Limitations:

- Chunk duplicate detection is global and not tied to document ownership.
- A new document with fully duplicate chunks can still update `document_hashes`.
- Duplicate behavior does not define how source citations should behave when two documents share identical content.
- The hash does not include embedding model, chunking parameters, or processing version.

Reference: `ai-service/app/retrieval/store.py`, `JsonVectorStore.ingest()` and `ai-service/app/ingestion/processing.py`.

### Concurrent ingestion and retrieval can produce inconsistent state

The FastAPI app uses a shared in-memory `JsonVectorStore` singleton. There is no lock around ingestion, persistence, vector replacement, or retrieval reads. Concurrent operations can observe partially updated in-memory state or cause last-writer-wins persistence behavior.

Reference: `ai-service/app/main.py`, `create_app()` and endpoints; `ai-service/app/retrieval/store.py`.

### Embedding compatibility is not enforced

The store persists `embedding_dimension`, but load does not reject or reindex data when the configured embedding provider, embedding dimension, normalization behavior, or chunking strategy changes.

Impact:

- A model change can silently reuse stale vectors.
- A dimension mismatch can fail during semantic search.
- A chunking change can leave old chunks mixed with new assumptions.

Reference: `ai-service/app/retrieval/store.py`, `JsonVectorStore.load()`; `ai-service/app/config.py`; `ai-service/app/embeddings/sentence_transformers.py`.

### AI service storage has no workspace isolation

The ingestion schemas contain document ids, titles, content, filenames, and metadata, but no organization id, workspace id, tenant id, or access boundary. All ingested chunks share one vector store.

Reference: `ai-service/app/models/schemas.py`.

### File handling is mostly path-safe, but payload controls are limited

Encoded document ingestion decodes base64 content in memory and uses `Path(filename).suffix` only for extension detection. It does not write uploaded filenames to disk, which reduces path traversal risk. However, there are no explicit size limits, metadata allowlists, filename normalization rules, or per-workspace storage boundaries in the AI service.

Reference: `ai-service/app/ingestion/processing.py`; `ai-service/app/models/schemas.py`.

## 3. Storage Alternatives Comparison

| Option | Fit for current project | Strengths | Weaknesses |
| --- | --- | --- | --- |
| Improved JSON store | Good short-term patch | Minimal architecture change, no new dependencies, easy Windows development, keeps current tests simple | Weak concurrency, poor query/update ergonomics, no real transactions, file-size growth, difficult multi-tenant isolation |
| SQLite with app-level vector search | Best next storage step | Built into Python, Windows-friendly, transactional, WAL support, easy backups, good document/chunk relationships, no external server, can keep NumPy similarity for now | No native high-performance vector index without extensions, requires schema/migration work, concurrent writes still serialized |
| PostgreSQL with pgvector | Best later SaaS-scale target | Strong concurrency, transactional integrity, production operations model, native vector indexing, natural multi-tenant data model | More setup burden, external service required, Windows development friction, new dependencies, operational cost, premature for current local-first project |

## 4. Recommended Storage Approach

The recommended path is staged:

1. First harden the existing JSON store enough to remove known correctness risks.
2. Then introduce SQLite as the durable local storage backend for documents, chunks, and embeddings.
3. Defer PostgreSQL with pgvector until the project needs real multi-user SaaS deployment, larger corpora, background ingestion, or hosted production operations.

SQLite is the best Phase 3.3 target because it materially improves persistence reliability and recovery while preserving the current self-hostable, free, Windows-friendly development model. PostgreSQL is eventually appropriate, but it is not the smallest credible next step for this repository.

## 5. Proposed Implementation Stages

### Stage 3.3A: JSON correctness hardening

Modify only the current AI storage layer and tests.

Planned work:

- Fix chunk/vector alignment during document updates.
- Add a document deletion method and endpoint only if the product flow needs deletion in this milestone.
- Add an in-process read/write lock around ingestion, persistence, and retrieval snapshots.
- Validate loaded storage shape before accepting it.
- Reject embedding dimension/model mismatches with a clear recovery path.
- Use unique temp files, explicit flush, best-effort fsync, atomic replace, and temp cleanup.
- Add a storage manifest with storage version, embedding model, embedding dimension, chunking config, and created/updated timestamps.

Likely files:

- `ai-service/app/retrieval/store.py`
- `ai-service/app/main.py`
- `ai-service/app/models/schemas.py`
- `ai-service/tests/test_rag.py`
- `ai-service/tests/test_real_model_integration.py`
- `ai-service/README.md`

### Stage 3.3B: SQLite storage adapter

Introduce a storage interface and a SQLite-backed implementation.

Recommended tables:

- `storage_meta(key, value)`
- `documents(id, title, source_type, content_hash, metadata_json, created_at, updated_at, deleted_at)`
- `chunks(id, document_id, position, text, hash, metadata_json, created_at)`
- `embeddings(chunk_id, model_name, dimension, vector_blob, vector_norm, created_at)`
- `ingestion_runs(id, status, started_at, finished_at, error_message)`

Initial vector search can remain application-level:

- Load candidate vectors from SQLite.
- Use NumPy cosine/dot-product scoring as today.
- Keep BM25 in process or add SQLite FTS5 later as a separate optimization.

Likely files:

- `ai-service/app/retrieval/store.py`
- New storage module under `ai-service/app/retrieval/` or `ai-service/app/storage/`
- `ai-service/app/config.py`
- `ai-service/tests/`
- `ai-service/README.md`

### Stage 3.3C: Migration and compatibility

Add a safe migration path:

- If SQLite storage is missing and `vectors.json` exists, import it.
- Never delete the original JSON file automatically.
- Write a migration report with counts of documents, chunks, skipped records, and validation warnings.
- Keep a read-only fallback command for inspecting legacy JSON.

### Stage 3.3D: Future PostgreSQL/pgvector path

Defer until the product needs:

- Multiple organizations and workspaces.
- Role-based access control.
- Larger vector corpora.
- Production backup/restore workflows.
- Horizontal scaling or hosted deployment.

## 6. Migration and Backward Compatibility Strategy

Backward compatibility should preserve existing local users and test data:

- Continue reading existing `vectors.json` during the first SQLite boot.
- Store imported JSON as legacy source data, not as the source of truth after migration.
- Validate every imported chunk/vector pair before writing SQLite rows.
- Preserve document ids, chunk ids, titles, metadata, content hashes, and embedding dimensions.
- Record the embedding model name and chunking settings at migration time.
- Refuse automatic migration if vector dimensions or chunk/vector counts are inconsistent.
- Provide a documented recovery path: back up the broken file, delete or repair the new storage file, and re-run ingestion from the knowledge base.

## 7. Security and Data Isolation Risks

Confirmed current risks:

- The AI service has no workspace or tenant boundary in its storage schemas.
- All documents and vectors share one store.
- Metadata is arbitrary and should be treated as untrusted.
- Encoded document payloads do not have explicit service-level size limits.
- The AI service should not be directly exposed without authentication, network restrictions, or a trusted backend proxy.

Recommended storage-level mitigations before multi-tenancy:

- Add `workspace_id` only when the application is ready to enforce it end to end.
- Keep provider credentials out of document, metadata, report, and vector storage.
- Validate metadata keys and value sizes before persistence.
- Avoid storing raw uploaded documents unless retention and deletion behavior are defined.
- Add request size limits at the AI service boundary.

## 8. Test Plan

High-priority tests for Phase 3.3:

- Storage persists and reloads across service restarts.
- Corrupted JSON or SQLite storage fails loudly and preserves the original data.
- Interrupted writes do not replace the last valid store.
- Duplicate ingestion is skipped without changing retrieval behavior.
- Updated document ingestion replaces the correct chunks and vectors.
- Deleted document cleanup removes associated chunks and embeddings.
- Vector rows remain aligned with chunk rows after insert, update, and delete operations.
- Concurrent ingestion requests cannot silently overwrite each other.
- Retrieval during ingestion sees either the old complete index or the new complete index, not a mixed state.
- Embedding model or dimension changes trigger reindexing or a clear error.
- Migration from legacy JSON preserves retrieval results.
- Empty knowledge base returns a safe abstention.
- Large metadata and malformed encoded documents are rejected safely.

## 9. Explicitly Deferred Features

These should remain out of Phase 3.3 unless the milestone is re-scoped:

- PostgreSQL and pgvector production deployment.
- Docker and external infrastructure.
- Authentication, RBAC, billing, and organizations.
- Background job queues.
- Cloud object storage for uploaded files.
- Multi-region replication.
- LLM-based semantic judging.
- Replacing BM25, semantic retrieval, or hybrid RRF.
- Changing the embedding model.
- React or frontend framework migration.

## 10. Open Decisions

The next implementation milestone needs product decisions on:

- Expected corpus size for a self-hosted workspace.
- Whether AskWell Lite should store raw uploaded documents or only extracted text/chunks.
- Whether document deletion must be exposed in the UI during Phase 3.3.
- Whether SQLite should become the default immediately or after a JSON-hardening release.
- Whether the AI service will ever be directly network-exposed or always called through the Node backend.
- How soon multiple workspaces or organizations are expected.

## Exact First Implementation Milestone

Implement Stage 3.3A: JSON storage correctness hardening.

The first concrete milestone should:

1. Fix vector/chunk alignment on document update.
2. Add storage shape and embedding compatibility validation.
3. Add in-process locking for ingestion and retrieval snapshots.
4. Strengthen atomic write behavior with fsync and temp cleanup.
5. Add deterministic tests for update alignment, corrupt storage, interrupted writes, duplicate ingestion, and concurrent operations.

This keeps the current architecture intact while removing the most serious correctness risks before introducing SQLite.
