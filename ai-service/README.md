# AskWell Lite AI Service

FastAPI service for AskWell Lite retrieval-augmented answering.

The service is optional. The browser talks to the existing Node.js server, and Node proxies AI requests to this service when `ASKWELL_AI_SERVICE_URL` is configured.

```text
Browser -> Node.js backend -> FastAPI AI service -> embeddings/retrieval/generation
```

## Virtual Environment

Create the environment inside this directory so dependencies do not install globally:

```powershell
cd ai-service
python -m venv .venv
.\.venv\Scripts\activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Model Configuration

Default model:

```text
sentence-transformers/all-MiniLM-L6-v2
```

It produces 384-dimensional normalized embeddings.

Environment variables:

- `ASKWELL_EMBEDDING_MODEL`: Sentence Transformers model name.
- `ASKWELL_AI_DATA_DIR`: JSON vector storage directory.
- `ASKWELL_VECTOR_STORAGE_BACKEND`: `auto`, `sqlite`, or `json`. Default `auto`.
- `ASKWELL_SQLITE_VECTOR_PATH`: optional SQLite database path. Default `ASKWELL_AI_DATA_DIR/askwell-vectors.sqlite3`.
- `ASKWELL_CHUNK_SIZE`: text chunk size, default `700`.
- `ASKWELL_CHUNK_OVERLAP`: chunk overlap, default `120`.
- `ASKWELL_TOP_K`: default retrieval size.
- `ASKWELL_INSUFFICIENT_SCORE_THRESHOLD`: minimum hybrid score, default `0.01`.
- `ASKWELL_BM25_SCORE_THRESHOLD`: strong keyword evidence threshold, default `3.0`.
- `ASKWELL_SEMANTIC_SCORE_THRESHOLD`: strong semantic evidence threshold, default `0.38`.
- `ASKWELL_HYBRID_SCORE_THRESHOLD`: minimum hybrid support threshold, default `0.02`.
- `ASKWELL_SEMANTIC_MARGIN_THRESHOLD`: minimum gap between the top two semantic matches, default `0.08`.
- `ASKWELL_QUERY_COVERAGE_THRESHOLD`: minimum query-token coverage in retrieved evidence for keyword-led answers, default `0.45`.
- `ASKWELL_MIN_EVIDENCE_CHUNKS`: minimum supporting retrieved chunks, default `1`.
- `ASKWELL_MIN_RETRIEVAL_AGREEMENT`: minimum overlap between retrieval signals, default `1`.
- `ASKWELL_LLM_PROVIDER`: default `extractive`. Use `openai` or `openai-compatible` for hosted LLM generation.
- `ASKWELL_LLM_API_KEY`: server-side key for the configured LLM provider.
- `ASKWELL_LLM_MODEL`: model name, default `gpt-4o-mini`.
- `ASKWELL_LLM_BASE_URL`: OpenAI-compatible base URL, default `https://api.openai.com/v1`.
- `ASKWELL_LLM_TIMEOUT_SECONDS`: generation timeout, default `20`.
- `ASKWELL_LLM_RETRIES`: retries for transient provider failures and rate limits, default `2`.
- `ASKWELL_LLM_MAX_OUTPUT_TOKENS`: maximum generated answer tokens, default `350`.
- `ASKWELL_AI_REQUIRE_TOKEN`: set to `1` to require a Node-to-FastAPI service token on all non-health routes.
- `ASKWELL_AI_SERVICE_TOKEN`: shared secret expected in the `X-AskWell-AI-Token` request header when service-token protection is enabled.

The first real model run downloads weights from Hugging Face. Unauthenticated downloads work, but Hugging Face may rate-limit them.

## LLM Generation

AskWell supports two generation modes:

- `extractive`: free default mode. It combines retrieved chunks and cites their real chunk IDs.
- `openai-compatible`: calls a hosted `/chat/completions` API using a server-side API key.

Enable OpenAI-compatible generation:

```powershell
$env:PYTHONPATH = "ai-service"
$env:ASKWELL_AI_DATA_DIR = "ai-service/data"
$env:ASKWELL_LLM_PROVIDER = "openai-compatible"
$env:ASKWELL_LLM_API_KEY = "sk-..."
$env:ASKWELL_LLM_MODEL = "gpt-4o-mini"
ai-service\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir ai-service --host 127.0.0.1 --port 8001
```

