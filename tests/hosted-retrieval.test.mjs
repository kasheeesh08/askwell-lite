import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { HostedSQLiteAdapter } from "../src/hosted/sqlite-adapter.mjs";
import {
  HOSTED_LIMITS,
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  sha256,
} from "../src/hosted/storage-contract.mjs";
import {
  answerFromRetrieval,
  assessEvidence,
  bm25Search,
  generateExtractiveAnswer,
  reciprocalRankFusion,
  retrieveFullScan,
  retrieveWithPrefilter,
  semanticSearch,
  validateCitationIds,
} from "../src/hosted/retrieval.mjs";

const workspace = { workspaceId: "default" };

function vector(values) {
  const result = Array.from({ length: SUPPORTED_EMBEDDING_PROFILE.dimension }, () => 0);
  for (const [index, value] of Object.entries(values)) {
    result[Number(index)] = value;
  }
  const norm = Math.sqrt(result.reduce((sum, value) => sum + value * value, 0));
  return result.map((value) => value / norm);
}

function chunk(id, documentId, text) {
  return {
    id,
    chunkId: id,
    workspaceId: "default",
    documentId,
    documentTitle: documentId,
    position: 0,
    text,
    hash: sha256(text),
    metadata: {},
  };
}

function payload(documents) {
  return {
    workspaceId: "default",
    embeddingProfile: {
      id: SUPPORTED_EMBEDDING_PROFILE.id,
      compatibilityKey: SUPPORTED_EMBEDDING_PROFILE.compatibilityKey,
    },
    indexingProfile: {
      id: SUPPORTED_INDEXING_PROFILE_WITH_KEY.id,
      compatibilityKey: SUPPORTED_INDEXING_PROFILE_WITH_KEY.compatibilityKey,
    },
    documents: documents.map((document) => ({
      id: document.id,
      title: document.title || document.id,
      sourceType: "test",
      contentHash: sha256(document.chunks.map((item) => item.text).join("\n")),
      metadata: {},
      chunks: document.chunks,
      vectors: document.vectors,
    })),
  };
}

