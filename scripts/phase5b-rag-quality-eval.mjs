import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOSTED_LIMITS,
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  createMemoryHostedStore,
  sha256,
} from "../src/hosted/storage-contract.mjs";
import {
  answerFromRetrieval,
  retrieveWithPrefilter,
} from "../src/hosted/retrieval.mjs";

const FIXTURE_PATH = "tests/fixtures/phase5b-rag-quality-fixture.json";
const WORKSPACE = { workspaceId: "default" };
const DIMENSION = SUPPORTED_EMBEDDING_PROFILE.dimension;

export async function main() {
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
  const report = evaluateFixture(fixture);
  console.log(JSON.stringify(report, null, 2));
}

export function evaluateFixture(fixture) {
  const store = createMemoryHostedStore({ limits: HOSTED_LIMITS });
  store.saveWorkspace(
    {
      workspaceId: WORKSPACE.workspaceId,
      expectedVersion: 1,
      settings: { brand: "AskWell Eval", accent: "#ef7d62", welcome: "Hi" },
      articles: fixture.articles,
      conversations: [],
    },
    WORKSPACE,
  );

  const ingestStarted = performance.now();
  const ingest = store.ingest(buildPayload(fixture.articles), WORKSPACE);
  const ingestMs = performance.now() - ingestStarted;

  const rows = fixture.questions.map((question) => evaluateQuestion(store, question));
  return {
    generatedAt: new Date().toISOString(),
    fixture: {
      path: FIXTURE_PATH,
      articles: fixture.articles.length,
      questions: fixture.questions.length,
      customerData: Boolean(fixture.customer_data),
    },
    workflow: {
      workspaceArticleCreation: "exercised through in-memory hosted workspace save",
      articleIndexing: {
        status: ingest.status,
        documentStatuses: ingest.documentStatuses,
        documentsIndexed: store.listDocuments(WORKSPACE.workspaceId).length,
        chunksIndexed: store.getRetrievalSnapshot(WORKSPACE.workspaceId).chunks.length,
        ingestMs: round(ingestMs),
      },
      embedding: {
        provider: "browser-compatible deterministic harness",
        productionModel: "Xenova/all-MiniLM-L6-v2",
        quantized: false,
        dimension: DIMENSION,
        note: "This local evaluation avoids model downloads and paid calls; it validates the hosted RAG contract with 384-dimensional normalized vectors under the supported browser profile.",
      },
      retrieval: "hosted BM25 + semantic + RRF using retrieveWithPrefilter",
      generation: "hosted extractive answer generation with evidence sufficiency and citation validation",
    },
    metrics: summarizeRows(rows),
    rows,
    limitations: [
      "This does not download the real browser model; Phase 4.2C established model parity separately.",
      "No production Turso database or remote Vercel deployment is used.",
      "Generation is extractive, not live LLM generation.",
    ],
  };
}

function buildPayload(articles) {
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
    documents: articles.map((article) => {
      const text = normalizeText(article.content);
      const chunk = {
        id: `${article.id}:chunk-0`,
        documentId: article.id,
        documentTitle: article.title,
        position: 0,
        text,
        hash: sha256(text),
        metadata: { tags: article.tags || [] },
      };
      return {
        id: article.id,
        stableId: article.id,
        title: article.title,
        sourceType: "article",
        contentHash: sha256(text),
        metadata: { tags: article.tags || [] },
        chunks: [chunk],
        vectors: [tokenHashVector(text)],
      };
    }),
  };
}

function evaluateQuestion(store, question) {
  const started = performance.now();
  const queryVector = tokenHashVector(question.question);
  const chunkIndex = store.getRetrievalSnapshot(WORKSPACE.workspaceId).chunks;
  const retrieval = retrieveWithPrefilter({
    question: question.question,
    queryVector,
    chunkIndex,
    vectorSnapshotForChunkIds: (chunkIds) =>
      filterSnapshot(store.getRetrievalSnapshot(WORKSPACE.workspaceId), chunkIds),
    topK: 5,
  });
  const answer = answerFromRetrieval({
    question: question.question,
    bm25: retrieval.bm25,
    semantic: retrieval.semantic,
    hybrid: retrieval.hybrid,
  });
  const latencyMs = performance.now() - started;
  const citations = answer.citations.map((citation) => citation.chunkId);
  return {
    id: question.id,
    type: question.type,
    question: question.question,
    expectedAbstain: question.expected_abstain,
    expectedDocuments: question.expected_relevant_documents,
    expectedChunks: question.expected_source_chunks,
    bm25: listResults(retrieval.bm25),
    semantic: listResults(retrieval.semantic),
    hybrid: listResults(retrieval.hybrid),
    abstained: Boolean(answer.insufficientContext),
    answer: answer.answer,
    fallbackReason: answer.fallbackReason,
    answerRelevancePass: answerRelevancePass(question, answer),
    citationValidityPass: citations.every((chunkId) => retrieval.hybrid.some((chunk) => chunk.chunkId === chunkId)),
    citationPrecision: precision(new Set(question.expected_source_chunks), citations),
    citationCoverage: recall(new Set(question.expected_source_chunks), citations),
    citations,
    latencyMs: round(latencyMs),
  };
}

