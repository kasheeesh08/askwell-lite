import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  HOSTED_LIMITS,
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  sha256,
} from "../src/hosted/storage-contract.mjs";
import { HostedSQLiteAdapter } from "../src/hosted/sqlite-adapter.mjs";

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

async function withTempDatabase(callback) {
  const directory = await mkdtemp(join(tmpdir(), "askwell-hosted-sqlite-"));
  const databasePath = join(directory, "hosted.sqlite3");
  try {
    await callback({ directory, databasePath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function openAdapter(databasePath, options = {}) {
  return new HostedSQLiteAdapter({
    path: databasePath,
    ...options,
  });
}

test("sqlite adapter creates schema, migrations, profiles, and default workspace", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    const adapter = openAdapter(databasePath);
    try {
      const diagnostics = adapter.diagnostics("default");
      assert.equal(diagnostics.schemaVersion, 2);
      assert.equal(diagnostics.integrityCheck, "ok");
      assert.equal(adapter.getWorkspace("default").version, 1);
    } finally {
      adapter.close();
    }

    const db = new DatabaseSync(databasePath);
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM embedding_profiles").get().count,
        1,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM indexing_profiles").get().count,
        1,
      );
      assert.equal(
        db.prepare("SELECT MAX(version) AS version FROM hosted_schema_migrations").get().version,
        2,
      );
    } finally {
      db.close();
    }
  });
});

test("sqlite adapter persists conversations, ordered messages, and workspace isolation", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    const adapter = openAdapter(databasePath, {
      workspaces: [
        { id: "default", version: 1 },
        { id: "support", version: 1 },
      ],
    });
    try {
      const created = adapter.createConversation(
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

      const added = adapter.addConversationMessage(
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
      assert.equal(adapter.getConversation("default", "conversation-1").messages.length, 3);
      assert.equal(adapter.listConversations("default")[0].lastMessagePreview, "An owner can help with exports.");
      assert.equal(adapter.listConversations("support").length, 0);

      assert.throws(
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
    } finally {
      adapter.close();
    }

    const reopened = openAdapter(databasePath, {
      workspaces: [
        { id: "default", version: 1 },
        { id: "support", version: 1 },
      ],
    });
    try {
      const details = reopened.getConversation("default", "conversation-1");
      assert.deepEqual(details.messages.map((message) => message.id), ["message-1", "message-2", "message-3"]);
    } finally {
      reopened.close();
    }
  });
});

test("sqlite adapter persists documents, chunks, and float32 vectors across reopen", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    let adapter = openAdapter(databasePath);
    adapter.ingest(ingestPayload(), workspace);
    const snapshot = adapter.getRetrievalSnapshot("default");
    assert.equal(snapshot.chunks.length, 1);
    assert.equal(snapshot.embeddings[0].vector.length, 384);
    assert.equal(snapshot.embeddings[0].vector[0], 1);
    adapter.close();

    adapter = openAdapter(databasePath);
    try {
      assert.equal(adapter.listDocuments("default").length, 1);
      const reopened = adapter.getRetrievalSnapshot("default");
      assert.equal(reopened.chunks[0].text, "A payment card is not required during the trial.");
      assert.equal(reopened.embeddings[0].vector[0], 1);
      assert.equal(reopened.embeddings[0].vector[1], 0);
    } finally {
      adapter.close();
    }
  });
});

test("sqlite adapter preserves unchanged documents and handles updates and conflicts", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    const adapter = openAdapter(databasePath);
    try {
      assert.equal(adapter.ingest(ingestPayload(), workspace).documentStatuses[0].status, "created");
      assert.equal(adapter.ingest(ingestPayload({ expectedVersion: 1 }), workspace).documentStatuses[0].status, "unchanged");
      assert.equal(adapter.getDocument("default", "trial").version, 1);

      const updated = adapter.ingest(
        ingestPayload({
          expectedVersion: 1,
          text: "The trial is 14 days and a card is not required.",
        }),
        workspace,
      );
      assert.equal(updated.documentStatuses[0].status, "updated");
      assert.equal(adapter.getDocument("default", "trial").version, 2);

      assert.throws(
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
    } finally {
      adapter.close();
    }
  });
});

