import { createHash, randomUUID } from "node:crypto";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ONE_MEGABYTE = 1024 * 1024;

export const HOSTED_LIMITS = Object.freeze({
  maxPayloadBytes: ONE_MEGABYTE,
  maxDocumentsPerIngest: 20,
  maxChunksPerDocument: 200,
  maxVectorsPerIngest: 500,
  maxChunkTextLength: 7000,
  maxQuestionLength: 800,
  normTolerance: 0.05,
});

const baseEmbeddingProfile = Object.freeze({
  id: "xenova-all-minilm-l6-v2-transformersjs-fp32-v1",
  provider: "transformers-js-browser",
  modelId: "Xenova/all-MiniLM-L6-v2",
  targetModelId: "sentence-transformers/all-MiniLM-L6-v2",
  modelRevision: "not-recorded-phase-4.2c",
  targetModelRevision: "1110a243fdf4706b3f48",
  runtime: "transformers-js-browser",
  runtimeConfiguration: "pipeline(feature-extraction, quantized:false)",
  packageName: "@xenova/transformers",
  packageVersion: "2.17.2",
  dimension: 384,
  normalized: true,
  pooling: "mean",
  quantized: false,
  dtype: "fp32",
});

export const SUPPORTED_INDEXING_PROFILE = Object.freeze({
  id: "askwell-char-window-v1-700-120",
  textNormalizationVersion: "askwell-normalize-v1",
  chunkingAlgorithm: "character-window",
  chunkingVersion: "askwell-char-window-v1",
  chunkSize: 700,
  chunkOverlap: 120,
});

export class HostedContractError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message);
    this.name = "HostedContractError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function canonicalJson(value) {
  return JSON.stringify(sortCanonical(value));
}

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function buildEmbeddingCompatibilityKey(profile) {
  return sha256(
    canonicalJson({
      provider: profile.provider,
      modelId: profile.modelId,
      targetModelId: profile.targetModelId,
      modelRevision: profile.modelRevision,
      targetModelRevision: profile.targetModelRevision,
      runtime: profile.runtime,
      runtimeConfiguration: profile.runtimeConfiguration,
      packageName: profile.packageName,
      packageVersion: profile.packageVersion,
      dimension: profile.dimension,
      normalized: profile.normalized,
      pooling: profile.pooling,
      quantized: profile.quantized,
      dtype: profile.dtype,
    }),
  );
}

export function buildIndexingCompatibilityKey(profile) {
  return sha256(canonicalJson(profile));
}

export const SUPPORTED_EMBEDDING_PROFILE = Object.freeze({
  ...baseEmbeddingProfile,
  compatibilityKey: buildEmbeddingCompatibilityKey(baseEmbeddingProfile),
});

export const SUPPORTED_INDEXING_PROFILE_WITH_KEY = Object.freeze({
  ...SUPPORTED_INDEXING_PROFILE,
  compatibilityKey: buildIndexingCompatibilityKey(SUPPORTED_INDEXING_PROFILE),
});

export function structuredError(error) {
  if (error instanceof HostedContractError) {
    return {
      error: error.message,
      code: error.code,
      details: error.details,
    };
  }
  return { error: "Hosted contract validation failed", code: "hosted_contract_error" };
}

export function validateEmbeddingProfileSelection(input) {
  const selection = typeof input === "string" ? { id: input } : objectRecord(input, "embeddingProfile");
  const allowed = SUPPORTED_EMBEDDING_PROFILE;

  if (selection.profileId && selection.profileId !== allowed.id) {
    fail("unknown_embedding_profile", "Unknown embedding profile", 400, {
      profileId: selection.profileId,
    });
  }

  if (selection.id && selection.id !== allowed.id) {
    fail("unknown_embedding_profile", "Unknown embedding profile", 400, {
      profileId: selection.id,
    });
  }

  if (selection.compatibilityKey && selection.compatibilityKey !== allowed.compatibilityKey) {
    fail("embedding_profile_mismatch", "Embedding profile compatibility key is not supported", 409, {
      expected: allowed.compatibilityKey,
      received: selection.compatibilityKey,
    });
  }

  for (const [key, value] of Object.entries(selection)) {
    if (key in allowed && value !== allowed[key]) {
      fail("embedding_profile_mismatch", `Embedding profile field ${key} is not supported`, 409, {
        field: key,
        expected: allowed[key],
        received: value,
      });
    }
  }

  return allowed;
}

