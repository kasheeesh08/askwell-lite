import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { HostedTursoAdapter, createTursoAdapterFromEnv } from "../src/hosted/turso-adapter.mjs";
import {
  HOSTED_LIMITS,
  HostedContractError,
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  sha256,
} from "../src/hosted/storage-contract.mjs";
import { retrieveFullScan, answerFromRetrieval } from "../src/hosted/retrieval.mjs";

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
  const chunks = overrides.chunks || [
    {
      id: `${id}:chunk-0`,
      position: 0,
      text,
      hash: sha256(text),
      metadata: {},
      ...(overrides.chunk || {}),
    },
  ];
  const vectors = overrides.vectors || chunks.map((_, index) => vector(1, index / 10));
  return {
    id,
    title: overrides.title || "Trial",
    sourceType: "article",
    contentHash: overrides.contentHash || sha256(chunks.map((chunk) => chunk.text).join("\n")),
    expectedVersion: overrides.expectedVersion,
    metadata: { tags: ["trial"] },
    chunks,
    vectors,
    ...(overrides.document || {}),
  };
}

function ingestPayload(overrides = {}) {
  return {
    workspaceId: overrides.workspaceId || "default",
    embeddingProfile: {
      id: SUPPORTED_EMBEDDING_PROFILE.id,
      compatibilityKey: SUPPORTED_EMBEDDING_PROFILE.compatibilityKey,
      ...(overrides.embeddingProfile || {}),
    },
    indexingProfile: {
      id: SUPPORTED_INDEXING_PROFILE_WITH_KEY.id,
      compatibilityKey: SUPPORTED_INDEXING_PROFILE_WITH_KEY.compatibilityKey,
      ...(overrides.indexingProfile || {}),
    },
    documents: [documentPayload(overrides)],
    ...(overrides.payload || {}),
  };
}

