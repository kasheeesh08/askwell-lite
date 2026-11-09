# Phase 6A - Conversation Persistence

## Summary

Phase 6A adds durable customer conversation storage separate from indexed RAG knowledge data. Existing workspace articles, documents, chunks, embeddings, ingestion runs, and browser inbox state are preserved. Hosted mode now stores conversations and messages through the same authenticated Vercel API and Turso/libSQL adapter path used by hosted knowledge management.

## Current Functionality Reused

- The customer widget already captures user questions and assistant answers in browser state.
- The dashboard inbox already renders recent conversations from `state.conversations`.
- Hosted API requests already use HttpOnly private-demo sessions plus CSRF headers for state-changing requests.
- Hosted storage already has workspace isolation, migrations, transactions, and Turso/local-libSQL adapters.

## Schema

New hosted storage tables:

- `conversations`
  - `id` stable conversation identifier.
  - `workspace_id` owner workspace.
  - `status` currently `open` or `resolved`.
  - `customer_id` anonymous visitor/customer identifier.
  - `metadata_json` future-safe metadata.
  - `created_at`, `updated_at`, `last_message_at`.
- `conversation_messages`
  - `id` stable message identifier.
  - `workspace_id` owner workspace.
  - `conversation_id` parent conversation.
  - `position` chronological message order.
  - `sender_type` one of `customer`, `assistant`, or `agent`.
  - `content`, `metadata_json`, `created_at`.

Foreign keys keep messages scoped to a valid conversation in the same workspace. Conversation tables are independent from `documents`, `chunks`, and `embeddings`, so customer messages are not indexed as knowledge.

## API Contracts

- `GET /api/conversations`
  - Lists conversations for the authenticated workspace.
- `POST /api/conversations`
  - Creates a conversation with optional initial ordered messages.
- `GET /api/conversations/:id`
  - Returns conversation details and messages.
- `POST /api/conversations/:id/messages`
  - Appends a customer, assistant, or agent message transactionally.

Hosted routes map to internal `/api/hosted/*` handlers and require the existing hosted session or server-side admin token. Browser requests never include the admin token.

## Runtime Behavior

- Hosted widget answers now create a persistent conversation after answer generation.
- A stable anonymous visitor ID is stored in local browser state and sent as `customerId`.
- Message metadata can include citations, generation metadata, sources, fallback reason, and insufficient-context status.
- Local browser/inbox behavior remains compatible and continues to work from local state.

## Migration

Hosted schema version is now `2`.

Version 2 adds conversation tables and indexes without modifying existing workspace, document, chunk, embedding, ingestion, or session-revocation data. Existing databases migrate in place with `CREATE TABLE IF NOT EXISTS` statements inside the adapter migration flow.

## Test Results

Verified before commit:

- `npm run check`
- `npm test`
- Phase 5B hosted RAG evaluation
- Phase 5C browser integration harness

Phase 6A adds regression coverage for:

- Conversation creation.
- Message persistence and ordering.
- Multiple messages in one conversation.
- Workspace isolation.
- Invalid conversation IDs and missing conversations.
- Transactional adapter behavior.
- Hosted session/CSRF protection.
- Hosted widget persistence after an answer.

## Limitations

- The dashboard inbox still renders the existing local conversation summary shape; a richer persistent inbox UI is deferred.
- Agent assignment, conversation reopening through the hosted API, and status updates beyond initial creation are deferred.
- Cross-instance hosted rate limiting remains instance-local unless backed by shared storage in a later milestone.
- No production Turso data was modified during this implementation.