The API key stays inside the Python service process. It is not sent to the browser, stored in the workspace JSON, or included in exports.

The LLM prompt instructs the model to answer only from retrieved chunks, treat document content as evidence rather than instructions, return concise customer-facing JSON, and admit insufficient context. AskWell still validates the model response server-side: every citation must match a retrieved chunk ID, and fabricated citations are rejected.

The service avoids unnecessary provider calls when retrieval evidence is insufficient. Evidence checks require strong BM25 or semantic evidence, enough retrieval support, and query coverage for keyword-led answers. RRF scores are treated as support signals, not calibrated probabilities.

## Run

```powershell
$env:PYTHONPATH = "ai-service"
$env:ASKWELL_AI_DATA_DIR = "ai-service/data"
ai-service\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir ai-service --host 127.0.0.1 --port 8001
```

For a production-style local deployment, protect non-health FastAPI routes with a service token and configure Node with the same token:

```powershell
$env:ASKWELL_AI_REQUIRE_TOKEN = "1"
$env:ASKWELL_AI_SERVICE_TOKEN = "<long random node-to-ai token>"
ai-service\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir ai-service --host 127.0.0.1 --port 8001
```

`GET /health` remains public for local process checks. `/config`, `/ingest`, `/documents`, `/diagnostics`, `/documents/{id}`, and `/answer` require `X-AskWell-AI-Token` when token protection is enabled. The `/config` response is sanitized and reports only booleans for token presence.

Then start Node from the repo root:

```powershell
$env:NODE_ENV = "development"
$env:ASKWELL_AI_SERVICE_URL = "http://127.0.0.1:8001"
npm start
```

## Ingest Documents

