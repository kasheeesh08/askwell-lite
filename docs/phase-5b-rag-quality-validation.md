# Phase 5B - End-to-End RAG Quality Validation

## Scope

Phase 5B validates the hosted customer question-answering workflow without touching production data, credentials, or deployment settings.

The validation used synthetic local fixtures only. It exercised:

- workspace article creation through the hosted workspace contract;
- article indexing through hosted ingestion payloads;
- 384-dimensional normalized browser-compatible embeddings;
- hosted BM25, semantic, and hybrid RRF retrieval;
- evidence sufficiency and abstention;
- extractive answer generation with citation validation;
- customer-facing widget rendering for answers, citations, and insufficient-evidence fallback.

No live LLM calls were made. No production Turso database was accessed.

## Synthetic Evaluation Corpus

Fixture: `tests/fixtures/phase5b-rag-quality-fixture.json`

- Articles: 8
- Questions: 12
- Customer data: false

Question categories:

- Direct factual questions.
- Paraphrased questions.
- Synonym-based questions.
- Multi-source workflow questions.
- Incomplete-evidence questions.
- Ambiguous questions.
- Unanswerable questions.

The corpus is intentionally separate from real workspace data and is not used by deployment, health checks, or production startup.

## Implementation Notes

The hosted retrieval evidence gate had two demonstrated support-analysis gaps:

1. Evidence token normalization stemmed `deleted` to `delet`, while the query token `delete` was not mapped to that normalized form.
2. Question-framing terms such as `happen`, `when`, and `stay` were counted as required evidence, which caused supported answers to abstain.

The fix keeps thresholds unchanged. It only adds explicit token equivalence and generic query-token handling in `src/hosted/retrieval.mjs`.

The word `long` remains evidence-bearing, but it can be supported by duration tokens such as `day`, `days`, `minute`, and `minutes`. This keeps vague questions protected while allowing duration questions like "How long is the trial?"

## Phase 5B Metrics

Command:

```powershell
node scripts/phase5b-rag-quality-eval.mjs
```

Final corrected metrics:

| Area | Metric | Result |
| --- | ---: | ---: |
| Denominators | Total questions | 12 |
| Denominators | Retrieval questions | 9 |
| Denominators | Answerable questions | 9 |
| Denominators | Unanswerable questions | 2 |
| Denominators | Ambiguous questions | 1 |
| BM25 retrieval | Recall@3 | 1.0 |
| BM25 retrieval | Recall@5 | 1.0 |
| BM25 retrieval | MRR | 1.0 |
| BM25 retrieval | Hit Rate@5 | 1.0 |
| Semantic retrieval | Recall@3 | 1.0 |
| Semantic retrieval | Recall@5 | 1.0 |
| Semantic retrieval | MRR | 0.9444 |
| Semantic retrieval | Hit Rate@5 | 1.0 |
| Hybrid retrieval | Recall@3 | 1.0 |
| Hybrid retrieval | Recall@5 | 1.0 |
| Hybrid retrieval | MRR | 1.0 |
| Hybrid retrieval | Hit Rate@5 | 1.0 |
| Generation | Answerable response rate | 1.0 |
| Generation | Unanswerable abstention rate | 1.0 |
| Generation | Ambiguous abstention rate | 1.0 |
| Generation | Answer relevance | 1.0 |
| Citations | Validity | 1.0 |
| Citations | Precision | 1.0 |
| Citations | Coverage | 1.0 |

Latency:

- Mean: 2.2749 ms
- Median: 1.0342 ms
- p95: 11.8555 ms

The earlier `0.75` Recall@5 and citation coverage values were caused by averaging expected-abstention rows with empty relevance labels into retrieval and citation metrics. Retrieval and citation metrics now use only labeled answerable/citation rows. Abstention behavior remains measured separately.

## Baseline Comparison

### Hosted Phase 4.3D.2 Comparable Baseline

Command:

```powershell
node scripts/hosted-retrieval-eval.mjs
```

Selected configuration: `adaptive-small-fullscan-bm25-50`

Final hosted baseline metrics after the Phase 5B fix:

| Area | Metric | Result |
| --- | ---: | ---: |
| Hybrid retrieval | Recall@3 | 0.8222 |
| Hybrid retrieval | Recall@5 | 0.8222 |
| Hybrid retrieval | MRR | 0.7889 |
| Hybrid retrieval | Hit Rate@5 | 0.8444 |
| Generation | Answerable response rate | 1.0 |
| Generation | Unanswerable abstention rate | 1.0 |
| Generation | Ambiguous abstention rate | 1.0 |
| Generation | Answer relevance | 0.9333 |
| Citations | Validity | 1.0 |
| Citations | Precision | 0.8889 |
| Citations | Coverage | 0.7556 |

No material retrieval ranking regression was observed in the selected hosted configuration.

### Phase 3.7 Reference

Phase 3.7 remains an external reference, not a direct parity claim. It used a 64-dimensional Python token-hash test provider, while hosted mode validates the 384-dimensional browser-compatible profile.

Phase 3.7 reference metrics:

- Hybrid document Recall@3: 0.9605
- Hybrid document Recall@5: 0.9868
- MRR: 0.8509
- Hit Rate@5: 1.0
- Answerable response rate: 1.0
- Unanswerable abstention rate: 1.0
- Ambiguous abstention rate: 1.0
- Answer relevance: 0.9556
- Citation validity: 1.0
- Citation precision: 0.863
- Citation coverage: 0.9222

The difference is expected because the datasets, vector dimensions, and hosted retrieval contract differ.

## Widget Verification

Added a regression test for the customer-facing hosted widget workflow:

- indexes workspace articles through the hosted ingestion API;
- asks an answerable question through the hosted answer API;
- renders an answer with citations;
- asks an unsupported question;
- verifies the insufficient-evidence fallback has no citations.

The test uses the in-memory hosted store and synthetic articles only.

## Remaining Limitations

- This milestone did not download the real browser model. Phase 4.2C remains the evidence for browser/Python embedding parity.
- This milestone did not contact production Turso or Vercel.
- Generation remains deterministic extractive generation in hosted mode; no live LLM validation was performed.
- The Phase 5B corpus is small and synthetic. It is useful for regression coverage, not proof of broad production quality.
- Retrieval and citation metrics are reported over labeled rows only; abstention behavior is reported separately.
