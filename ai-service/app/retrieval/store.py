from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from datetime import UTC, datetime
from json import JSONDecodeError
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from pydantic import ValidationError

from app.embeddings.base import EmbeddingProvider
from app.ingestion.processing import ChunkConfig, chunk_text, content_hash, extract_text_from_encoded
from app.models.schemas import Chunk, DocumentInfo, IngestRequest, StorageDiagnostics


STORAGE_SCHEMA_VERSION = 1
LEGACY_COMPATIBILITY_ENV = "ASKWELL_ALLOW_LEGACY_VECTOR_STORAGE"


class VectorStore(Protocol):
    def snapshot(self) -> tuple[list[Chunk], np.ndarray]:
        ...

    def chunk_count(self) -> int:
        ...

    def ingest(self, request: IngestRequest, chunk_config: ChunkConfig) -> tuple[int, int, int, int]:
        ...

    def list_documents(self) -> list[DocumentInfo]:
        ...

    def delete_document(self, document_id: str) -> tuple[bool, int]:
        ...

    def diagnostics(self) -> StorageDiagnostics:
        ...


def embedding_model_id(embeddings: EmbeddingProvider) -> str:
    return str(getattr(embeddings, "model_name", embeddings.__class__.__name__))


def documents_from_request(request: IngestRequest) -> list[dict[str, Any]]:
    return [
        *[
            {
                "id": article.id,
                "title": article.title,
                "content": f"{article.title}\n{' '.join(article.tags)}\n{article.content}",
                "source_type": "article",
                "metadata": {"tags": article.tags, "article_id": article.id},
            }
            for article in request.articles
        ],
        *[document.model_dump() for document in request.documents],
        *[
            extract_text_from_encoded(document).model_dump()
            for document in request.encoded_documents
        ],
    ]


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def safe_diagnostic_error(error: Exception) -> str:
    message = str(error).replace("\\", "/")
    if " at " in message:
        message = message.split(" at ", 1)[0]
    return message[:240] or error.__class__.__name__


def failed_document_statuses(request: IngestRequest, error: Exception) -> list[dict[str, Any]]:
    message = safe_diagnostic_error(error)
    return [
        {
            "id": document["id"],
            "title": document["title"],
            "status": "failed",
            "chunks_indexed": 0,
            "last_failed_at": utc_now(),
            "error": message,
            "retryable": True,
        }
        for document in documents_from_request(request)
    ]