Index the current AskWell workspace articles through Node:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:4173/api/ai/ingest -ContentType "application/json" -Body "{}"
```

The service also accepts direct `POST /ingest` payloads containing:

- `articles`
- `documents`
- `encoded_documents`

Supported encoded file types: `.txt`, `.md`, `.markdown`, `.pdf`, and `.docx`.

## Document Lifecycle API

The normal browser path is still Browser -> Node -> FastAPI. Direct FastAPI calls are useful for local diagnostics.

## Phase 3.6 evaluation

The deterministic Phase 3.6 integration suite uses only synthetic support data and temporary SQLite storage. It does not call live LLM providers and does not modify the real workspace or production vector database.

Run it from the project root with:

```powershell
cd ai-service
.\.venv\Scripts\python.exe -m app.evaluation.phase36
```

The suite writes:

- `ai-service/evaluation/phase-3.6-report.json`
- `ai-service/evaluation/phase-3.6-report.md`

The report covers retrieval metrics, answer/citation checks, document lifecycle workflows, mocked failure handling, local performance timings, and frontend validation scope. Browser automation is reported only when available; the current repository relies on Node VM frontend tests rather than a real browser driver.

## Phase 3.7 quality and integration validation

Phase 3.7 builds on the Phase 3.6 corpus without changing labels. It compares the preserved baseline report against the current RAG implementation, records question-level improvements/regressions, and starts real local Node.js and FastAPI processes for an HTTP integration check.

Run it from the project root with:

```powershell
cd ai-service
.\.venv\Scripts\python.exe -m app.evaluation.phase37
```

The suite writes:

- `ai-service/evaluation/phase-3.7-report.json`
- `ai-service/evaluation/phase-3.7-report.md`

The cross-process check uses temporary SQLite storage, deterministic test embeddings, and the extractive generator. It exercises Node-to-FastAPI ingestion, document listing, answering with citations, update, deletion, malformed answer input, and AI-service-unavailable handling. It does not automate browser DOM rendering and does not make live LLM calls.

### Ingest or Update

`POST /ingest` creates new documents and updates existing documents by stable `id`.

Behavior:

- Document titles and filenames are metadata, not unique identifiers.
- Unchanged documents are skipped by content hash and return `status: "unchanged"` in `document_statuses`.
- Changed documents replace only their own chunks and embeddings.
- Failed embedding or storage writes roll back and preserve the previous committed document.
- Duplicate chunk text inside a document is skipped, while duplicate content across different documents keeps separate ownership.

Example response fields:

```json
{
  "ingested_documents": 1,
  "chunks_indexed": 2,
  "duplicates_skipped": 0,
  "unchanged_skipped": 0,
  "document_statuses": [
    { "id": "trial", "status": "created", "chunks_indexed": 2 }
  ],
  "status": "ok"
}
```

### List Indexed Documents

`GET /documents` returns indexed document metadata:

```json
[
  {
    "id": "trial",
    "title": "Trial policy",
    "source_type": "article",
    "content_hash": "...",
    "chunk_count": 1,
    "created_at": "2026-11-08T10:00:00.000Z",
    "updated_at": "2026-11-08T10:00:00.000Z",
    "metadata": { "tags": ["billing"] }
  }
]
```

### Delete

`DELETE /documents/{document_id}` deletes exactly one document. SQLite uses foreign-key cascades to remove the document's chunks and embeddings in the same transaction. The JSON backend removes the document's chunks, vectors, and content hash in one atomic JSON commit.

Successful response:

```json
{
  "document_id": "trial",
  "deleted": true,
  "chunks_deleted": 1,
  "status": "deleted"
}
```

Unknown IDs return `404 Document not found`. Repeating a delete is therefore predictable: the first call succeeds, later calls return 404 through the API.

### Retrieval Consistency

Retrieval reads committed snapshots. After an update, BM25, semantic, and hybrid retrieval use the new chunks and vectors. After deletion, deleted chunks cannot appear in retrieval results or generated citations. During ingestion, readers observe either the previous committed index or the completed new index, not a partial update.

## Operational Diagnostics

`GET /diagnostics` returns read-only storage and indexing diagnostics. The Node app exposes the same data through `GET /api/ai/diagnostics`, so browsers do not contact FastAPI directly.

Diagnostics include:

- storage backend: `sqlite` or `json`,
- overall status: `healthy` or `needs_attention`,
- readable and writable checks,
- SQLite `PRAGMA integrity_check` where supported,
- document, chunk, and embedding counts,
- configured vector dimension and dimension consistency,
- manifest/configuration compatibility,
- sanitized last error messages,
- per-document status and retry eligibility.

The endpoint never exposes absolute storage paths, provider keys, environment variables, stack traces, or connection strings. Checks do not migrate, repair, delete, or overwrite storage.

If `ASKWELL_AI_REQUIRE_TOKEN=1` is set without `ASKWELL_AI_SERVICE_TOKEN`, startup fails instead of serving an unprotected API by accident.

Failed ingestion attempts are recorded in memory as document operation diagnostics. If the previous indexed version still exists, diagnostics marks the document as `Needs attention` while keeping it indexed. Retry is appropriate only when source content is still available, such as an existing workspace article. If source content is unavailable, supply replacement content through the document update workflow instead of relying on AskWell to reconstruct it.

## Vector Storage

AskWell can use either SQLite storage or the legacy JSON storage backend for the AI-service retrieval index.

Default behavior:

- `ASKWELL_VECTOR_STORAGE_BACKEND=auto` uses SQLite.
- If no SQLite database exists and a compatible `vectors.json` exists, AskWell migrates it into SQLite.
- If SQLite already exists, AskWell uses it and does not import JSON again.
- `ASKWELL_VECTOR_STORAGE_BACKEND=json` explicitly uses the legacy JSON store for development or recovery.

SQLite database default path:

```text
ASKWELL_AI_DATA_DIR/askwell-vectors.sqlite3
```

Legacy JSON path:

```text
ASKWELL_AI_DATA_DIR/vectors.json
```

The Node static-file allowlist does not expose the AI data directory.

### SQLite Storage

SQLite is the primary local persistence backend. It uses Python's standard-library `sqlite3` module, so no external database service is required.

Schema:

- `storage_meta(key, value)`: schema version, embedding provider/model, embedding dimension, normalization flag, and chunking configuration.
- `documents(id, title, source_type, content_hash, metadata_json, created_at, updated_at, deleted_at)`.
- `chunks(id, document_id, position, text, hash, metadata_json, created_at)`.
- `embeddings(chunk_id, model_name, dimension, vector_blob, vector_norm, created_at)`.
- `ingestion_runs(id, status, started_at, finished_at, error_message)`.

SQLite foreign keys are enabled on every connection. Chunks belong to documents, and embeddings belong to chunks. Embedding vectors are stored as `float32` binary blobs and are validated for dimension and numeric safety when written and read.

SQLite runs in WAL mode where supported. WAL allows readers to observe the last committed index while ingestion is preparing or committing updates. It does not provide distributed locking and should not be shared by multiple AI-service processes.

Transactional behavior:

- New documents commit document rows, chunk rows, and embedding rows atomically.
- Updating a document replaces only that document's chunks and embeddings.
- Deleting a document removes its chunks and embeddings through foreign-key cascade in one transaction.
- Failed updates roll back and preserve the previous committed document state.
- Unchanged documents are skipped by content hash.
- Multiple documents with identical content keep separate chunk ownership, so citations remain document-specific.

### JSON Storage

The legacy JSON backend stores the AI-service retrieval index in `vectors.json` under `ASKWELL_AI_DATA_DIR`.

The file contains:

- `manifest`: storage schema version, embedding provider/model, embedding dimension, normalization flag, chunking configuration, creation time, and last-updated time.
- `chunks`: chunk records with document id, title, text, hash, and metadata.
- `vectors`: embedding rows aligned by position with `chunks`.
- `document_hashes`: source document content hashes used to skip unchanged documents.
- `embedding_dimension`: retained for compatibility checks.

The store enforces `len(chunks) == len(vectors)` whenever data is loaded, persisted, or committed after ingestion. Document updates preserve unrelated document vectors and replace only the updated document's chunks.

Document deletion in the JSON backend atomically persists the removal of matching chunks, aligned vectors, and the document content hash. The previous valid file remains intact if the write fails.

### Validation and Recovery

On startup the service validates the storage file before serving answers. It rejects:

- malformed JSON,
- missing top-level fields,
- invalid chunk records,
- chunk/vector count mismatches,
- non-numeric, NaN, infinite, or incorrectly shaped vectors,
- embedding dimension mismatches,
- incompatible embedding model metadata,
- unsupported storage schema versions,
- incompatible chunking configuration on re-ingestion.

AskWell does not silently reseed or overwrite corrupted vector storage. If validation fails:

1. Stop the AI service.
2. Preserve the failing `vectors.json` for inspection or backup.
3. Restore a known-good file, or remove the invalid file and re-run ingestion from the source knowledge base.

Legacy `vectors.json` files without a manifest are rejected when they contain chunks because the embedding model cannot be verified. If you have manually confirmed that a legacy file was built with the current embedding model and dimension, you can temporarily set:

```powershell
$env:ASKWELL_ALLOW_LEGACY_VECTOR_STORAGE = "1"
```

Then start the service and re-ingest documents so a manifest-backed file is written. Do not use this override for unknown or shared data.

### Atomic Persistence

Persistence writes use a unique temporary file in the same directory, flush file buffers, call `fsync()` on the temporary file, atomically replace the destination, and clean up the temporary file after failures. On platforms that support parent-directory syncing, the store also attempts to sync the storage directory.

If a write fails, the previous valid `vectors.json` remains in place and the in-memory store rolls back the failed commit.

### Concurrency Guarantees

The JSON store uses in-process synchronization:

- Retrieval uses immutable snapshots of chunks and vectors.
- Ingestion plans work from a consistent snapshot.
- Expensive embedding generation happens outside the write lock.
- Commit retries if another ingestion completed first.
- Completed ingestions cannot silently overwrite one another inside one Python process.

Limitations:

- This is not multi-process or distributed locking.
- Running multiple AI-service processes against the same `vectors.json` is unsupported.
- JSON storage remains a local MVP persistence layer, not a replacement for SQLite or PostgreSQL when multi-user concurrency is required.

### JSON to SQLite Migration

Automatic migration happens only in `auto` or `sqlite` mode when:

- the SQLite database does not already exist,
- `vectors.json` exists,
- the JSON file passes Phase 3.3A validation,
- the manifest is compatible with the current embedding model and dimension.

Migration imports documents, chunks, embeddings, metadata, hashes, and vector values transactionally. The original `vectors.json` is never deleted, renamed, or overwritten.

Migration report path:

```text
ASKWELL_AI_DATA_DIR/sqlite-migration-report.json
```

The report includes source file, destination database, document count, chunk count, embedding count, skipped records, validation warnings, status, and timestamp.

If migration fails, the SQLite transaction rolls back and the JSON file remains untouched. Fix the source issue or continue with the explicit JSON backend:

```powershell
$env:ASKWELL_VECTOR_STORAGE_BACKEND = "json"
```

Back up `vectors.json` and the complete SQLite file family before manual recovery work. With WAL mode enabled, that means `askwell-vectors.sqlite3`, plus `askwell-vectors.sqlite3-wal` and `askwell-vectors.sqlite3-shm` when present. Stop the service before copying these files.

### Explicit Legacy JSON Migration

Legacy JSON files created before Phase 3.3A may not contain a storage manifest. Normal application startup still rejects non-empty manifest-less JSON because the embedding model cannot be verified safely.

Use the dedicated migration command only for an explicit, operator-reviewed legacy migration. It is separate from normal startup and never enables global legacy compatibility.

Dry run:

```powershell
$env:PYTHONPATH = "ai-service"
ai-service\.venv\Scripts\python.exe -m app.migration.legacy_json `
  --source "path\to\vectors.json" `
  --destination "path\to\legacy-migration.sqlite3" `
  --report "path\to\legacy-compatibility-report.json" `
  --dry-run
