import random

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.services.fractional import key_between, sequence


@pytest.mark.parametrize(
    ("low", "high", "expected"),
    [
        (None, None, "a0"),
        (None, "a0", "Zz"),
        ("a0", None, "a1"),
        ("a1", None, "a2"),
        ("a0", "a1", "a0V"),
        ("a1", "a2", "a1V"),
        ("a0V", "a1", "a0l"),
        ("Zz", "a0", "ZzV"),
        ("Zz", "a1", "a0"),
        (None, "Y00", "Xzzz"),
        ("bzz", None, "c000"),
        ("a0", "a0V", "a0G"),
        ("a0", "a0G", "a08"),
        ("b125", "b129", "b127"),
        ("a0", "a1V", "a1"),
        ("Zz", "a01", "a0"),
        (None, "a0V", "a0"),
        (None, "b999", "b99"),
    ],
)
def test_matches_reference_implementation(low: str | None, high: str | None, expected: str) -> None:
    assert key_between(low, high) == expected


def test_rejects_inverted_bounds() -> None:
    with pytest.raises(ValueError):
        key_between("a1", "a0")


def test_sequence_is_strictly_increasing() -> None:
    keys = sequence(500)
    assert keys == sorted(keys) and len(set(keys)) == 500


def test_repeated_insertions_stay_ordered() -> None:
    rng = random.Random(7)
    keys = [key_between(None, None)]
    for _ in range(2000):
        index = rng.randint(0, len(keys))
        low = keys[index - 1] if index > 0 else None
        high = keys[index] if index < len(keys) else None
        keys.insert(index, key_between(low, high))
    assert keys == sorted(keys)
    assert max(len(key) for key in keys) < 128


@given(st.lists(st.integers(min_value=0, max_value=10_000), max_size=60))
def test_arbitrary_insert_positions(moves: list[int]) -> None:
    keys = [key_between(None, None)]
    for move in moves:
        index = move % (len(keys) + 1)
        low = keys[index - 1] if index > 0 else None
        high = keys[index] if index < len(keys) else None
        key = key_between(low, high)
        assert (low is None or low < key) and (high is None or key < high)
        keys.insert(index, key)
