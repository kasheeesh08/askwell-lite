from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from dataclasses import dataclass
from json import JSONDecodeError
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import ValidationError

from app.embeddings.base import EmbeddingProvider
from app.models.schemas import Chunk
from app.retrieval.store import SQLiteVectorStore, embedding_model_id, utc_now


LEGACY_MIGRATION_VERSION = "phase-3.3c.2"


@dataclass(frozen=True)
class StaticEmbeddingProvider(EmbeddingProvider):
    model_name: str
    _dimension: int

    @property
    def dimension(self) -> int:
        return self._dimension

    def embed(self, texts: list[str]) -> np.ndarray:
        raise RuntimeError("Legacy migration does not generate embeddings.")


@dataclass(frozen=True)
class LegacyValidation:
    source_path: Path
    source_sha256: str
    payload: dict[str, Any]
    chunks: list[Chunk]
    vectors: np.ndarray
    document_hashes: dict[str, str]
    report: dict[str, Any]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def validate_legacy_json(
    source_path: Path,
    *,
    embedding_model: str | None = None,
    expected_dimension: int | None = None,
) -> LegacyValidation:
    source_path = source_path.resolve()
    errors: list[str] = []
    warnings: list[str] = []
    source_sha256 = sha256_file(source_path)
    try:
        payload = json.loads(source_path.read_text("utf-8"))
    except JSONDecodeError as error:
        raise RuntimeError(f"Legacy JSON is malformed: {source_path}") from error

    if not isinstance(payload, dict):
        raise RuntimeError("Legacy JSON root must be an object.")

    required = {"chunks", "vectors", "document_hashes", "embedding_dimension"}
    missing = sorted(required - set(payload))
    if missing:
        errors.append(f"Missing required top-level fields: {', '.join(missing)}")

    if "manifest" in payload:
        warnings.append("Source already contains a manifest; use normal migration if possible.")

    raw_chunks = payload.get("chunks", [])
    raw_vectors = payload.get("vectors", [])
    raw_hashes = payload.get("document_hashes", {})
    dimension = payload.get("embedding_dimension")

    if not isinstance(raw_chunks, list):
        errors.append("chunks must be a list")
        raw_chunks = []
    if not isinstance(raw_vectors, list):
        errors.append("vectors must be a list")
        raw_vectors = []
    if not isinstance(raw_hashes, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in raw_hashes.items()
    ):
        errors.append("document_hashes must map strings to strings")
        raw_hashes = {}
    if not isinstance(dimension, int) or dimension <= 0:
        errors.append("embedding_dimension must be a positive integer")
        dimension = expected_dimension or 0
    if expected_dimension is not None and dimension != expected_dimension:
        errors.append(
            f"embedding_dimension {dimension} does not match expected dimension {expected_dimension}",
        )

    chunks: list[Chunk] = []
    seen_chunk_ids: set[str] = set()
    for index, raw_chunk in enumerate(raw_chunks):
        if not isinstance(raw_chunk, dict):
            errors.append(f"chunk[{index}] must be an object")
            continue
        missing_chunk_fields = sorted(
            {"id", "document_id", "document_title", "text", "hash", "metadata"} - set(raw_chunk),
        )
        if missing_chunk_fields:
            errors.append(
                f"chunk[{index}] is missing required fields: {', '.join(missing_chunk_fields)}",
            )
            continue
        try:
            chunk = Chunk(**raw_chunk)
        except (TypeError, ValidationError) as error:
            errors.append(f"chunk[{index}] is invalid: {error}")
            continue
        if not chunk.id.strip() or not chunk.document_id.strip():
            errors.append(f"chunk[{index}] has an empty id or document_id")
        if chunk.id in seen_chunk_ids:
            errors.append(f"duplicate chunk id: {chunk.id}")
        seen_chunk_ids.add(chunk.id)
        if not isinstance(chunk.metadata, dict):
            errors.append(f"chunk[{index}] metadata must be an object")
        if chunk.document_id not in raw_hashes:
            errors.append(f"chunk[{index}] document_id {chunk.document_id!r} has no document hash")
        chunks.append(chunk)

    try:
        vectors = np.asarray(raw_vectors, dtype=np.float32)
    except (TypeError, ValueError) as error:
        raise RuntimeError("Legacy vectors contain non-numeric values.") from error

    if chunks:
        if vectors.ndim != 2:
            errors.append("vectors must be a two-dimensional matrix")
        elif vectors.shape != (len(chunks), dimension):
            errors.append(
                f"vector shape {vectors.shape} does not match expected ({len(chunks)}, {dimension})",
            )
        elif not np.isfinite(vectors).all():
            errors.append("vectors contain NaN or infinite values")
    elif vectors.size != 0:
        errors.append("vectors exist without chunks")

    norm_summary: dict[str, float | None] = {"min": None, "max": None}
    if vectors.ndim == 2 and vectors.size:
        norms = np.linalg.norm(vectors, axis=1)
        norm_summary = {"min": float(norms.min()), "max": float(norms.max())}
        if not np.allclose(norms, 1.0, atol=1e-3):
            errors.append("vectors are not normalized within tolerance 0.001")

    model_verification = "unknown"
    can_import = False
    reembedding_required = True
    if not embedding_model:
        warnings.append(
            "Embedding model identity is unknown; provide --embedding-model only if "
            "operator provenance confirms the legacy file's model.",
        )
    elif errors:
        model_verification = "operator_supplied"
    else:
        model_verification = "operator_supplied"
        can_import = True
        reembedding_required = False

    vector_checksum = (
        hashlib.sha256(vectors.astype(np.float32).tobytes()).hexdigest()
        if vectors.ndim == 2
        else None
    )
    report = {
        "status": "compatible_for_import" if can_import else "requires_reembedding_or_repair",
        "source_file": str(source_path),
        "source_sha256": source_sha256,
        "legacy_format_schema_version": "pre-manifest-json",
        "manifest_present": "manifest" in payload,
        "document_count": len(raw_hashes),
        "chunk_count": len(chunks),
        "embedding_count": int(vectors.shape[0]) if vectors.ndim >= 1 else 0,
        "embedding_dimension": dimension,
        "embedding_model": embedding_model,
        "embedding_model_verification": model_verification,
        "reembedding_required": reembedding_required,
        "normalization": norm_summary,
        "vector_checksum_sha256": vector_checksum,
        "document_ids": sorted(raw_hashes.keys()),
        "chunk_ids": [chunk.id for chunk in chunks],
        "errors": errors,
        "warnings": warnings,
        "can_import": can_import,
        "migration_implementation_version": LEGACY_MIGRATION_VERSION,
        "timestamp": utc_now(),
    }
    return LegacyValidation(
        source_path=source_path,
        source_sha256=source_sha256,
        payload=payload,
        chunks=chunks,
        vectors=vectors,
        document_hashes=dict(raw_hashes),
        report=report,
    )