```

If the report says `embedding_model_verification: "unknown"` or `reembedding_required: true`, do not import the vectors as compatible. Rebuild/re-ingest from source documents, or provide the model only when you have trustworthy operator provenance.

Confirmed migration with an operator-verified model:

```powershell
$env:PYTHONPATH = "ai-service"
ai-service\.venv\Scripts\python.exe -m app.migration.legacy_json `
  --source "path\to\vectors.json" `
  --destination "path\to\legacy-migration.sqlite3" `
  --report "path\to\legacy-migration-report.json" `
  --embedding-model "sentence-transformers/all-MiniLM-L6-v2" `
  --expected-dimension 384 `
  --confirm-migration
```

The command refuses to import without `--confirm-migration`, refuses populated SQLite destinations, validates chunk/vector alignment, validates finite normalized vectors, preserves the source JSON, and records migration provenance in `storage_meta`.

Recorded provenance includes:

- original source path,
- source SHA256 checksum,
- migration timestamp,
- legacy format/schema version,
- embedding model value supplied for the migration,
- embedding model verification status,
- embedding dimension,
- whether re-embedding was required,
- migration implementation version.

Warnings:

- Do not infer model compatibility from vector dimension alone.
- Do not pass `--embedding-model` unless the model is known from trustworthy project history, deployment records, or operator knowledge.
- The explicit migration command does not re-embed data.

## Answer

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:4173/api/ai/answer -ContentType "application/json" -Body '{"question":"What was saved through the API?","topK":3}'
```

