import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOSTED_LIMITS,
  SUPPORTED_EMBEDDING_PROFILE,
  SUPPORTED_INDEXING_PROFILE_WITH_KEY,
  sha256,
} from "../src/hosted/storage-contract.mjs";
import { HostedSQLiteAdapter } from "../src/hosted/sqlite-adapter.mjs";

const sizes = [100, 1000, 5000];
const workspace = { workspaceId: "default" };

function vector(index) {
  const values = Array.from({ length: SUPPORTED_EMBEDDING_PROFILE.dimension }, () => 0);
  values[index % values.length] = 0.8;
  values[(index + 1) % values.length] = 0.6;
  return values;
}

function payload(chunkCount) {
  const chunks = Array.from({ length: chunkCount }, (_, index) => {
    const text = `Synthetic hosted storage benchmark chunk ${index}. It validates local libSQL-compatible persistence and retrieval snapshot decoding.`;
    return {
      id: `bench-${chunkCount}:chunk-${index}`,
      position: index,
      text,
      hash: sha256(text),
      metadata: { index },
    };
  });
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
    documents: [
      {
        id: `bench-${chunkCount}`,
        title: `Benchmark ${chunkCount}`,
        sourceType: "synthetic",
        contentHash: sha256(chunks.map((chunk) => chunk.hash).join(":")),
        metadata: { synthetic: true },
        chunks,
        vectors: chunks.map((_, index) => vector(index)),
      },
    ],
  };
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

async function run() {
  const output = [];
  for (const chunkCount of sizes) {
    const directory = await mkdtemp(join(tmpdir(), `askwell-hosted-bench-${chunkCount}-`));
    const databasePath = join(directory, "hosted.sqlite3");
    const adapter = new HostedSQLiteAdapter({
      path: databasePath,
      limits: {
        ...HOSTED_LIMITS,
        maxPayloadBytes: 200 * 1024 * 1024,
        maxChunksPerDocument: chunkCount,
        maxVectorsPerIngest: chunkCount,
      },
    });
    try {
      const request = payload(chunkCount);
      const ingestStarted = process.hrtime.bigint();
      adapter.ingest(request, workspace);
      const ingestMs = elapsedMs(ingestStarted);

      const snapshotStarted = process.hrtime.bigint();
      const snapshot = adapter.getRetrievalSnapshot("default");
      const snapshotMs = elapsedMs(snapshotStarted);

      const decodeStarted = process.hrtime.bigint();
      let checksum = 0;
      for (const embedding of snapshot.embeddings) {
        checksum += embedding.vector[0] || 0;
      }
      const vectorDecodeMs = elapsedMs(decodeStarted);

      const diagnostics = adapter.diagnostics("default");
      output.push({
        chunkCount,
        ingestMs: Number(ingestMs.toFixed(2)),
        retrievalSnapshotMs: Number(snapshotMs.toFixed(2)),
        vectorIterationMs: Number(vectorDecodeMs.toFixed(2)),
        databaseBytes: diagnostics.databaseBytes,
        checksum: Number(checksum.toFixed(6)),
      });
    } finally {
      adapter.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), results: output }, null, 2));
}

await run();