export function validateIndexingProfileSelection(input = SUPPORTED_INDEXING_PROFILE_WITH_KEY) {
  const selection = objectRecord(input, "indexingProfile");
  const allowed = SUPPORTED_INDEXING_PROFILE_WITH_KEY;

  if (selection.id !== allowed.id) {
    fail("unsupported_indexing_profile", "Indexing profile is not supported", 409, {
      expected: allowed.id,
      received: selection.id,
    });
  }

  if (
    selection.compatibilityKey &&
    selection.compatibilityKey !== allowed.compatibilityKey
  ) {
    fail("indexing_profile_mismatch", "Indexing profile compatibility key is not supported", 409, {
      expected: allowed.compatibilityKey,
      received: selection.compatibilityKey,
    });
  }

  for (const [key, value] of Object.entries(selection)) {
    if (key in allowed && value !== allowed[key]) {
      fail("indexing_profile_mismatch", `Indexing profile field ${key} is not supported`, 409, {
        field: key,
        expected: allowed[key],
        received: value,
      });
    }
  }

  return allowed;
}

export function validateVector(vector, profile = SUPPORTED_EMBEDDING_PROFILE, limits = HOSTED_LIMITS) {
  if (!Array.isArray(vector) && !(ArrayBuffer.isView(vector) && typeof vector.length === "number")) {
    fail("invalid_vector", "Embedding vector must be an array of numbers");
  }

  if (vector.length !== profile.dimension) {
    fail("invalid_vector_dimension", `Embedding vector must have exactly ${profile.dimension} dimensions`, 400, {
      expected: profile.dimension,
      received: vector.length,
    });
  }

  let squared = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = Number(vector[index]);
    if (!Number.isFinite(value)) {
      fail("invalid_vector_value", "Embedding vector contains NaN or Infinity", 400, {
        index,
      });
    }
    squared += value * value;
  }

  const norm = Math.sqrt(squared);
  if (Math.abs(norm - 1) > limits.normTolerance) {
    fail("invalid_vector_norm", "Embedding vector is not normalized within tolerance", 400, {
      norm,
      tolerance: limits.normTolerance,
    });
  }

  return Array.from(vector, Number);
}

export function validateHostedIngestRequest(payload, context, limits = HOSTED_LIMITS) {
  const body = objectRecord(payload, "ingestRequest");
  const workspaceId = validateWorkspaceContext(body.workspaceId, context);
  enforcePayloadSize(body, limits.maxPayloadBytes);

  const embeddingProfile = validateEmbeddingProfileSelection(
    body.embeddingProfile || body.embeddingProfileId || body.embeddingProfileCompatibilityKey,
  );
  const indexingProfile = validateIndexingProfileSelection(
    body.indexingProfile || SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  );
  const documents = arrayOf(body.documents, "documents");

  if (documents.length > limits.maxDocumentsPerIngest) {
    fail("document_limit_exceeded", "Too many documents in hosted ingest request", 413, {
      limit: limits.maxDocumentsPerIngest,
      received: documents.length,
    });
  }

  let vectorCount = 0;
  const normalizedDocuments = documents.map((document) => {
    const normalized = validateDocumentIngestPayload(document, {
      workspaceId,
      embeddingProfile,
      limits,
    });
    vectorCount += normalized.vectors.length;
    return normalized;
  });

  if (vectorCount > limits.maxVectorsPerIngest) {
    fail("vector_limit_exceeded", "Too many vectors in hosted ingest request", 413, {
      limit: limits.maxVectorsPerIngest,
      received: vectorCount,
    });
  }

  return {
    workspaceId,
    embeddingProfile,
    indexingProfile,
    documents: normalizedDocuments,
  };
}

