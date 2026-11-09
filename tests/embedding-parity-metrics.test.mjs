import assert from "node:assert/strict";
import test from "node:test";

import {
  assertVector,
  cosineSimilarity,
  elementDiff,
  l2Norm,
  rankBySimilarity,
  reciprocalRank,
  summarizeParity,
  topKAgreement,
} from "../experiments/browser-embedding-parity/embedding-metrics.mjs";

test("validates vector dimensions and finite values", () => {
  assert.doesNotThrow(() => assertVector([0.6, 0.8], 2));
  assert.throws(() => assertVector([0.6], 2), /Expected 2 dimensions/);
  assert.throws(() => assertVector([Number.NaN, 0], 2), /non-finite/);
});

test("computes norm, cosine similarity, and element differences", () => {
  assert.equal(l2Norm([3, 4]), 5);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.deepEqual(elementDiff([1, 2], [0.5, 3]), { maxAbs: 1, meanAbs: 0.75 });
});

test("ranks vectors by cosine similarity with stable tie-breaking", () => {
  const ranking = rankBySimilarity([1, 0], [
    { id: "b", vector: [0.5, 0] },
    { id: "a", vector: [0.5, 0] },
    { id: "c", vector: [0, 1] },
  ]);
  assert.deepEqual(ranking.map((item) => item.id), ["a", "b", "c"]);
});

test("computes top-k agreement and reciprocal rank", () => {
  const left = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const right = [{ id: "b" }, { id: "d" }, { id: "a" }];
  assert.equal(topKAgreement(left, right, 3), 2 / 3);
  assert.equal(reciprocalRank(left, ["c"]), 1 / 3);
  assert.equal(reciprocalRank(left, ["x"]), 0);
});

test("summarizes parity for matching vector ids", () => {
  const summary = summarizeParity({
    expectedDimension: 2,
    python: [{ id: "x", vector: [1, 0] }],
    browser: [{ id: "x", vector: [0.8, 0.6] }],
  });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].id, "x");
  assert.equal(Math.round(summary[0].cosine * 10) / 10, 0.8);
});
