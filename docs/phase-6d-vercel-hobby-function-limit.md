# Phase 6D Vercel Hobby Function Limit Fix

## Problem

The Vercel Hobby deployment for commit `2b5c6cb` failed after a successful build because the repository contained 15 files under `api/`. Vercel treats each API route file as a Serverless Function, which exceeded the Hobby limit of 12 functions per deployment.

Root `server.mjs` remains excluded from hosted deployment and is still only the local development server.

## Original Consolidation Attempt

Commit `8607302` reduced the `api/` tree to a single `api/[...path].mjs` route. Local tests passed, but production showed that Vercel routed only single-segment paths such as `/api/config` and `/api/unknown` to that function. Nested paths such as `/api/auth/login`, `/api/auth/session`, and `/api/ai/health` returned Vercel's platform `NOT_FOUND` page before application code ran.

That proved the failure was not the frontend request method, the hosted authentication handler, or the internal dispatcher. The frontend was correctly sending `POST /api/auth/login`; Vercel was failing to route that nested public path to the consolidated function.

## Corrected Consolidation Architecture

The hosted API now uses five explicit Vercel functions:

```text
api/config.mjs
api/workspace.mjs
api/auth.mjs
api/ai.mjs
api/conversations.mjs
```

`vercel.json` rewrites nested route groups to those explicit functions:

```json
[
  { "source": "/api/auth/:path*", "destination": "/api/auth?path=:path*" },
  { "source": "/api/ai/:path*", "destination": "/api/ai?path=:path*" },
  { "source": "/api/conversations/:path*", "destination": "/api/conversations?path=:path*" }
]
```

Those grouped functions dispatch the existing public API paths to the same shared hosted handlers that were already used by the thin wrapper files:

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
- Failed catch-all attempt: 1 route file, but nested paths were not routed to it in production.
- Final deployable API route files: 5.
- Expected generated Vercel Serverless Functions: 5.

Local generated artifact counting was not completed with the Vercel CLI because the CLI is not installed in this workspace. The source-level deployment boundary is now five explicit API functions, leaving seven functions of headroom under the Hobby limit.

## Endpoint Compatibility

The public endpoint surface is unchanged. Dynamic routes are matched by grouped functions and forwarded to the same hosted internals:

- `/api/ai/documents/:id` forwards to `/api/hosted/delete-document`.
- `/api/conversations/:id` forwards to `/api/hosted/conversation`.
- `/api/conversations/:id/messages` forwards to `/api/hosted/conversation-message`.
- `/api/conversations/:id/status` forwards to `/api/hosted/conversation-status`.

Unknown grouped API paths now return a JSON `404` with `code: "not_found"`.

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
- Vercel rewrite destination paths such as `/api/auth?path=login`, `/api/ai?path=ingest`, `/api/ai?path=documents/trial`, and `/api/conversations?path=conversation-rewrite/messages`.
- Secret non-disclosure in hosted config/auth responses.

Commands run on 2026-11-09:

- `npm run check`: passed.
- `npm test`: 151 passed, 0 failed.
- `node --test tests/hosted-vercel-routes.test.mjs`: 13 passed, 0 failed.
- `node scripts/hosted-retrieval-eval.mjs`: passed; selected configuration remained `adaptive-small-fullscan-bm25-50`, with top-3 ranking agreement `1`, top-5 ranking agreement `1`, answerable response rate `1`, unanswerable abstention rate `1`, ambiguous abstention rate `1`, and citation validity `1`.
- `npm run test:browser`: not passed in this local environment. Chromium launched a DevTools target but crashed/timed out before `Runtime.enable`, before application code or the consolidated API route was exercised. This remains a local browser-harness verification blocker, not a confirmed application regression.

## Limitations

This change fixes the Vercel Hobby function-count deployment blocker locally. A new Vercel deployment must still be observed remotely before claiming the deployment is Ready.

Instance-local rate limiting remains a known hosted limitation. This change does not alter billing, credentials, Turso schema, local Node/FastAPI mode, browser embeddings, or production data.
