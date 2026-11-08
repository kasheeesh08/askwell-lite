# AskWell Lite

A free starter inspired by the “coding agents build a SaaS” workflow: a support-chat SaaS cockpit with overview metrics, a knowledge base, conversation triage, agent-style launch audits, widget settings, live preview, export, optional API persistence, optional RAG service integration, and an embeddable widget script.

## Features

- Support cockpit with launch score, source-match rate, readiness checks, and recent questions.
- Knowledge base with local article creation, delete controls, search, and source-backed answers.
- Document management UI for indexed document details, re-indexing, replacement-content updates, operation status, and deletion.
- Inbox with open/resolved conversation states.
- Agent build room that simulates a lead/builder/QA audit for the static MVP.
- Widget settings for brand, accent color, and welcome message.
- JSON workspace export for articles, conversations, and settings.
- Standalone `askwell-widget.js` script for embedding on another static page.
- Optional Node server with API persistence, security headers, rate limiting, health checks, and bounded payload sanitization.
- Optional Python FastAPI AI service for local RAG experiments.
- No database or paid AI key required for the core static app.

## Run locally

Open `index.html` in a browser. No package install is required.

For a local development server:

```bash
NODE_ENV=development npm start
```

PowerShell:

```powershell
$env:NODE_ENV = "development"; npm start
```

Then open `http://127.0.0.1:4173`.

The server stores workspace data in `data/workspace.json`, which is intentionally ignored by Git.

## Production Mode

`server.mjs` is a dependency-free Node server for self-hosting. It serves the app and exposes:

- `GET /api/health` for uptime and storage checks.
- `GET /api/workspace` for loading settings, articles, and conversations.
- `PUT /api/workspace` for persisting workspace changes.
- `GET /api/export` for a JSON export.
- `GET /api/ai/health` for optional AI service status.
- `POST /api/ai/ingest` for indexing current workspace articles or supplied documents.
- `GET /api/ai/documents` for indexed document metadata.
- `GET /api/ai/diagnostics` for read-only storage and indexing diagnostics.
- `DELETE /api/ai/documents/:id` for deleting one indexed document and its chunks.
- `POST /api/ai/answer` for asking the configured AI service.

Production protection:

```bash
NODE_ENV=production ASKWELL_ADMIN_TOKEN=replace-with-a-long-random-token npm start
```

Outside `NODE_ENV=development`, the server refuses to start unless `ASKWELL_ADMIN_TOKEN` is configured with a non-placeholder value of at least 16 characters. Protected API calls must include the `X-AskWell-Admin-Token` header. Use `NODE_ENV=development npm start` only for local demos.
In the app, open Install -> Widget settings and enter the same server admin token once. It is saved only in the browser's local storage and is not included in workspace exports.

The production server intentionally serves only the public application assets: `index.html`, `styles.css`, the allowlisted `src/*.js` frontend modules, and `askwell-widget.js`. Internal files such as `.git`, `data`, `.env`, `server.mjs`, `tests`, `.github`, package metadata, and `ai-service` internals are blocked.

Production reads that expose workspace or indexed-document data are protected too: `/api/workspace`, `/api/export`, `/api/ai/documents`, and `/api/ai/diagnostics` require the admin token outside development mode. `/api/config` is intentionally public but sanitized; it reports booleans and safe operational settings, never tokens or secrets.

Recommended production environment:

```powershell
$env:NODE_ENV = "production"
$env:PORT = "4173"
$env:ASKWELL_ADMIN_TOKEN = "<long random admin token>"
$env:ASKWELL_ALLOWED_HOSTS = "support.example.com"
$env:ASKWELL_AI_SERVICE_URL = "http://127.0.0.1:8001"
$env:ASKWELL_AI_SERVICE_TOKEN = "<long random node-to-ai token>"
npm start
```

`ASKWELL_ALLOWED_HOSTS` is a comma-separated host-header allowlist. If it is omitted in production, only `localhost`, `127.0.0.1`, and `::1` are allowed. AskWell does not emit permissive CORS headers; deploy it same-origin or behind a trusted reverse proxy.

The Node server forwards `ASKWELL_AI_SERVICE_TOKEN` to FastAPI as `X-AskWell-AI-Token` when configured. Expensive AI answer and ingestion endpoints have additional per-IP rate limits on top of the global API limit.

See `.env.example` for a copyable configuration template and `docs/release-readiness-checklist.md` for the release checklist.

## Optional RAG Service

Phase 3 adds a separate Python FastAPI service in `ai-service/`. The browser never talks to it directly. The path is:

```text
Browser / widget -> Node server -> Python FastAPI AI service
```

Install and run it locally:

```powershell
cd ai-service
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8001
```

In another terminal, point the Node server at it:

```powershell
$env:NODE_ENV = "development"
$env:ASKWELL_AI_SERVICE_URL = "http://127.0.0.1:8001"
npm start
```

For a controlled production-style run with a private service token:

```powershell
$env:ASKWELL_AI_REQUIRE_TOKEN = "1"
$env:ASKWELL_AI_SERVICE_TOKEN = "<long random node-to-ai token>"
ai-service\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir ai-service --host 127.0.0.1 --port 8001
```

Start Node with the same `ASKWELL_AI_SERVICE_TOKEN`. Keep the FastAPI port bound to `127.0.0.1` or a private network unless an upstream gateway provides equivalent protection.

Then ingest the current workspace articles:

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:4173/api/ai/ingest -ContentType "application/json" -Body "{}"
```

Document lifecycle operations stay behind the Node server:

```powershell
Invoke-RestMethod http://127.0.0.1:4173/api/ai/documents
Invoke-RestMethod -Method Delete http://127.0.0.1:4173/api/ai/documents/article-id
```

The browser never calls the Python service directly. In production, ingestion and deletion require the same `X-AskWell-Admin-Token` write protection as workspace saves.

The Knowledge page can inspect indexed documents, show chunk counts and content hashes, re-index existing article documents, and submit replacement content through the same ingestion API while preserving the stable document ID.

It also includes a compact diagnostics card for storage health, backend type, counts, integrity status, and attention-required documents. Diagnostics are read-only and do not repair, migrate, delete, or rewrite storage. Retry actions reuse the same ingestion flow and only run when source content is still available in the workspace.

The AI service implements:

- Document normalization and chunking with overlap.
- Existing AskWell article ingestion.
- TXT, Markdown, PDF, and DOCX extraction through the ingestion layer.
- Content hashes, duplicate detection, and unchanged-document skips.
- Sentence Transformers embeddings for real local semantic vectors.
- SQLite vector storage by default, with a hardened JSON storage backend still available for development or recovery.
- BM25 retrieval, semantic vector retrieval, and hybrid Reciprocal Rank Fusion.
- A reranking interface with a no-op MVP implementation.
- A provider-independent generation interface.
- An explicit free `extractive` generator that answers only from retrieved chunks and cites actual chunk IDs.
- Optional OpenAI-compatible LLM generation with grounded prompts, timeout/retry handling, token usage tracking, and server-side citation validation.

The default AI service requires `sentence-transformers` from `ai-service/requirements.txt` for production embeddings. The automated Python tests inject a deterministic lexical embedding provider so tests do not download models or require paid LLM access. LLM provider tests use mocked HTTP responses by default; real provider calls are opt-in.

### AI Environment Variables

- `ASKWELL_AI_SERVICE_URL`: Node-to-Python service URL.
- `ASKWELL_AI_TIMEOUT_MS`: Node proxy timeout, default `8000`.
- `ASKWELL_EMBEDDING_MODEL`: Sentence Transformers model.
- `ASKWELL_AI_DATA_DIR`: AI vector store directory.
- `ASKWELL_CHUNK_SIZE`: chunk size.
- `ASKWELL_CHUNK_OVERLAP`: chunk overlap.
- `ASKWELL_BM25_SCORE_THRESHOLD`: strong keyword evidence threshold, default `3.0`.
- `ASKWELL_SEMANTIC_SCORE_THRESHOLD`: strong semantic evidence threshold, default `0.38`.
- `ASKWELL_HYBRID_SCORE_THRESHOLD`: minimum hybrid support threshold, default `0.02`.
- `ASKWELL_SEMANTIC_MARGIN_THRESHOLD`: minimum gap between the top two semantic matches, default `0.08`.
- `ASKWELL_QUERY_COVERAGE_THRESHOLD`: minimum query-token coverage in retrieved evidence for keyword-led answers, default `0.45`.
- `ASKWELL_MIN_EVIDENCE_CHUNKS`: minimum supporting retrieved chunks, default `1`.
- `ASKWELL_MIN_RETRIEVAL_AGREEMENT`: minimum overlap between retrieval signals, default `1`.
- `ASKWELL_LLM_PROVIDER`: `extractive` by default. Use `openai` or `openai-compatible` for hosted LLM generation.
- `ASKWELL_LLM_API_KEY`: server-side provider key. It is never exported to the browser workspace.
- `ASKWELL_LLM_MODEL`: provider model name, default `gpt-4o-mini`.
- `ASKWELL_LLM_BASE_URL`: OpenAI-compatible API base URL, default `https://api.openai.com/v1`.
- `ASKWELL_LLM_TIMEOUT_SECONDS`: generation timeout, default `20`.
- `ASKWELL_LLM_RETRIES`: retries for transient provider failures and rate limits, default `2`.
- `ASKWELL_LLM_MAX_OUTPUT_TOKENS`: maximum generated answer tokens, default `350`.

