export const RETRIEVAL_DEFAULTS = Object.freeze({
  topK: 5,
  rrfConstant: 60,
  bm25K1: 1.5,
  bm25B: 0.75,
  bm25ScoreThreshold: 3.0,
  semanticScoreThreshold: 0.38,
  hybridScoreThreshold: 0.02,
  semanticMarginThreshold: 0.08,
  queryCoverageThreshold: 0.45,
  missingEvidenceTokenLimit: 1,
  minimumSpecificQueryTokens: 2,
  minEvidenceChunks: 1,
  minRetrievalAgreement: 1,
  generationMaxChunks: 3,
  lexicalCandidateLimit: 50,
  fullScanFallbackChunkLimit: 100,
});

const BM25_STOPWORDS = new Set(["a", "an", "and", "are", "do", "does", "how", "is", "of", "or", "the", "to"]);
const EVIDENCE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "after",
  "before",
  "can",
  "do",
  "does",
  "from",
  "how",
  "i",
  "if",
  "is",
  "it",
  "my",
  "of",
  "or",
  "should",
  "the",
  "to",
  "what",
  "where",
]);
const GENERIC_QUERY_TOKENS = new Set([
  "askwell",
  "are",
  "at",
  "before",
  "but",
  "each",
  "enter",
  "for",
  "data",
  "handle",
  "happen",
  "include",
  "included",
  "includ",
  "in",
  "many",
  "must",
  "no",
  "old",
  "product",
  "provide",
  "right",
  "away",
  "setting",
  "settings",
  "someone",
  "stay",
  "test",
  "testing",
  "when",
]);
const AMBIGUOUS_REFERENCE_TOKENS = new Set(["it", "this", "that", "thing", "setting", "settings"]);
const TEMPORAL_CONFLICT_TOKENS = new Set(["active", "current", "old", "outdated", "still"]);
const TOKEN_EQUIVALENTS = new Map([
  ["chat", ["conversation"]],
  ["chats", ["conversation", "conversations"]],
  ["conversation", ["chat", "chats"]],
  ["conversations", ["chat", "chats"]],
  ["credit", ["payment", "card"]],
  ["delet", ["delete", "deleted", "remove", "removed"]],
  ["delete", ["delet", "deleted", "remove", "removed"]],
  ["deleted", ["delet", "delete", "remove", "removed"]],
  ["email", ["mail", "recipient", "recipients"]],
  ["expires", ["expire", "valid"]],
  ["arriv", ["arrive", "arrives"]],
  ["fast", ["within", "second", "seconds"]],
  ["includ", ["include", "included", "includes"]],
  ["long", ["day", "days", "minute", "minutes", "hour", "hours"]],
  ["mailbox", ["inbox"]],
  ["respond", ["response", "return", "within", "second", "seconds"]],
  ["subscription", ["plan"]],
  ["swap", ["replace"]],
  ["valid", ["expire", "expires"]],
]);

export function tokenize(value) {
  return [...String(value || "").toLowerCase().matchAll(/[a-z0-9]+/g)]
    .map((match) => match[0])
    .filter((token) => !BM25_STOPWORDS.has(token) && token.length > 1);
}