export function validateHostedAnswerRequest(payload, context, limits = HOSTED_LIMITS) {
  const body = objectRecord(payload, "answerRequest");
  const workspaceId = validateWorkspaceContext(body.workspaceId, context);
  const question = stringValue(body.question, "question", { min: 1, max: limits.maxQuestionLength });

  if (body.clientScore !== undefined || body.scores !== undefined || body.citations !== undefined) {
    fail("untrusted_client_retrieval", "Client-provided retrieval scores or citations are not accepted");
  }

  const embeddingProfile = validateEmbeddingProfileSelection(
    body.embeddingProfile || body.embeddingProfileId || body.embeddingProfileCompatibilityKey,
  );
  const queryVector = validateVector(body.queryVector, embeddingProfile, limits);
  const topK = integerValue(body.topK ?? 5, "topK", { min: 1, max: 12 });

  return {
    workspaceId,
    question,
    topK,
    queryVector,
    embeddingProfile,
  };
}

export function validateWorkspaceUpdateRequest(payload, context) {
  const body = objectRecord(payload, "workspaceUpdate");
  const workspaceId = validateWorkspaceContext(body.workspaceId, context);
  return {
    workspaceId,
    expectedVersion: integerValue(body.expectedVersion, "expectedVersion", { min: 1 }),
    settings: objectRecord(body.settings || {}, "settings"),
    articles: Array.isArray(body.articles) ? body.articles : [],
    conversations: Array.isArray(body.conversations) ? body.conversations : [],
  };
}

export function validateDeleteDocumentRequest(payload, context) {
  const body = objectRecord(payload, "deleteDocument");
  const workspaceId = validateWorkspaceContext(body.workspaceId, context);
  return {
    workspaceId,
    documentId: validId(body.documentId, "documentId"),
    expectedDocumentVersion:
      body.expectedDocumentVersion === undefined
        ? undefined
        : integerValue(body.expectedDocumentVersion, "expectedDocumentVersion", { min: 1 }),
  };
}

export function validateCitations(citationChunkIds, retrievedChunks) {
  const allowed = new Set(arrayOf(retrievedChunks, "retrievedChunks").map((chunk) => chunk.chunkId || chunk.id));
  return arrayOf(citationChunkIds, "citationChunkIds").map((chunkId) => {
    const id = validId(chunkId, "citationChunkId");
    if (!allowed.has(id)) {
      fail("invalid_citation", "Citation references a chunk that was not retrieved", 400, {
        chunkId: id,
      });
    }
    return id;
  });
}