To enable real LLM answers locally:

```powershell
$env:ASKWELL_LLM_PROVIDER = "openai-compatible"
$env:ASKWELL_LLM_API_KEY = "sk-..."
$env:ASKWELL_LLM_MODEL = "gpt-4o-mini"
uvicorn app.main:app --host 127.0.0.1 --port 8001
```

The LLM is called only after retrieval finds sufficient evidence. Generated citations are accepted only when they reference retrieved chunk IDs, so fabricated citation IDs fail safely instead of being displayed as real sources.

### AI Evaluation

The reproducible starter evaluation fixture is in `ai-service/evaluation/fixtures.json`. It contains synthetic support articles and labeled questions for answerable, paraphrased, ambiguous, multi-source, and unanswerable cases; it is not customer data. The Python test suite covers ingestion, persisted embeddings, BM25 retrieval, semantic retrieval, hybrid retrieval, grounded citations, insufficient-context fallback, deterministic retrieval metrics, mocked LLM success/failure paths, rate-limit handling, malformed provider responses, timeout behavior, and citation validation. Automated tests check mechanics and citation correctness; they do not prove answer faithfulness without human review.

Generate the calibrated Phase 3.2.2 evaluation report:

```powershell
$env:PYTHONPATH = "ai-service"
ai-service\.venv\Scripts\python.exe -m app.evaluation.report --embedding-provider real
```

The report is written to `ai-service/evaluation/phase-3.2.2-report.json` and compares against the preserved Phase 3.2.1 baseline when available. It uses the synthetic corpus, records retrieval metrics for BM25, semantic search, and hybrid RRF, and runs deterministic generation/failure checks. Live OpenAI-compatible validation is included only when `ASKWELL_LLM_PROVIDER` and `ASKWELL_LLM_API_KEY` are configured in the shell; secrets are not written to the report.

The evidence gate intentionally does not treat RRF scores as calibrated probabilities. A question must have strong keyword or semantic evidence, retrieval support, and enough query coverage to avoid answering partially relevant unsupported questions.

Generate the Phase 3.2.3 live-provider validation report:

```powershell
$env:PYTHONPATH = "ai-service"
ai-service\.venv\Scripts\python.exe -m app.evaluation.live_provider_report --embedding-provider real
```

The report is written to `ai-service/evaluation/phase-3.2.3-live-llm-report.json`. It runs a small fixed scenario set and records actual provider results only when `ASKWELL_LLM_PROVIDER`, `ASKWELL_LLM_MODEL`, `ASKWELL_LLM_BASE_URL`, and `ASKWELL_LLM_API_KEY` are configured. For synthetic evaluation cases, the report may include generated answer text and retrieved evidence snippets to support quality debugging. The API key is never written to the report.

Known limitations:

- The current app is still single-workspace.
- The JSON vector store is an MVP storage layer, not pgvector.
- Document lifecycle management is synchronous. There is no background queue, retry dashboard, or raw uploaded-file storage.
- Replacement-content updates are typed into the UI; AskWell does not retain original uploaded files for later editing.
- The default `extractive` generator is not a hosted LLM. It is intentionally explicit so AskWell does not silently fake model output.
- Hosted LLM generation can cost money and depends on the configured provider's availability, latency, and rate limits.
- Real LLM integration tests are skipped unless explicitly enabled with provider credentials.
- PDF extraction requires `pypdf`; DOCX extraction uses built-in ZIP/XML parsing for basic `.docx` text.
- No multi-tenant isolation, RBAC, support inbox automation, or analytics pipeline has been added yet.

## Persistence Architecture

In server mode, workspace data is stored as JSON in `data/workspace.json`.

The server protects that file with:

- Atomic writes: data is written to a temporary file in the same directory, flushed, then renamed into place.
- Temporary-file cleanup after failed writes.
- Versioned updates: every workspace has a numeric `version`.
- Conflict detection: clients must send `expectedVersion` when saving.
- In-process write queueing so simultaneous saves are serialized inside one running Node process.
- Corruption protection: corrupted JSON is never silently replaced with seed data.

