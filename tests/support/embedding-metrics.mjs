export function assertVector(vector, expectedDimension = 384) {
  if (!Array.isArray(vector) && !(ArrayBuffer.isView(vector))) {
    throw new TypeError("Embedding vector must be an array or typed array");
  }
  if (vector.length !== expectedDimension) {
    throw new Error(`Expected ${expectedDimension} dimensions, received ${vector.length}`);
  }
  for (const value of vector) {
    if (!Number.isFinite(Number(value))) {
      throw new Error("Embedding vector contains a non-finite value");
    }
  }
}

export function l2Norm(vector) {
  return Math.sqrt(Array.from(vector).reduce((sum, value) => sum + Number(value) ** 2, 0));
}

export function cosineSimilarity(left, right) {
  if (left.length !== right.length) {
    throw new Error(`Vector length mismatch: ${left.length} !== ${right.length}`);
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]);
    const b = Number(right[index]);
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function elementDiff(left, right) {
  if (left.length !== right.length) {
    throw new Error(`Vector length mismatch: ${left.length} !== ${right.length}`);
  }
  let maxAbs = 0;
  let totalAbs = 0;
  for (let index = 0; index < left.length; index += 1) {
    const diff = Math.abs(Number(left[index]) - Number(right[index]));
    maxAbs = Math.max(maxAbs, diff);
    totalAbs += diff;
  }
  return {
    maxAbs,
    meanAbs: totalAbs / left.length,
  };
}

export function rankBySimilarity(queryVector, documentVectors) {
  return documentVectors
    .map((document) => ({
      id: document.id,
      score: cosineSimilarity(queryVector, document.vector),
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function topKAgreement(leftRanking, rightRanking, k = 3) {
  const left = new Set(leftRanking.slice(0, k).map((item) => item.id));
  const right = new Set(rightRanking.slice(0, k).map((item) => item.id));
  let overlap = 0;
  for (const id of left) {
    if (right.has(id)) overlap += 1;
  }
  return overlap / Math.max(k, 1);
}

export function reciprocalRank(ranking, relevantIds) {
  const relevant = new Set(relevantIds);
  const index = ranking.findIndex((item) => relevant.has(item.id));
  return index === -1 ? 0 : 1 / (index + 1);
}

export function summarizeParity({ python, browser, expectedDimension = 384 }) {
  const byId = new Map(browser.map((item) => [item.id, item.vector]));
  return python.map((item) => {
    const browserVector = byId.get(item.id);
    if (!browserVector) {
      throw new Error(`Missing browser vector for ${item.id}`);
    }
    assertVector(item.vector, expectedDimension);
    assertVector(browserVector, expectedDimension);
    return {
      id: item.id,
      pythonNorm: l2Norm(item.vector),
      browserNorm: l2Norm(browserVector),
      cosine: cosineSimilarity(item.vector, browserVector),
      ...elementDiff(item.vector, browserVector),
    };
  });
}