class JsonVectorStore:
    def __init__(self, path: Path, embeddings: EmbeddingProvider):
        self.path = path
        self.embeddings = embeddings
        self._lock = threading.RLock()
        self._revision = 0
        self.chunks: list[Chunk] = []
        self.vectors = np.zeros((0, embeddings.dimension), dtype=np.float32)
        self.document_hashes: dict[str, str] = {}
        self.manifest: dict[str, Any] = self._new_manifest(None)
        self.last_document_statuses: list[dict[str, Any]] = []
        self.load()

    def _embedding_model_id(self) -> str:
        return embedding_model_id(self.embeddings)

    def _new_manifest(self, chunk_config: ChunkConfig | None) -> dict[str, Any]:
        now = utc_now()
        return {
            "storage_schema_version": STORAGE_SCHEMA_VERSION,
            "embedding": {
                "provider": self.embeddings.__class__.__name__,
                "model": self._embedding_model_id(),
                "dimension": self.embeddings.dimension,
                "normalized": True,
            },
            "chunking": self._chunk_config_payload(chunk_config),
            "created_at": now,
            "updated_at": now,
        }

    @staticmethod
    def _chunk_config_payload(chunk_config: ChunkConfig | None) -> dict[str, int] | None:
        if chunk_config is None:
            return None
        return {"size": chunk_config.size, "overlap": chunk_config.overlap}

    def _storage_error(self, message: str) -> RuntimeError:
        return RuntimeError(
            f"{message} at {self.path}. Stop the service, preserve the file for inspection, "
            "and rebuild the index from source documents or restore a known-good backup.",
        )

    def load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text("utf-8"))
        except JSONDecodeError as error:
            raise self._storage_error("Vector storage is corrupted") from error

        chunks, vectors, document_hashes, manifest = self._validate_payload(payload)
        with self._lock:
            self.chunks = chunks
            self.vectors = vectors
            self.document_hashes = document_hashes
            self.manifest = manifest
            self._revision += 1

    def snapshot(self) -> tuple[list[Chunk], np.ndarray]:
        with self._lock:
            return list(self.chunks), self.vectors.copy()

    def chunk_count(self) -> int:
        with self._lock:
            return len(self.chunks)

    def persist(self, chunk_config: ChunkConfig | None = None) -> None:
        with self._lock:
            self._persist_locked(chunk_config)

    def _persist_locked(self, chunk_config: ChunkConfig | None = None) -> None:
        self._validate_state(self.chunks, self.vectors)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        now = utc_now()
        created_at = self.manifest.get("created_at") or now
        manifest = self._new_manifest(chunk_config)
        manifest["created_at"] = created_at
        manifest["updated_at"] = now
        payload = {
            "manifest": manifest,
            "chunks": [chunk.model_dump() for chunk in self.chunks],
            "vectors": self.vectors.tolist(),
            "document_hashes": self.document_hashes,
            "embedding_dimension": self.embeddings.dimension,
        }
        try:
            with temp_path.open("w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            self._replace_atomically(temp_path)
            self._fsync_parent_directory()
            self.manifest = manifest
        except Exception:
            try:
                temp_path.unlink(missing_ok=True)
            finally:
                raise

    def _replace_atomically(self, temp_path: Path) -> None:
        attempts = 4 if os.name == "nt" else 1
        for attempt in range(attempts):
            try:
                os.replace(temp_path, self.path)
                return
            except PermissionError:
                if attempt == attempts - 1:
                    raise
                time.sleep(0.05 * (attempt + 1))

    def _fsync_parent_directory(self) -> None:
        if os.name == "nt" or not hasattr(os, "O_DIRECTORY"):
            return
        directory_fd = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def ingest(self, request: IngestRequest, chunk_config: ChunkConfig) -> tuple[int, int, int, int]:
        documents = documents_from_request(request)

        while True:
            with self._lock:
                self._ensure_chunk_config_compatible(chunk_config)
                base_revision = self._revision
                base_chunks = list(self.chunks)
                base_vectors = self.vectors.copy()
                base_hashes = dict(self.document_hashes)

            plan = self._plan_ingest(documents, base_chunks, base_vectors, base_hashes, chunk_config)
            new_vectors = (
                self._embed_new_chunks(plan["new_chunks"])
                if plan["new_chunks"]
                else np.zeros((0, self.embeddings.dimension), dtype=np.float32)
            )
            final_chunks, final_vectors = self._build_final_state(
                plan["kept_pairs"],
                plan["new_chunks"],
                new_vectors,
            )

            with self._lock:
                if self._revision != base_revision:
                    continue
                previous_chunks = self.chunks
                previous_vectors = self.vectors
                previous_hashes = self.document_hashes
                previous_manifest = self.manifest
                try:
                    self.chunks = final_chunks
                    self.vectors = final_vectors
                    self.document_hashes = plan["document_hashes"]
                    self.last_document_statuses = plan["document_statuses"]
                    self._persist_locked(chunk_config)
                    self._revision += 1
                except Exception:
                    self.chunks = previous_chunks
                    self.vectors = previous_vectors
                    self.document_hashes = previous_hashes
                    self.manifest = previous_manifest
                    raise
                return (
                    len(documents),
                    len(plan["new_chunks"]),
                    plan["duplicates"],
                    plan["unchanged"],
                )

    def list_documents(self) -> list[DocumentInfo]:
        with self._lock:
            counts: dict[str, int] = {}
            titles: dict[str, str] = {}
            metadata_by_document: dict[str, dict[str, Any]] = {}
            source_types: dict[str, str] = {}
            for chunk in self.chunks:
                counts[chunk.document_id] = counts.get(chunk.document_id, 0) + 1
                titles.setdefault(chunk.document_id, chunk.document_title)
                metadata = dict(chunk.metadata)
                source_types.setdefault(chunk.document_id, str(metadata.get("source_type", "legacy")))
                metadata.pop("chunk_index", None)
                metadata.pop("content_hash", None)
                metadata_by_document.setdefault(chunk.document_id, metadata)

            return [
                DocumentInfo(
                    id=document_id,
                    title=titles.get(document_id, document_id),
                    source_type=source_types.get(document_id, "legacy"),
                    content_hash=document_hash,
                    chunk_count=counts.get(document_id, 0),
                    updated_at=self.manifest.get("updated_at"),
                    metadata=metadata_by_document.get(document_id, {}),
                )
                for document_id, document_hash in sorted(self.document_hashes.items())
            ]

    def delete_document(self, document_id: str) -> tuple[bool, int]:
        with self._lock:
            matching_indexes = [
                index for index, chunk in enumerate(self.chunks) if chunk.document_id == document_id
            ]
            if document_id not in self.document_hashes and not matching_indexes:
                return False, 0
            deleted = len(matching_indexes)
            keep_pairs = [
                (chunk, vector)
                for chunk, vector in zip(self.chunks, self.vectors)
                if chunk.document_id != document_id
            ]
            self.chunks = [chunk for chunk, _vector in keep_pairs]
            self.vectors = (
                np.asarray([vector for _chunk, vector in keep_pairs], dtype=np.float32)
                if keep_pairs
                else np.zeros((0, self.embeddings.dimension), dtype=np.float32)
            )
            self.document_hashes.pop(document_id, None)
            self._persist_locked()
            self._revision += 1
            return True, deleted

    def diagnostics(self) -> StorageDiagnostics:
        with self._lock:
            last_error = None
            readable = True
            writable = True
            dimension_consistent = True
            manifest_compatible = True
            try:
                self._validate_state(self.chunks, self.vectors)
                self._ensure_manifest_compatible()
            except Exception as error:
                readable = False
                manifest_compatible = False
                last_error = safe_diagnostic_error(error)
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                probe = self.path.with_name(f".{self.path.name}.diagnostic-{uuid.uuid4().hex}.tmp")
                probe.write_text("ok", encoding="utf-8")
                probe.unlink(missing_ok=True)
            except Exception as error:
                writable = False
                last_error = last_error or safe_diagnostic_error(error)
            dimension_consistent = self.vectors.shape[1] == self.embeddings.dimension if self.vectors.ndim == 2 else False
            if not dimension_consistent:
                last_error = last_error or "Vector dimension mismatch"
            documents = [
                {
                    **document.model_dump(),
                    "status": "Indexed" if document.chunk_count > 0 else "Not indexed",
                    "indexed": document.chunk_count > 0,
                    "retryable": False,
                }
                for document in self.list_documents()
            ]
            documents_by_id = {document["id"]: document for document in documents}
            for status in self.last_document_statuses:
                if status.get("status") == "failed" and status.get("id") in documents_by_id:
                    documents_by_id[status.get("id")].update(
                        {
                            "status": "Needs attention",
                            "retryable": bool(status.get("retryable")),
                            "last_failed_at": status.get("last_failed_at"),
                            "last_error": status.get("error"),
                        },
                    )
                elif status.get("status") == "failed":
                    documents.append(
                        {
                            "id": status.get("id", ""),
                            "title": status.get("title", status.get("id", "")),
                            "source_type": "unknown",
                            "content_hash": "",
                            "chunk_count": 0,
                            "created_at": None,
                            "updated_at": None,
                            "metadata": {},
                            "status": "Failed",
                            "indexed": False,
                            "retryable": bool(status.get("retryable")),
                            "last_failed_at": status.get("last_failed_at"),
                            "last_error": status.get("error"),
                        },
                    )
            status = "healthy" if readable and writable and dimension_consistent and manifest_compatible else "needs_attention"
            return StorageDiagnostics(
                backend="json",
                status=status,
                readable=readable,
                writable=writable,
                integrity_check="unavailable",
                document_count=len(self.document_hashes),
                chunk_count=len(self.chunks),
                embedding_count=int(self.vectors.shape[0]) if self.vectors.ndim == 2 else 0,
                vector_dimension=self.embeddings.dimension,
                dimension_consistent=dimension_consistent,
                manifest_compatible=manifest_compatible,
                last_error=last_error,
                documents=documents,
                unsupported_checks=["sqlite_integrity_check"],
            )

    def _plan_ingest(
        self,
        documents: list[dict[str, Any]],
        base_chunks: list[Chunk],
        base_vectors: np.ndarray,
        base_hashes: dict[str, str],
        chunk_config: ChunkConfig,
    ) -> dict[str, Any]:
        self._validate_state(base_chunks, base_vectors)
        kept_pairs = [
            (chunk, np.asarray(vector, dtype=np.float32))
            for chunk, vector in zip(base_chunks, base_vectors)
        ]
        new_chunks: list[Chunk] = []
        document_hashes = dict(base_hashes)
        duplicates = 0
        unchanged = 0
        document_statuses: list[dict[str, Any]] = []

        for document_data in documents:
            document_hash = content_hash(document_data["content"])
            if document_hashes.get(document_data["id"]) == document_hash:
                unchanged += 1
                document_statuses.append(
                    {
                        "id": document_data["id"],
                        "status": "unchanged",
                        "chunks_indexed": 0,
                    },
                )
                continue

            previous_exists = document_data["id"] in document_hashes or any(
                chunk.document_id == document_data["id"] for chunk, _vector in kept_pairs
            )
            kept_pairs = [
                (chunk, vector)
                for chunk, vector in kept_pairs
                if chunk.document_id != document_data["id"]
            ]
            new_chunks = [
                chunk for chunk in new_chunks if chunk.document_id != document_data["id"]
            ]
            existing_hashes = {chunk.hash for chunk, _vector in kept_pairs} | {
                chunk.hash for chunk in new_chunks
            }

            document_chunks = chunk_text(type("Document", (), document_data)(), chunk_config)
            document_hashes[document_data["id"]] = document_hash
            indexed_for_document = 0
            for chunk in document_chunks:
                if chunk.hash in existing_hashes:
                    duplicates += 1
                    continue
                existing_hashes.add(chunk.hash)
                new_chunks.append(chunk)
                indexed_for_document += 1
            document_statuses.append(
                {
                    "id": document_data["id"],
                    "status": "updated" if previous_exists else "created",
                    "chunks_indexed": indexed_for_document,
                },
            )

        return {
            "kept_pairs": kept_pairs,
            "new_chunks": new_chunks,
            "document_hashes": document_hashes,
            "duplicates": duplicates,
            "unchanged": unchanged,
            "document_statuses": document_statuses,
        }

    def _embed_new_chunks(self, chunks: list[Chunk]) -> np.ndarray:
        vectors = np.asarray(self.embeddings.embed([chunk.text for chunk in chunks]), dtype=np.float32)
        self._validate_vectors(vectors, len(chunks), "embedding provider output")
        return vectors

    def _build_final_state(
        self,
        kept_pairs: list[tuple[Chunk, np.ndarray]],
        new_chunks: list[Chunk],
        new_vectors: np.ndarray,
    ) -> tuple[list[Chunk], np.ndarray]:
        kept_chunks = [chunk for chunk, _vector in kept_pairs]
        kept_vectors = (
            np.asarray([vector for _chunk, vector in kept_pairs], dtype=np.float32)
            if kept_pairs
            else np.zeros((0, self.embeddings.dimension), dtype=np.float32)
        )
        if kept_vectors.size == 0:
            kept_vectors = np.zeros((0, self.embeddings.dimension), dtype=np.float32)

        chunks = [*kept_chunks, *new_chunks]
        if new_vectors.size == 0:
            vectors = kept_vectors
        elif kept_vectors.size == 0:
            vectors = new_vectors
        else:
            vectors = np.vstack([kept_vectors, new_vectors]).astype(np.float32)
        self._validate_state(chunks, vectors)
        return chunks, vectors

    def _validate_payload(
        self,
        payload: Any,
    ) -> tuple[list[Chunk], np.ndarray, dict[str, str], dict[str, Any]]:
        if not isinstance(payload, dict):
            raise self._storage_error("Vector storage payload must be a JSON object")

        required = {"chunks", "vectors", "document_hashes", "embedding_dimension"}
        missing = sorted(required - set(payload))
        if missing:
            raise self._storage_error(f"Vector storage is missing required fields: {', '.join(missing)}")

        dimension = payload["embedding_dimension"]
        if not isinstance(dimension, int) or dimension <= 0:
            raise self._storage_error("Vector storage has an invalid embedding_dimension")
        if dimension != self.embeddings.dimension:
            raise self._storage_error(
                f"Vector storage embedding dimension {dimension} does not match "
                f"configured dimension {self.embeddings.dimension}",
            )

        manifest = self._validate_manifest(payload.get("manifest"), has_chunks=bool(payload["chunks"]))
        chunks = self._parse_chunks(payload["chunks"])
        vectors = self._parse_vectors(payload["vectors"], len(chunks), dimension)
        document_hashes = self._parse_document_hashes(payload["document_hashes"])
        return chunks, vectors, document_hashes, manifest

    def _validate_manifest(self, manifest: Any, has_chunks: bool) -> dict[str, Any]:
        if manifest is None:
            if has_chunks and os.getenv(LEGACY_COMPATIBILITY_ENV) != "1":
                raise self._storage_error(
                    "Vector storage was created without a manifest, so embedding model "
                    f"compatibility cannot be verified. Set {LEGACY_COMPATIBILITY_ENV}=1 only "
                    "after confirming this file was built with the current embedding model, "
                    "or rebuild the index",
                )
            legacy_manifest = self._new_manifest(None)
            legacy_manifest["legacy_without_manifest"] = True
            return legacy_manifest

        if not isinstance(manifest, dict):
            raise self._storage_error("Vector storage manifest must be an object")
        if manifest.get("storage_schema_version") != STORAGE_SCHEMA_VERSION:
            raise self._storage_error("Vector storage schema version is unsupported")

        embedding = manifest.get("embedding")
        if not isinstance(embedding, dict):
            raise self._storage_error("Vector storage manifest is missing embedding metadata")
        if embedding.get("dimension") != self.embeddings.dimension:
            raise self._storage_error("Vector storage manifest dimension is incompatible")
        if embedding.get("model") != self._embedding_model_id():
            raise self._storage_error(
                f"Vector storage manifest model {embedding.get('model')!r} does not match "
                f"configured model {self._embedding_model_id()!r}",
            )
        if embedding.get("normalized") is not True:
            raise self._storage_error("Vector storage manifest normalization setting is unsupported")
        return dict(manifest)

    def _ensure_manifest_compatible(self) -> None:
        self._validate_manifest(self.manifest, has_chunks=bool(self.chunks))

    def _parse_chunks(self, raw_chunks: Any) -> list[Chunk]:
        if not isinstance(raw_chunks, list):
            raise self._storage_error("Vector storage chunks must be a list")
        try:
            return [Chunk(**chunk) for chunk in raw_chunks]
        except (TypeError, ValidationError) as error:
            raise self._storage_error("Vector storage contains invalid chunk records") from error

    def _parse_vectors(self, raw_vectors: Any, expected_rows: int, dimension: int) -> np.ndarray:
        if not isinstance(raw_vectors, list):
            raise self._storage_error("Vector storage vectors must be a list")
        try:
            vectors = np.asarray(raw_vectors, dtype=np.float32)
        except (TypeError, ValueError) as error:
            raise self._storage_error("Vector storage contains non-numeric vectors") from error
        if expected_rows == 0:
            if raw_vectors != []:
                raise self._storage_error("Vector storage has vectors without chunks")
            return np.zeros((0, self.embeddings.dimension), dtype=np.float32)
        self._validate_vectors(vectors, expected_rows, "stored vectors", dimension)
        return vectors

    def _parse_document_hashes(self, raw_hashes: Any) -> dict[str, str]:
        if not isinstance(raw_hashes, dict):
            raise self._storage_error("Vector storage document_hashes must be an object")
        if not all(isinstance(key, str) and isinstance(value, str) for key, value in raw_hashes.items()):
            raise self._storage_error("Vector storage document_hashes must map strings to strings")
        return dict(raw_hashes)

    def _validate_vectors(
        self,
        vectors: np.ndarray,
        expected_rows: int,
        label: str,
        dimension: int | None = None,
    ) -> None:
        dimension = dimension or self.embeddings.dimension
        if vectors.ndim != 2:
            raise self._storage_error(f"{label} must be a two-dimensional matrix")
        if vectors.shape != (expected_rows, dimension):
            raise self._storage_error(
                f"{label} shape {vectors.shape} does not match expected "
                f"({expected_rows}, {dimension})",
            )
        if not np.isfinite(vectors).all():
            raise self._storage_error(f"{label} contain NaN or infinite values")

    def _validate_state(self, chunks: list[Chunk], vectors: np.ndarray) -> None:
        self._validate_vectors(vectors, len(chunks), "in-memory vectors")

    def _ensure_chunk_config_compatible(self, chunk_config: ChunkConfig) -> None:
        existing = self.manifest.get("chunking")
        requested = self._chunk_config_payload(chunk_config)
        if self.chunks and existing and existing != requested:
            raise self._storage_error(
                f"Vector storage chunking configuration {existing} does not match "
                f"requested configuration {requested}",
            )


class SQLiteVectorStore:
    def __init__(self, path: Path, embeddings: EmbeddingProvider):
        self.path = path
        self.embeddings = embeddings
        self._lock = threading.RLock()
        self._revision = 0
        self.last_document_statuses: list[dict[str, Any]] = []
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def _initialize(self) -> None:
        with self._lock, self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS storage_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    deleted_at TEXT
                );

                CREATE TABLE IF NOT EXISTS chunks (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL,
                    position INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    hash TEXT NOT NULL,
                    metadata_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
                    UNIQUE(document_id, position)
                );

                CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
                CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);

                CREATE TABLE IF NOT EXISTS embeddings (
                    chunk_id TEXT NOT NULL,
                    model_name TEXT NOT NULL,
                    dimension INTEGER NOT NULL,
                    vector_blob BLOB NOT NULL,
                    vector_norm REAL NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (chunk_id, model_name),
                    FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model_name);

                CREATE TABLE IF NOT EXISTS ingestion_runs (
                    id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    error_message TEXT
                );
                """
            )
            self._set_meta(connection, "storage_schema_version", str(STORAGE_SCHEMA_VERSION))
            self._set_meta(connection, "embedding_provider", self.embeddings.__class__.__name__)
            self._set_meta(connection, "embedding_model", embedding_model_id(self.embeddings))
            self._set_meta(connection, "embedding_dimension", str(self.embeddings.dimension))
            self._set_meta(connection, "embedding_normalized", "true")
            self._validate_meta(connection)

    def _set_meta(self, connection: sqlite3.Connection, key: str, value: str) -> None:
        connection.execute(
            """
            INSERT INTO storage_meta(key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO NOTHING
            """,
            (key, value),
        )

    def _validate_meta(self, connection: sqlite3.Connection) -> None:
        meta = {
            row["key"]: row["value"]
            for row in connection.execute("SELECT key, value FROM storage_meta")
        }
        expected = {
            "storage_schema_version": str(STORAGE_SCHEMA_VERSION),
            "embedding_model": embedding_model_id(self.embeddings),
            "embedding_dimension": str(self.embeddings.dimension),
            "embedding_normalized": "true",
        }
        for key, value in expected.items():
            if meta.get(key) != value:
                raise RuntimeError(
                    f"SQLite vector storage metadata mismatch for {key}: "
                    f"stored {meta.get(key)!r}, expected {value!r}. Rebuild or migrate "
                    "the index with the configured embedding model.",
                )

    def snapshot(self) -> tuple[list[Chunk], np.ndarray]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    chunks.id,
                    chunks.document_id,
                    documents.title AS document_title,
                    chunks.text,
                    chunks.hash,
                    chunks.metadata_json,
                    embeddings.vector_blob
                FROM chunks
                JOIN documents ON documents.id = chunks.document_id
                JOIN embeddings ON embeddings.chunk_id = chunks.id
                    AND embeddings.model_name = ?
                WHERE documents.deleted_at IS NULL
                ORDER BY chunks.rowid
                """,
                (embedding_model_id(self.embeddings),),
            ).fetchall()

        chunks: list[Chunk] = []
        vectors: list[np.ndarray] = []
        for row in rows:
            metadata = self._decode_metadata(row["metadata_json"])
            chunks.append(
                Chunk(
                    id=row["id"],
                    document_id=row["document_id"],
                    document_title=row["document_title"],
                    text=row["text"],
                    hash=row["hash"],
                    metadata=metadata,
                ),
            )
            vectors.append(self._blob_to_vector(row["vector_blob"]))
        matrix = (
            np.asarray(vectors, dtype=np.float32)
            if vectors
            else np.zeros((0, self.embeddings.dimension), dtype=np.float32)
        )
        self._validate_vectors(matrix, len(chunks), "SQLite snapshot vectors")
        return chunks, matrix

    def chunk_count(self) -> int:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM chunks
                JOIN documents ON documents.id = chunks.document_id
                WHERE documents.deleted_at IS NULL
                """,
            ).fetchone()
        return int(row["count"])

    def list_documents(self) -> list[DocumentInfo]:
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    documents.id,
                    documents.title,
                    documents.source_type,
                    documents.content_hash,
                    documents.metadata_json,
                    documents.created_at,
                    documents.updated_at,
                    COUNT(chunks.id) AS chunk_count
                FROM documents
                LEFT JOIN chunks ON chunks.document_id = documents.id
                WHERE documents.deleted_at IS NULL
                GROUP BY documents.id
                ORDER BY documents.updated_at DESC, documents.id ASC
                """,
            ).fetchall()
        return [
            DocumentInfo(
                id=row["id"],
                title=row["title"],
                source_type=row["source_type"],
                content_hash=row["content_hash"],
                chunk_count=int(row["chunk_count"]),
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                metadata=self._decode_metadata(row["metadata_json"]),
            )
            for row in rows
        ]

    def delete_document(self, document_id: str) -> tuple[bool, int]:
        with self._lock, self._connect() as connection:
            try:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute(
                    "SELECT COUNT(*) AS count FROM chunks WHERE document_id = ?",
                    (document_id,),
                ).fetchone()
                document = connection.execute(
                    "SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL",
                    (document_id,),
                ).fetchone()
                if document is None:
                    connection.rollback()
                    return False, 0
                chunks_deleted = int(row["count"])
                connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))
                connection.commit()
                self._revision += 1
                return True, chunks_deleted
            except Exception:
                connection.rollback()
                raise

    def diagnostics(self) -> StorageDiagnostics:
        readable = True
        writable = True
        manifest_compatible = True
        dimension_consistent = True
        integrity_check = "unavailable"
        last_error = None
        document_count = 0
        chunk_count = 0
        embedding_count = 0
        documents: list[dict[str, Any]] = []
        try:
            with self._lock, self._connect() as connection:
                integrity_row = connection.execute("PRAGMA integrity_check").fetchone()
                integrity_check = str(integrity_row[0]) if integrity_row else "unavailable"
                try:
                    self._validate_meta(connection)
                except Exception as error:
                    manifest_compatible = False
                    last_error = safe_diagnostic_error(error)
                document_count = int(
                    connection.execute(
                        "SELECT COUNT(*) AS count FROM documents WHERE deleted_at IS NULL",
                    ).fetchone()["count"],
                )
                chunk_count = int(
                    connection.execute(
                        """
                        SELECT COUNT(*) AS count
                        FROM chunks
                        JOIN documents ON documents.id = chunks.document_id
                        WHERE documents.deleted_at IS NULL
                        """,
                    ).fetchone()["count"],
                )
                embedding_count = int(
                    connection.execute(
                        """
                        SELECT COUNT(*) AS count
                        FROM embeddings
                        JOIN chunks ON chunks.id = embeddings.chunk_id
                        JOIN documents ON documents.id = chunks.document_id
                        WHERE documents.deleted_at IS NULL
                            AND embeddings.model_name = ?
                        """,
                        (embedding_model_id(self.embeddings),),
                    ).fetchone()["count"],
                )
                inconsistent = int(
                    connection.execute(
                        """
                        SELECT COUNT(*) AS count
                        FROM embeddings
                        WHERE dimension != ? OR length(vector_blob) != ?
                        """,
                        (self.embeddings.dimension, self.embeddings.dimension * 4),
                    ).fetchone()["count"],
                )
                dimension_consistent = inconsistent == 0 and chunk_count == embedding_count
                documents = [
                    {
                        **document.model_dump(),
                        "status": "Indexed" if document.chunk_count > 0 else "Not indexed",
                        "indexed": document.chunk_count > 0,
                        "retryable": False,
                    }
                    for document in self.list_documents()
                ]
        except Exception as error:
            readable = False
            last_error = last_error or safe_diagnostic_error(error)

        try:
            with self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                connection.rollback()
        except Exception as error:
            writable = False
            last_error = last_error or safe_diagnostic_error(error)

        documents_by_id = {document["id"]: document for document in documents}
        for status in self.last_document_statuses:
            if status.get("status") == "failed" and status.get("id") in documents_by_id:
                documents_by_id[status.get("id")].update(
                    {
                        "status": "Needs attention",
                        "retryable": bool(status.get("retryable")),
                        "last_failed_at": status.get("last_failed_at"),
                        "last_error": status.get("error"),
                    },
                )
            elif status.get("status") == "failed":
                documents.append(
                    {
                        "id": status.get("id", ""),
                        "title": status.get("title", status.get("id", "")),
                        "source_type": "unknown",
                        "content_hash": "",
                        "chunk_count": 0,
                        "created_at": None,
                        "updated_at": None,
                        "metadata": {},
                        "status": "Failed",
                        "indexed": False,
                        "retryable": bool(status.get("retryable")),
                        "last_failed_at": status.get("last_failed_at"),
                        "last_error": status.get("error"),
                    },
                )

        if not dimension_consistent and last_error is None:
            last_error = "Chunk/vector count or dimension mismatch"
        status = (
            "healthy"
            if readable and writable and manifest_compatible and dimension_consistent and integrity_check == "ok"
            else "needs_attention"
        )
        return StorageDiagnostics(
            backend="sqlite",
            status=status,
            readable=readable,
            writable=writable,
            integrity_check=integrity_check,
            document_count=document_count,
            chunk_count=chunk_count,
            embedding_count=embedding_count,
            vector_dimension=self.embeddings.dimension,
            dimension_consistent=dimension_consistent,
            manifest_compatible=manifest_compatible,
            last_error=last_error,
            documents=documents,
            unsupported_checks=[],
        )

    def ingest(self, request: IngestRequest, chunk_config: ChunkConfig) -> tuple[int, int, int, int]:
        documents = documents_from_request(request)
        while True:
            with self._lock:
                with self._connect() as connection:
                    self._validate_meta(connection)
                    self._ensure_chunk_config_compatible(connection, chunk_config)
                    base_revision = self._revision
                    base_hashes = self._document_hashes(connection)

            plan = self._plan_ingest(documents, base_hashes, chunk_config)
            new_vectors = (
                self._embed_new_chunks(plan["chunks_by_document"])
                if plan["new_chunk_count"]
                else {}
            )

            with self._lock:
                if self._revision != base_revision:
                    continue
                with self._connect() as connection:
                    self._validate_meta(connection)
                    if self._document_hashes(connection) != base_hashes:
                        continue
                    self._commit_ingest(connection, plan, new_vectors, chunk_config)
                    self.last_document_statuses = plan["document_statuses"]
                    self._revision += 1
                    return (
                        len(documents),
                        plan["new_chunk_count"],
                        plan["duplicates"],
                        plan["unchanged"],
                    )

    def _plan_ingest(
        self,
        documents: list[dict[str, Any]],
        base_hashes: dict[str, str],
        chunk_config: ChunkConfig,
    ) -> dict[str, Any]:
        changed_documents: list[dict[str, Any]] = []
        chunks_by_document: dict[str, list[Chunk]] = {}
        duplicates = 0
        unchanged = 0
        document_statuses: list[dict[str, Any]] = []
        for document_data in documents:
            document_hash = content_hash(document_data["content"])
            if base_hashes.get(document_data["id"]) == document_hash:
                unchanged += 1
                document_statuses.append(
                    {
                        "id": document_data["id"],
                        "status": "unchanged",
                        "chunks_indexed": 0,
                    },
                )
                continue

            document_chunks = chunk_text(type("Document", (), document_data)(), chunk_config)
            unique_chunks: list[Chunk] = []
            seen_hashes: set[str] = set()
            for chunk in document_chunks:
                if chunk.hash in seen_hashes:
                    duplicates += 1
                    continue
                seen_hashes.add(chunk.hash)
                unique_chunks.append(chunk)
            changed_documents.append({**document_data, "content_hash": document_hash})
            chunks_by_document[document_data["id"]] = unique_chunks
            document_statuses.append(
                {
                    "id": document_data["id"],
                    "status": "updated" if document_data["id"] in base_hashes else "created",
                    "chunks_indexed": len(unique_chunks),
                },
            )

        return {
            "changed_documents": changed_documents,
            "chunks_by_document": chunks_by_document,
            "new_chunk_count": sum(len(chunks) for chunks in chunks_by_document.values()),
            "duplicates": duplicates,
            "unchanged": unchanged,
            "document_statuses": document_statuses,
        }

    def _embed_new_chunks(self, chunks_by_document: dict[str, list[Chunk]]) -> dict[str, np.ndarray]:
        vectors_by_document: dict[str, np.ndarray] = {}
        for document_id, chunks in chunks_by_document.items():
            if not chunks:
                vectors_by_document[document_id] = np.zeros((0, self.embeddings.dimension), dtype=np.float32)
                continue
            vectors = np.asarray(self.embeddings.embed([chunk.text for chunk in chunks]), dtype=np.float32)
            self._validate_vectors(vectors, len(chunks), "SQLite embedding provider output")
            vectors_by_document[document_id] = vectors
        return vectors_by_document

    def _commit_ingest(
        self,
        connection: sqlite3.Connection,
        plan: dict[str, Any],
        vectors_by_document: dict[str, np.ndarray],
        chunk_config: ChunkConfig,
    ) -> None:
        run_id = uuid.uuid4().hex
        started_at = utc_now()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT INTO ingestion_runs(id, status, started_at) VALUES (?, ?, ?)",
                (run_id, "running", started_at),
            )
            self._set_meta(connection, "chunk_size", str(chunk_config.size))
            self._set_meta(connection, "chunk_overlap", str(chunk_config.overlap))
            for document_data in plan["changed_documents"]:
                self._replace_document(
                    connection,
                    document_data,
                    plan["chunks_by_document"][document_data["id"]],
                    vectors_by_document.get(
                        document_data["id"],
                        np.zeros((0, self.embeddings.dimension), dtype=np.float32),
                    ),
                )
            connection.execute(
                """
                UPDATE ingestion_runs
                SET status = ?, finished_at = ?
                WHERE id = ?
                """,
                ("success", utc_now(), run_id),
            )
            connection.commit()
        except Exception as error:
            connection.rollback()
            self._record_failed_run(run_id, started_at, str(error))
            raise

    def _replace_document(
        self,
        connection: sqlite3.Connection,
        document_data: dict[str, Any],
        chunks: list[Chunk],
        vectors: np.ndarray,
    ) -> None:
        self._validate_vectors(vectors, len(chunks), "SQLite document vectors")
        now = utc_now()
        existing = connection.execute(
            "SELECT created_at FROM documents WHERE id = ?",
            (document_data["id"],),
        ).fetchone()
        created_at = existing["created_at"] if existing else now
        connection.execute("DELETE FROM documents WHERE id = ?", (document_data["id"],))
        connection.execute(
            """
            INSERT INTO documents(
                id, title, source_type, content_hash, metadata_json,
                created_at, updated_at, deleted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                document_data["id"],
                document_data["title"],
                document_data.get("source_type", "text"),
                document_data["content_hash"],
                self._encode_metadata(document_data.get("metadata", {})),
                created_at,
                now,
            ),
        )
        for position, (chunk, vector) in enumerate(zip(chunks, vectors)):
            connection.execute(
                """
                INSERT INTO chunks(id, document_id, position, text, hash, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    chunk.id,
                    chunk.document_id,
                    position,
                    chunk.text,
                    chunk.hash,
                    self._encode_metadata(chunk.metadata),
                    now,
                ),
            )
            norm = float(np.linalg.norm(vector))
            connection.execute(
                """
                INSERT INTO embeddings(
                    chunk_id, model_name, dimension, vector_blob, vector_norm, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    chunk.id,
                    embedding_model_id(self.embeddings),
                    self.embeddings.dimension,
                    self._vector_to_blob(vector),
                    norm,
                    now,
                ),
            )

    def _record_failed_run(self, run_id: str, started_at: str, error_message: str) -> None:
        try:
            with self._connect() as connection:
                connection.execute(
                    """
                    INSERT OR REPLACE INTO ingestion_runs(
                        id, status, started_at, finished_at, error_message
                    )
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (run_id, "failed", started_at, utc_now(), error_message[:1000]),
                )
        except sqlite3.Error:
            pass

    def _document_hashes(self, connection: sqlite3.Connection) -> dict[str, str]:
        return {
            row["id"]: row["content_hash"]
            for row in connection.execute(
                "SELECT id, content_hash FROM documents WHERE deleted_at IS NULL",
            )
        }

    def _ensure_chunk_config_compatible(
        self,
        connection: sqlite3.Connection,
        chunk_config: ChunkConfig,
    ) -> None:
        meta = {
            row["key"]: row["value"]
            for row in connection.execute("SELECT key, value FROM storage_meta")
        }
        has_chunks = connection.execute("SELECT 1 FROM chunks LIMIT 1").fetchone() is not None
        if not has_chunks:
            return
        expected = {"chunk_size": str(chunk_config.size), "chunk_overlap": str(chunk_config.overlap)}
        for key, value in expected.items():
            if meta.get(key) != value:
                raise RuntimeError(
                    f"SQLite vector storage chunking metadata mismatch for {key}: "
                    f"stored {meta.get(key)!r}, expected {value!r}. Rebuild the index "
                    "with the requested chunking configuration.",
                )

    def _validate_vectors(self, vectors: np.ndarray, expected_rows: int, label: str) -> None:
        if vectors.ndim != 2:
            raise RuntimeError(f"{label} must be a two-dimensional matrix")
        if vectors.shape != (expected_rows, self.embeddings.dimension):
            raise RuntimeError(
                f"{label} shape {vectors.shape} does not match expected "
                f"({expected_rows}, {self.embeddings.dimension})",
            )
        if not np.isfinite(vectors).all():
            raise RuntimeError(f"{label} contain NaN or infinite values")

    def _vector_to_blob(self, vector: np.ndarray) -> bytes:
        vector = np.asarray(vector, dtype=np.float32)
        self._validate_vectors(vector.reshape(1, -1), 1, "SQLite vector")
        return vector.tobytes()

    def _blob_to_vector(self, blob: bytes) -> np.ndarray:
        vector = np.frombuffer(blob, dtype=np.float32).copy()
        if vector.shape != (self.embeddings.dimension,):
            raise RuntimeError(
                f"SQLite stored vector dimension {vector.shape[0]} does not match "
                f"configured dimension {self.embeddings.dimension}",
            )
        if not np.isfinite(vector).all():
            raise RuntimeError("SQLite stored vector contains NaN or infinite values")
        return vector

    def _encode_metadata(self, metadata: Any) -> str:
        if not isinstance(metadata, dict):
            raise RuntimeError("SQLite metadata must be an object")
        return json.dumps(metadata, sort_keys=True, separators=(",", ":"))

    def _decode_metadata(self, metadata_json: str) -> dict[str, Any]:
        try:
            metadata = json.loads(metadata_json)
        except JSONDecodeError as error:
            raise RuntimeError("SQLite metadata JSON is corrupted") from error
        if not isinstance(metadata, dict):
            raise RuntimeError("SQLite metadata must decode to an object")
        return metadata

    def migrate_from_json(
        self,
        json_store: JsonVectorStore,
        source_path: Path,
        report_path: Path,
        chunk_config: ChunkConfig | None = None,
    ) -> dict[str, Any]:
        with self._lock, self._connect() as connection:
            if connection.execute("SELECT 1 FROM documents LIMIT 1").fetchone() is not None:
                raise RuntimeError("SQLite vector database is already populated; refusing JSON import.")

        chunks, vectors = json_store.snapshot()
        json_store._validate_state(chunks, vectors)
        documents: dict[str, dict[str, Any]] = {}
        for chunk in chunks:
            metadata = dict(chunk.metadata)
            source_type = str(metadata.get("source_type", "legacy"))
            metadata.pop("chunk_index", None)
            metadata.pop("content_hash", None)
            documents.setdefault(
                chunk.document_id,
                {
                    "id": chunk.document_id,
                    "title": chunk.document_title,
                    "source_type": source_type,
                    "content_hash": json_store.document_hashes.get(chunk.document_id, chunk.hash),
                    "metadata": metadata,
                },
            )

        now = utc_now()
        report = {
            "source_file": str(source_path),
            "destination_database": str(self.path),
            "document_count": len(documents),
            "chunk_count": len(chunks),
            "embedding_count": int(vectors.shape[0]),
            "skipped_records": 0,
            "validation_warnings": [],
            "status": "success",
            "timestamp": now,
        }
        try:
            with self._lock, self._connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                self._validate_meta(connection)
                if connection.execute("SELECT 1 FROM documents LIMIT 1").fetchone() is not None:
                    raise RuntimeError("SQLite vector database became populated during migration.")
                if chunk_config is not None:
                    self._set_meta(connection, "chunk_size", str(chunk_config.size))
                    self._set_meta(connection, "chunk_overlap", str(chunk_config.overlap))
                for document in documents.values():
                    connection.execute(
                        """
                        INSERT INTO documents(
                            id, title, source_type, content_hash, metadata_json,
                            created_at, updated_at, deleted_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                        """,
                        (
                            document["id"],
                            document["title"],
                            document["source_type"],
                            document["content_hash"],
                            self._encode_metadata(document["metadata"]),
                            now,
                            now,
                        ),
                    )
                for position, (chunk, vector) in enumerate(zip(chunks, vectors)):
                    connection.execute(
                        """
                        INSERT INTO chunks(id, document_id, position, text, hash, metadata_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            chunk.id,
                            chunk.document_id,
                            int(chunk.metadata.get("chunk_index", position)),
                            chunk.text,
                            chunk.hash,
                            self._encode_metadata(chunk.metadata),
                            now,
                        ),
                    )
                    connection.execute(
                        """
                        INSERT INTO embeddings(
                            chunk_id, model_name, dimension, vector_blob, vector_norm, created_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            chunk.id,
                            embedding_model_id(self.embeddings),
                            self.embeddings.dimension,
                            self._vector_to_blob(vector),
                            float(np.linalg.norm(vector)),
                            now,
                        ),
                    )
                connection.commit()
                self._revision += 1
        except Exception:
            try:
                connection.rollback()
            except Exception:
                pass
            raise

        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n", "utf-8")
        return report


def build_vector_store(settings: Any, embeddings: EmbeddingProvider) -> VectorStore:
    backend = settings.vector_storage_backend.lower()
    json_path = settings.data_dir / "vectors.json"
    sqlite_path = settings.sqlite_vector_path or (settings.data_dir / "askwell-vectors.sqlite3")
    if backend == "json":
        return JsonVectorStore(json_path, embeddings)
    if backend not in {"auto", "sqlite"}:
        raise RuntimeError(
            "ASKWELL_VECTOR_STORAGE_BACKEND must be one of: auto, sqlite, json.",
        )

    sqlite_exists = sqlite_path.exists()
    store = SQLiteVectorStore(sqlite_path, embeddings)
    if sqlite_exists:
        return store
    if json_path.exists():
        json_store = JsonVectorStore(json_path, embeddings)
        store.migrate_from_json(
            json_store,
            source_path=json_path,
            report_path=settings.data_dir / "sqlite-migration-report.json",
        )
    return store
