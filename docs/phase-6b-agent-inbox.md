# Phase 6B: Agent Inbox MVP

## Summary

Phase 6B turns the existing local inbox into a functional authenticated support inbox for hosted mode while preserving the original local demo behavior.

The implementation reuses Phase 6A conversation persistence instead of storing customer conversations in the RAG knowledge index. Conversations and messages remain separate from documents, chunks, and embeddings.

## Implemented Functionality

- Hosted inbox conversation list with customer/visitor identity, latest message preview, status, and last activity.
- Conversation detail view with chronological message history.
- Sender-specific transcript display for customer, assistant, and agent messages.
- Agent replies persisted as `senderType: "agent"`.
- Resolve and reopen actions persisted through storage adapters.
- Open, resolved, and all filters.
- Loading, empty, success, and error states.
- Local-mode inbox behavior remains available from `state.conversations`.

## API Behavior

Existing Phase 6A endpoints are reused:

- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/:id`
- `POST /api/conversations/:id/messages`

Phase 6B adds:

- `PUT /api/conversations/:id/status`

Request body:

```json
{
  "status": "resolved"
}
```

Supported status values are `open` and `resolved`.

All hosted conversation endpoints route through the existing Vercel hosted handler and enforce the same HttpOnly session authentication boundary. Mutating requests require the existing CSRF token.

## Storage Changes

The hosted memory, SQLite, and Turso/libSQL adapters now expose:

```js
updateConversationStatus(payload, context)
```

The update is scoped by workspace, validates the conversation ID, validates the status transition, updates `status` and `updatedAt`, and returns the updated conversation summary. Message ordering and message persistence continue to use the Phase 6A transactional message append flow.

## Security

- The frontend never receives or stores the server-side admin token.
- Hosted write operations use the existing HttpOnly session plus CSRF header flow.
- Workspace isolation is enforced by the storage contract and adapter lookups.
- Invalid conversation IDs, unknown conversations, invalid sender types, invalid statuses, missing CSRF tokens, and cross-workspace access remain rejected.

## Verification

Commands run locally:

- `npm run check`: passed.
- `npm test`: passed, 147 tests.
- `npm run test:browser`: passed after launching the local browser harness outside the sandbox. This is local browser verification with temporary storage, not deployed Vercel/Turso verification.
- `node scripts/hosted-retrieval-eval.mjs`: passed.

Hosted retrieval evaluation selected `adaptive-small-fullscan-bm25-50` and reported:

- Hybrid Recall@3: `0.8222`
- Hybrid Recall@5: `0.8222`
- Answerable response rate: `1`
- Unanswerable abstention rate: `1`
- Ambiguous abstention rate: `1`
- Answer relevance: `0.9333`
- Citation validity: `1`
- Citation precision: `0.8889`
- Citation coverage: `0.7556`

## Limitations

- No agent assignment, internal notes, SLA timers, or multi-agent RBAC yet.
- Rate limiting remains the existing hosted instance-local implementation.
- No remote production database or deployed Vercel verification was performed in this phase.
- Browser tests use the existing local integration harness and synthetic data only.
