import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { HostedSQLiteAdapter } from "../src/hosted/sqlite-adapter.mjs";
import {
  HOSTED_LIMITS,
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  sha256,
} from "../src/hosted/storage-contract.mjs";
import {
  answerFromRetrieval,
  bm25Search,
  reciprocalRankFusion,
  retrieveFullScan,
  retrieveWithPrefilter,
  semanticSearch,
} from "../src/hosted/retrieval.mjs";

const WORKSPACE = { workspaceId: "default" };
const FIXTURE_PATH = "ai-service/evaluation/phase-3.6-fixtures.json";
const BASELINE_REPORT_PATH = "ai-service/evaluation/phase-3.7-report.json";
const EMBEDDING_DIMENSION = SUPPORTED_EMBEDDING_PROFILE.dimension;
const SELECTED_CONFIG_ID = "adaptive-small-fullscan-bm25-50";
const QUALITY_CONFIGURATIONS = Object.freeze([
  {
    id: "bm25-only-10",
    label: "BM25-only candidates, limit 10",
    strategy: "bm25",
    settings: { lexicalCandidateLimit: 10, fullScanFallbackChunkLimit: 0 },
  },
  {
    id: "bm25-only-50",
    label: "BM25-only candidates, limit 50",
    strategy: "bm25",
    settings: { lexicalCandidateLimit: 50, fullScanFallbackChunkLimit: 0 },
  },
  {
    id: SELECTED_CONFIG_ID,
    label: "Full scan for <=100 chunks, then BM25 candidates limit 50",
    strategy: "bm25",
    settings: { lexicalCandidateLimit: 50, fullScanFallbackChunkLimit: 100 },
  },
  {
    id: "semantic-fullscan-top-5",
    label: "Semantic candidates from full vector scan, top 5",
    strategy: "semantic-fullscan",
    semanticCandidateLimit: 5,
  },
  {
    id: "bm25-semantic-union-fullscan",
    label: "BM25 + semantic union after full vector scan",
    strategy: "bm25-semantic-union-fullscan",
    lexicalCandidateLimit: 10,
    semanticCandidateLimit: 10,
  },
]);
const BENCHMARK_CONFIGURATIONS = Object.freeze([
  QUALITY_CONFIGURATIONS.find((config) => config.id === "bm25-only-50"),
  QUALITY_CONFIGURATIONS.find((config) => config.id === SELECTED_CONFIG_ID),
]);

async function main() {
  const [fixture, baseline] = await Promise.all([
    readJson(FIXTURE_PATH),
    readJson(BASELINE_REPORT_PATH),
  ]);
  const evaluation = await evaluateFixture(fixture, baseline);
  const benchmark = await runBenchmark();
  console.log(JSON.stringify({ evaluation, benchmark }, null, 2));
}

