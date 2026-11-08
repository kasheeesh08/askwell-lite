from __future__ import annotations

import time

from app.generation.base import AnswerGenerator, GenerationResult
from app.models.schemas import Citation, RetrievedChunk


class ExtractiveAnswerGenerator(AnswerGenerator):
    mode = "extractive"

    def generate(self, question: str, chunks: list[RetrievedChunk]) -> GenerationResult:
        started = time.perf_counter()
        used = chunks[:3]
        answer = " ".join(chunk.text for chunk in used).strip()
        citations = [
            Citation(
                document_id=chunk.document_id,
                chunk_id=chunk.chunk_id,
                title=chunk.document_title,
            )
            for chunk in used
        ]
        return GenerationResult(
            answer=answer,
            citations=citations,
            provider="extractive",
            model="retrieved-chunks",
            latency_ms=(time.perf_counter() - started) * 1000,
        )