async function withTempTurso(callback, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "askwell-hosted-turso-"));
  const databasePath = join(directory, "hosted-libsql.sqlite3");
  const url = pathToFileURL(databasePath).href;
  let adapters = [];
  try {
    const openAdapter = async (extra = {}) => {
      const adapter = await HostedTursoAdapter.create({
        url,
        limits: {
          ...HOSTED_LIMITS,
          maxPayloadBytes: 20 * 1024 * 1024,
          maxChunksPerDocument: 500,
          maxVectorsPerIngest: 500,
        },
        ...options,
        ...extra,
      });
      adapters.push(adapter);
      return adapter;
    };
    await callback({ directory, databasePath, url, openAdapter });
  } finally {
    for (const adapter of adapters) adapter.close();
    await sleep(25);
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      if (error?.code !== "EBUSY") throw error;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("turso adapter initializes schema, profiles, and default workspace with local libSQL", async () => {
  await withTempTurso(async ({ openAdapter }) => {
    const adapter = await openAdapter();
    const diagnostics = await adapter.diagnostics("default");
    assert.equal(diagnostics.backend, "turso-libsql-hosted");
    assert.equal(diagnostics.schemaVersion, 2);
    assert.equal((await adapter.getWorkspace("default")).version, 1);
  });
});

test("turso adapter persists documents, chunks, and float32 vectors across instances", async () => {
  await withTempTurso(async ({ openAdapter }) => {
    let adapter = await openAdapter();
    await adapter.ingest(ingestPayload(), workspace);
    assert.equal((await adapter.getRetrievalSnapshot("default")).chunks.length, 1);
    adapter.close();

    adapter = await openAdapter();
    const snapshot = await adapter.getRetrievalSnapshot("default");
    assert.equal((await adapter.listDocuments("default")).length, 1);
    assert.equal(snapshot.chunks[0].text, "A payment card is not required during the trial.");
    assert.equal(snapshot.embeddings[0].vector.length, 384);
    assert.equal(snapshot.embeddings[0].vector[0], 1);
  });
});

test("turso adapter persists hosted session revocation across instances", async () => {
  await withTempTurso(async ({ openAdapter }) => {
    const first = await openAdapter();
    const second = await openAdapter();
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    assert.equal(await second.isSessionRevoked("session-a"), false);
    await first.revokeSession("session-a", future);
    assert.equal(await second.isSessionRevoked("session-a"), true);

    await first.revokeSession("session-b", past);
    assert.equal(await second.isSessionRevoked("session-b"), false);
  });
});

test("turso adapter persists conversations, ordered messages, and workspace isolation", async () => {
  await withTempTurso(
    async ({ openAdapter }) => {
      let adapter = await openAdapter();
      const created = await adapter.createConversation(
        {
          workspaceId: "default",
          id: "conversation-1",
          customerId: "visitor-1",
          messages: [
            { id: "message-1", senderType: "customer", content: "Can I export conversations?" },
            { id: "message-2", senderType: "assistant", content: "Yes, export before cancelling." },
          ],
        },
        workspace,
      );
      assert.equal(created.conversation.messageCount, 2);
      assert.deepEqual(created.messages.map((message) => message.position), [0, 1]);

      const added = await adapter.addConversationMessage(
        {
          workspaceId: "default",
          conversationId: "conversation-1",
          id: "message-3",
          senderType: "agent",
          content: "An owner can help with exports.",
        },
        workspace,
      );
      assert.equal(added.message.position, 2);
      assert.equal((await adapter.getConversation("default", "conversation-1")).messages.length, 3);
      assert.equal((await adapter.listConversations("default"))[0].lastMessagePreview, "An owner can help with exports.");
      assert.equal(
        (
          await adapter.updateConversationStatus(
            {
              workspaceId: "default",
              conversationId: "conversation-1",
              status: "resolved",
            },
            { workspaceId: "default" },
          )
        ).conversation.status,
        "resolved",
      );
      assert.equal((await adapter.listConversations("support")).length, 0);

      await assert.rejects(
        () =>
          adapter.addConversationMessage(
            {
              workspaceId: "support",
              conversationId: "conversation-1",
              senderType: "customer",
              content: "Wrong workspace",
            },
            { workspaceId: "support" },
          ),
        /Conversation is not available/,
      );
      adapter.close();

      adapter = await openAdapter();
      const details = await adapter.getConversation("default", "conversation-1");
      assert.deepEqual(details.messages.map((message) => message.id), ["message-1", "message-2", "message-3"]);
    },
    {
      workspaces: [
        { id: "default", version: 1 },
        { id: "support", version: 1 },
      ],
    },
  );
});

test("turso adapter preserves unchanged documents and rejects stale updates", async () => {
  await withTempTurso(async ({ openAdapter }) => {
    const adapter = await openAdapter();
    assert.equal((await adapter.ingest(ingestPayload(), workspace)).documentStatuses[0].status, "created");
    assert.equal(
      (await adapter.ingest(ingestPayload({ expectedVersion: 1 }), workspace)).documentStatuses[0].status,
      "unchanged",
    );

    await adapter.ingest(
      ingestPayload({
        expectedVersion: 1,
        text: "The trial lasts 14 days and a card is not required.",
      }),
      workspace,
    );
    assert.equal((await adapter.getDocument("default", "trial")).version, 2);

    await assert.rejects(
      () =>
        adapter.ingest(
          ingestPayload({
            expectedVersion: 1,
            text: "A stale writer must fail.",
          }),
          workspace,
        ),
      /Document version conflict/,
    );
  });
});

test("turso adapter rolls back failed re-index and records failed ingestion run", async () => {
  await withTempTurso(async ({ openAdapter }) => {
    const adapter = await openAdapter();
    await adapter.ingest(ingestPayload(), workspace);

    await assert.rejects(
      () =>
        adapter.ingest(
          ingestPayload({
            expectedVersion: 1,
            text: "Broken replacement should never commit.",
            vectors: [vector().slice(1)],
          }),
          workspace,
        ),
      /exactly 384 dimensions/,
    );

    assert.equal((await adapter.getDocument("default", "trial")).version, 1);
    assert.equal(
      (await adapter.getRetrievalSnapshot("default")).chunks[0].text,
      "A payment card is not required during the trial.",
    );
    const runs = await adapter.ingestionRuns("default");
    assert.equal(runs.at(-1).status, "failed");
    assert.match(runs.at(-1).error, /exactly 384 dimensions/);
  });
});

test("turso adapter enforces workspace isolation, delete cascades, and retrieval consistency", async () => {
  await withTempTurso(
    async ({ openAdapter }) => {
      const adapter = await openAdapter();
      await adapter.ingest(ingestPayload(), workspace);
      await assert.rejects(
        () =>
          adapter.ingest(
            ingestPayload({
              workspaceId: "support",
              text: "Another workspace tries to reuse the id.",
            }),
            { workspaceId: "support" },
          ),
        /belongs to another workspace/,
      );

      const retrieval = retrieveFullScan({
        question: "Do I need a payment card during the trial?",
        queryVector: vector(),
        ...(await adapter.getRetrievalSnapshot("default")),
        topK: 3,
      });
      const answer = answerFromRetrieval({
        question: "Do I need a payment card during the trial?",
        ...retrieval,
      });
      assert.equal(answer.insufficientContext, false);
      assert.equal(answer.citations[0].chunkId, "trial:chunk-0");

      const deleted = await adapter.deleteDocument(
        { workspaceId: "default", documentId: "trial", expectedDocumentVersion: 1 },
        workspace,
      );
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.chunksDeleted, 1);
      assert.equal((await adapter.getRetrievalSnapshot("default")).chunks.length, 0);
    },
    {
      workspaces: [
        { id: "default", version: 1 },
        { id: "support", version: 1 },
      ],
    },
  );
});