async function evaluateFixture(fixture, baseline) {
  return withTempAdapter(async (adapter) => {
    const payload = createPayload(fixture.documents);
    const ingestStarted = performance.now();
    adapter.ingest(payload, WORKSPACE);
    const ingestMs = performance.now() - ingestStarted;

    const fullRows = [];
    const configurationRows = new Map(QUALITY_CONFIGURATIONS.map((config) => [config.id, []]));
    for (const question of fixture.questions) {
      const queryVector = tokenHashVector(question.question);
      const fullStarted = performance.now();
      const full = retrieveFullScan({
        question: question.question,
        queryVector,
        ...adapter.getRetrievalSnapshot(WORKSPACE.workspaceId),
        topK: 5,
      });
      const fullMs = performance.now() - fullStarted;
      fullRows.push(rowForQuestion(question, full, answerFromRetrieval({ question: question.question, ...full }), fullMs, {
        vectorsLoaded: fixture.documents.length,
        fallbackFullScan: true,
        candidateChunkIds: full.hybrid.map((chunk) => chunk.chunkId),
      }));
      for (const config of QUALITY_CONFIGURATIONS) {
        const started = performance.now();
        const retrieval = runConfiguredRetrieval(adapter, question.question, queryVector, config, 5);
        const elapsed = performance.now() - started;
        const answer = answerFromRetrieval({ question: question.question, ...retrieval });
        configurationRows.get(config.id).push(rowForQuestion(question, retrieval, answer, elapsed, retrieval));
      }
    }
    const configurations = QUALITY_CONFIGURATIONS.map((config) => ({
      id: config.id,
      label: config.label,
      strategy: config.strategy,
      settings: config.settings || {
        lexicalCandidateLimit: config.lexicalCandidateLimit,
        semanticCandidateLimit: config.semanticCandidateLimit,
      },
      summary: summarizeRows(configurationRows.get(config.id)),
      candidatePrefilter: summarizePrefilter(configurationRows.get(config.id), fullRows),
      sampleRows: configurationRows.get(config.id).slice(0, 5),
    }));
    const selected = configurations.find((config) => config.id === SELECTED_CONFIG_ID);

    return {
      generatedAt: new Date().toISOString(),
      fixture: {
        path: FIXTURE_PATH,
        documents: fixture.documents.length,
        questions: fixture.questions.length,
        customerData: Boolean(fixture.customer_data),
      },
      indexing: {
        adapter: "HostedSQLiteAdapter",
        documentsIngested: fixture.documents.length,
        chunksIndexed: adapter.getChunkIndex(WORKSPACE.workspaceId).length,
        embeddingDimension: EMBEDDING_DIMENSION,
        embeddingProvider: "deterministic token-hash parity harness",
        ingestMs: round(ingestMs),
      },
      selectedConfiguration: selected,
      fullScan: summarizeRows(fullRows),
      configurations,
      candidatePrefilter: selected.candidatePrefilter,
      referencePhase37: {
        reportPath: BASELINE_REPORT_PATH,
        embeddingProvider: baseline.indexing?.embedding_provider,
        embeddingDimensions: baseline.indexing?.embedding_dimensions,
        hybridDocumentLevel: baseline.retrieval?.document_level?.hybrid,
        generation: pickGenerationSummary(baseline.generation),
      },
      comparability: [
        "The hosted run exercises the same synthetic corpus and metric formulas as Phase 3.7.",
        "It does not reuse Phase 3.7's 64-dimensional Python TokenHash vectors because the hosted contract validates the browser-compatible 384-dimensional profile.",
        "Full scan and optimized hosted retrieval in this report use the same 384-dimensional vectors, corpus, chunk IDs, queries, labels, retrieval settings, and evidence thresholds.",
        "The Phase 3.7 Python report remains an external reference only; it is not a direct parity claim because its vectors are 64-dimensional.",
      ],
      rootCause: [
        "The Phase 4.3D optimized path loaded only BM25-positive candidates before semantic scoring.",
        "Semantic candidates outside that lexical shortlist were discarded before RRF, causing low top-5 ranking agreement against full scan.",
        "A true semantic candidate generator needs vector scoring, so full-scan fallback is the only exact semantic-preservation strategy without an additional approximate vector index.",
      ],
    };
  });
}

async function runBenchmark() {
  const sizes = [100, 1000, 5000];
  const results = [];
  for (const size of sizes) {
    results.push(await withTempAdapter(async (adapter) => {
      adapter.ingest(createSyntheticPayload(size), WORKSPACE);
      const question = "Where is the aurora escalation policy for billing alerts?";
      const queryVector = tokenHashVector(question);
      const chunkIndex = adapter.getChunkIndex(WORKSPACE.workspaceId);

      const fullStarted = performance.now();
      const snapshot = adapter.getRetrievalSnapshot(WORKSPACE.workspaceId);
      retrieveFullScan({ question, queryVector, ...snapshot, topK: 5 });
      const fullMs = performance.now() - fullStarted;

      return {
        chunks: size,
        fullScanMs: round(fullMs),
        vectorsLoadedFullScan: snapshot.embeddings.length,
        configurations: BENCHMARK_CONFIGURATIONS.map((config) => benchmarkConfiguration(adapter, question, queryVector, chunkIndex, config)),
        heapUsedMb: round(process.memoryUsage().heapUsed / 1024 / 1024),
      };
    }, { maxChunksPerDocument: 6000, maxVectorsPerIngest: 6000, maxPayloadBytes: 80 * 1024 * 1024 }));
  }
  return {
    methodology: "Single local Node.js process using node:sqlite, synthetic one-document corpora, 384-dimensional deterministic vectors, and deterministic candidate configurations.",
    results,
  };
}

