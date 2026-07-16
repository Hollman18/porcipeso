"""Utilidades comunes de los tests de drivers."""
from __future__ import annotations

import pytest

from porcipeso.core.models import ScaleProfile


@pytest.fixture
def make_profile():
    def _make(parser: str, profile_id: str = "test-scale", **extra) -> ScaleProfile:
        return ScaleProfile(
            id=profile_id,
            name=f"Test {parser}",
            brand="Test",
            parser=parser,
            extra=extra,
        )
    return _make
