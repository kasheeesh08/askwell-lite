import assert from "node:assert/strict";
import test from "node:test";

import {
  HOSTED_LIMITS,
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  buildEmbeddingCompatibilityKey,
  buildIndexingCompatibilityKey,
  createMemoryHostedStore,
  sha256,
  structuredError,
  validateCitations,
  validateEmbeddingProfileSelection,
  validateHostedAnswerRequest,
  validateHostedIngestRequest,
  validateIndexingProfileSelection,
  validateVector,
} from "../src/hosted/storage-contract.mjs";

const workspace = { workspaceId: "default" };

function vector(first = 1, second = 0) {
  const values = Array.from({ length: SUPPORTED_EMBEDDING_PROFILE.dimension }, () => 0);
  values[0] = first;
  values[1] = second;
  const norm = Math.sqrt(first * first + second * second);
  return values.map((value) => value / norm);
}

function documentPayload(overrides = {}) {
  const text = overrides.text || "A payment card is not required during the trial.";
  const id = overrides.id || "trial";
  return {
    id,
    title: overrides.title || "Trial",
    sourceType: "article",
    contentHash: sha256(text),
    expectedVersion: overrides.expectedVersion,
    metadata: { tags: ["trial"] },
    chunks: [
      {
        id: `${id}:chunk-0`,
        position: 0,
        text,
        hash: sha256(text),
        metadata: {},
        ...overrides.chunk,
      },
    ],
    vectors: [overrides.vector || vector()],
    ...overrides.document,
  };
}

function ingestPayload(overrides = {}) {
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
    documents: [documentPayload(overrides)],
    ...overrides.payload,
  };
}

test("accepts only the server-owned supported embedding profile", () => {
  const profile = validateEmbeddingProfileSelection({
    id: SUPPORTED_EMBEDDING_PROFILE.id,
    compatibilityKey: SUPPORTED_EMBEDDING_PROFILE.compatibilityKey,
  });

  assert.equal(profile.modelId, "Xenova/all-MiniLM-L6-v2");
  assert.equal(profile.targetModelId, "sentence-transformers/all-MiniLM-L6-v2");
  assert.equal(profile.dimension, 384);
  assert.equal(profile.normalized, true);
  assert.equal(profile.pooling, "mean");
  assert.equal(profile.quantized, false);

  assert.throws(
    () => validateEmbeddingProfileSelection({ id: "attacker-profile" }),
    /Unknown embedding profile/,
  );
  assert.throws(
    () =>
      validateEmbeddingProfileSelection({
        id: SUPPORTED_EMBEDDING_PROFILE.id,
        modelId: "Xenova/other-model",
      }),
    /modelId is not supported/,
  );
});

test("builds deterministic embedding and indexing compatibility keys separately", () => {
  const shuffledEmbedding = {
    dtype: SUPPORTED_EMBEDDING_PROFILE.dtype,
    quantized: SUPPORTED_EMBEDDING_PROFILE.quantized,
    pooling: SUPPORTED_EMBEDDING_PROFILE.pooling,
    normalized: SUPPORTED_EMBEDDING_PROFILE.normalized,
    dimension: SUPPORTED_EMBEDDING_PROFILE.dimension,
    packageVersion: SUPPORTED_EMBEDDING_PROFILE.packageVersion,
    packageName: SUPPORTED_EMBEDDING_PROFILE.packageName,
    runtimeConfiguration: SUPPORTED_EMBEDDING_PROFILE.runtimeConfiguration,
    runtime: SUPPORTED_EMBEDDING_PROFILE.runtime,
    targetModelRevision: SUPPORTED_EMBEDDING_PROFILE.targetModelRevision,
    modelRevision: SUPPORTED_EMBEDDING_PROFILE.modelRevision,
    targetModelId: SUPPORTED_EMBEDDING_PROFILE.targetModelId,
    modelId: SUPPORTED_EMBEDDING_PROFILE.modelId,
    provider: SUPPORTED_EMBEDDING_PROFILE.provider,
  };

  assert.equal(
    buildEmbeddingCompatibilityKey(shuffledEmbedding),
    SUPPORTED_EMBEDDING_PROFILE.compatibilityKey,
  );

  const changedIndexing = {
    ...SUPPORTED_INDEXING_PROFILE,
    id: "askwell-char-window-v1-600-100",
    chunkSize: 600,
    chunkOverlap: 100,
  };
  assert.equal(
    buildEmbeddingCompatibilityKey(SUPPORTED_EMBEDDING_PROFILE),
    SUPPORTED_EMBEDDING_PROFILE.compatibilityKey,
  );
  assert.notEqual(
    buildIndexingCompatibilityKey(changedIndexing),
    SUPPORTED_INDEXING_PROFILE_WITH_KEY.compatibilityKey,
  );
  assert.throws(
    () => validateIndexingProfileSelection({ ...SUPPORTED_INDEXING_PROFILE_WITH_KEY, chunkSize: 600 }),
    /chunkSize is not supported/,
  );
});