function runConfiguredRetrieval(adapter, question, queryVector, config, topK) {
  const chunkIndex = adapter.getChunkIndex(WORKSPACE.workspaceId);
  if (config.strategy === "bm25") {
    return retrieveWithPrefilter({
      question,
      queryVector,
      chunkIndex,
      vectorSnapshotForChunkIds: (ids) => adapter.getRetrievalSnapshot(WORKSPACE.workspaceId, { chunkIds: ids }),
      topK,
      settings: config.settings,
    });
  }

  const fullSnapshot = adapter.getRetrievalSnapshot(WORKSPACE.workspaceId);
  const bm25All = bm25Search(question, chunkIndex, Math.max(topK, config.lexicalCandidateLimit || topK));
  const semanticAll = semanticSearch(queryVector, fullSnapshot.chunks, fullSnapshot.embeddings, Math.max(topK, config.semanticCandidateLimit || topK));
  if (config.strategy === "semantic-fullscan") {
    const semantic = semanticAll.slice(0, topK);
    const bm25 = bm25All.slice(0, topK);
    const hybrid = reciprocalRankFusion(bm25, semantic, topK);
    return {
      bm25,
      semantic,
      hybrid,
      candidateChunkIds: semanticAll.slice(0, config.semanticCandidateLimit || topK).map((chunk) => chunk.chunkId),
      vectorsLoaded: fullSnapshot.embeddings.length,
      fallbackFullScan: true,
    };
  }

  if (config.strategy === "bm25-semantic-union-fullscan") {
    const candidateIds = unique([
      ...bm25All.slice(0, config.lexicalCandidateLimit || topK).map((chunk) => chunk.chunkId),
      ...semanticAll.slice(0, config.semanticCandidateLimit || topK).map((chunk) => chunk.chunkId),
    ]);
    const candidateSnapshot = adapter.getRetrievalSnapshot(WORKSPACE.workspaceId, { chunkIds: candidateIds });
    const bm25 = bm25All.slice(0, topK);
    const semantic = semanticSearch(queryVector, candidateSnapshot.chunks, candidateSnapshot.embeddings, topK);
    const hybrid = reciprocalRankFusion(bm25, semantic, topK);
    return {
      bm25,
      semantic,
      hybrid,
      candidateChunkIds: candidateIds,
      vectorsLoaded: fullSnapshot.embeddings.length,
      fallbackFullScan: true,
    };
  }

  throw new Error(`Unknown retrieval configuration: ${config.id}`);
}