export function createMemoryHostedStore(options = {}) {
  const workspaces = new Map();
  const documents = new Map();
  const chunks = new Map();
  const embeddings = new Map();
  const ingestionRuns = [];

  for (const workspace of options.workspaces || [{ id: "default", version: 1, settings: {} }]) {
    const id = validId(workspace.id, "workspace.id");
    workspaces.set(id, {
      id,
      version: workspace.version || 1,
      settings: workspace.settings || {},
      createdAt: now(),
      updatedAt: now(),
    });
    documents.set(id, new Map());
    chunks.set(id, new Map());
    embeddings.set(id, new Map());
  }

  function requireWorkspace(workspaceId) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace) {
      fail("unknown_workspace", "Workspace is not available in hosted storage", 404, {
        workspaceId,
      });
    }
    return workspace;
  }

  function ensureDocumentIdAvailable(workspaceId, documentId) {
    for (const [otherWorkspaceId, workspaceDocuments] of documents.entries()) {
      if (otherWorkspaceId !== workspaceId && workspaceDocuments.has(documentId)) {
        fail("cross_workspace_document_reference", "Document id belongs to another workspace", 409, {
          workspaceId,
          documentId,
          ownerWorkspaceId: otherWorkspaceId,
        });
      }
    }
  }

  return {
    supportedEmbeddingProfile: SUPPORTED_EMBEDDING_PROFILE,
    supportedIndexingProfile: SUPPORTED_INDEXING_PROFILE_WITH_KEY,

    getWorkspace(workspaceId = "default") {
      return clone(requireWorkspace(workspaceId));
    },

    saveWorkspace(payload, context) {
      const request = validateWorkspaceUpdateRequest(payload, context);
      const workspace = requireWorkspace(request.workspaceId);
      if (workspace.version !== request.expectedVersion) {
        fail("workspace_version_conflict", "Workspace version conflict", 409, {
          expectedVersion: request.expectedVersion,
          latestVersion: workspace.version,
        });
      }
      workspace.version += 1;
      workspace.settings = request.settings;
      workspace.articles = request.articles;
      workspace.conversations = request.conversations;
      workspace.updatedAt = now();
      return clone(workspace);
    },

    ingest(payload, context) {
      const workspaceId = payload?.workspaceId || context?.workspaceId || "default";
      requireWorkspace(workspaceId);
      const run = {
        id: randomUUID(),
        workspaceId,
        operation: "ingest",
        status: "running",
        startedAt: now(),
        finishedAt: null,
        error: null,
      };
      ingestionRuns.push(run);

      try {
        const request = validateHostedIngestRequest(payload, context);
        const workspaceDocuments = documents.get(request.workspaceId);
        const workspaceChunks = chunks.get(request.workspaceId);
        const workspaceEmbeddings = embeddings.get(request.workspaceId);
        const replacementDocuments = cloneMap(workspaceDocuments);
        const replacementChunks = cloneMap(workspaceChunks);
        const replacementEmbeddings = cloneMap(workspaceEmbeddings);
        const statuses = [];
        let chunksWritten = 0;

        for (const document of request.documents) {
          ensureDocumentIdAvailable(request.workspaceId, document.id);
          const existing = replacementDocuments.get(document.id);
          if (
            existing &&
            document.expectedVersion !== undefined &&
            document.expectedVersion !== existing.version
          ) {
            fail("document_version_conflict", "Document version conflict", 409, {
              documentId: document.id,
              expectedVersion: document.expectedVersion,
              latestVersion: existing.version,
            });
          }

          const unchanged =
            existing &&
            existing.contentHash === document.contentHash &&
            existing.embeddingProfileId === request.embeddingProfile.id &&
            existing.indexingProfileId === request.indexingProfile.id;

          if (unchanged) {
            statuses.push({ id: document.id, status: "unchanged", version: existing.version });
            continue;
          }

          for (const [chunkId, chunk] of [...replacementChunks.entries()]) {
            if (chunk.documentId === document.id) {
              replacementChunks.delete(chunkId);
              replacementEmbeddings.delete(chunkId);
            }
          }

          const nextVersion = existing ? existing.version + 1 : 1;
          const storedDocument = {
            id: document.id,
            workspaceId: request.workspaceId,
            stableId: document.stableId,
            title: document.title,
            sourceType: document.sourceType,
            contentHash: document.contentHash,
            embeddingProfileId: request.embeddingProfile.id,
            indexingProfileId: request.indexingProfile.id,
            status: "indexed",
            version: nextVersion,
            chunkCount: document.chunks.length,
            metadata: document.metadata,
            updatedAt: now(),
            createdAt: existing?.createdAt || now(),
          };
          replacementDocuments.set(document.id, storedDocument);

          for (let index = 0; index < document.chunks.length; index += 1) {
            const chunk = document.chunks[index];
            replacementChunks.set(chunk.id, chunk);
            replacementEmbeddings.set(chunk.id, {
              chunkId: chunk.id,
              workspaceId: request.workspaceId,
              embeddingProfileId: request.embeddingProfile.id,
              vector: document.vectors[index],
            });
          }

          chunksWritten += document.chunks.length;
          statuses.push({ id: document.id, status: existing ? "updated" : "created", version: nextVersion });
        }

        documents.set(request.workspaceId, replacementDocuments);
        chunks.set(request.workspaceId, replacementChunks);
        embeddings.set(request.workspaceId, replacementEmbeddings);
        run.status = "completed";
        run.finishedAt = now();
        run.chunksWritten = chunksWritten;
        return {
          status: "ok",
          ingestionRunId: run.id,
          documentStatuses: statuses,
        };
      } catch (error) {
        run.status = "failed";
        run.finishedAt = now();
        run.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },

    listDocuments(workspaceId = "default") {
      requireWorkspace(workspaceId);
      return [...documents.get(workspaceId).values()].map(clone);
    },

    getDocument(workspaceId, documentId) {
      requireWorkspace(workspaceId);
      return clone(documents.get(workspaceId).get(documentId) || null);
    },

    deleteDocument(payload, context) {
      const request = validateDeleteDocumentRequest(payload, context);
      requireWorkspace(request.workspaceId);
      const workspaceDocuments = documents.get(request.workspaceId);
      const document = workspaceDocuments.get(request.documentId);
      if (!document) return { deleted: false, chunksDeleted: 0 };
      if (
        request.expectedDocumentVersion !== undefined &&
        request.expectedDocumentVersion !== document.version
      ) {
        fail("document_version_conflict", "Document version conflict", 409, {
          documentId: document.id,
          expectedVersion: request.expectedDocumentVersion,
          latestVersion: document.version,
        });
      }

      let chunksDeleted = 0;
      for (const [chunkId, chunk] of chunks.get(request.workspaceId).entries()) {
        if (chunk.documentId === request.documentId) {
          chunks.get(request.workspaceId).delete(chunkId);
          embeddings.get(request.workspaceId).delete(chunkId);
          chunksDeleted += 1;
        }
      }
      workspaceDocuments.delete(request.documentId);
      return { deleted: true, chunksDeleted };
    },

    getRetrievalSnapshot(workspaceId = "default") {
      requireWorkspace(workspaceId);
      return {
        chunks: [...chunks.get(workspaceId).values()].map(clone),
        embeddings: [...embeddings.get(workspaceId).values()].map(clone),
      };
    },

    ingestionRuns(workspaceId = "default") {
      return ingestionRuns.filter((run) => run.workspaceId === workspaceId).map(clone);
    },
  };
}

