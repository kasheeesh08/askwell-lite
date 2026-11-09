import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeRows } from "../scripts/phase5b-rag-quality-eval.mjs";

test("phase 5b retrieval metrics exclude expected-abstention rows without relevance labels", () => {
  const metrics = summarizeRows([
    {
      expectedAbstain: false,
      expectedDocuments: ["trial-policy"],
      expectedChunks: ["trial-policy:chunk-0"],
      type: "direct",
      bm25: { documents: ["trial-policy"] },
      semantic: { documents: ["trial-policy"] },
      hybrid: { documents: ["trial-policy"] },
      abstained: false,
      answerRelevancePass: true,
      citationValidityPass: true,
      citationPrecision: 1,
      citationCoverage: 1,
      latencyMs: 1,
    },
    {
      expectedAbstain: true,
      expectedDocuments: [],
      expectedChunks: [],
      type: "unanswerable",
      bm25: { documents: ["trial-policy"] },
      semantic: { documents: ["trial-policy"] },
      hybrid: { documents: ["trial-policy"] },
      abstained: true,
      answerRelevancePass: true,
      citationValidityPass: true,
      citationPrecision: 1,
      citationCoverage: 0,
      latencyMs: 1,
    },
  ]);

  assert.equal(metrics.denominators.totalQuestions, 2);
  assert.equal(metrics.denominators.retrievalQuestions, 1);
  assert.equal(metrics.retrieval.hybrid.recallAt5, 1);
  assert.equal(metrics.retrieval.hybrid.hitRateAt5, 1);
  assert.equal(metrics.generation.answerRelevance, 1);
  assert.equal(metrics.generation.citationCoverage, 1);
});