function benchmarkConfiguration(adapter, question, queryVector, chunkIndex, config) {
  const candidateStarted = performance.now();
  const bm25All = bm25Search(question, chunkIndex, Math.max(5, config.settings?.lexicalCandidateLimit || 50));
  const smallCorpusFallback = config.settings?.fullScanFallbackChunkLimit != null && chunkIndex.length <= config.settings.fullScanFallbackChunkLimit;
  const candidateIds = smallCorpusFallback
    ? chunkIndex.map((chunk) => chunk.id || chunk.chunkId)
    : bm25All.slice(0, config.settings?.lexicalCandidateLimit || 50).map((chunk) => chunk.chunkId);
  const prefilterMs = performance.now() - candidateStarted;

  const vectorLoadStarted = performance.now();
  const selectedSnapshot = adapter.getRetrievalSnapshot(WORKSPACE.workspaceId, { chunkIds: candidateIds });
  const vectorLoadMs = performance.now() - vectorLoadStarted;

  const semanticStarted = performance.now();
  const semantic = semanticSearch(queryVector, selectedSnapshot.chunks, selectedSnapshot.embeddings, 5);
  const semanticMs = performance.now() - semanticStarted;

  const fusionStarted = performance.now();
  reciprocalRankFusion(bm25All.slice(0, 5), semantic, 5);
  const fusionMs = performance.now() - fusionStarted;

  return {
    id: config.id,
    label: config.label,
    totalMs: round(prefilterMs + vectorLoadMs + semanticMs + fusionMs),
    prefilterMs: round(prefilterMs),
    vectorLoadMs: round(vectorLoadMs),
    semanticMs: round(semanticMs),
    fusionMs: round(fusionMs),
    candidates: candidateIds.length,
    vectorsLoaded: selectedSnapshot.embeddings.length,
    fallbackFullScan: smallCorpusFallback || candidateIds.length === 0,
  };
}

function createPayload(documents) {
  return {
    workspaceId: WORKSPACE.workspaceId,
    embeddingProfile: {
      id: SUPPORTED_EMBEDDING_PROFILE.id,
      compatibilityKey: SUPPORTED_EMBEDDING_PROFILE.compatibilityKey,
    },
    indexingProfile: {
      id: SUPPORTED_INDEXING_PROFILE_WITH_KEY.id,
      compatibilityKey: SUPPORTED_INDEXING_PROFILE_WITH_KEY.compatibilityKey,
    },
    documents: documents.map((document) => {
      const chunkId = `${document.id}:chunk-0`;
      return {
        id: document.id,
        title: document.title,
        sourceType: "synthetic-fixture",
        contentHash: sha256(document.content),
        metadata: { tags: document.tags || [] },
        chunks: [
          {
            id: chunkId,
            documentId: document.id,
            documentTitle: document.title,
            position: 0,
            text: document.content,
            hash: sha256(document.content),
            metadata: { tags: document.tags || [] },
          },
        ],
        vectors: [tokenHashVector(document.content)],
      };
    }),
  };
}

function createSyntheticPayload(size) {
  const target = Math.min(size - 1, 42);
  const chunks = Array.from({ length: size }, (_, index) => {
    const text = index === target
      ? "Aurora escalation policy covers billing alerts, urgent customer risk, and support handoff."
      : `Synthetic support filler ${index} about routine settings exports widgets and workspace operations.`;
    return {
      id: `bench:chunk-${index}`,
      documentId: "bench",
      documentTitle: "Benchmark Corpus",
      position: index,
      text,
      hash: sha256(text),
      metadata: {},
    };
  });
  return {
    workspaceId: WORKSPACE.workspaceId,
    embeddingProfile: {
      id: SUPPORTED_EMBEDDING_PROFILE.id,
      compatibilityKey: SUPPORTED_EMBEDDING_PROFILE.compatibilityKey,
    },
    indexingProfile: {
      id: SUPPORTED_INDEXING_PROFILE_WITH_KEY.id,
      compatibilityKey: SUPPORTED_INDEXING_PROFILE_WITH_KEY.compatibilityKey,
    },
    documents: [
      {
        id: "bench",
        title: "Benchmark Corpus",
        sourceType: "synthetic-benchmark",
        contentHash: sha256(chunks.map((chunk) => chunk.text).join("\n")),
        metadata: {},
        chunks,
        vectors: chunks.map((chunk) => tokenHashVector(chunk.text)),
      },
    ],
  };
}

