from __future__ import annotations

import base64
import hashlib
import io
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree

from app.models.schemas import Chunk, DocumentInput, EncodedDocumentInput


class UnsupportedDocumentError(ValueError):
    pass


@dataclass(frozen=True)
class ChunkConfig:
    size: int = 700
    overlap: int = 120


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def content_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def extract_text_from_encoded(document: EncodedDocumentInput) -> DocumentInput:
    try:
      raw = base64.b64decode(document.content_base64, validate=True)
    except Exception as error:
      raise ValueError("Document content is not valid base64") from error

    suffix = Path(document.filename).suffix.lower()
    if suffix in {".txt", ".md", ".markdown"}:
        text = raw.decode("utf-8", errors="replace")
    elif suffix == ".pdf":
        text = extract_pdf_text(raw)
    elif suffix == ".docx":
        text = extract_docx_text(raw)
    else:
        raise UnsupportedDocumentError(f"Unsupported document type: {suffix or 'unknown'}")

    return DocumentInput(
        id=document.id,
        title=document.title,
        content=text,
        source_type=suffix.lstrip(".") or "encoded",
        metadata={**document.metadata, "filename": document.filename},
    )


def extract_pdf_text(raw: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise UnsupportedDocumentError("PDF ingestion requires pypdf") from error

    reader = PdfReader(io.BytesIO(raw))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def extract_docx_text(raw: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            xml = archive.read("word/document.xml")
    except Exception as error:
        raise UnsupportedDocumentError("DOCX ingestion requires a valid .docx file") from error

    root = ElementTree.fromstring(xml)
    namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    return "\n".join(node.text or "" for node in root.findall(".//w:t", namespace))


def chunk_text(document: DocumentInput, config: ChunkConfig) -> list[Chunk]:
    text = normalize_text(document.content)
    if not text:
        return []

    step = max(1, config.size - config.overlap)
    chunks: list[Chunk] = []
    for index, start in enumerate(range(0, len(text), step)):
        part = text[start : start + config.size].strip()
        if not part:
            continue
        chunk_hash = content_hash(part)
        chunks.append(
            Chunk(
                id=f"{document.id}:chunk-{index}",
                document_id=document.id,
                document_title=document.title,
                text=part,
                hash=chunk_hash,
                metadata={
                    **document.metadata,
                    "source_type": document.source_type,
                    "chunk_index": index,
                    "content_hash": content_hash(text),
                },
            ),
        )
        if start + config.size >= len(text):
            break
    return chunks