test("validates vector dimension, finite values, and normalization tolerance", () => {
  assert.doesNotThrow(() => validateVector(vector()));
  assert.throws(() => validateVector(vector().slice(1)), /exactly 384 dimensions/);
  const withNaN = vector();
  withNaN[2] = Number.NaN;
  assert.throws(() => validateVector(withNaN), /NaN or Infinity/);
  const withInfinity = vector();
  withInfinity[2] = Infinity;
  assert.throws(() => validateVector(withInfinity), /NaN or Infinity/);
  const unnormalized = vector();
  unnormalized[0] = 2;
  assert.throws(() => validateVector(unnormalized), /not normalized/);
});

test("rejects malformed ingest payloads and untrusted retrieval fields", () => {
  assert.doesNotThrow(() => validateHostedIngestRequest(ingestPayload(), workspace));
  assert.throws(
    () =>
      validateHostedIngestRequest(
        ingestPayload({
          payload: { documents: [documentPayload({ document: { vectors: [] } })] },
        }),
        workspace,
      ),
    /Chunk and vector counts must match/,
  );
  assert.throws(
    () =>
      validateHostedIngestRequest(
        ingestPayload({
          payload: { embeddingProfile: { id: "unknown" } },
        }),
        workspace,
      ),
    /Unknown embedding profile/,
  );
  assert.throws(
    () =>
      validateHostedIngestRequest(
        ingestPayload({ chunk: { score: 0.99 } }),
        workspace,
      ),
    /Client-provided chunk scores/,
  );
  assert.throws(
    () =>
      validateHostedIngestRequest(
        ingestPayload({
          payload: {
            documents: Array.from({ length: HOSTED_LIMITS.maxDocumentsPerIngest + 1 }, (_, index) =>
              documentPayload({ id: `doc-${index}` }),
            ),
          },
        }),
        workspace,
      ),
    /Too many documents/,
  );
});

test("enforces workspace context and child ownership references", () => {
  assert.throws(
    () => validateHostedIngestRequest(ingestPayload({ payload: { workspaceId: "other" } }), workspace),
    /not authorized/,
  );
  assert.throws(
    () =>
      validateHostedIngestRequest(
        ingestPayload({ document: { workspaceId: "other" } }),
        workspace,
      ),
    /Document workspace does not match/,
  );
  assert.throws(
    () =>
      validateHostedIngestRequest(
        ingestPayload({ chunk: { workspaceId: "other" } }),
        workspace,
      ),
    /Chunk workspace does not match/,
  );
  assert.throws(
    () =>
      validateHostedIngestRequest(
        ingestPayload({ chunk: { documentId: "other-doc" } }),
        workspace,
      ),
    /Chunk document reference/,
  );
});

test("validates answer request vectors and rejects client citations or scores", () => {
  const answer = validateHostedAnswerRequest(
    {
      workspaceId: "default",
      question: "Do I need a card?",
      topK: 3,
      queryVector: vector(0.6, 0.8),
      embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
    },
    workspace,
  );

  assert.equal(answer.topK, 3);
  assert.equal(answer.queryVector.length, 384);

  assert.throws(
    () =>
      validateHostedAnswerRequest(
        {
          workspaceId: "default",
          question: "Do I need a card?",
          queryVector: vector().slice(1),
          embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
        },
        workspace,
      ),
    /exactly 384 dimensions/,
  );
  assert.throws(
    () =>
      validateHostedAnswerRequest(
        {
          workspaceId: "default",
          question: "Do I need a card?",
          queryVector: vector(),
          embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
          citations: ["trial:chunk-0"],
        },
        workspace,
      ),
    /Client-provided retrieval scores or citations/,
  );
});