function filterSnapshot(snapshot, chunkIds) {
  const selected = new Set(chunkIds);
  return {
    chunks: snapshot.chunks.filter((chunk) => selected.has(chunk.id || chunk.chunkId)),
    embeddings: snapshot.embeddings.filter((embedding) => selected.has(embedding.chunkId)),
  };
}

export function summarizeRows(rows) {
  const retrievalRows = rows.filter((row) => row.expectedDocuments.length > 0);
  const answerableRows = rows.filter((row) => !row.expectedAbstain);
  const citationRows = rows.filter((row) => row.expectedChunks.length > 0);
  const unanswerableRows = rows.filter((row) => row.type === "unanswerable" || row.type === "partial-insufficient");
  const ambiguousRows = rows.filter((row) => row.type === "ambiguous");
  return {
    denominators: {
      totalQuestions: rows.length,
      retrievalQuestions: retrievalRows.length,
      answerableQuestions: answerableRows.length,
      unanswerableQuestions: unanswerableRows.length,
      ambiguousQuestions: ambiguousRows.length,
      citationQuestions: citationRows.length,
    },
    retrieval: {
      bm25: summarizeStrategy(retrievalRows, "bm25"),
      semantic: summarizeStrategy(retrievalRows, "semantic"),
      hybrid: summarizeStrategy(retrievalRows, "hybrid"),
    },
    generation: {
      answerableResponseRate: round(rate(answerableRows, (row) => !row.abstained)),
      unanswerableAbstentionRate: round(rate(unanswerableRows, (row) => row.abstained)),
      ambiguousAbstentionRate: round(rate(ambiguousRows, (row) => row.abstained)),
      answerRelevance: round(rate(answerableRows, (row) => row.answerRelevancePass)),
      citationValidity: round(rate(rows, (row) => row.citationValidityPass)),
      citationPrecision: round(average(citationRows.map((row) => row.citationPrecision))),
      citationCoverage: round(average(citationRows.map((row) => row.citationCoverage))),
    },
    latencyMs: latency(rows.map((row) => row.latencyMs)),
  };
}

function summarizeStrategy(rows, strategy) {
  return {
    recallAt3: round(average(rows.map((row) => recall(new Set(row.expectedDocuments), row[strategy].documents.slice(0, 3))))),
    recallAt5: round(average(rows.map((row) => recall(new Set(row.expectedDocuments), row[strategy].documents.slice(0, 5))))),
    mrr: round(average(rows.map((row) => reciprocalRank(new Set(row.expectedDocuments), row[strategy].documents)))),
    hitRateAt5: round(average(rows.map((row) => hitRate(new Set(row.expectedDocuments), row[strategy].documents.slice(0, 5))))),
  };
}

function listResults(results) {
  return {
    documents: results.map((result) => result.documentId),
    chunks: results.map((result) => result.chunkId),
  };
}

function answerRelevancePass(question, answer) {
  if (question.expected_abstain) return Boolean(answer.insufficientContext);
  if (answer.insufficientContext) return false;
  const normalized = normalize(answer.answer);
  return question.expected_answer_contains.some((phrase) => normalized.includes(normalize(phrase)));
}

function tokenHashVector(text) {
  const values = Array.from({ length: DIMENSION }, () => 0);
  for (const token of [...String(text || "").toLowerCase().matchAll(/[a-z0-9]+/g)].map((match) => match[0])) {
    const digest = createHash("sha256").update(token).digest();
    values[digest.readUInt32BE(0) % values.length] += 1;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return values;
  return values.map((value) => value / norm);
}

function normalizeText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function recall(expected, retrieved) {
  if (!expected.size) return 0;
  return [...expected].filter((item) => retrieved.includes(item)).length / expected.size;
}

function precision(expected, retrieved) {
  if (!expected.size && !retrieved.length) return 1;
  if (!retrieved.length) return expected.size ? 0 : 1;
  return [...expected].filter((item) => retrieved.includes(item)).length / retrieved.length;
}

function hitRate(expected, retrieved) {
  if (!expected.size) return 0;
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

function round(value) {
  return Number(value.toFixed(4));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