export function normalizeToken(token) {
  for (const suffix of ["ing", "ed", "s"]) {
    if (token.length > suffix.length + 3 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function contentTokens(value) {
  return new Set(
    [...String(value || "").toLowerCase().matchAll(/[a-z0-9]+/g)]
      .map((match) => normalizeToken(match[0]))
      .filter((token) => !EVIDENCE_STOPWORDS.has(token) && token.length > 1),
  );
}

export function bm25Search(question, chunks, topK, options = {}) {
  const settings = { ...RETRIEVAL_DEFAULTS, ...options };
  const query = tokenize(question);
  if (!query.length || !chunks.length) return [];

  const documents = chunks.map((chunk) => tokenize(chunk.text));
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / Math.max(documents.length, 1);
  const documentFrequency = new Map();
  for (const document of documents) {
    for (const token of new Set(document)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const scored = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const document = documents[index];
    const counts = countTokens(document);
    let score = 0;
    for (const token of query) {
      const count = counts.get(token) || 0;
      if (!count) continue;
      const frequency = documentFrequency.get(token) || 0;
      const idf = Math.log(1 + (chunks.length - frequency + 0.5) / (frequency + 0.5));
      const numerator = count * (settings.bm25K1 + 1);
      const denominator = count + settings.bm25K1 * (1 - settings.bm25B + settings.bm25B * document.length / Math.max(averageLength, 1));
      score += idf * (numerator / denominator);
    }
    if (score > 0) scored.push({ score, chunk: chunks[index] });
  }

  return scored
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .slice(0, topK)
    .map(({ score, chunk }) => retrievedChunk(chunk, score, "bm25"));
}

export function semanticSearch(queryVector, chunks, embeddings, topK) {
  if (!chunks.length || !embeddings.length) return [];
  const vectorsByChunk = new Map(embeddings.map((embedding) => [embedding.chunkId, embedding.vector]));
  return chunks
    .map((chunk) => {
      const vector = vectorsByChunk.get(chunk.id || chunk.chunkId);
      if (!vector) return null;
      return { chunk, score: dot(queryVector, vector) };
    })
    .filter((item) => item && item.score > 0)
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .slice(0, topK)
    .map(({ score, chunk }) => retrievedChunk(chunk, score, "semantic"));
}

export function reciprocalRankFusion(bm25Results, semanticResults, topK, constant = RETRIEVAL_DEFAULTS.rrfConstant) {
  const byChunk = new Map();
  const scores = new Map();
  for (const results of [bm25Results, semanticResults]) {
    for (let index = 0; index < results.length; index += 1) {
      const chunk = results[index];
      byChunk.set(chunk.chunkId, byChunk.get(chunk.chunkId) || chunk);
      scores.set(chunk.chunkId, (scores.get(chunk.chunkId) || 0) + 1 / (constant + index + 1));
    }
  }
  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, topK)
    .map(([chunkId, score]) => ({ ...byChunk.get(chunkId), score, strategy: "hybrid" }));
}

export function assessEvidence({ question = "", bm25 = [], semantic = [], hybrid = [], settings = RETRIEVAL_DEFAULTS }) {
  const config = { ...RETRIEVAL_DEFAULTS, ...settings };
  const bestBm25 = bestScore(bm25);
  const bestSemantic = bestScore(semantic);
  const bestHybrid = bestScore(hybrid);
  const semanticMargin = scoreMargin(semantic);
  const coverage = question ? queryCoverage(question, hybrid) : 1;
  const support = supportAnalysis(question, hybrid);
  const ambiguous = isAmbiguousQuestion(question, support.queryTokens);
  const conflict = hasTemporalConflictQuestion(question, support);
  const bm25Documents = topDocumentIds(bm25);
  const semanticDocuments = topDocumentIds(semantic);
  const hybridDocuments = topDocumentIds(hybrid);
  const agreedDocuments = union(intersection(bm25Documents, semanticDocuments), intersection(hybridDocuments, bm25Documents), intersection(hybridDocuments, semanticDocuments));
  const retrievalAgreement = agreedDocuments.size;
  const bm25RankedDocuments = new Set(rankedDocumentIds(bm25));
  const semanticRankedDocuments = new Set(rankedDocumentIds(semantic));
  const topDocumentsCrossSupported = Boolean(
    bm25.length &&
      semantic.length &&
      (semanticRankedDocuments.has(bm25[0].documentId) ||
        bm25RankedDocuments.has(semantic[0].documentId) ||
        intersection(bm25RankedDocuments, semanticRankedDocuments).size),
  );

  const strongBm25 = bestBm25 >= config.bm25ScoreThreshold && coverage >= config.queryCoverageThreshold;
  const strongSemantic = bestSemantic >= config.semanticScoreThreshold && semanticMargin >= config.semanticMarginThreshold;
  const conflictingTopDocuments = Boolean(
    bm25.length &&
      semantic.length &&
      bm25[0].documentId !== semantic[0].documentId &&
      bestBm25 >= config.bm25ScoreThreshold &&
      bestSemantic >= config.semanticScoreThreshold &&
      !topDocumentsCrossSupported,
  );
  const usefulHybrid = bestHybrid >= config.hybridScoreThreshold && retrievalAgreement >= config.minRetrievalAgreement;
  const evidenceChunks = hybrid.filter(
    (chunk) =>
      agreedDocuments.has(chunk.documentId) &&
      (chunk.score >= config.hybridScoreThreshold ||
        bm25Documents.has(chunk.documentId) ||
        semanticDocuments.has(chunk.documentId)),
  ).length;
  const signals = [];
  if (strongBm25) signals.push("strong_bm25");
  if (strongSemantic) signals.push("strong_semantic");
  if (coverage >= config.queryCoverageThreshold) signals.push("query_coverage");
  if (usefulHybrid) signals.push("retrieval_agreement");
  const missingEvidence = support.missingImportantTokens.length > config.missingEvidenceTokenLimit;
  const tooVague = support.specificQueryTokens.length < config.minimumSpecificQueryTokens;
  const sufficient =
    (strongBm25 || strongSemantic) &&
    usefulHybrid &&
    evidenceChunks >= config.minEvidenceChunks &&
    !conflictingTopDocuments &&
    !ambiguous &&
    !conflict &&
    !missingEvidence &&
    !tooVague;
  const reason = evidenceReason({
    sufficient,
    ambiguous,
    conflict: conflict || conflictingTopDocuments,
    missingEvidence,
    tooVague,
  });
  return {
    sufficient,
    reason,
    bestBm25,
    bestSemantic,
    bestHybrid,
    semanticMargin,
    queryCoverage: coverage,
    specificQueryTokens: support.specificQueryTokens,
    missingImportantTokens: support.missingImportantTokens,
    evidenceChunks,
    retrievalAgreement,
    signals,
  };
}

export function selectGenerationContext({ question, bm25 = [], semantic = [], hybrid = [], settings = RETRIEVAL_DEFAULTS, maxChunks = RETRIEVAL_DEFAULTS.generationMaxChunks }) {
  const config = { ...RETRIEVAL_DEFAULTS, ...settings };
  if (!hybrid.length) return [];
  const queryTokens = contentTokens(question);
  const bm25Rank = rankByChunkId(bm25);
  const semanticRank = rankByChunkId(semantic);
  const crossSupportedDocuments = intersection(new Set(rankedDocumentIds(bm25)), new Set(rankedDocumentIds(semantic)));
  const scored = [];
  for (let index = 0; index < hybrid.length; index += 1) {
    const chunk = hybrid[index];
    const overlap = queryTokens.size ? chunkTokenOverlap(question, chunk) : 1;
    if (overlap <= 0 && !crossSupportedDocuments.has(chunk.documentId)) continue;
    const rank = index + 1;
    const rankBonus = 0.3 / rank;
    const lexicalBonus = (2 * overlap) / Math.max(queryTokens.size, 1);
    const crossRankerBonus = crossSupportedDocuments.has(chunk.documentId) ? 0.35 : 0;
    const bm25Bonus = bm25Rank.has(chunk.chunkId) ? 1 / bm25Rank.get(chunk.chunkId) : 0;
    const semanticBonus = semanticRank.has(chunk.chunkId) ? 0.05 / semanticRank.get(chunk.chunkId) : 0;
    scored.push({ score: lexicalBonus + crossRankerBonus + bm25Bonus + semanticBonus + rankBonus, chunk });
  }
  if (!scored.length) return hybrid.slice(0, 1);
  scored.sort((left, right) => right.score - left.score || left.chunk.chunkId.localeCompare(right.chunk.chunkId));
  const best = scored[0].score;
  const selected = [];
  for (const item of scored) {
    if (selected.length >= maxChunks) break;
    if (selected.length && item.score < best * 0.65 && selected.length >= config.minEvidenceChunks) continue;
    selected.push(item.chunk);
  }
  if (selected.length < config.minEvidenceChunks) {
    for (const item of scored) {
      if (!selected.some((chunk) => chunk.chunkId === item.chunk.chunkId)) selected.push(item.chunk);
      if (selected.length >= config.minEvidenceChunks) break;
    }
  }
  return selected.slice(0, maxChunks);
}

export function generateExtractiveAnswer(question, chunks) {
  const used = chunks.slice(0, 3);
  return {
    answer: used.map((chunk) => chunk.text).join(" ").trim(),
    citations: used.map((chunk) => ({ documentId: chunk.documentId, chunkId: chunk.chunkId, title: chunk.documentTitle })),
    sources: used.map((chunk) => chunk.documentTitle),
    insufficientContext: false,
    mode: "extractive",
  };
}

export function validateCitationIds(citationIds, chunks) {
  const allowed = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const seen = new Set();
  const citations = [];
  for (const id of citationIds) {
    if (!allowed.has(id)) throw new Error(`Provider returned fabricated citation: ${id}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const chunk = allowed.get(id);
    citations.push({ documentId: chunk.documentId, chunkId: chunk.chunkId, title: chunk.documentTitle });
  }
  if (!citations.length) throw new Error("Provider response did not include valid citations");
  return citations;
}

export function retrieveFullScan({ question, queryVector, chunks, embeddings, topK = RETRIEVAL_DEFAULTS.topK, settings = RETRIEVAL_DEFAULTS }) {
  const bm25 = bm25Search(question, chunks, topK, settings);
  const semantic = semanticSearch(queryVector, chunks, embeddings, topK);
  const hybrid = reciprocalRankFusion(bm25, semantic, topK, settings.rrfConstant);
  return { bm25, semantic, hybrid };
}

export function retrieveWithPrefilter({ question, queryVector, chunkIndex, vectorSnapshotForChunkIds, topK = RETRIEVAL_DEFAULTS.topK, settings = RETRIEVAL_DEFAULTS }) {
  const config = { ...RETRIEVAL_DEFAULTS, ...settings };
  const bm25All = bm25Search(question, chunkIndex, Math.max(topK, config.lexicalCandidateLimit), config);
  const candidateIds = bm25All.slice(0, config.lexicalCandidateLimit).map((chunk) => chunk.chunkId);
  const fallback = candidateIds.length === 0 || chunkIndex.length <= config.fullScanFallbackChunkLimit;
  const selectedIds = fallback ? chunkIndex.map((chunk) => chunk.id || chunk.chunkId) : candidateIds;
  const snapshot = vectorSnapshotForChunkIds(selectedIds);
  const bm25 = bm25All.slice(0, topK);
  const semantic = semanticSearch(queryVector, snapshot.chunks, snapshot.embeddings, topK);
  const hybrid = reciprocalRankFusion(bm25, semantic, topK, config.rrfConstant);
  return {
    bm25,
    semantic,
    hybrid,
    candidateChunkIds: selectedIds,
    vectorsLoaded: snapshot.embeddings.length,
    fallbackFullScan: fallback,
  };
}

export function answerFromRetrieval({ question, bm25, semantic, hybrid, settings = RETRIEVAL_DEFAULTS }) {
  const evidence = assessEvidence({ question, bm25, semantic, hybrid, settings });
  if (!hybrid.length || !evidence.sufficient) {
    return {
      answer: "I do not have enough information in the knowledge base to answer that.",
      citations: [],
      sources: [],
      chunks: hybrid,
      insufficientContext: true,
      mode: "extractive",
      fallbackReason: evidence.reason,
      evidence,
    };
  }
  const context = selectGenerationContext({ question, bm25, semantic, hybrid, settings });
  return {
    ...generateExtractiveAnswer(question, context),
    chunks: context,
    fallbackReason: null,
    evidence,
  };
}

function retrievedChunk(chunk, score, strategy) {
  return {
    chunkId: chunk.id || chunk.chunkId,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    text: chunk.text,
    score: Number(score),
    strategy,
    metadata: chunk.metadata || {},
  };
}

function countTokens(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function dot(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

function bestScore(chunks) {
  return chunks.reduce((score, chunk) => Math.max(score, chunk.score), 0);
}

function scoreMargin(chunks) {
  if (chunks.length < 2) return bestScore(chunks);
  const ordered = chunks.map((chunk) => chunk.score).sort((left, right) => right - left);
  return ordered[0] - ordered[1];
}

function topDocumentIds(chunks, limit = 3) {
  return new Set(chunks.slice(0, limit).map((chunk) => chunk.documentId));
}

function rankedDocumentIds(chunks, limit = 5) {
  const seen = new Set();
  const ranked = [];
  for (const chunk of chunks.slice(0, limit)) {
    if (seen.has(chunk.documentId)) continue;
    seen.add(chunk.documentId);
    ranked.push(chunk.documentId);
  }
  return ranked;
}

function union(...sets) {
  return new Set(sets.flatMap((set) => [...set]));
}

function intersection(left, right) {
  return new Set([...left].filter((item) => right.has(item)));
}

function queryCoverage(question, chunks) {
  const query = contentTokens(question);
  if (!query.size) return 1;
  const evidence = expandedContentTokens(chunks.map((chunk) => chunk.text).join(" "));
  return [...query].filter((token) => tokenSupported(token, evidence)).length / query.size;
}

function chunkTokenOverlap(question, chunk) {
  const query = contentTokens(question);
  const evidence = contentTokens(chunk.text);
  return [...query].filter((token) => evidence.has(token)).length;
}

function rankByChunkId(chunks) {
  return new Map(chunks.map((chunk, index) => [chunk.chunkId, index + 1]));
}

function expandedContentTokens(value) {
  const tokens = contentTokens(value);
  for (const token of [...tokens]) {
    for (const equivalent of TOKEN_EQUIVALENTS.get(token) || []) tokens.add(equivalent);
  }
  return tokens;
}

function supportAnalysis(question, chunks) {
  const queryTokens = contentTokens(question);
  const evidenceTokens = expandedContentTokens(chunks.map((chunk) => chunk.text).join(" "));
  const specificQueryTokens = [...queryTokens].filter((token) => !GENERIC_QUERY_TOKENS.has(token));
  const missingImportantTokens = specificQueryTokens.filter((token) => !tokenSupported(token, evidenceTokens));
  return {
    queryTokens: [...queryTokens],
    evidenceTokens: [...evidenceTokens],
    specificQueryTokens,
    missingImportantTokens,
  };
}

function tokenSupported(token, evidenceTokens) {
  if (evidenceTokens.has(token)) return true;
  return (TOKEN_EQUIVALENTS.get(token) || []).some((equivalent) => evidenceTokens.has(equivalent));
}

function isAmbiguousQuestion(question, queryTokens) {
  const rawTokens = [...String(question || "").toLowerCase().matchAll(/[a-z0-9]+/g)].map((match) => normalizeToken(match[0]));
  const hasReference = rawTokens.some((token) => AMBIGUOUS_REFERENCE_TOKENS.has(token));
  const specificTokens = queryTokens.filter((token) => !GENERIC_QUERY_TOKENS.has(token));
  return hasReference && specificTokens.length <= 2;
}

function hasTemporalConflictQuestion(question, support) {
  const rawTokens = [...String(question || "").toLowerCase().matchAll(/[a-z0-9]+/g)].map((match) => normalizeToken(match[0]));
  const hasYear = rawTokens.some((token) => /^\d{4}$/.test(token));
  const asksTemporalStatus =
    hasYear ||
    rawTokens.includes("outdated") ||
    (rawTokens.includes("old") && rawTokens.includes("still") && rawTokens.includes("active"));
  if (!hasYear && !asksTemporalStatus) return false;
  return support.missingImportantTokens.some((token) => /^\d{4}$/.test(token) || TEMPORAL_CONFLICT_TOKENS.has(token));
}

function evidenceReason({ sufficient, ambiguous, conflict, missingEvidence, tooVague }) {
  if (sufficient) return null;
  if (ambiguous || tooVague) return "ambiguous_question";
  if (conflict) return "conflicting_retrieval_evidence";
  if (missingEvidence) return "missing_required_evidence";
  return "insufficient_retrieval_evidence";
}