Initial seed data is written only when `data/workspace.json` does not exist.

## Backup and Restore

Back up the Node workspace and AI index while services are stopped. The SQLite store uses WAL mode, so copy the database file family, not only the main `.sqlite3` file:

```powershell
New-Item -ItemType Directory -Force backups
Copy-Item data\workspace.json backups\workspace.json
Copy-Item ai-service\data\askwell-vectors.sqlite3* backups\
```

Restore into a fresh or stopped deployment:

```powershell
Copy-Item backups\workspace.json data\workspace.json
Copy-Item backups\askwell-vectors.sqlite3* ai-service\data\
```

After restore, start FastAPI and Node, then check `/api/health`, `/api/ai/health`, and `/api/ai/diagnostics`. The diagnostics endpoint is read-only; it will not repair or rewrite storage by itself.

### Workspace Versioning

`GET /api/workspace` returns the current workspace, including:

```json
{
  "version": 1
}
```

`PUT /api/workspace` must include:

```json
{
  "expectedVersion": 1,
  "settings": {},
  "articles": [],
  "conversations": []
}
```

If the submitted version is stale, the server returns:

```text
409 Conflict
```

with the latest version and workspace. The browser app then reloads the latest server workspace and shows a conflict save state instead of silently overwriting newer data.

### Corruption Recovery

If `data/workspace.json` becomes corrupted, the server returns a meaningful error and leaves the corrupted file untouched.

Safe recovery procedure:

1. Stop the server.
2. Copy `data/workspace.json` somewhere safe for inspection.
3. Repair the JSON manually or replace it with a known-good export.
4. Restart the server.

If you intentionally want to reset the workspace, stop the server, remove `data/workspace.json`, and restart. The seed workspace will be recreated only because the file is missing.

### Persistence Limitations

- JSON persistence is reliable enough for a small self-hosted MVP, not for high-volume production.
- Concurrency protection is in-process only. Multiple Node processes writing the same file are not supported.
- There is no cross-machine locking.
- There are no automatic backups yet.
- PostgreSQL is still the recommended next persistence step for real multi-user production.

## Test

This repo uses Node's built-in test runner, so no dependencies are needed.

```bash
npm run check
npm test
```

Python RAG tests:

```powershell
$env:PYTHONPATH = "ai-service"
pytest ai-service/tests -q
```

The smoke suite verifies the cockpit render, add/delete/search article flows, chat answering, AI citation display, AI fallback behavior, inbox status updates, agent audit, settings, install snippet escaping, responsive/delete CSS rules, standalone widget boot flow, server workspace sanitization, atomic writes, failed-write recovery, corrupted JSON handling, initial workspace creation, version conflicts, concurrent updates, frontend save failure/conflict states, HTTP static-file restrictions, AI bridge proxy behavior, protected writes, invalid JSON handling, and security headers.

## Deploy on GitHub Pages

1. Push this folder to a GitHub repository.
2. Open the repository settings.
3. Go to Pages.
4. Choose Deploy from a branch.
5. Select the `main` branch and `/root` folder.
6. Save, then wait for GitHub Pages to publish the site.

The `.nojekyll` file keeps GitHub Pages from applying Jekyll processing to the static app.

## What is free

- Static app hosting on GitHub Pages, Netlify, or Cloudflare Pages free tiers.
- Browser-only knowledge base storage with `localStorage`.
- Self-hosted Node persistence with `data/workspace.json`.
- Simple retrieval answers without an AI API key.
- Embeddable widget script in `askwell-widget.js`.
- Local JSON export for moving the workspace data later.

## What costs money later

- Hosted AI APIs such as OpenAI, Anthropic, Gemini, or Groq beyond their free tier.
- Managed database, auth, email, analytics, and custom domain services.
- Production monitoring and higher traffic hosting.

## Upgrade path

1. Move article and conversation storage from `localStorage` to a database.
2. Replace the simple admin token with real authentication for workspace owners.
3. Replace the browser retrieval function in `src/app.js` with a server model route.
4. Keep model API keys only on the server.
5. Deploy the dashboard and widget script from the same domain.

## Files

- `index.html` is the app entry point.
- `styles.css` contains the responsive dashboard and widget preview styling.
- `src/` contains modular frontend state, API, retrieval, rendering, escaping, and validation code.
- `askwell-widget.js` is the drop-in widget script for other pages.
- `server.mjs` is the optional production-style Node server.
- `ai-service/` contains the optional FastAPI RAG service.
- `tests/smoke.test.mjs` contains the no-dependency smoke suite.
