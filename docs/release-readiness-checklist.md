# AskWell Lite Release Readiness Checklist

Use this checklist before a controlled self-hosted MVP deployment. It does not certify the app as production-ready or multi-tenant.

## Phase 4.1 Verification Evidence

Last verified: 2026-11-08.

- `npm run check`: passed.
- `npm test`: passed with 46 Node tests.
- `ai-service\.venv\Scripts\python.exe -m pytest ai-service\tests -q -rs --basetemp .tmp-pytest`: passed with 95 Python tests and 2 opt-in tests skipped.
- Fresh-environment smoke: passed from an isolated temporary project copy using temporary Node workspace storage and temporary FastAPI SQLite storage.
- Fresh smoke covered weak production startup rejection, Node startup, FastAPI startup, health checks, admin-token protection, FastAPI service-token protection, Node-to-FastAPI token forwarding, document ingestion, extractive answer with citation, indexed-document persistence after restart, and graceful process shutdown.
- Browser-level smoke: passed in the app browser against an isolated copy for dashboard load, Knowledge page, document listing/details, diagnostics, re-indexing, chat answer/citation rendering, insufficient-evidence response, service-unavailable feedback, Install page, and major navigation.
- Browser deletion was not performed through Computer Use because it is a local delete action; deletion remains covered by automated HTTP/Node tests.
- Backup/restore smoke: passed for SQLite and JSON fallback using isolated temporary storage. SQLite backup copied `askwell-vectors.sqlite3`, `askwell-vectors.sqlite3-wal`, and `askwell-vectors.sqlite3-shm`.
- Basic security smoke: passed for unauthenticated/invalid admin rejection, protected reads, service-token rejection, host-header rejection, request-size limit, static allowlist, security headers coverage in automated tests, rate limiting on AI answer route, sanitized config, and AI-service unavailable handling.
- Basic local load smoke: passed with 10 concurrent mocked answer requests and observed AI answer rate limiting. This is not a formal load test.
- Real embedding integration: passed with `sentence-transformers/all-MiniLM-L6-v2` and 384-dimensional embeddings.
- Real LLM provider integration: pending because `ASKWELL_RUN_REAL_LLM_TESTS`, provider configuration, and API key were not available to the agent subprocess. No live LLM calls were made.

## Configuration

- [x] `NODE_ENV=production` is set for the Node server.
- [x] `ASKWELL_ADMIN_TOKEN` is set to a long random value and is not a placeholder.
- [x] `ASKWELL_ALLOWED_HOSTS` contains only the public hostnames that should serve AskWell.
- [x] `ASKWELL_AI_SERVICE_URL` points to the private FastAPI service URL, if AI features are enabled.
- [x] `ASKWELL_AI_SERVICE_TOKEN` is set when the AI service is reachable outside the same private host.
- [x] `ASKWELL_AI_REQUIRE_TOKEN=1` is set for the FastAPI service when service-token protection is required.
- [x] Hosted LLM variables are unset unless live provider calls are intentionally enabled.
- [x] No real secrets are committed to Git, README files, reports, or screenshots.

## Startup

- [x] Node starts with `npm start` and refuses unsafe production configuration.
- [x] FastAPI starts with `uvicorn app.main:app --app-dir ai-service --host 127.0.0.1 --port 8001`.
- [x] `GET /api/health` returns HTTP 200.
- [x] `GET /api/config` returns only booleans and sanitized configuration.
- [x] `GET /api/ai/health` is healthy when AI features are enabled, or returns a useful unavailable response when disabled.
- [x] Shutdown with `Ctrl+C` or SIGTERM exits cleanly.

## Security

- [x] Workspace reads, exports, saves, document listing, diagnostics, ingestion, and deletion require the admin token outside development mode.
- [x] The FastAPI service rejects non-health routes without `X-AskWell-AI-Token` when `ASKWELL_AI_REQUIRE_TOKEN=1`.
- [x] Static file access is restricted to the explicit public asset allowlist.
- [x] Private files such as `.git`, `.env`, `data`, `server.mjs`, `tests`, package metadata, and `ai-service` internals are not served.
- [x] Security headers and the restrictive CSP are present on HTML/API responses.
- [x] Cross-origin browser access is not enabled unless a trusted reverse proxy explicitly handles it.
- [x] Host header allowlisting is configured for the deployment hostname.

## Storage and Backup

- [x] Node workspace storage path is persistent and backed up: `data/workspace.json`.
- [x] AI-service storage path is persistent and backed up: `ai-service/data/askwell-vectors.sqlite3` by default.
- [x] A backup has been created before the release.
- [x] Restore has been rehearsed in an isolated directory.
- [x] Diagnostics show healthy storage after restart.

SQLite backup note: copy the full SQLite file family while services are stopped: `askwell-vectors.sqlite3`, `askwell-vectors.sqlite3-wal`, and `askwell-vectors.sqlite3-shm` when present.

## Validation

- [x] `npm run check` passes.
- [x] `npm test` passes.
- [x] `ai-service\.venv\Scripts\python.exe -m pytest ai-service\tests -q -rs --basetemp .tmp-pytest` passes.
- [x] Real embedding integration is run only when the model is already available or model download is intended.
- [ ] Real LLM validation is run only when credentials and opt-in flags are intentionally configured.
- [x] Browser automation is recorded as not run unless a real browser automation tool is available.

## Known Scope Limits

- [x] Single workspace only.
- [x] No multi-user accounts, OAuth, RBAC, tenant isolation, or audit log.
- [x] No background job queue.
- [x] No PostgreSQL or pgvector.
- [x] No formal penetration test or load test has been completed.