Responses include:

- `answer`
- `sources`
- `citations`
- `source_document_ids`
- `source_chunk_ids`
- retrieved `chunks`
- `insufficient_context`
- generation `mode`
- `retrieval_strategy`
- `fallback_reason`
- `generation.provider`
- `generation.model`
- `generation.latency_ms`
- `generation.token_usage` when returned by the provider
- `generation.citation_coverage`

The default generator is `extractive`: it answers only by quoting/combining retrieved chunks and cites real chunk IDs. It is not an LLM.

If `ASKWELL_LLM_PROVIDER=openai-compatible`, the response uses the same shape and includes provider/model metadata. Provider failures return structured HTTP errors where practical:

- Missing API key or rejected credentials: configuration error.
- Provider timeout: timeout error.
- Rate limit: rate-limit error after configured retries.
- Malformed provider response or fabricated citations: provider response error.
- Insufficient retrieval evidence: no LLM call; response includes `insufficient_context: true` and `fallback_reason`.

## Evaluation

Core tests without model downloads:

```powershell
$env:PYTHONPATH = "ai-service"
ai-service\.venv\Scripts\pytest.exe ai-service\tests -q
```

Real model validation:

```powershell
$env:PYTHONPATH = "ai-service"
$env:ASKWELL_RUN_REAL_MODEL_TESTS = "1"
ai-service\.venv\Scripts\pytest.exe ai-service\tests\test_real_model_integration.py -q
```

Real LLM provider validation is opt-in so normal tests never require paid API calls:

