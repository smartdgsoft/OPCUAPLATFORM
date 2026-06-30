"""
Detector registry — maps pred_models.method to a detector class.

Adding a new method = implement BaseDetector + register here. Nothing else in
the service, API, or schema needs to change. This is the extensibility seam.
"""
from __future__ import annotations
from typing import Dict, Type

from .base import BaseDetector
from .univariate import UnivariateDriftDetector
from .multivariate import MultivariateDetector

_REGISTRY: Dict[str, Type[BaseDetector]] = {
    UnivariateDriftDetector.method: UnivariateDriftDetector,
    MultivariateDetector.method: MultivariateDetector,
}


def get_detector(method: str, config: dict) -> BaseDetector:
    cls = _REGISTRY.get(method)
    if cls is None:
        raise ValueError(f"Unknown detector method '{method}'. "
                         f"Available: {', '.join(_REGISTRY)}")
    return cls(config or {})


def available_methods() -> list[str]:
    return list(_REGISTRY)
