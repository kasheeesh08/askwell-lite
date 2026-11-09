# Phase 5C - Browser Integration Validation and RAG Evaluation Audit

## Scope

Phase 5C verifies the real browser application path locally and audits the Phase 5B RAG metrics.

This milestone did not access production Turso, deploy to Vercel, change credentials, create production records, or make live LLM calls.

## Phase 5B Evaluation Audit

Files inspected:

- `scripts/phase5b-rag-quality-eval.mjs`
- `tests/fixtures/phase5b-rag-quality-fixture.json`
- `docs/phase-5b-rag-quality-validation.md`
- `src/hosted/retrieval.mjs`

Confirmed issue:

- Phase 5B retrieval metrics were averaged over all 12 questions.
- Three of those questions are expected-abstention cases and intentionally have no relevant documents or source chunks.
- The old `recall()` and `hitRate()` helpers returned `0` for empty expected sets, so perfect retrieval over the 9 answerable questions appeared as `0.75`.

Correction:

- Retrieval metrics now use rows with labeled `expected_relevant_documents`.
- Citation precision and coverage now use rows with labeled `expected_source_chunks`.
- Answer relevance now uses answerable questions; unanswerable and ambiguous behavior remain separate abstention metrics.
- A regression test verifies that expected-abstention rows no longer depress retrieval metrics.

Corrected Phase 5B results:

| Metric | Result |
| --- | ---: |
| Retrieval questions | 9 |
| Hybrid Recall@3 | 1.0 |
| Hybrid Recall@5 | 1.0 |
| Hybrid MRR | 1.0 |
| Hybrid Hit Rate@5 | 1.0 |
| Answerable response rate | 1.0 |
| Unanswerable abstention rate | 1.0 |
| Ambiguous abstention rate | 1.0 |
| Answer relevance | 1.0 |
| Citation validity | 1.0 |
| Citation precision | 1.0 |
| Citation coverage | 1.0 |

The evaluator remains heuristic and deterministic. It verifies expected phrases and citation labels; it is not a general semantic judge.

## Browser-Level Test

Added:

- `scripts/phase5c-browser-integration.mjs`
- `npm run test:browser`

The browser harness:

1. Starts an isolated local HTTP server.
2. Serves the actual `index.html`, CSS, and frontend JavaScript files.
3. Launches installed Microsoft Edge in headless mode through the Chrome DevTools Protocol.
4. Uses a temporary browser profile and synthetic in-memory hosted storage.
5. Drives the real DOM and app event handlers.

Verified flow:

- application loads;
- Knowledge page navigation works;
- private hosted login form submits;
- session confirmation is displayed;
- a knowledge article is created through the UI;
- article indexing calls hosted ingestion;
- document listing and diagnostics update;
- the customer-facing widget submits an answerable question;
- answer and citation text render in the widget;
- an unsupported question returns the insufficient-evidence fallback;
- Delete Document removes the indexed document and associated chunks/embeddings from the isolated store.

Latest browser result:

```json
{
  "browser": "Microsoft Edge",
  "embeddingMode": "deterministic-test-embedder",
  "modelId": "Xenova/all-MiniLM-L6-v2",
  "quantized": false,
  "dimension": 384,
  "normalized": true,
  "finite": true,
  "checks": {
    "appLoaded": true,
    "navigationLoadedKnowledge": true,
    "hostedLoginConfirmed": true,
    "articleCreated": true,
    "indexingCompletedBeforeDelete": true,
    "answerRendered": true,
    "citationRenderedBeforeDelete": true,
    "insufficientEvidenceFallbackRendered": true,
    "deletionCompleted": true
  },
  "finalDiagnostics": {
    "documentCount": 0,
    "chunkCount": 0,
    "embeddingCount": 0
  }
}
```

The browser test produced a temporary Edge profile cleanup warning for a locked browser cache file on Windows. The app verification itself passed; the warning does not affect application state or production data.

## Browser Embedding Verification

The browser test verifies the actual browser embedding integration surface:

- `AskWellHostedEmbeddings.EMBEDDING_PROFILE.modelId` is `Xenova/all-MiniLM-L6-v2`.
- `quantized` is `false`.
- generated vectors are 384-dimensional, finite, and normalized.
- hosted ingestion and answer requests use browser-generated vectors through the real frontend API client.

To avoid unnecessary model downloads during normal regression runs, the default browser test uses the existing test embedder hook inside the real browser page. Phase 4.2C remains the evidence for real browser/Python model parity.

Optional real browser model loading can be attempted with:

```powershell
$env:ASKWELL_PHASE5C_REAL_BROWSER_MODEL = "1"
npm run test:browser
```

That optional path may require network access and the browser model cache. It was not required for this milestone.

## Verification Commands

Commands run:

```powershell
npm run check
npm test
npm run test:browser
node scripts/phase5b-rag-quality-eval.mjs
node scripts/hosted-retrieval-eval.mjs
```

Results:

- `npm run check`: passed.
- `npm test`: 140 passed, 0 failed.
- `npm run test:browser`: passed in Microsoft Edge through CDP.
- `node scripts/phase5b-rag-quality-eval.mjs`: passed with corrected denominators and 1.0 hybrid Recall@5 over 9 labeled retrieval questions.
- `node scripts/hosted-retrieval-eval.mjs`: passed; selected hosted configuration remained `adaptive-small-fullscan-bm25-50` with hybrid document Recall@5 `0.8222`, answerable response rate `1.0`, unanswerable abstention `1.0`, ambiguous abstention `1.0`, and citation validity `1.0`.

## Limitations

- The browser test is local and synthetic; it is not a deployed Vercel/Turso verification.
- The default browser test intentionally avoids downloading the real model.
- Hosted generation remains extractive and deterministic; no live LLM provider was called.
- The test uses local temporary storage and does not prove remote database latency or cross-instance behavior.