function tokenHashVector(text) {
  const values = Array.from({ length: EMBEDDING_DIMENSION }, () => 0);
  for (const token of [...String(text || "").toLowerCase().matchAll(/[a-z0-9]+/g)].map((match) => match[0])) {
    const digest = createHash("sha256").update(token).digest();
    values[digest.readUInt32BE(0) % values.length] += 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return values;
  return values.map((value) => value / norm);
}

function rowForQuestion(question, retrieval, answer, latencyMs, optimization) {
  const citations = answer.citations.map((citation) => citation.chunkId);
  return {
    id: question.id,
    type: question.type,
    expectedAbstain: question.expected_abstain,
    expectedDocuments: question.expected_relevant_documents,
    expectedChunks: question.expected_source_chunks,
    bm25: listResults(retrieval.bm25),
    semantic: listResults(retrieval.semantic),
    hybrid: listResults(retrieval.hybrid),
    abstained: Boolean(answer.insufficientContext),
    answerRelevancePass: answerRelevancePass(question, answer),
    citationValidityPass: citations.every((chunkId) => retrieval.hybrid.some((chunk) => chunk.chunkId === chunkId)),
    citationPrecision: precision(new Set(question.expected_source_chunks), citations),
    citationCoverage: recall(new Set(question.expected_source_chunks), citations),
    citations,
    latencyMs: round(latencyMs),
    vectorsLoaded: optimization.vectorsLoaded,
    candidateCount: optimization.candidateChunkIds?.length || optimization.vectorsLoaded,
    fallbackFullScan: Boolean(optimization.fallbackFullScan),
  };
}

function listResults(results) {
  return {
    documents: results.map((result) => result.documentId),
    chunks: results.map((result) => result.chunkId),
  };
}

function summarizeRows(rows) {
  return {
    retrieval: {
      documentLevel: {
        bm25: summarizeStrategy(rows, "bm25", "documents"),
        semantic: summarizeStrategy(rows, "semantic", "documents"),
        hybrid: summarizeStrategy(rows, "hybrid", "documents"),
      },
      chunkLevel: {
        bm25: summarizeStrategy(rows, "bm25", "chunks", "expectedChunks"),
        semantic: summarizeStrategy(rows, "semantic", "chunks", "expectedChunks"),
        hybrid: summarizeStrategy(rows, "hybrid", "chunks", "expectedChunks"),
      },
      multiDocumentSuccessAt5: round(average(rows.filter((row) => row.expectedDocuments.length > 1).map((row) => recall(new Set(row.expectedDocuments), row.hybrid.documents.slice(0, 5)) === 1 ? 1 : 0))),
    },
    generation: {
      answerableResponseRate: round(rate(rows.filter((row) => !row.expectedAbstain), (row) => !row.abstained)),
      unanswerableAbstentionRate: round(rate(rows.filter((row) => row.type === "unanswerable" || row.type === "partial-insufficient" || row.type === "conflict"), (row) => row.abstained)),
      ambiguousAbstentionRate: round(rate(rows.filter((row) => row.type === "ambiguous"), (row) => row.abstained)),
      answerRelevance: round(rate(rows, (row) => row.answerRelevancePass)),
      citationValidity: round(rate(rows, (row) => row.citationValidityPass)),
      citationPrecision: round(average(rows.map((row) => row.citationPrecision))),
      citationCoverage: round(average(rows.map((row) => row.citationCoverage))),
    },
    latencyMs: latency(rows.map((row) => row.latencyMs)),
  };
}

function summarizeStrategy(rows, strategy, target, expectedKey = "expectedDocuments") {
  return {
    recallAt3: round(average(rows.map((row) => recall(new Set(row[expectedKey]), row[strategy][target].slice(0, 3))))),
    precisionAt3: round(average(rows.map((row) => precision(new Set(row[expectedKey]), row[strategy][target].slice(0, 3), 3)))),
    mrr: round(average(rows.map((row) => reciprocalRank(new Set(row[expectedKey]), row[strategy][target])))),
    hitRateAt3: round(average(rows.map((row) => hitRate(new Set(row[expectedKey]), row[strategy][target].slice(0, 3))))),
    recallAt5: round(average(rows.map((row) => recall(new Set(row[expectedKey]), row[strategy][target].slice(0, 5))))),
    precisionAt5: round(average(rows.map((row) => precision(new Set(row[expectedKey]), row[strategy][target].slice(0, 5), 5)))),
    hitRateAt5: round(average(rows.map((row) => hitRate(new Set(row[expectedKey]), row[strategy][target].slice(0, 5))))),
  };
}

function summarizePrefilter(rows, fullRows) {
  let top5Agreement = 0;
  let top3Agreement = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (sameList(rows[index].hybrid.chunks.slice(0, 5), fullRows[index].hybrid.chunks.slice(0, 5))) top5Agreement += 1;
    if (sameList(rows[index].hybrid.chunks.slice(0, 3), fullRows[index].hybrid.chunks.slice(0, 3))) top3Agreement += 1;
  }
  return {
    top3RankingAgreement: round(top3Agreement / rows.length),
    top5RankingAgreement: round(top5Agreement / rows.length),
    averageVectorsLoaded: round(average(rows.map((row) => row.vectorsLoaded))),
    maxVectorsLoaded: Math.max(...rows.map((row) => row.vectorsLoaded)),
    fallbackFullScanCount: rows.filter((row) => row.fallbackFullScan).length,
    optimizedHybridRecallAt5: summarizeStrategy(rows, "hybrid", "documents").recallAt5,
    fullScanHybridRecallAt5: summarizeStrategy(fullRows, "hybrid", "documents").recallAt5,
  };
}

