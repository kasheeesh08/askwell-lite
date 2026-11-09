# Phase 6D: Production Validation and Reliability

Validation date: 2026-11-09

Baseline commit requested for validation: `fde6c1345fc5965fe019ef501184ff6648f1557f`

Production URL checked: `https://askwell-lite.vercel.app`

## Readiness Assessment

Status: **CONDITIONAL / BLOCKED FOR REMOTE END-TO-END SIGN-OFF**

The local Phase 6C implementation is verified, pushed, and passing CI. The deployed production site is reachable and reports hosted mode with authentication, database, and session configuration enabled. However, the deployed static assets do not include Phase 6C customer-conversation continuity markers, so the production deployment appears to be behind commit `fde6c1345fc5965fe019ef501184ff6648f1557f`.

Because this execution environment also did not have the private-demo credential available as an environment variable, authenticated production customer-to-agent validation could not be completed without asking for or exposing credentials.

## Deployment Commit Verification

Confirmed locally:

- Current repository `HEAD`: `fde6c1345fc5965fe019ef501184ff6648f1557f`
- Latest local commit message: `feat: improve customer chat and conversation continuity`
- GitHub Actions for that commit: passed on `main`.

Remote production checks:

- `GET /` returned `200` from Vercel.
- `GET /api/config` returned `200`.
- `GET /api/auth/session` without a session returned `401`.
- `GET /api/workspace` without a session returned `401`.
- `GET /api/ai/health` without a session returned `401`.
- `GET /api/ai/diagnostics` without a session returned `401`.

Deployment freshness:

- `GET /src/state.js?v=9` did **not** contain `askwell-conversation-id`.
- `GET /src/app.js?v=9` did **not** contain `Human agent`.
- `GET /docs/phase-6c-customer-chat.md` returned `404`.
- GitHub deployments API returned no deployment records for `fde6c1345fc5965fe019ef501184ff6648f1557f`.

Conclusion: **production is reachable but the deployed artifact could not be confirmed as Phase 6C**. A redeploy of the latest `main` commit is required before Phase 6D remote workflow validation can be meaningful.

## Hosted Configuration and Diagnostics

Verified from `/api/config`:

- `apiMode`: `hosted`
- `hostedConfigured`: `true`
- `deployment.hostedMode`: `true`
- `deployment.authConfigured`: `true`
- `deployment.databaseConfigured`: `true`
- `deployment.sessionSecretConfigured`: `true`
- Browser embedding model: `Xenova/all-MiniLM-L6-v2`
- Embedding dimension: `384`

Secret exposure check:

- The public config response exposed only boolean configuration status for auth, database, and session secret setup.
- The only secret-related field name observed was `deployment.sessionSecretConfigured`, a boolean.
- No admin token, Turso token, database URL, session secret value, or private credential value was printed or persisted by this validation.

Turso/libSQL status:

- **Partially verified**: production reports `databaseConfigured: true`.
- **Not fully verified**: authenticated reads/writes against the deployed Turso database could not be performed because the private-demo credential was unavailable to this subprocess and the deployed artifact appears outdated.

## End-to-End Customer-to-Agent Workflow

Remote production status: **blocked**

The following production workflow could not be completed:

1. Private-demo login.
2. Customer conversation creation.
3. Customer message persistence.
4. Assistant response persistence.
5. Agent inbox confirmation.
6. Agent reply.
7. Customer chat refresh showing the agent reply.
8. Resolve/reopen status persistence.
9. Refresh persistence across sessions.

Blockers:

- The deployed assets appear older than Phase 6C, so the customer chat continuity code is not present in production.
- `ASKWELL_ADMIN_TOKEN` was not present in the local subprocess environment, so no private-demo login attempt was made.

No synthetic production records were created by this validation.

## Persistence and Reliability

Remote production:

- **Not verified** for conversation/message persistence because authenticated production access was blocked.
- **Not verified** for chronological ordering, stable visitor recovery, duplicate-message prevention, stale conversation recovery, or status synchronization because the deployed customer-continuity client code appears absent.

Local automated coverage:

- Hosted conversation creation.
- Returning visitor recovery.
- Message history reload.
- Customer and assistant message persistence.
- Agent message rendering and sender attribution.
- Invalid stored conversation ID recovery.
- Duplicate-submit prevention.
- Insufficient-evidence rendering and citations.