async function withTempDatabase(callback, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "askwell-hosted-retrieval-"));
  const databasePath = join(directory, "hosted.sqlite3");
  const adapter = new HostedSQLiteAdapter({
    path: databasePath,
    limits: { ...HOSTED_LIMITS, maxPayloadBytes: 20 * 1024 * 1024, maxChunksPerDocument: 500, maxVectorsPerIngest: 500 },
    ...options,
  });
  try {
    await callback(adapter, databasePath);
  } finally {
    adapter.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("BM25 ranks exact lexical support first with deterministic tie-breaking", () => {
  const chunks = [
    chunk("b:chunk-0", "b", "alpha beta support"),
    chunk("a:chunk-0", "a", "alpha beta support"),
    chunk("c:chunk-0", "c", "unrelated words"),
  ];
  const results = bm25Search("alpha beta", chunks, 3);
  assert.deepEqual(results.map((item) => item.chunkId), ["a:chunk-0", "b:chunk-0"]);
  assert.equal(results[0].strategy, "bm25");
});

test("semantic retrieval ranks by cosine similarity", () => {
  const chunks = [
    chunk("trial:chunk-0", "trial", "Trial"),
    chunk("billing:chunk-0", "billing", "Billing"),
  ];
  const embeddings = [
    { chunkId: "trial:chunk-0", vector: vector({ 0: 1 }) },
    { chunkId: "billing:chunk-0", vector: vector({ 1: 1 }) },
  ];
  const results = semanticSearch(vector({ 0: 0.8, 1: 0.2 }), chunks, embeddings, 2);
  assert.deepEqual(results.map((item) => item.chunkId), ["trial:chunk-0", "billing:chunk-0"]);
});

test("RRF fuses BM25 and semantic rankings deterministically", () => {
  const first = { chunkId: "a", documentId: "a", documentTitle: "A", text: "A", score: 10, strategy: "bm25" };
  const second = { chunkId: "b", documentId: "b", documentTitle: "B", text: "B", score: 0.9, strategy: "semantic" };
  const fused = reciprocalRankFusion([first, second], [second, first], 2);
  assert.deepEqual(fused.map((item) => item.chunkId), ["a", "b"]);
  assert.equal(fused[0].strategy, "hybrid");
});

test("evidence sufficiency supports answerable questions and abstains on weak evidence", () => {
  const strong = { chunkId: "trial:chunk-0", documentId: "trial", documentTitle: "Trial", text: "The trial lasts 14 days.", score: 4.2, strategy: "bm25" };
  const semantic = { ...strong, score: 0.7, strategy: "semantic" };
  const hybrid = { ...strong, score: 0.04, strategy: "hybrid" };
  assert.equal(assessEvidence({ question: "How long is the trial?", bm25: [strong], semantic: [semantic], hybrid: [hybrid] }).sufficient, true);

  const weak = { ...hybrid, documentId: "other", chunkId: "other:chunk-0", text: "Other content", score: 0.001 };
  assert.equal(assessEvidence({ question: "How long is the trial?", bm25: [], semantic: [], hybrid: [weak] }).sufficient, false);
});

test("evidence sufficiency distinguishes support, ambiguity, missing evidence, and conflict", () => {
  const webhook = {
    chunkId: "webhook:chunk-0",
    documentId: "webhook",
    documentTitle: "Webhook",
    text: "The webhook endpoint must return a 2xx response within ten seconds.",
    score: 8,
    strategy: "bm25",
  };
  const supported = assessEvidence({
    question: "How fast must my webhook endpoint respond?",
    bm25: [webhook],
    semantic: [{ ...webhook, score: 0.45, strategy: "semantic" }],
    hybrid: [{ ...webhook, score: 0.04, strategy: "hybrid" }],
  });
  assert.equal(supported.sufficient, true);

  const vague = {
    chunkId: "roles:chunk-0",
    documentId: "roles",
    documentTitle: "Roles",
    text: "Owners can change roles and manage billing.",
    score: 5,
    strategy: "bm25",
  };
  assert.equal(
    assessEvidence({
      question: "Can I change it?",
      bm25: [vague],
      semantic: [{ ...vague, score: 0.4, strategy: "semantic" }],
      hybrid: [{ ...vague, score: 0.04, strategy: "hybrid" }],
    }).reason,
    "ambiguous_question",
  );

  const signIn = {
    chunkId: "password:chunk-0",
    documentId: "password",
    documentTitle: "Password",
    text: "Use Forgot password on the sign in page to request a reset email.",
    score: 5,
    strategy: "bm25",
  };
  assert.equal(
    assessEvidence({
      question: "How do I configure SAML single sign on?",
      bm25: [signIn],
      semantic: [{ ...signIn, score: 0.4, strategy: "semantic" }],
      hybrid: [{ ...signIn, score: 0.04, strategy: "hybrid" }],
    }).reason,
    "missing_required_evidence",
  );

  const trial = {
    chunkId: "trial:chunk-0",
    documentId: "trial",
    documentTitle: "Trial",
    text: "A payment card is not required during the 14 day trial.",
    score: 6,
    strategy: "bm25",
  };
  assert.equal(
    assessEvidence({
      question: "Is the old 2023 trial card policy still active?",
      bm25: [trial],
      semantic: [{ ...trial, score: 0.5, strategy: "semantic" }],
      hybrid: [{ ...trial, score: 0.04, strategy: "hybrid" }],
    }).reason,
    "conflicting_retrieval_evidence",
  );
});

test("evidence sufficiency ignores conversational filler while preserving unsupported abstention", () => {
  const install = {
    chunkId: "install-widget:chunk-0",
    documentId: "install-widget",
    documentTitle: "Install the chat widget",
    text: "Copy the widget script from the Install tab and paste it before the closing body tag on your website. The static starter uses local knowledge base answers.",
    score: 0.04,
    strategy: "hybrid",
    metadata: { tags: ["setup", "widget"] },
  };
  const bm25 = [{ ...install, score: 3.6940987388980213, strategy: "bm25" }];
  const semantic = [{ ...install, score: 0.553806163577732, strategy: "semantic" }];
  const hybrid = [install];

  for (const question of [
    "I need help understanding how to install the AskWell support widget on my website.",
    "Can you help me install the support widget?",
    "How do I add the widget to my website?",
    "I need instructions for installing the chat widget.",
  ]) {
    const answer = answerFromRetrieval({ question, bm25, semantic, hybrid });
    assert.equal(answer.insufficientContext, false, question);
    assert.deepEqual(answer.citations.map((citation) => citation.title), ["Install the chat widget"]);
    assert.ok(answer.evidence.queryCoverage >= 0.45, question);
    assert.deepEqual(answer.evidence.missingImportantTokens, [], question);
  }

  const unrelated = answerFromRetrieval({
    question: "Can I connect Slack alerts to a private billing channel?",
    bm25,
    semantic,
    hybrid,
  });
  assert.equal(unrelated.insufficientContext, true);
  assert.equal(unrelated.fallbackReason, "missing_required_evidence");

  const unsupportedSpecific = answerFromRetrieval({
    question: "How do I install the Shopify plugin for the support widget?",
    bm25,
    semantic,
    hybrid,
  });
  assert.equal(unsupportedSpecific.insufficientContext, true);
  assert.equal(unsupportedSpecific.fallbackReason, "missing_required_evidence");
});

test("answer generation works for sufficient multi-chunk evidence and abstains when support is missing", () => {
  const exportChunk = {
    chunkId: "export:chunk-0",
    documentId: "export",
    documentTitle: "Export",
    text: "Exports include article titles, tags, questions, answers, timestamps, and cited source IDs.",
    score: 0.04,
    strategy: "hybrid",
  };
  const paymentChunk = {
    chunkId: "payment:chunk-0",
    documentId: "payment",
    documentTitle: "Payment",
    text: "Exports do not include payment card details or API keys.",
    score: 0.03,
    strategy: "hybrid",
  };
  const answer = answerFromRetrieval({
    question: "What data is included in exports and are payment cards included?",
    bm25: [{ ...exportChunk, score: 7, strategy: "bm25" }, { ...paymentChunk, score: 4, strategy: "bm25" }],
    semantic: [{ ...exportChunk, score: 0.5, strategy: "semantic" }, { ...paymentChunk, score: 0.45, strategy: "semantic" }],
    hybrid: [exportChunk, paymentChunk],
  });
  assert.equal(answer.insufficientContext, false);
  assert.deepEqual(answer.citations.map((citation) => citation.chunkId), ["export:chunk-0", "payment:chunk-0"]);

  const unsupported = answerFromRetrieval({
    question: "Can exports include audit logs and payment card numbers?",
    bm25: [{ ...exportChunk, score: 7, strategy: "bm25" }, { ...paymentChunk, score: 4, strategy: "bm25" }],
    semantic: [{ ...exportChunk, score: 0.5, strategy: "semantic" }, { ...paymentChunk, score: 0.45, strategy: "semantic" }],
    hybrid: [exportChunk, paymentChunk],
  });
  assert.equal(unsupported.insufficientContext, true);
  assert.equal(unsupported.fallbackReason, "missing_required_evidence");
});

test("extractive generation and citation validation use retrieved evidence only", () => {
  const chunks = [
    { chunkId: "trial:chunk-0", documentId: "trial", documentTitle: "Trial", text: "Trial answer.", score: 0.04, strategy: "hybrid" },
  ];
  const answer = generateExtractiveAnswer("Trial?", chunks);
  assert.equal(answer.answer, "Trial answer.");
  assert.deepEqual(validateCitationIds(["trial:chunk-0"], chunks), [
    { documentId: "trial", chunkId: "trial:chunk-0", title: "Trial" },
  ]);
  assert.throws(() => validateCitationIds(["missing:chunk-0"], chunks), /fabricated citation/);
});

test("hosted retrieval is workspace isolated and embedding-profile scoped", async () => {
  await withTempDatabase(async (adapter) => {
    adapter.ingest(
      payload([
        {
          id: "trial",
          chunks: [chunk("trial:chunk-0", "trial", "The trial lasts 14 days.")],
          vectors: [vector({ 0: 1 })],
        },
      ]),
      workspace,
    );
    const snapshot = adapter.getRetrievalSnapshot("default");
    assert.equal(snapshot.chunks.length, 1);
    assert.throws(() => adapter.getRetrievalSnapshot("missing"), /Workspace is not available/);
    assert.throws(
      () =>
        adapter.ingest(
          {
            ...payload([]),
            embeddingProfile: { id: SUPPORTED_EMBEDDING_PROFILE.id, compatibilityKey: "wrong" },
            documents: [],
          },
          workspace,
        ),
      /compatibility key is not supported/,
    );
  });
});

test("deleted documents and failed re-indexes do not leak into retrieval", async () => {
  await withTempDatabase(async (adapter) => {
    adapter.ingest(
      payload([
        {
          id: "safe",
          chunks: [chunk("safe:chunk-0", "safe", "The safe version mentions durable content.")],
          vectors: [vector({ 0: 1 })],
        },
      ]),
      workspace,
    );
    assert.throws(
      () =>
        adapter.ingest(
          payload([
            {
              id: "safe",
              chunks: [chunk("safe:chunk-0", "safe", "Broken replacement should fail.")],
              vectors: [vector({ 0: 1 }).slice(1)],
            },
          ]),
          workspace,
        ),
      /exactly 384 dimensions/,
    );
    assert.equal(adapter.getRetrievalSnapshot("default").chunks[0].text, "The safe version mentions durable content.");

    adapter.deleteDocument({ workspaceId: "default", documentId: "safe" }, workspace);
    assert.equal(adapter.getRetrievalSnapshot("default").chunks.length, 0);
  });
});

test("optimized candidate retrieval agrees with full scan when lexical candidates cover the answer", async () => {
  await withTempDatabase(async (adapter) => {
    const docs = Array.from({ length: 12 }, (_, index) => ({
      id: `doc-${index}`,
      chunks: [chunk(`doc-${index}:chunk-0`, `doc-${index}`, index === 7 ? "Aurora launch code lives here." : `Unrelated filler ${index}`)],
      vectors: [vector({ [index + 1]: 1 })],
    }));
    adapter.ingest(payload(docs), workspace);
    const queryVector = vector({ 8: 1 });
    const full = retrieveFullScan({ question: "Where is the Aurora launch code?", queryVector, ...adapter.getRetrievalSnapshot("default"), topK: 5 });
    const optimized = retrieveWithPrefilter({
      question: "Where is the Aurora launch code?",
      queryVector,
      chunkIndex: adapter.getChunkIndex("default"),
      vectorSnapshotForChunkIds: (ids) => adapter.getRetrievalSnapshot("default", { chunkIds: ids }),
      topK: 5,
      settings: { lexicalCandidateLimit: 5, fullScanFallbackChunkLimit: 0 },
    });
    assert.equal(full.hybrid[0].documentId, "doc-7");
    assert.equal(optimized.hybrid[0].documentId, "doc-7");
    assert.ok(optimized.candidateChunkIds.includes("doc-7:chunk-0"));
    assert.ok(optimized.vectorsLoaded < adapter.getChunkIndex("default").length);
  });
});

test("small corpora fall back to full scan to preserve semantic candidates and ranking agreement", async () => {
  await withTempDatabase(async (adapter) => {
    const docs = Array.from({ length: 8 }, (_, index) => ({
      id: `doc-${index}`,
      chunks: [chunk(`doc-${index}:chunk-0`, `doc-${index}`, index === 6 ? "No lexical overlap appears here." : `Routine filler ${index}`)],
      vectors: [vector({ [index + 1]: 1 })],
    }));
    adapter.ingest(payload(docs), workspace);
    const queryVector = vector({ 7: 1 });
    const full = retrieveFullScan({ question: "Pure semantic match?", queryVector, ...adapter.getRetrievalSnapshot("default"), topK: 5 });
    const optimized = retrieveWithPrefilter({
      question: "Pure semantic match?",
      queryVector,
      chunkIndex: adapter.getChunkIndex("default"),
      vectorSnapshotForChunkIds: (ids) => adapter.getRetrievalSnapshot("default", { chunkIds: ids }),
      topK: 5,
      settings: { lexicalCandidateLimit: 3, fullScanFallbackChunkLimit: 100 },
    });
    assert.equal(optimized.fallbackFullScan, true);
    assert.equal(optimized.vectorsLoaded, adapter.getChunkIndex("default").length);
    assert.deepEqual(optimized.hybrid.map((item) => item.chunkId), full.hybrid.map((item) => item.chunkId));
    assert.equal(optimized.semantic[0].documentId, "doc-6");
  });
});

test("empty corpus returns insufficient context", () => {
  const retrieval = retrieveFullScan({ question: "Anything?", queryVector: vector({ 0: 1 }), chunks: [], embeddings: [] });
  const answer = answerFromRetrieval({ question: "Anything?", ...retrieval });
  assert.equal(answer.insufficientContext, true);
});

test("malformed stored vectors are surfaced during hosted retrieval", async () => {
  await withTempDatabase(async (adapter, databasePath) => {
    adapter.ingest(
      payload([
        {
          id: "trial",
          chunks: [chunk("trial:chunk-0", "trial", "The trial lasts 14 days.")],
          vectors: [vector({ 0: 1 })],
        },
      ]),
      workspace,
    );
    adapter.close();
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.prepare("UPDATE embeddings SET vector_blob = ? WHERE chunk_id = ?").run(Buffer.from([1, 2, 3]), "trial:chunk-0");
    } finally {
      db.close();
    }
    const reopened = new HostedSQLiteAdapter({ path: databasePath });
    try {
      assert.throws(() => reopened.getRetrievalSnapshot("default"), /invalid byte length/);
    } finally {
      reopened.close();
    }
  });
});