function answerRelevancePass(question, answer) {
  if (question.expected_abstain) return Boolean(answer.insufficientContext);
  if (answer.insufficientContext) return false;
  const normalized = normalize(answer.answer);
  return question.expected_answer_contains.some((phrase) => normalized.includes(normalize(phrase)));
}

function pickGenerationSummary(generation = {}) {
  return {
    answerableResponseRate: generation.answerable_response_rate,
    unanswerableAbstentionRate: generation.unanswerable_abstention_rate,
    ambiguousAbstentionRate: generation.ambiguous_abstention_rate,
    answerRelevance: generation.answer_relevance,
    citationValidity: generation.citation_validity,
    citationPrecision: generation.citation_precision,
    citationCoverage: generation.citation_coverage,
  };
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function recall(expected, retrieved) {
  if (!expected.size) return 0;
  return [...expected].filter((item) => retrieved.includes(item)).length / expected.size;
}

function precision(expected, retrieved, denominator = retrieved.length) {
  if (denominator <= 0) return expected.size ? 0 : 1;
  return [...expected].filter((item) => retrieved.includes(item)).length / denominator;
}

function hitRate(expected, retrieved) {
  return [...expected].some((item) => retrieved.includes(item)) ? 1 : 0;
}

function reciprocalRank(expected, retrieved) {
  for (let index = 0; index < retrieved.length; index += 1) {
    if (expected.has(retrieved[index])) return 1 / (index + 1);
  }
  return 0;
}

function rate(rows, predicate) {
  if (!rows.length) return 0;
  return rows.filter(predicate).length / rows.length;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function latency(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    mean: round(average(sorted)),
    median: round(sorted[Math.floor(sorted.length / 2)] || 0),
    p95: round(sorted[Math.floor(sorted.length * 0.95)] || sorted.at(-1) || 0),
  };
}

function sameList(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function unique(values) {
  return [...new Set(values)];
}

function round(value) {
  return Number(value.toFixed(4));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function withTempAdapter(callback, limits = {}) {
  const directory = await mkdtemp(join(tmpdir(), "askwell-hosted-retrieval-eval-"));
  const adapter = new HostedSQLiteAdapter({
    path: join(directory, "hosted.sqlite3"),
    limits: { ...HOSTED_LIMITS, ...limits },
  });
  try {
    return await callback(adapter);
  } finally {
    adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