def write_report(report_path: Path, report: dict[str, Any]) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", "utf-8")


def dry_run_legacy_json(
    source_path: Path,
    destination_path: Path,
    report_path: Path,
    *,
    embedding_model: str | None = None,
    expected_dimension: int | None = None,
) -> dict[str, Any]:
    validation = validate_legacy_json(
        source_path,
        embedding_model=embedding_model,
        expected_dimension=expected_dimension,
    )
    report = {
        **validation.report,
        "destination_database": str(destination_path.resolve()),
        "operation": "dry_run",
        "destination_modified": False,
    }
    write_report(report_path, report)
    return report


def migrate_legacy_json(
    source_path: Path,
    destination_path: Path,
    report_path: Path,
    *,
    embedding_model: str | None = None,
    expected_dimension: int | None = None,
    confirm: bool = False,
) -> dict[str, Any]:
    if not confirm:
        raise RuntimeError("Refusing legacy migration without explicit confirmation.")

    validation = validate_legacy_json(
        source_path,
        embedding_model=embedding_model,
        expected_dimension=expected_dimension,
    )
    report = {
        **validation.report,
        "destination_database": str(destination_path.resolve()),
        "operation": "confirmed_migration",
        "destination_modified": False,
    }
    if not validation.report["can_import"]:
        write_report(report_path, report)
        raise RuntimeError("Legacy JSON is not compatible for import; see compatibility report.")

    provider = StaticEmbeddingProvider(
        model_name=embedding_model or "unknown",
        _dimension=int(validation.report["embedding_dimension"]),
    )
    source_before = sha256_file(validation.source_path)
    destination_path = destination_path.resolve()
    store = SQLiteVectorStore(destination_path, provider)
    with store._connect() as connection:
        if connection.execute("SELECT 1 FROM documents LIMIT 1").fetchone() is not None:
            raise RuntimeError("Destination SQLite database is already populated; refusing import.")

    documents: dict[str, dict[str, Any]] = {}
    for chunk in validation.chunks:
        metadata = dict(chunk.metadata)
        source_type = str(metadata.get("source_type", "legacy"))
        document_metadata = dict(metadata)
        document_metadata.pop("chunk_index", None)
        document_metadata.pop("content_hash", None)
        documents.setdefault(
            chunk.document_id,
            {
                "id": chunk.document_id,
                "title": chunk.document_title,
                "source_type": source_type,
                "content_hash": validation.document_hashes[chunk.document_id],
                "metadata": document_metadata,
            },
        )

    now = utc_now()
    try:
        with store._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            if connection.execute("SELECT 1 FROM documents LIMIT 1").fetchone() is not None:
                raise RuntimeError("Destination SQLite database became populated during migration.")
            provenance = {
                "migration_source_path": str(validation.source_path),
                "migration_source_sha256": validation.source_sha256,
                "migration_timestamp": now,
                "legacy_format_schema_version": "pre-manifest-json",
                "legacy_embedding_model": embedding_model or "unknown",
                "legacy_embedding_model_verification": validation.report["embedding_model_verification"],
                "legacy_embedding_dimension": str(validation.report["embedding_dimension"]),
                "legacy_reembedding_required": str(validation.report["reembedding_required"]).lower(),
                "migration_implementation_version": LEGACY_MIGRATION_VERSION,
            }
            for key, value in provenance.items():
                connection.execute(
                    """
                    INSERT OR REPLACE INTO storage_meta(key, value)
                    VALUES (?, ?)
                    """,
                    (key, value),
                )
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
                        json.dumps(document["metadata"], sort_keys=True, separators=(",", ":")),
                        now,
                        now,
                    ),
                )
            for fallback_position, (chunk, vector) in enumerate(zip(validation.chunks, validation.vectors)):
                position = int(chunk.metadata.get("chunk_index", fallback_position))
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
                        json.dumps(chunk.metadata, sort_keys=True, separators=(",", ":")),
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
                        embedding_model_id(provider),
                        provider.dimension,
                        store._vector_to_blob(vector),
                        float(np.linalg.norm(vector)),
                        now,
                    ),
                )
            connection.commit()
    except Exception:
        try:
            with store._connect() as connection:
                connection.rollback()
        except sqlite3.Error:
            pass
        raise

    if sha256_file(validation.source_path) != source_before:
        raise RuntimeError("Source JSON changed during migration; investigate before using destination.")

    with store._connect() as connection:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_keys = connection.execute("PRAGMA foreign_key_check").fetchall()
        document_count = connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
        chunk_count = connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        embedding_count = connection.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0]

    report.update(
        {
            "status": "success",
            "destination_modified": True,
            "document_count_after": int(document_count),
            "chunk_count_after": int(chunk_count),
            "embedding_count_after": int(embedding_count),
            "sqlite_integrity_check": integrity,
            "sqlite_foreign_key_check": [list(row) for row in foreign_keys],
            "source_sha256_after": source_before,
        },
    )
    write_report(report_path, report)
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Dry-run or explicitly migrate a legacy manifest-less AskWell JSON vector store.",
    )
    parser.add_argument("--source", required=True, type=Path, help="Legacy vectors.json source path.")
    parser.add_argument("--destination", required=True, type=Path, help="Destination SQLite database path.")
    parser.add_argument("--report", required=True, type=Path, help="Compatibility or migration report path.")
    parser.add_argument("--embedding-model", help="Operator-verified embedding model for legacy vectors.")
    parser.add_argument("--expected-dimension", type=int, help="Expected embedding dimension.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Validate and write a report only.")
    mode.add_argument(
        "--confirm-migration",
        action="store_true",
        help="Actually import into the destination SQLite database.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.dry_run:
        report = dry_run_legacy_json(
            args.source,
            args.destination,
            args.report,
            embedding_model=args.embedding_model,
            expected_dimension=args.expected_dimension,
        )
    else:
        report = migrate_legacy_json(
            args.source,
            args.destination,
            args.report,
            embedding_model=args.embedding_model,
            expected_dimension=args.expected_dimension,
            confirm=args.confirm_migration,
        )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