Local browser coverage:

- Hosted login against a local synthetic harness.
- Article creation and indexing.
- Answer rendering with citations.
- Insufficient-evidence fallback.
- Conversation message persistence.
- Agent-message refresh in the customer chat.
- Synthetic indexed-document deletion cleanup.

## Security Checks

Verified remotely without credentials:

- Protected production routes reject unauthenticated requests with `401`.
- Public `/api/config` returns sanitized configuration booleans and embedding metadata.
- Protected workspace and AI diagnostics routes are not publicly readable.

Not verified remotely:

- Valid private-demo login.
- Cookie flags from production `Set-Cookie`.
- CSRF enforcement after a valid login.
- Authenticated conversation access.
- Cross-conversation or cross-workspace access attempts.
- Message size enforcement in production.

Local tests cover missing, expired, tampered, and invalid-signature sessions, CSRF rejection, protected hosted routes, route coverage, and secret non-exposure.

## Test Results

Commands run locally:

- `npm run check`: passed.
- `npm test`: passed, 150 tests.
- `npm run test:browser`: passed using local Microsoft Edge/CDP, temporary synthetic storage, and deterministic browser embeddings.
- `node scripts/hosted-retrieval-eval.mjs`: passed.

Hosted retrieval evaluation selected `adaptive-small-fullscan-bm25-50` and reported:

- Answerable response rate: `1`
- Unanswerable abstention rate: `1`
- Ambiguous abstention rate: `1`
- Answer relevance: `0.9333`
- Citation validity: `1`
- Citation precision: `0.8889`
- Citation coverage: `0.7556`

GitHub Actions:

- Workflow `Test` for commit `fde6c1345fc5965fe019ef501184ff6648f1557f`: passed.

## Issues Found

1. **Production deployment appears outdated**
   - Severity: major.
   - Evidence: production `src/state.js?v=9` and `src/app.js?v=9` do not contain Phase 6C markers.
   - Impact: production cannot validate the newly implemented customer conversation continuity and agent handoff UI.
   - Fix required: redeploy latest `main` commit `fde6c1345fc5965fe019ef501184ff6648f1557f`.

2. **Remote authenticated validation blocked in this subprocess**
   - Severity: major for validation, not an application defect.
   - Evidence: `ASKWELL_ADMIN_TOKEN` was missing from the agent subprocess environment.
   - Impact: no safe private-demo login could be attempted.
   - Fix required: provide the private-demo credential to the execution environment without pasting it into chat, then rerun Phase 6D remote validation after redeploy.

3. **No conversation cleanup endpoint exists**
   - Severity: minor/operational.
   - Impact: a full remote E2E test can create uniquely labeled synthetic conversations, but cannot remove them afterwards through an existing supported API. They can be resolved/reopened, but not deleted.
   - Recommendation: add a future admin-only synthetic-test cleanup endpoint or dashboard delete action before repeated production validation runs.

## Fixes Made

No application code was changed in Phase 6D because the confirmed blocker is deployment freshness and missing validation credentials, not a local source-code defect.

This document records the exact validation state and prevents local mocked tests from being mistaken for remote production proof.

## Remaining Remote Verification Steps

After redeploying latest `main`:

1. Confirm production assets contain `askwell-conversation-id` and `Human agent`.
2. Confirm `/api/config` still reports hosted mode, auth, database, and session secret configured.
3. Perform private-demo login using the configured access credential.
4. Verify `Set-Cookie` attributes: `HttpOnly`, `Secure`, appropriate `SameSite`, `Path=/`, and expiry.
5. Create a uniquely named synthetic article and index it.
6. Start a uniquely named synthetic customer conversation.
7. Verify assistant answer, citations, and persisted messages.
8. Open Inbox and verify the same conversation and chronological transcript.
9. Send an agent reply and confirm the customer chat refresh displays it as `Human agent`.
10. Resolve and reopen the conversation.
11. Refresh in a separate browser session and verify persistence.
12. Delete the synthetic indexed document.
13. Resolve the synthetic conversation and document the remaining conversation cleanup limitation.

Do not run these steps against real customer records.