test("sqlite adapter rolls back failed re-index and records failed ingestion run", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    const adapter = openAdapter(databasePath);
    try {
      adapter.ingest(ingestPayload(), workspace);
      assert.throws(
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

      assert.equal(adapter.getDocument("default", "trial").version, 1);
      assert.equal(
        adapter.getRetrievalSnapshot("default").chunks[0].text,
        "A payment card is not required during the trial.",
      );
      const runs = adapter.ingestionRuns("default");
      assert.equal(runs.at(-1).status, "failed");
      assert.match(runs.at(-1).error, /exactly 384 dimensions/);
    } finally {
      adapter.close();
    }
  });
});

test("sqlite adapter enforces workspace ownership and foreign keys", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    const adapter = openAdapter(databasePath, {
      workspaces: [
        { id: "default", version: 1 },
        { id: "support", version: 1 },
      ],
    });
    try {
      adapter.ingest(ingestPayload(), workspace);
      assert.throws(
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
    } finally {
      adapter.close();
    }

    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO chunks(
                id, workspace_id, document_id, position, text, hash, metadata_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run("bad:chunk-0", "support", "trial", 0, "bad", sha256("bad"), "{}", new Date().toISOString()),
        /constraint/i,
      );
    } finally {
      db.close();
    }
  });
});

test("sqlite adapter deletes documents with chunk and embedding cascades", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    const adapter = openAdapter(databasePath);
    try {
      adapter.ingest(ingestPayload(), workspace);
      const deleted = adapter.deleteDocument(
        { workspaceId: "default", documentId: "trial", expectedDocumentVersion: 1 },
        workspace,
      );
      assert.equal(deleted.deleted, true);
      assert.equal(deleted.chunksDeleted, 1);
      assert.equal(adapter.listDocuments("default").length, 0);
    } finally {
      adapter.close();
    }

    const db = new DatabaseSync(databasePath);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM chunks").get().count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM embeddings").get().count, 0);
    } finally {
      db.close();
    }
  });
});

test("sqlite adapter rejects profile mismatches and malformed stored vectors", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    let adapter = openAdapter(databasePath);
    try {
      assert.throws(
        () =>
          adapter.ingest(
            ingestPayload({
              embeddingProfile: { compatibilityKey: "bad-key" },
            }),
            workspace,
          ),
        /compatibility key is not supported/,
      );
      adapter.ingest(ingestPayload(), workspace);
    } finally {
      adapter.close();
    }

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

    adapter = openAdapter(databasePath);
    try {
      assert.throws(() => adapter.getRetrievalSnapshot("default"), /invalid byte length/);
    } finally {
      adapter.close();
    }
  });
});

test("sqlite adapter prevents stale workspace updates across adapter instances", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    const first = openAdapter(databasePath);
    const second = openAdapter(databasePath);
    try {
      const saved = first.saveWorkspace(
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
      assert.throws(
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
    } finally {
      first.close();
      second.close();
    }
  });
});

test("sqlite adapter supports larger synthetic payloads when limits are raised", async () => {
  await withTempDatabase(async ({ databasePath }) => {
    const chunkCount = 100;
    const chunks = Array.from({ length: chunkCount }, (_, index) => {
      const text = `Synthetic chunk ${index} explains hosted retrieval validation.`;
      return {
        id: `bulk:chunk-${index}`,
        position: index,
        text,
        hash: sha256(text),
        metadata: {},
      };
    });
    const adapter = openAdapter(databasePath, {
      limits: {
        ...HOSTED_LIMITS,
        maxPayloadBytes: 10 * 1024 * 1024,
        maxChunksPerDocument: chunkCount,
        maxVectorsPerIngest: chunkCount,
      },
    });
    try {
      adapter.ingest(
        ingestPayload({
          id: "bulk",
          title: "Bulk",
          chunks,
          vectors: chunks.map((_, index) => vector(1, index + 1)),
        }),
        workspace,
      );
      const snapshot = adapter.getRetrievalSnapshot("default");
      assert.equal(snapshot.chunks.length, chunkCount);
      assert.equal(snapshot.embeddings.length, chunkCount);
      assert.equal(adapter.diagnostics("default").integrityCheck, "ok");
    } finally {
      adapter.close();
    }
  });
});
