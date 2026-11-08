from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import numpy as np
import pytest

from app.embeddings.testing import TokenHashEmbeddingProvider
from app.migration.legacy_json import (
    dry_run_legacy_json,
    migrate_legacy_json,
    validate_legacy_json,
)


class LegacyEmbedding(TokenHashEmbeddingProvider):
    model_name = "test-legacy-model"

    def __init__(self, dimension: int = 64):
        super().__init__(dimension)


def legacy_payload(embeddings: LegacyEmbedding | None = None) -> dict:
    embeddings = embeddings or LegacyEmbedding()
    vector = embeddings.embed(["Legacy Article test Saved through the API."])[0].tolist()
    return {
        "chunks": [
            {
                "id": "legacy-doc:chunk-0",
                "document_id": "legacy-doc",
                "document_title": "Legacy Article",
                "text": "Legacy Article test Saved through the API.",
                "hash": "chunk-hash",
                "metadata": {
                    "article_id": "legacy-doc",
                    "source_type": "article",
                    "chunk_index": 0,
                    "content_hash": "chunk-content-hash",
                    "tags": ["legacy"],
                },
            },
        ],
        "vectors": [vector],
        "document_hashes": {"legacy-doc": "document-content-hash"},
        "embedding_dimension": embeddings.dimension,
    }


def write_payload(tmp_path: Path, payload: dict) -> Path:
    source = tmp_path / "vectors.json"
    source.write_text(json.dumps(payload, indent=2), "utf-8")
    return source


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_valid_manifestless_legacy_json_dry_run_with_operator_model(tmp_path):
    source = write_payload(tmp_path, legacy_payload())
    destination = tmp_path / "vectors.sqlite3"
    report_path = tmp_path / "legacy-report.json"

    report = dry_run_legacy_json(
        source,
        destination,
        report_path,
        embedding_model="test-legacy-model",
        expected_dimension=64,
    )

    assert report["can_import"] is True
    assert report["status"] == "compatible_for_import"
    assert report["embedding_model_verification"] == "operator_supplied"
    assert report["destination_modified"] is False
    assert report_path.exists()
    assert not destination.exists()


def test_unknown_legacy_embedding_model_requires_reembedding(tmp_path):
    source = write_payload(tmp_path, legacy_payload())

    report = validate_legacy_json(source).report

    assert report["can_import"] is False
    assert report["reembedding_required"] is True
    assert report["embedding_model_verification"] == "unknown"
    assert "Embedding model identity is unknown" in report["warnings"][0]


def test_incompatible_legacy_embedding_dimension_is_rejected(tmp_path):
    source = write_payload(tmp_path, legacy_payload())

    report = validate_legacy_json(
        source,
        embedding_model="test-legacy-model",
        expected_dimension=384,
    ).report

    assert report["can_import"] is False
    assert any("does not match expected dimension" in error for error in report["errors"])


def test_legacy_chunk_vector_misalignment_is_rejected(tmp_path):
    payload = legacy_payload()
    payload["vectors"] = []
    source = write_payload(tmp_path, payload)

    report = validate_legacy_json(
        source,
        embedding_model="test-legacy-model",
        expected_dimension=64,
    ).report

    assert report["can_import"] is False
    assert any("two-dimensional" in error for error in report["errors"])


def test_legacy_non_finite_vectors_are_rejected(tmp_path):
    payload = legacy_payload()
    payload["vectors"][0][0] = float("nan")
    source = write_payload(tmp_path, payload)

    report = validate_legacy_json(
        source,
        embedding_model="test-legacy-model",
        expected_dimension=64,
    ).report

    assert report["can_import"] is False
    assert any("NaN or infinite" in error for error in report["errors"])


def test_legacy_duplicate_chunk_identifiers_are_rejected(tmp_path):
    payload = legacy_payload()
    payload["chunks"].append(dict(payload["chunks"][0]))
    payload["vectors"].append(payload["vectors"][0])
    source = write_payload(tmp_path, payload)

    report = validate_legacy_json(
        source,
        embedding_model="test-legacy-model",
        expected_dimension=64,
    ).report

    assert report["can_import"] is False
    assert "duplicate chunk id: legacy-doc:chunk-0" in report["errors"]


def test_legacy_missing_metadata_is_rejected(tmp_path):
    payload = legacy_payload()
    payload["chunks"][0].pop("metadata")
    source = write_payload(tmp_path, payload)

    report = validate_legacy_json(
        source,
        embedding_model="test-legacy-model",
        expected_dimension=64,
    ).report

    assert report["can_import"] is False
    assert any("missing required fields: metadata" in error for error in report["errors"])


def test_confirmed_legacy_migration_requires_confirmation(tmp_path):
    source = write_payload(tmp_path, legacy_payload())

    with pytest.raises(RuntimeError, match="without explicit confirmation"):
        migrate_legacy_json(
            source,
            tmp_path / "vectors.sqlite3",
            tmp_path / "migration-report.json",
            embedding_model="test-legacy-model",
            expected_dimension=64,
            confirm=False,
        )


def test_successful_confirmed_legacy_migration_persists_provenance(tmp_path):
    source = write_payload(tmp_path, legacy_payload())
    source_hash = sha256(source)
    destination = tmp_path / "vectors.sqlite3"
    report_path = tmp_path / "migration-report.json"

    report = migrate_legacy_json(
        source,
        destination,
        report_path,
        embedding_model="test-legacy-model",
        expected_dimension=64,
        confirm=True,
    )

    assert sha256(source) == source_hash
    assert report["status"] == "success"
    assert report["document_count_after"] == 1
    assert report["chunk_count_after"] == 1
    assert report["embedding_count_after"] == 1
    with sqlite3.connect(destination) as connection:
        meta = dict(connection.execute("SELECT key, value FROM storage_meta").fetchall())
        assert meta["migration_source_sha256"] == source_hash
        assert meta["legacy_format_schema_version"] == "pre-manifest-json"
        assert meta["legacy_embedding_model"] == "test-legacy-model"
        assert meta["legacy_embedding_model_verification"] == "operator_supplied"
        assert meta["legacy_reembedding_required"] == "false"
        assert meta["migration_implementation_version"] == "phase-3.3c.2"
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_legacy_migration_refuses_existing_populated_database(tmp_path):
    source = write_payload(tmp_path, legacy_payload())
    destination = tmp_path / "vectors.sqlite3"
    migrate_legacy_json(
        source,
        destination,
        tmp_path / "first-report.json",
        embedding_model="test-legacy-model",
        expected_dimension=64,
        confirm=True,
    )

    with pytest.raises(RuntimeError, match="already populated"):
        migrate_legacy_json(
            source,
            destination,
            tmp_path / "second-report.json",
            embedding_model="test-legacy-model",
            expected_dimension=64,
            confirm=True,
        )


def test_legacy_migration_rolls_back_on_failure(tmp_path, monkeypatch):
    source = write_payload(tmp_path, legacy_payload())
    destination = tmp_path / "vectors.sqlite3"

    def failing_to_blob(self, vector):
        raise RuntimeError("simulated vector write failure")

    monkeypatch.setattr("app.retrieval.store.SQLiteVectorStore._vector_to_blob", failing_to_blob)

    with pytest.raises(RuntimeError, match="simulated vector write failure"):
        migrate_legacy_json(
            source,
            destination,
            tmp_path / "migration-report.json",
            embedding_model="test-legacy-model",
            expected_dimension=64,
            confirm=True,
        )

    with sqlite3.connect(destination) as connection:
        assert connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 0
        assert connection.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0] == 0

