from __future__ import annotations


def recall_at_k(expected: set[str], retrieved: list[str], k: int) -> float:
    if not expected:
        return 0.0
    return len(expected.intersection(retrieved[:k])) / len(expected)


def precision_at_k(expected: set[str], retrieved: list[str], k: int) -> float:
    if k <= 0:
        return 0.0
    return len(expected.intersection(retrieved[:k])) / k


def hit_rate_at_k(expected: set[str], retrieved: list[str], k: int) -> float:
    return 1.0 if expected.intersection(retrieved[:k]) else 0.0


def reciprocal_rank(expected: set[str], retrieved: list[str]) -> float:
    for index, item in enumerate(retrieved, start=1):
        if item in expected:
            return 1.0 / index
    return 0.0