function validateDocumentIngestPayload(document, options) {
  const body = objectRecord(document, "document");
  const workspaceId = options.workspaceId;
  if (body.workspaceId !== undefined && body.workspaceId !== workspaceId) {
    fail("cross_workspace_document_reference", "Document workspace does not match authorized workspace", 409, {
      expected: workspaceId,
      received: body.workspaceId,
    });
  }
  if (body.clientScore !== undefined || body.citations !== undefined) {
    fail("untrusted_client_retrieval", "Client-provided scores or citations are not accepted");
  }

  const chunks = arrayOf(body.chunks, "chunks");
  const vectors = arrayOf(body.vectors, "vectors");
  if (chunks.length !== vectors.length) {
    fail("chunk_vector_mismatch", "Chunk and vector counts must match", 400, {
      chunks: chunks.length,
      vectors: vectors.length,
    });
  }
  if (chunks.length > options.limits.maxChunksPerDocument) {
    fail("chunk_limit_exceeded", "Too many chunks for one document", 413, {
      limit: options.limits.maxChunksPerDocument,
      received: chunks.length,
    });
  }

  const documentId = validId(body.id, "document.id");
  const normalizedChunks = chunks.map((chunk, index) =>
    validateChunkPayload(chunk, {
      workspaceId,
      documentId,
      expectedPosition: index,
      limits: options.limits,
    }),
  );

  return {
    id: documentId,
    workspaceId,
    stableId: validId(body.stableId || body.id, "document.stableId"),
    title: stringValue(body.title, "document.title", { min: 1, max: 160 }),
    sourceType: stringValue(body.sourceType || body.source_type || "text", "document.sourceType", {
      min: 1,
      max: 40,
    }),
    contentHash: sha256Value(body.contentHash || body.content_hash, "document.contentHash"),
    expectedVersion:
      body.expectedVersion === undefined
        ? undefined
        : integerValue(body.expectedVersion, "document.expectedVersion", { min: 1 }),
    metadata: objectRecord(body.metadata || {}, "document.metadata"),
    chunks: normalizedChunks,
    vectors: vectors.map((vector) => validateVector(vector, options.embeddingProfile, options.limits)),
  };
}