test("validates generated citations against retrieved chunks only", () => {
  const retrieved = [{ chunkId: "trial:chunk-0" }, { chunkId: "billing:chunk-0" }];
  assert.deepEqual(validateCitations(["trial:chunk-0"], retrieved), ["trial:chunk-0"]);
  assert.throws(() => validateCitations(["missing:chunk-0"], retrieved), /not retrieved/);
});

test("memory hosted store handles create, unchanged, update, delete, and version conflicts", () => {
  const store = createMemoryHostedStore();

  const created = store.ingest(ingestPayload(), workspace);
  assert.equal(created.documentStatuses[0].status, "created");
  assert.equal(store.listDocuments("default")[0].version, 1);

  const unchanged = store.ingest(ingestPayload({ expectedVersion: 1 }), workspace);
  assert.equal(unchanged.documentStatuses[0].status, "unchanged");
  assert.equal(store.listDocuments("default")[0].version, 1);

  const updated = store.ingest(
    ingestPayload({
      expectedVersion: 1,
      text: "The trial lasts 14 days and still does not require a payment card.",
    }),
    workspace,
  );
  assert.equal(updated.documentStatuses[0].status, "updated");
  assert.equal(store.getDocument("default", "trial").version, 2);
  assert.equal(store.getRetrievalSnapshot("default").chunks[0].text.includes("14 days"), true);

  assert.throws(
    () =>
      store.ingest(
        ingestPayload({
          expectedVersion: 1,
          text: "Stale writer should fail.",
        }),
        workspace,
      ),
    /Document version conflict/,
  );

  const deleted = store.deleteDocument(
    { workspaceId: "default", documentId: "trial", expectedDocumentVersion: 2 },
    workspace,
  );
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.chunksDeleted, 1);
  assert.equal(store.listDocuments("default").length, 0);
});

test("failed re-index preserves previous committed content and records failure", () => {
  const store = createMemoryHostedStore();
  store.ingest(ingestPayload(), workspace);

  assert.throws(
    () =>
      store.ingest(
        ingestPayload({
          expectedVersion: 1,
          text: "Broken replacement should not commit.",
          vector: vector().slice(1),
        }),
        workspace,
      ),
    /exactly 384 dimensions/,
  );

  assert.equal(store.getDocument("default", "trial").contentHash, sha256("A payment card is not required during the trial."));
  assert.equal(store.getRetrievalSnapshot("default").chunks[0].text, "A payment card is not required during the trial.");
  const runs = store.ingestionRuns("default");
  assert.equal(runs.at(-1).status, "failed");
  assert.match(runs.at(-1).error, /exactly 384 dimensions/);
});

test("memory hosted store rejects cross-workspace document ownership", () => {
  const store = createMemoryHostedStore({
    workspaces: [
      { id: "default", version: 1 },
      { id: "support", version: 1 },
    ],
  });

  store.ingest(ingestPayload(), workspace);

  assert.throws(
    () =>
      store.ingest(
        {
          ...ingestPayload({ text: "Another workspace tries to reuse the id." }),
          workspaceId: "support",
        },
        { workspaceId: "support" },
      ),
    /belongs to another workspace/,
  );
});

test("workspace updates are versioned and return structured validation errors", () => {
  const store = createMemoryHostedStore();
  const saved = store.saveWorkspace(
    {
      workspaceId: "default",
      expectedVersion: 1,
      settings: { brand: "AskWell" },
      articles: [],
      conversations: [],
    },
    workspace,
  );
  assert.equal(saved.version, 2);

  assert.throws(
    () =>
      store.saveWorkspace(
        {
          workspaceId: "default",
          expectedVersion: 1,
          settings: {},
        },
        workspace,
      ),
    /Workspace version conflict/,
  );

  try {
    validateHostedAnswerRequest(
      {
        workspaceId: "default",
        question: "Bad vector",
        queryVector: [1],
        embeddingProfileId: SUPPORTED_EMBEDDING_PROFILE.id,
      },
      workspace,
    );
  } catch (error) {
    assert.deepEqual(structuredError(error).code, "invalid_vector_dimension");
  }
});
