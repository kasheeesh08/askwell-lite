(function attachHostedEmbeddings(root) {
  const EMBEDDING_PROFILE = Object.freeze({
    id: "xenova-all-minilm-l6-v2-transformersjs-fp32-v1",
    compatibilityKey: "9783ece26557496878710f6a24d38b4e2b1e0daf3e1863de1167bd4a13b78a01",
    provider: "transformers-js-browser",
    modelId: "Xenova/all-MiniLM-L6-v2",
    targetModelId: "sentence-transformers/all-MiniLM-L6-v2",
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

  const INDEXING_PROFILE = Object.freeze({
    id: "askwell-char-window-v1-700-120",
    compatibilityKey: "c4e52049a05ccec6f30efbe700ea30825a989af0feb793ecdc22dc68691fcc73",
    textNormalizationVersion: "askwell-normalize-v1",
    chunkingAlgorithm: "character-window",
    chunkingVersion: "askwell-char-window-v1",
    chunkSize: 700,
    chunkOverlap: 120,
  });

  let extractorPromise;
  let customEmbedder;

  async function loadExtractor() {
    if (customEmbedder) return customEmbedder;
    if (!extractorPromise) {
      extractorPromise = import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2")
        .then(async ({ pipeline, env }) => {
          env.allowLocalModels = false;
          env.allowRemoteModels = true;
          return pipeline("feature-extraction", EMBEDDING_PROFILE.modelId, { quantized: false });
        })
        .catch((error) => {
          extractorPromise = undefined;
          throw new Error(`Browser embedding model failed to load: ${error?.message || error}`);
        });
    }
    return extractorPromise;
  }

  async function embedTexts(texts) {
    const extractor = await loadExtractor();
    const vectors = [];
    for (const text of texts) {
      const result = await extractor(String(text || ""), { pooling: "mean", normalize: true });
      const vector = toArray(result);
      validateVector(vector);
      vectors.push(vector);
    }
    return vectors;
  }

  async function embedQuestion(question) {
    const [queryVector] = await embedTexts([question]);
    return {
      workspaceId: "default",
      question,
      queryVector,
      embeddingProfileId: EMBEDDING_PROFILE.id,
      embeddingProfileCompatibilityKey: EMBEDDING_PROFILE.compatibilityKey,
    };
  }

  async function buildIngestPayload(payload = {}) {
    const sourceDocuments = normalizeDocuments(payload);
    const documents = [];
    for (const document of sourceDocuments) {
      const normalizedContent = normalizeText(document.content);
      if (!normalizedContent) continue;
      const chunks = await chunkDocument(document, normalizedContent);
      const vectors = await embedTexts(chunks.map((chunk) => chunk.text));
      documents.push({
        id: document.id,
        stableId: document.id,
        title: document.title,
        sourceType: document.sourceType,
        contentHash: await sha256Hex(normalizedContent),
        expectedVersion: document.expectedVersion,
        metadata: document.metadata,
        chunks,
        vectors,
      });
    }

    return {
      workspaceId: payload.workspaceId || "default",
      embeddingProfile: {
        id: EMBEDDING_PROFILE.id,
        compatibilityKey: EMBEDDING_PROFILE.compatibilityKey,
      },
      indexingProfile: {
        id: INDEXING_PROFILE.id,
        compatibilityKey: INDEXING_PROFILE.compatibilityKey,
      },
      documents,
    };
  }

  function normalizeDocuments(payload) {
    if (Array.isArray(payload.documents)) {
      return payload.documents.map((document) => ({
        id: safeId(document.id),
        title: String(document.title || document.id || "Document").trim(),
        sourceType: String(document.sourceType || document.source_type || "text").trim() || "text",
        content: String(document.content || document.text || "").trim(),
        expectedVersion: document.expectedVersion,
        metadata: document.metadata && typeof document.metadata === "object" ? document.metadata : {},
      }));
    }

    return (payload.articles || []).map((article) => ({
      id: safeId(article.id),
      title: String(article.title || article.id || "Article").trim(),
      sourceType: "article",
      content: String(article.content || "").trim(),
      metadata: { tags: Array.isArray(article.tags) ? article.tags : [] },
    }));
  }

  async function chunkDocument(document, content) {
    const chunks = [];
    const size = INDEXING_PROFILE.chunkSize;
    const step = size - INDEXING_PROFILE.chunkOverlap;
    for (let start = 0, position = 0; start < content.length; start += step, position += 1) {
      const text = content.slice(start, start + size).trim();
      if (!text) continue;
      chunks.push({
        id: `${document.id}:chunk-${position}`,
        documentId: document.id,
        position,
        text,
        hash: await sha256Hex(text),
        metadata: document.metadata || {},
      });
      if (start + size >= content.length) break;
    }
    return chunks;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  }

  function toArray(tensorLike) {
    if (Array.isArray(tensorLike)) return tensorLike.map(Number);
    if (ArrayBuffer.isView(tensorLike)) return Array.from(tensorLike, Number);
    if (tensorLike?.data) return Array.from(tensorLike.data, Number);
    throw new Error("Unsupported embedding output shape");
  }

  function validateVector(vector) {
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_PROFILE.dimension) {
      throw new Error(`Embedding vector must have ${EMBEDDING_PROFILE.dimension} dimensions`);
    }
    let squared = 0;
    for (const value of vector) {
      if (!Number.isFinite(value)) throw new Error("Embedding vector contains NaN or Infinity");
      squared += value * value;
    }
    const norm = Math.sqrt(squared);
    if (Math.abs(norm - 1) > 0.05) {
      throw new Error(`Embedding vector is not normalized (${norm.toFixed(4)})`);
    }
  }

  async function sha256Hex(value) {
    if (!root.crypto?.subtle || typeof root.TextEncoder !== "function") {
      throw new Error("Browser crypto support is required for hosted ingestion");
    }
    const bytes = new root.TextEncoder().encode(String(value));
    const digest = await root.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function safeId(value) {
    return String(value || "").trim().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 160) || "document";
  }

  root.AskWellHostedEmbeddings = {
    EMBEDDING_PROFILE,
    INDEXING_PROFILE,
    buildIngestPayload,
    embedQuestion,
    embedTexts,
    isAvailable() {
      return Boolean(customEmbedder || root.crypto?.subtle);
    },
    __setEmbedderForTests(embedder) {
      customEmbedder = embedder;
      extractorPromise = undefined;
    },
  };
})(globalThis);