function validateChunkPayload(chunk, options) {
  const body = objectRecord(chunk, "chunk");
  if (body.workspaceId !== undefined && body.workspaceId !== options.workspaceId) {
    fail("cross_workspace_chunk_reference", "Chunk workspace does not match authorized workspace", 409, {
      expected: options.workspaceId,
      received: body.workspaceId,
    });
  }
  if (body.documentId !== undefined && body.documentId !== options.documentId) {
    fail("cross_document_chunk_reference", "Chunk document reference does not match parent document", 409, {
      expected: options.documentId,
      received: body.documentId,
    });
  }
  if (body.score !== undefined || body.clientScore !== undefined || body.citations !== undefined) {
    fail("untrusted_client_retrieval", "Client-provided chunk scores or citations are not accepted");
  }
  const position = integerValue(body.position, "chunk.position", { min: 0 });
  if (position !== options.expectedPosition) {
    fail("invalid_chunk_position", "Chunk positions must be contiguous and ordered", 400, {
      expected: options.expectedPosition,
      received: position,
    });
  }

  return {
    id: validId(body.id, "chunk.id"),
    workspaceId: options.workspaceId,
    documentId: options.documentId,
    position,
    text: stringValue(body.text, "chunk.text", {
      min: 1,
      max: options.limits.maxChunkTextLength,
    }),
    hash: sha256Value(body.hash, "chunk.hash"),
    metadata: objectRecord(body.metadata || {}, "chunk.metadata"),
  };
}

function validateWorkspaceContext(workspaceId, context = {}) {
  const authorizedWorkspaceId = validId(context.workspaceId || "default", "authorizedWorkspaceId");
  const requestedWorkspaceId = validId(workspaceId || authorizedWorkspaceId, "workspaceId");
  if (requestedWorkspaceId !== authorizedWorkspaceId) {
    fail("workspace_context_mismatch", "Requested workspace is not authorized for this operation", 403, {
      authorizedWorkspaceId,
      requestedWorkspaceId,
    });
  }
  return authorizedWorkspaceId;
}

function enforcePayloadSize(value, maxBytes) {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > maxBytes) {
    fail("payload_too_large", "Hosted request payload is too large", 413, {
      limitBytes: maxBytes,
      receivedBytes: bytes,
    });
  }
}

function validId(value, field) {
  const id = stringValue(value, field, { min: 1, max: 160 });
  if (!ID_PATTERN.test(id)) {
    fail("invalid_identifier", `${field} contains unsupported characters`, 400, {
      field,
    });
  }
  return id;
}

function sha256Value(value, field) {
  const hash = stringValue(value, field, { min: 64, max: 64 }).toLowerCase();
  if (!SHA256_PATTERN.test(hash)) {
    fail("invalid_hash", `${field} must be a lowercase SHA-256 hex hash`, 400, {
      field,
    });
  }
  return hash;
}

function stringValue(value, field, { min = 0, max = Infinity } = {}) {
  if (typeof value !== "string") {
    fail("invalid_string", `${field} must be a string`, 400, { field });
  }
  const text = value.trim();
  if (text.length < min || text.length > max) {
    fail("invalid_string_length", `${field} length is outside the allowed range`, 400, {
      field,
      min,
      max,
      received: text.length,
    });
  }
  return text;
}

function integerValue(value, field, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail("invalid_integer", `${field} must be an integer in the allowed range`, 400, {
      field,
      min,
      max,
      received: value,
    });
  }
  return value;
}

function objectRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_object", `${field} must be an object`, 400, { field });
  }
  return value;
}

function arrayOf(value, field) {
  if (!Array.isArray(value)) {
    fail("invalid_array", `${field} must be an array`, 400, { field });
  }
  return value;
}

function fail(code, message, status = 400, details = {}) {
  throw new HostedContractError(code, message, status, details);
}

function sortCanonical(value) {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortCanonical(value[key])]),
    );
  }
  return value;
}

function clone(value) {
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function cloneMap(map) {
  return new Map([...map.entries()].map(([key, value]) => [key, clone(value)]));
}

function now() {
  return new Date().toISOString();
}
