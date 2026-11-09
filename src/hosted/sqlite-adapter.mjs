import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  HOSTED_LIMITS,
  HostedContractError,
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  validateConversationCreateRequest,
  validateConversationMessageRequest,
  validateConversationStatusRequest,
  validateDeleteDocumentRequest,
  validateHostedIngestRequest,
  validateVector,
  validateWorkspaceUpdateRequest,
} from "./storage-contract.mjs";

const SCHEMA_VERSION = 2;

export class HostedSQLiteAdapter {
  constructor(options = {}) {
    if (!options.path) {
      throw new TypeError("HostedSQLiteAdapter requires a database path");
    }
    this.path = options.path;
    this.limits = options.limits || HOSTED_LIMITS;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.closed = false;
    this._configure();
    this._migrate();
    this._seedProfiles();
    this._seedWorkspaces(options.workspaces);
  }

  close() {
    if (!this.closed) {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.close();
      this.closed = true;
    }
  }

  getWorkspace(workspaceId = "default") {
    const row = this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(workspaceId);
    if (!row) {
      fail("unknown_workspace", "Workspace is not available in hosted storage", 404, {
        workspaceId,
      });
    }
    return workspaceFromRow(row);
  }

  saveWorkspace(payload, context) {
    const request = validateWorkspaceUpdateRequest(payload, context);
    return this._transaction(() => {
      const current = this.db
        .prepare("SELECT * FROM workspaces WHERE id = ?")
        .get(request.workspaceId);
      if (!current) {
        fail("unknown_workspace", "Workspace is not available in hosted storage", 404, {
          workspaceId: request.workspaceId,
        });
      }
      if (Number(current.version) !== request.expectedVersion) {
        fail("workspace_version_conflict", "Workspace version conflict", 409, {
          expectedVersion: request.expectedVersion,
          latestVersion: Number(current.version),
        });
      }
      const updatedAt = now();
      this.db
        .prepare(
          `UPDATE workspaces
           SET version = version + 1,
               settings_json = ?,
               articles_json = ?,
               conversations_json = ?,
               updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          JSON.stringify(request.settings),
          JSON.stringify(request.articles),
          JSON.stringify(request.conversations),
          updatedAt,
          request.workspaceId,
          request.expectedVersion,
        );
      return this.getWorkspace(request.workspaceId);
    });
  }

  ingest(payload, context) {
    const workspaceId = payload?.workspaceId || context?.workspaceId || "default";
    this._requireWorkspace(workspaceId);
    const runId = randomUUID();
    const startedAt = now();
    this.db
      .prepare(
        `INSERT INTO ingestion_runs(
          id, workspace_id, operation, status, started_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, workspaceId, "ingest", "running", startedAt, "{}");

    try {
      const request = validateHostedIngestRequest(payload, context, this.limits);
      let chunksWritten = 0;
      const statuses = this._transaction(() => {
        const documentStatuses = [];
        for (const document of request.documents) {
          this._ensureDocumentIdAvailable(request.workspaceId, document.id);
          const existing = this.db
            .prepare("SELECT * FROM documents WHERE workspace_id = ? AND id = ?")
            .get(request.workspaceId, document.id);

          if (
            existing &&
            document.expectedVersion !== undefined &&
            Number(existing.version) !== document.expectedVersion
          ) {
            fail("document_version_conflict", "Document version conflict", 409, {
              documentId: document.id,
              expectedVersion: document.expectedVersion,
              latestVersion: Number(existing.version),
            });
          }

          const unchanged =
            existing &&
            existing.content_hash === document.contentHash &&
            existing.embedding_profile_id === request.embeddingProfile.id &&
            existing.indexing_profile_id === request.indexingProfile.id;

          if (unchanged) {
            documentStatuses.push({
              id: document.id,
              status: "unchanged",
              version: Number(existing.version),
            });
            continue;
          }

          const timestamp = now();
          const nextVersion = existing ? Number(existing.version) + 1 : 1;
          this.db
            .prepare("DELETE FROM chunks WHERE workspace_id = ? AND document_id = ?")
            .run(request.workspaceId, document.id);

          if (existing) {
            this.db
              .prepare(
                `UPDATE documents
                 SET stable_id = ?,
                     title = ?,
                     source_type = ?,
                     content_hash = ?,
                     embedding_profile_id = ?,
                     indexing_profile_id = ?,
                     status = ?,
                     version = ?,
                     chunk_count = ?,
                     metadata_json = ?,
                     updated_at = ?
                 WHERE workspace_id = ? AND id = ?`,
              )
              .run(
                document.stableId,
                document.title,
                document.sourceType,
                document.contentHash,
                request.embeddingProfile.id,
                request.indexingProfile.id,
                "indexed",
                nextVersion,
                document.chunks.length,
                JSON.stringify(document.metadata),
                timestamp,
                request.workspaceId,
                document.id,
              );
          } else {
            this.db
              .prepare(
                `INSERT INTO documents(
                  id, workspace_id, stable_id, title, source_type, content_hash,
                  embedding_profile_id, indexing_profile_id, status, version,
                  chunk_count, metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                document.id,
                request.workspaceId,
                document.stableId,
                document.title,
                document.sourceType,
                document.contentHash,
                request.embeddingProfile.id,
                request.indexingProfile.id,
                "indexed",
                nextVersion,
                document.chunks.length,
                JSON.stringify(document.metadata),
                timestamp,
                timestamp,
              );
          }

          for (let index = 0; index < document.chunks.length; index += 1) {
            const chunk = document.chunks[index];
            const vector = document.vectors[index];
            const blob = vectorToBlob(vector);
            const norm = vectorNorm(vector);
            this.db
              .prepare(
                `INSERT INTO chunks(
                  id, workspace_id, document_id, position, text, hash, metadata_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                chunk.id,
                request.workspaceId,
                document.id,
                chunk.position,
                chunk.text,
                chunk.hash,
                JSON.stringify(chunk.metadata),
                timestamp,
              );
            this.db
              .prepare(
                `INSERT INTO embeddings(
                  chunk_id, workspace_id, embedding_profile_id, dimension,
                  vector_blob, vector_norm, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                chunk.id,
                request.workspaceId,
                request.embeddingProfile.id,
                request.embeddingProfile.dimension,
                blob,
                norm,
                timestamp,
              );
          }

          chunksWritten += document.chunks.length;
          documentStatuses.push({
            id: document.id,
            status: existing ? "updated" : "created",
            version: nextVersion,
          });
        }
        return documentStatuses;
      });

      this.db
        .prepare(
          `UPDATE ingestion_runs
           SET status = ?, finished_at = ?, chunks_written = ?, metadata_json = ?
           WHERE id = ?`,
        )
        .run(
          "completed",
          now(),
          chunksWritten,
          JSON.stringify({ documentStatuses: statuses }),
          runId,
        );
      return {
        status: "ok",
        ingestionRunId: runId,
        documentStatuses: statuses,
      };
    } catch (error) {
      this.db
        .prepare(
          `UPDATE ingestion_runs
           SET status = ?, finished_at = ?, error_message = ?
           WHERE id = ?`,
        )
        .run("failed", now(), error instanceof Error ? error.message : String(error), runId);
      throw error;
    }
  }

  listDocuments(workspaceId = "default") {
    this._requireWorkspace(workspaceId);
    return this.db
      .prepare(
        `SELECT *
         FROM documents
         WHERE workspace_id = ?
         ORDER BY updated_at DESC, id ASC`,
      )
      .all(workspaceId)
      .map(documentFromRow);
  }

  getDocument(workspaceId, documentId) {
    this._requireWorkspace(workspaceId);
    const row = this.db
      .prepare("SELECT * FROM documents WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, documentId);
    return row ? documentFromRow(row) : null;
  }

  deleteDocument(payload, context) {
    const request = validateDeleteDocumentRequest(payload, context);
    return this._transaction(() => {
      this._requireWorkspace(request.workspaceId);
      const document = this.db
        .prepare("SELECT * FROM documents WHERE workspace_id = ? AND id = ?")
        .get(request.workspaceId, request.documentId);
      if (!document) return { deleted: false, chunksDeleted: 0 };

      if (
        request.expectedDocumentVersion !== undefined &&
        Number(document.version) !== request.expectedDocumentVersion
      ) {
        fail("document_version_conflict", "Document version conflict", 409, {
          documentId: request.documentId,
          expectedVersion: request.expectedDocumentVersion,
          latestVersion: Number(document.version),
        });
      }

      const count = this.db
        .prepare("SELECT COUNT(*) AS count FROM chunks WHERE workspace_id = ? AND document_id = ?")
        .get(request.workspaceId, request.documentId);
      this.db
        .prepare("DELETE FROM documents WHERE workspace_id = ? AND id = ?")
        .run(request.workspaceId, request.documentId);
      return { deleted: true, chunksDeleted: Number(count.count) };
    });
  }

  getRetrievalSnapshot(workspaceId = "default", options = {}) {
    this._requireWorkspace(workspaceId);
    const chunkIds = Array.isArray(options.chunkIds) ? options.chunkIds : null;
    const chunkFilter = chunkIds?.length
      ? `AND chunks.id IN (${chunkIds.map(() => "?").join(", ")})`
      : "";
    const rows = this.db
      .prepare(
        `SELECT
           chunks.id AS chunk_id,
           chunks.workspace_id AS workspace_id,
           chunks.document_id AS document_id,
           documents.title AS document_title,
           chunks.position AS position,
           chunks.text AS text,
           chunks.hash AS hash,
           chunks.metadata_json AS chunk_metadata_json,
           embeddings.embedding_profile_id AS embedding_profile_id,
           embeddings.dimension AS dimension,
           embeddings.vector_blob AS vector_blob
         FROM chunks
         JOIN documents
           ON documents.workspace_id = chunks.workspace_id
          AND documents.id = chunks.document_id
         JOIN embeddings
           ON embeddings.workspace_id = chunks.workspace_id
          AND embeddings.chunk_id = chunks.id
         WHERE chunks.workspace_id = ?
           AND embeddings.embedding_profile_id = ?
           ${chunkFilter}
         ORDER BY documents.id ASC, chunks.position ASC`,
      )
      .all(workspaceId, SUPPORTED_EMBEDDING_PROFILE.id, ...(chunkIds || []));

    const chunks = [];
    const embeddings = [];
    for (const row of rows) {
      const vector = blobToVector(row.vector_blob, Number(row.dimension));
      chunks.push({
        id: row.chunk_id,
        chunkId: row.chunk_id,
        workspaceId: row.workspace_id,
        documentId: row.document_id,
        documentTitle: row.document_title,
        position: Number(row.position),
        text: row.text,
        hash: row.hash,
        metadata: parseJson(row.chunk_metadata_json, "chunk metadata"),
      });
      embeddings.push({
        chunkId: row.chunk_id,
        workspaceId: row.workspace_id,
        embeddingProfileId: row.embedding_profile_id,
        vector,
      });
    }
    return { chunks, embeddings };
  }

  getChunkIndex(workspaceId = "default") {
    this._requireWorkspace(workspaceId);
    return this.db
      .prepare(
        `SELECT
           chunks.id AS chunk_id,
           chunks.workspace_id AS workspace_id,
           chunks.document_id AS document_id,
           documents.title AS document_title,
           chunks.position AS position,
           chunks.text AS text,
           chunks.hash AS hash,
           chunks.metadata_json AS chunk_metadata_json
         FROM chunks
         JOIN documents
           ON documents.workspace_id = chunks.workspace_id
          AND documents.id = chunks.document_id
         WHERE chunks.workspace_id = ?
         ORDER BY documents.id ASC, chunks.position ASC`,
      )
      .all(workspaceId)
      .map((row) => ({
        id: row.chunk_id,
        chunkId: row.chunk_id,
        workspaceId: row.workspace_id,
        documentId: row.document_id,
        documentTitle: row.document_title,
        position: Number(row.position),
        text: row.text,
        hash: row.hash,
        metadata: parseJson(row.chunk_metadata_json, "chunk metadata"),
      }));
  }

  ingestionRuns(workspaceId = "default") {
    this._requireWorkspace(workspaceId);
    return this.db
      .prepare(
        `SELECT *
         FROM ingestion_runs
         WHERE workspace_id = ?
         ORDER BY started_at ASC, id ASC`,
      )
      .all(workspaceId)
      .map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        operation: row.operation,
        status: row.status,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        chunksWritten: Number(row.chunks_written || 0),
        error: row.error_message || null,
        metadata: parseJson(row.metadata_json, "ingestion run metadata"),
      }));
  }

  createConversation(payload, context) {
    const request = validateConversationCreateRequest(payload, context, this.limits);
    return this._transaction(() => {
      this._requireWorkspace(request.workspaceId);
      this._ensureConversationIdAvailable(request.workspaceId, request.id);
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO conversations(
            id, workspace_id, status, customer_id, metadata_json,
            created_at, updated_at, last_message_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.id,
          request.workspaceId,
          request.status,
          request.customerId,
          JSON.stringify(request.metadata),
          timestamp,
          timestamp,
          request.messages.length ? timestamp : null,
        );
      const insertMessage = this.db.prepare(
        `INSERT INTO conversation_messages(
          id, workspace_id, conversation_id, position, sender_type,
          content, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      request.messages.forEach((message, index) => {
        insertMessage.run(
          message.id,
          request.workspaceId,
          request.id,
          index,
          message.senderType,
          message.content,
          JSON.stringify(message.metadata),
          timestamp,
        );
      });
      return this.getConversation(request.workspaceId, request.id);
    });
  }

  listConversations(workspaceId = "default") {
    this._requireWorkspace(workspaceId);
    return this.db
      .prepare(
        `SELECT
           conversations.*,
           COUNT(conversation_messages.id) AS message_count,
           (
             SELECT content
             FROM conversation_messages latest
             WHERE latest.workspace_id = conversations.workspace_id
               AND latest.conversation_id = conversations.id
             ORDER BY latest.position DESC
             LIMIT 1
           ) AS last_message_preview
         FROM conversations
         LEFT JOIN conversation_messages
           ON conversation_messages.workspace_id = conversations.workspace_id
          AND conversation_messages.conversation_id = conversations.id
         WHERE conversations.workspace_id = ?
         GROUP BY conversations.id
         ORDER BY COALESCE(conversations.last_message_at, conversations.updated_at) DESC, conversations.id ASC`,
      )
      .all(workspaceId)
      .map(conversationSummaryFromRow);
  }

  getConversation(workspaceId, conversationId) {
    this._requireWorkspace(workspaceId);
    const conversation = this.db
      .prepare("SELECT * FROM conversations WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, conversationId);
    if (!conversation) return null;
    const messages = this.db
      .prepare(
        `SELECT *
         FROM conversation_messages
         WHERE workspace_id = ? AND conversation_id = ?
         ORDER BY position ASC, created_at ASC, id ASC`,
      )
      .all(workspaceId, conversationId)
      .map(messageFromRow);
    return {
      conversation: conversationSummaryFromRow({
        ...conversation,
        message_count: messages.length,
        last_message_preview: messages.at(-1)?.content || "",
      }),
      messages,
    };
  }

  addConversationMessage(payload, context) {
    const request = validateConversationMessageRequest(payload, context, this.limits);
    return this._transaction(() => {
      this._requireWorkspace(request.workspaceId);
      const conversation = this.db
        .prepare("SELECT * FROM conversations WHERE workspace_id = ? AND id = ?")
        .get(request.workspaceId, request.conversationId);
      if (!conversation) {
        fail("unknown_conversation", "Conversation is not available in hosted storage", 404, {
          conversationId: request.conversationId,
        });
      }
      const latest = this.db
        .prepare(
          `SELECT MAX(position) AS position
           FROM conversation_messages
           WHERE workspace_id = ? AND conversation_id = ?`,
        )
        .get(request.workspaceId, request.conversationId);
      const position = Number.isInteger(Number(latest.position)) ? Number(latest.position) + 1 : 0;
      const timestamp = now();
      this.db
        .prepare(
          `INSERT INTO conversation_messages(
            id, workspace_id, conversation_id, position, sender_type,
            content, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          request.id,
          request.workspaceId,
          request.conversationId,
          position,
          request.senderType,
          request.content,
          JSON.stringify(request.metadata),
          timestamp,
        );
      this.db
        .prepare(
          `UPDATE conversations
           SET updated_at = ?, last_message_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(timestamp, timestamp, request.workspaceId, request.conversationId);
      return {
        conversation: this.listConversations(request.workspaceId).find((item) => item.id === request.conversationId),
        message: {
          id: request.id,
          workspaceId: request.workspaceId,
          conversationId: request.conversationId,
          position,
          senderType: request.senderType,
          content: request.content,
          metadata: request.metadata,
          createdAt: timestamp,
        },
      };
    });
  }

  updateConversationStatus(payload, context) {
    const request = validateConversationStatusRequest(payload, context);
    return this._transaction(() => {
      this._requireWorkspace(request.workspaceId);
      const conversation = this.db
        .prepare("SELECT id FROM conversations WHERE workspace_id = ? AND id = ?")
        .get(request.workspaceId, request.conversationId);
      if (!conversation) {
        fail("unknown_conversation", "Conversation is not available in hosted storage", 404, {
          conversationId: request.conversationId,
        });
      }
      const timestamp = now();
      this.db
        .prepare(
          `UPDATE conversations
           SET status = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(request.status, timestamp, request.workspaceId, request.conversationId);
      return {
        conversation: this.listConversations(request.workspaceId).find((item) => item.id === request.conversationId),
      };
    });
  }

  diagnostics(workspaceId = "default") {
    this._requireWorkspace(workspaceId);
    const integrity = this.db.prepare("PRAGMA integrity_check").get();
    const documentCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM documents WHERE workspace_id = ?")
      .get(workspaceId);
    const chunkCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM chunks WHERE workspace_id = ?")
      .get(workspaceId);
    const embeddingCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM embeddings WHERE workspace_id = ?")
      .get(workspaceId);
    const migration = this.db
      .prepare("SELECT MAX(version) AS version FROM hosted_schema_migrations")
      .get();
    return {
      backend: "sqlite-hosted",
      schemaVersion: Number(migration.version || 0),
      integrityCheck: integrity.integrity_check,
      documentCount: Number(documentCount.count),
      chunkCount: Number(chunkCount.count),
      embeddingCount: Number(embeddingCount.count),
      databaseBytes: databaseBytes(this.path),
    };
  }

  revokeSession(sessionId, expiresAt) {
    this.db
      .prepare(
        `INSERT INTO hosted_session_revocations(session_id, expires_at, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET expires_at = excluded.expires_at`,
      )
      .run(sessionId, expiresAt, now());
  }

  isSessionRevoked(sessionId, nowIso = now()) {
    this.db
      .prepare("DELETE FROM hosted_session_revocations WHERE expires_at <= ?")
      .run(nowIso);
    const row = this.db
      .prepare("SELECT session_id FROM hosted_session_revocations WHERE session_id = ? AND expires_at > ?")
      .get(sessionId, nowIso);
    return Boolean(row);
  }

  _configure() {
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
    `);
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosted_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const current = this.db
      .prepare("SELECT MAX(version) AS version FROM hosted_schema_migrations")
      .get();
    if (Number(current.version || 0) < 1) {
      this._transaction(() => {
        this.db.exec(SCHEMA_V1);
        this.db
          .prepare(
            "INSERT INTO hosted_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(1, "initial-hosted-libsql-compatible-schema", now());
      });
    }
    const afterInitial = this.db
      .prepare("SELECT MAX(version) AS version FROM hosted_schema_migrations")
      .get();
    if (Number(afterInitial.version || 0) < 2) {
      this._transaction(() => {
        this.db.exec(CONVERSATION_SCHEMA);
        this.db
          .prepare(
            "INSERT INTO hosted_schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(2, "conversation-persistence-schema", now());
      });
    }
    this.db.exec(SECURITY_SCHEMA);
  }

  _seedProfiles() {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO embedding_profiles(
          id, compatibility_key, provider, model_id, target_model_id,
          model_revision, target_model_revision, runtime, runtime_configuration,
          package_name, package_version, dimension, normalized, pooling,
          quantized, dtype, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        SUPPORTED_EMBEDDING_PROFILE.id,
        SUPPORTED_EMBEDDING_PROFILE.compatibilityKey,
        SUPPORTED_EMBEDDING_PROFILE.provider,
        SUPPORTED_EMBEDDING_PROFILE.modelId,
        SUPPORTED_EMBEDDING_PROFILE.targetModelId,
        SUPPORTED_EMBEDDING_PROFILE.modelRevision,
        SUPPORTED_EMBEDDING_PROFILE.targetModelRevision,
        SUPPORTED_EMBEDDING_PROFILE.runtime,
        SUPPORTED_EMBEDDING_PROFILE.runtimeConfiguration,
        SUPPORTED_EMBEDDING_PROFILE.packageName,
        SUPPORTED_EMBEDDING_PROFILE.packageVersion,
        SUPPORTED_EMBEDDING_PROFILE.dimension,
        SUPPORTED_EMBEDDING_PROFILE.normalized ? 1 : 0,
        SUPPORTED_EMBEDDING_PROFILE.pooling,
        SUPPORTED_EMBEDDING_PROFILE.quantized ? 1 : 0,
        SUPPORTED_EMBEDDING_PROFILE.dtype,
        now(),
      );

    this.db
      .prepare(
        `INSERT OR IGNORE INTO indexing_profiles(
          id, compatibility_key, text_normalization_version,
          chunking_algorithm, chunking_version, chunk_size,
          chunk_overlap, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        SUPPORTED_INDEXING_PROFILE_WITH_KEY.id,
        SUPPORTED_INDEXING_PROFILE_WITH_KEY.compatibilityKey,
        SUPPORTED_INDEXING_PROFILE_WITH_KEY.textNormalizationVersion,
        SUPPORTED_INDEXING_PROFILE_WITH_KEY.chunkingAlgorithm,
        SUPPORTED_INDEXING_PROFILE_WITH_KEY.chunkingVersion,
        SUPPORTED_INDEXING_PROFILE_WITH_KEY.chunkSize,
        SUPPORTED_INDEXING_PROFILE_WITH_KEY.chunkOverlap,
        now(),
      );
  }

  _seedWorkspaces(workspaces = [{ id: "default", version: 1, settings: {} }]) {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM workspaces").get();
    if (Number(count.count) > 0) return;
    const insert = this.db.prepare(
      `INSERT INTO workspaces(
        id, version, settings_json, articles_json, conversations_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const workspace of workspaces) {
      insert.run(
        workspace.id,
        workspace.version || 1,
        JSON.stringify(workspace.settings || {}),
        JSON.stringify(workspace.articles || []),
        JSON.stringify(workspace.conversations || []),
        now(),
        now(),
      );
    }
  }

  _requireWorkspace(workspaceId) {
    const row = this.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(workspaceId);
    if (!row) {
      fail("unknown_workspace", "Workspace is not available in hosted storage", 404, {
        workspaceId,
      });
    }
  }

  _ensureDocumentIdAvailable(workspaceId, documentId) {
    const row = this.db
      .prepare("SELECT workspace_id FROM documents WHERE id = ?")
      .get(documentId);
    if (row && row.workspace_id !== workspaceId) {
      fail("cross_workspace_document_reference", "Document id belongs to another workspace", 409, {
        workspaceId,
        documentId,
        ownerWorkspaceId: row.workspace_id,
      });
    }
  }

  _ensureConversationIdAvailable(workspaceId, conversationId) {
    const row = this.db
      .prepare("SELECT workspace_id FROM conversations WHERE id = ?")
      .get(conversationId);
    if (row && row.workspace_id !== workspaceId) {
      fail("cross_workspace_conversation_reference", "Conversation id belongs to another workspace", 409, {
        workspaceId,
        conversationId,
        ownerWorkspaceId: row.workspace_id,
      });
    }
    if (row) {
      fail("conversation_exists", "Conversation already exists", 409, {
        conversationId,
      });
    }
  }

  _transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const SCHEMA_V1 = `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    settings_json TEXT NOT NULL,
    articles_json TEXT NOT NULL DEFAULT '[]',
    conversations_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE embedding_profiles (
    id TEXT PRIMARY KEY,
    compatibility_key TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    target_model_id TEXT NOT NULL,
    model_revision TEXT,
    target_model_revision TEXT,
    runtime TEXT NOT NULL,
    runtime_configuration TEXT NOT NULL,
    package_name TEXT NOT NULL,
    package_version TEXT NOT NULL,
    dimension INTEGER NOT NULL CHECK (dimension = 384),
    normalized INTEGER NOT NULL CHECK (normalized IN (0, 1)),
    pooling TEXT NOT NULL,
    quantized INTEGER NOT NULL CHECK (quantized IN (0, 1)),
    dtype TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE indexing_profiles (
    id TEXT PRIMARY KEY,
    compatibility_key TEXT NOT NULL UNIQUE,
    text_normalization_version TEXT NOT NULL,
    chunking_algorithm TEXT NOT NULL,
    chunking_version TEXT NOT NULL,
    chunk_size INTEGER NOT NULL,
    chunk_overlap INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    stable_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    embedding_profile_id TEXT NOT NULL,
    indexing_profile_id TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, stable_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (embedding_profile_id) REFERENCES embedding_profiles(id),
    FOREIGN KEY (indexing_profile_id) REFERENCES indexing_profiles(id)
  );

  CREATE TABLE chunks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    hash TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, id),
    UNIQUE (document_id, position),
    UNIQUE (document_id, hash),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE
  );

  CREATE TABLE embeddings (
    chunk_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    embedding_profile_id TEXT NOT NULL,
    dimension INTEGER NOT NULL CHECK (dimension = 384),
    vector_blob BLOB NOT NULL CHECK (length(vector_blob) = 1536),
    vector_norm REAL NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (chunk_id, embedding_profile_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, chunk_id) REFERENCES chunks(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (embedding_profile_id) REFERENCES embedding_profiles(id)
  );

  CREATE TABLE ingestion_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    chunks_written INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_documents_workspace_status
    ON documents(workspace_id, status, updated_at DESC);
  CREATE INDEX idx_chunks_workspace_document
    ON chunks(workspace_id, document_id, position);
  CREATE INDEX idx_embeddings_workspace_profile
    ON embeddings(workspace_id, embedding_profile_id);
  CREATE INDEX idx_ingestion_runs_workspace_status
    ON ingestion_runs(workspace_id, status, started_at DESC);
`;

const CONVERSATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    customer_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_message_at TEXT,
    deleted_at TEXT,
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'assistant', 'agent')),
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, conversation_id, position),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, conversation_id) REFERENCES conversations(workspace_id, id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_conversations_workspace_status
    ON conversations(workspace_id, status, last_message_at DESC);
  CREATE INDEX IF NOT EXISTS idx_conversation_messages_order
    ON conversation_messages(workspace_id, conversation_id, position);
`;

const SECURITY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS hosted_session_revocations (
    session_id TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_hosted_session_revocations_expires
    ON hosted_session_revocations(expires_at);
`;

function workspaceFromRow(row) {
  return {
    id: row.id,
    version: Number(row.version),
    settings: parseJson(row.settings_json, "workspace settings"),
    articles: parseJson(row.articles_json, "workspace articles"),
    conversations: parseJson(row.conversations_json, "workspace conversations"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function conversationSummaryFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status,
    customerId: row.customer_id,
    metadata: parseJson(row.metadata_json, "conversation metadata"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at,
    messageCount: Number(row.message_count || 0),
    lastMessagePreview: row.last_message_preview || "",
  };
}

function messageFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    position: Number(row.position),
    senderType: row.sender_type,
    content: row.content,
    metadata: parseJson(row.metadata_json, "conversation message metadata"),
    createdAt: row.created_at,
  };
}

function documentFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    stableId: row.stable_id,
    title: row.title,
    sourceType: row.source_type,
    contentHash: row.content_hash,
    embeddingProfileId: row.embedding_profile_id,
    indexingProfileId: row.indexing_profile_id,
    status: row.status,
    version: Number(row.version),
    chunkCount: Number(row.chunk_count),
    metadata: parseJson(row.metadata_json, "document metadata"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function vectorToBlob(vector) {
  const array = new Float32Array(vector);
  return Buffer.from(array.buffer.slice(0));
}

function blobToVector(blob, dimension) {
  if (!blob || typeof blob.byteLength !== "number" || blob.byteLength !== dimension * 4) {
    fail("invalid_stored_vector", "Stored vector BLOB has an invalid byte length", 500, {
      expectedBytes: dimension * 4,
      receivedBytes: blob?.byteLength,
    });
  }
  const bytes = Buffer.from(blob);
  const vector = Array.from(
    new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  );
  return validateVector(vector);
}

function vectorNorm(vector) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function parseJson(value, label) {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    fail("invalid_stored_json", `Stored ${label} is malformed`, 500);
  }
}

function databaseBytes(path) {
  return [path, `${path}-wal`, `${path}-shm`].reduce((total, candidate) => {
    try {
      return total + statSync(candidate).size;
    } catch {
      return total;
    }
  }, 0);
}

function now() {
  return new Date().toISOString();
}

function fail(code, message, status = 400, details = {}) {
  throw new HostedContractError(code, message, status, details);
}
