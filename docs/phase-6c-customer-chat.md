# Phase 6C: Customer Chat and Conversation Continuity

## Summary

Phase 6C improves the customer-facing chat preview so hosted conversations persist through the Phase 6A conversation APIs and remain visible to the Phase 6B agent inbox.

The local Node/FastAPI workflow remains unchanged. Hosted mode uses the existing HttpOnly private-demo session and CSRF flow; the browser stores only non-sensitive anonymous visitor and conversation identifiers.

## Implemented Behavior

- The chat preview now renders distinct customer, assistant, agent, and status messages.
- Assistant answers show source titles, chunk citations, generation metadata, and fallback reasons where available.
- Insufficient-evidence responses are rendered as normal assistant messages with empty citations and a visible fallback reason.
- The composer disables while a request is pending to prevent duplicate submissions.
- A refresh control reloads the current hosted conversation so customer visitors can see later human-agent replies.
- Hosted visitors receive a stable anonymous visitor ID in `localStorage`.
- Hosted open conversation IDs are stored in `localStorage` and reused across reloads.
- Stale or deleted stored conversation IDs are removed and replaced with a newly created conversation on the next message.
- Customer messages and assistant responses are persisted as chronological conversation messages.
- Agent messages are displayed as human replies and are not labeled as AI-generated answers.

## Persistence and Privacy

Hosted mode stores these non-sensitive browser values:

- `askwell-visitor-id`: an anonymous stable visitor identifier, generated locally.
- `askwell-conversation-id`: the currently open conversation ID.

The private-demo admin token, session secret, and CSRF secret remain server-side. The frontend does not store admin credentials in browser storage for hosted mode, and all hosted write operations continue to use the existing HttpOnly session cookie plus CSRF token.

## API Usage

Phase 6C reuses the existing conversation endpoints:

- `POST /api/conversations` to create a conversation with the first customer message.
- `GET /api/conversations` to discover an existing open conversation for the anonymous visitor.
- `GET /api/conversations/:id` to load message history.
- `POST /api/conversations/:id/messages` to append customer, assistant, and agent messages.

The customer widget answer still uses:

- `POST /api/ai/answer`

No backend storage rewrite was introduced.

## Verification

Local VM tests added coverage for:

- Hosted customer conversation creation.
- Returning visitor conversation recovery.
- Message history after refresh.
- Assistant response persistence.
- Agent message display and sender attribution.
- Invalid stored conversation ID recovery.
- Duplicate-submit prevention.
- Insufficient-evidence rendering with citation behavior.

The browser harness was extended to verify:

- Hosted login.
- Article indexing.
- Answer rendering with citations.
- Insufficient-evidence fallback.
- Conversation persistence.
- Agent-message refresh in the customer chat.
- Isolated document deletion cleanup.

Commands run for this milestone:

- `npm run check`: passed.
- `npm test`: passed, 150 tests.
- `npm run test:browser`: passed with local Microsoft Edge/CDP, temporary synthetic storage, deterministic test embedder, and all browser scenario checks true.
- `node scripts/hosted-retrieval-eval.mjs`: passed. Selected configuration remained `adaptive-small-fullscan-bm25-50`; reported answerable response rate `1`, unanswerable abstention `1`, ambiguous abstention `1`, answer relevance `0.9333`, citation validity `1`, citation precision `0.8889`, and citation coverage `0.7556`.

## Limitations

- No real-time push infrastructure is included; visitors manually refresh the thread from the widget preview.
- The standalone embeddable `askwell-widget.js` remains the static no-backend starter. Full hosted continuity currently lives in the AskWell Lite application shell.
- Browser verification uses isolated local synthetic storage, not deployed Vercel/Turso production.
- Rate limiting remains the existing hosted implementation.