```powershell
$env:PYTHONPATH = "ai-service"
$env:ASKWELL_RUN_REAL_LLM_TESTS = "1"
$env:ASKWELL_LLM_API_KEY = "sk-..."
$env:ASKWELL_LLM_MODEL = "gpt-4o-mini"
ai-service\.venv\Scripts\pytest.exe ai-service\tests\test_real_llm_provider.py -q
```

The real-model test writes:

```text
ai-service/evaluation/real-model-report.json
```

The static evaluation fixture is:

```text
ai-service/evaluation/fixtures.json
```

That fixture contains synthetic support articles and labeled questions for exact keyword, paraphrase, synonym, contextual, multi-source, ambiguous, and unanswerable retrieval cases. Automated retrieval metrics can cover Recall@K, Precision@K, MRR, and Hit Rate@K where labels exist. Answer faithfulness remains a human-judged quality signal; the tests verify response structure, citation validation, and failure handling, not full factual perfection.

Generate the calibrated Phase 3.2.2 report with the real local embedding model:

```powershell
$env:PYTHONPATH = "ai-service"
ai-service\.venv\Scripts\python.exe -m app.evaluation.report --embedding-provider real
```

The report is written to:

```text
ai-service/evaluation/phase-3.2.2-report.json
```

It records dataset size, retrieval metrics, deterministic generation checks, latency, token usage when available, provider configuration without secrets, failure checks, known weaknesses, and a before-versus-after comparison against `ai-service/evaluation/phase-3.2.1-report.json` when that baseline exists. If `ASKWELL_LLM_PROVIDER=openai-compatible` and `ASKWELL_LLM_API_KEY` are set, the same command runs a small live-provider validation sample. Without those variables, live LLM validation is marked `not_run`.

Generate the Phase 3.2.3 live-provider validation report:

```powershell
$env:PYTHONPATH = "ai-service"
ai-service\.venv\Scripts\python.exe -m app.evaluation.live_provider_report --embedding-provider real
```

The report is written to:

```text
ai-service/evaluation/phase-3.2.3-live-llm-report.json
```

It uses a small fixed scenario set: answerable, paraphrased answerable, multi-source, ambiguous, and unanswerable. Actual provider observations are recorded only when all required OpenAI-compatible provider variables are configured. For synthetic evaluation cases, the report may include generated answer text and retrieved evidence snippets so answer-quality failures can be diagnosed later. Mocked timeout, rate-limit, invalid-key, and invalid-citation checks are reported separately from live observations. Provider credentials are represented only as present or missing and are never written to the report.

## Troubleshooting

- Missing `sentence-transformers`: reinstall `requirements.txt` inside `ai-service/.venv`.
- Missing LLM API key: use `ASKWELL_LLM_PROVIDER=extractive` or set `ASKWELL_LLM_API_KEY` before starting the service.
- Invalid LLM credentials: verify the provider key and `ASKWELL_LLM_BASE_URL`; the service does not fall back to hidden browser keys.
- Provider timeouts or rate limits: increase `ASKWELL_LLM_TIMEOUT_SECONDS`, reduce traffic, lower `ASKWELL_LLM_MAX_OUTPUT_TOKENS`, or keep the free `extractive` provider enabled.
- Fabricated citations: the service rejects them; inspect retrieved chunks and provider output in tests before relaxing prompts.
- Model download is slow: rerun the command; cached weights are reused.
- Hugging Face rate limits: set `HF_TOKEN` in the shell before loading the model.
- Corrupted vector storage: stop the service, remove the JSON vector file under `ASKWELL_AI_DATA_DIR`, and re-ingest source documents.
- Empty answers: verify documents were ingested and lower `ASKWELL_INSUFFICIENT_SCORE_THRESHOLD` only if the retrieval scores justify it.
- Service unavailable in the frontend: confirm Node has `ASKWELL_AI_SERVICE_URL` and `/api/ai/health` returns `available: true`.

## Limitations

- Single-workspace only.
- JSON vector storage is an MVP layer, not PostgreSQL/pgvector.
- The default `extractive` generator is not LLM generation.
- OpenAI-compatible generation is implemented, but answer faithfulness is not proven by automated tests alone.
- Hosted LLM usage may cost money and inherits provider availability, latency, and rate-limit constraints.
- Reranking is an interface with a no-op MVP implementation.
- Relevance thresholds need more tuning after the knowledge base has more than the current demo article.