test("turso adapter prevents stale workspace saves across instances", async () => {
  await withTempTurso(async ({ openAdapter }) => {
    const first = await openAdapter();
    const second = await openAdapter();
    const saved = await first.saveWorkspace(
      {
        workspaceId: "default",
        expectedVersion: 1,
        settings: { brand: "First" },
        articles: [],
        conversations: [],
      },
      workspace,
    );
    assert.equal(saved.version, 2);
    await assert.rejects(
      () =>
        second.saveWorkspace(
          {
            workspaceId: "default",
            expectedVersion: 1,
            settings: { brand: "Second" },
            articles: [],
            conversations: [],
          },
          workspace,
        ),
      /Workspace version conflict/,
    );
  });
});

test("turso adapter rejects malformed stored vectors and profile mismatches", async () => {
  await withTempTurso(async ({ databasePath, openAdapter }) => {
    let adapter = await openAdapter();
    await assert.rejects(
      () =>
        adapter.ingest(
          ingestPayload({
            embeddingProfile: { compatibilityKey: "bad-key" },
          }),
          workspace,
        ),
      /compatibility key is not supported/,
    );
    await adapter.ingest(ingestPayload(), workspace);
    adapter.close();

    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA ignore_check_constraints = ON");
      db.prepare("UPDATE embeddings SET vector_blob = ? WHERE chunk_id = ?").run(
        Buffer.from([0, 1, 2]),
        "trial:chunk-0",
      );
    } finally {
      db.close();
    }

    adapter = await openAdapter();
    await assert.rejects(() => adapter.getRetrievalSnapshot("default"), /invalid byte length/);
  });
});

test("turso environment factory fails safely without remote configuration", async () => {
  await assert.rejects(
    () => createTursoAdapterFromEnv({ env: {} }),
    (error) =>
      error instanceof HostedContractError &&
      error.code === "missing_turso_database_url" &&
      error.status === 500,
  );
  await assert.rejects(
    () => createTursoAdapterFromEnv({ env: { TURSO_DATABASE_URL: "libsql://example.turso.io" } }),
    (error) =>
      error instanceof HostedContractError &&
      error.code === "missing_turso_auth_token" &&
      error.status === 500,
  );
});

test("turso adapter reports retryable database failures and timeouts", async () => {
  const unavailable = await HostedTursoAdapter.create({
    client: {
      async execute() {
        throw Object.assign(new Error("database unavailable"), { code: "SQLITE_BUSY" });
      },
      async executeMultiple() {},
      async transaction() {
        throw Object.assign(new Error("database unavailable"), { code: "SQLITE_BUSY" });
      },
      close() {},
    },
  }).catch((error) => error);
  assert.equal(unavailable.code, "hosted_database_retryable_error");

  const timeout = await HostedTursoAdapter.create({
    client: {
      execute() {
        return new Promise(() => {});
      },
      executeMultiple() {
        return Promise.resolve();
      },
      close() {},
    },
    timeoutMs: 5,
  }).catch((error) => error);
  assert.equal(timeout.code, "hosted_database_timeout");
});
