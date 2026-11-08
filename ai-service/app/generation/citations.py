from __future__ import annotations

from app.generation.base import ProviderResponseError
from app.models.schemas import Citation, RetrievedChunk


def validate_citations(citation_ids: list[str], chunks: list[RetrievedChunk]) -> list[Citation]:
    by_id = {chunk.chunk_id: chunk for chunk in chunks}
    citations: list[Citation] = []
    seen: set[str] = set()

    for chunk_id in citation_ids:
        if chunk_id not in by_id:
            raise ProviderResponseError(f"Provider returned fabricated citation: {chunk_id}")
        if chunk_id in seen:
            continue
        seen.add(chunk_id)
        chunk = by_id[chunk_id]
        citations.append(
            Citation(
                document_id=chunk.document_id,
                chunk_id=chunk.chunk_id,
                title=chunk.document_title,
            ),
        )

    if not citations:
        raise ProviderResponseError("Provider response did not include valid citations")

    return citations
