# Phase 6D Vercel Hobby Function Limit Fix

## Problem

The Vercel Hobby deployment for commit `2b5c6cb` failed after a successful build because the repository contained 15 files under `api/`. Vercel treats each API route file as a Serverless Function, which exceeded the Hobby limit of 12 functions per deployment.

Root `server.mjs` remains excluded from hosted deployment and is still only the local development server.

## Consolidation Architecture

The hosted API now uses one catch-all Vercel function:

```text
api/[...path].mjs
```

That entry point dispatches the existing public API paths to the same shared hosted handlers that were already used by the thin wrapper files:

- `/api/config`
- `/api/auth/login`
- `/api/auth/logout`
- `/api/auth/session`
- `/api/workspace`
- `/api/ai/health`
- `/api/ai/diagnostics`
- `/api/ai/ingest`
- `/api/ai/answer`
- `/api/ai/documents`
- `/api/ai/documents/:id`
- `/api/conversations`
- `/api/conversations/:id`
- `/api/conversations/:id/messages`
- `/api/conversations/:id/status`

Authentication, HttpOnly session cookies, CSRF validation, request forwarding, Turso-backed storage, diagnostics, knowledge management, answer generation, and conversation APIs continue to live in the shared hosted modules under `src/hosted/`.

## Function Count

- Original deployable API route files: 15.
- Final deployable API route files: 1.
- Expected generated Vercel Serverless Functions: 1.

Local generated artifact counting was not completed with the Vercel CLI because the CLI is not installed in this workspace. The source-level deployment boundary is now a single catch-all API function, and regression tests assert that no other `.mjs` files remain under `api/`.

## Endpoint Compatibility

The public endpoint surface is unchanged. Dynamic routes are matched by the consolidated function and forwarded to the same hosted internals:

- `/api/ai/documents/:id` forwards to `/api/hosted/delete-document`.
- `/api/conversations/:id` forwards to `/api/hosted/conversation`.
- `/api/conversations/:id/messages` forwards to `/api/hosted/conversation-message`.
- `/api/conversations/:id/status` forwards to `/api/hosted/conversation-status`.

Unknown `/api/*` paths now return a JSON `404` with `code: "not_found"`.

## Verification

Focused hosted route tests were updated to call the consolidated route while preserving the old request URLs. They cover:

- Authentication and session cookies.
- Missing, expired, tampered, and invalid-signature session rejection.
- CSRF rejection on writes.
- Workspace reads and writes.
- Diagnostics and health.
- Document ingestion, listing, re-indexing, answer retrieval, and deletion.
- Conversation creation, listing, detail, agent message, and status update routes.
- Unknown route handling.
- Secret non-disclosure in hosted config/auth responses.

Commands run on 2026-11-09:

- `npm run check`: passed.
- `npm test`: 151 passed, 0 failed.
- `node --test tests/hosted-vercel-routes.test.mjs`: 12 passed, 0 failed.
- `node scripts/hosted-retrieval-eval.mjs`: passed; selected configuration remained `adaptive-small-fullscan-bm25-50`, with top-3 ranking agreement `1`, top-5 ranking agreement `1`, answerable response rate `1`, unanswerable abstention rate `1`, ambiguous abstention rate `1`, and citation validity `1`.
- `npm run test:browser`: not passed in this local environment. Chromium launched a DevTools target but crashed/timed out before `Runtime.enable`, before application code or the consolidated API route was exercised. This remains a local browser-harness verification blocker, not a confirmed application regression.

## Limitations

This change fixes the Vercel Hobby function-count deployment blocker locally. A new Vercel deployment must still be observed remotely before claiming the deployment is Ready.

Instance-local rate limiting remains a known hosted limitation. This change does not alter billing, credentials, Turso schema, local Node/FastAPI mode, browser embeddings, or production data.
