"""
Detector interface — the pluggable contract for all predictive methods.

Every detection/prediction method (univariate drift, multivariate, forecast,
RUL, ...) implements BaseDetector. This is what makes the predictive module
extensible "again and again": new methods slot in without touching the
service loop, registry, API, or governance.

A detector is reproducible: train() returns parameters (plain JSON-able dict)
that fully define the model, and score() consumes those same parameters. No
hidden state, no binary blobs — a version is its parameters.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import pandas as pd


@dataclass
class TrainResult:
    """Output of training: the portable parameters + quality metrics."""
    parameters: Dict[str, Any]
    metrics: Dict[str, Any] = field(default_factory=dict)
    sample_count: int = 0
    notes: str = ""


@dataclass
class Detection:
    """A single scored output for one signal/asset at one moment."""
    output_type: str                     # anomaly | prediction | health | recommendation
    severity: str                        # info | warning | critical
    title: str
    detail: str
    score: float                         # method score (e.g. z, mahalanobis, residual)
    confidence: float                    # 0..1
    tag_id: Optional[str] = None
    payload: Dict[str, Any] = field(default_factory=dict)


@dataclass
class DriftResult:
    """Model self-monitoring: has live input drifted from training?"""
    drift_score: float
    drifted: bool
    detail: Dict[str, Any] = field(default_factory=dict)


class BaseDetector(ABC):
    """Common interface for all predictive methods.

    Implementations must be stateless beyond the parameters passed in:
    train(history) -> parameters; score(parameters, live/recent) -> detections.
    """

    #: pluggable key matching pred_models.method
    method: str = "base"

    def __init__(self, config: Dict[str, Any]):
        self.config = config or {}

    @abstractmethod
    def train(self, history: pd.DataFrame, signals: List[Dict[str, Any]]) -> TrainResult:
        """Fit the model from historical data.

        history: tidy frame with columns [time, tag_id, value]. signals: the
        twin signal metadata (tag_id, role, label, unit). Returns portable
        parameters + metrics. Must raise ValueError if data is insufficient.
        """
        raise NotImplementedError

    @abstractmethod
    def score(
        self,
        parameters: Dict[str, Any],
        recent: pd.DataFrame,
        signals: List[Dict[str, Any]],
    ) -> List[Detection]:
        """Score recent data against trained parameters → detections.

        recent: tidy frame [time, tag_id, value] of the latest window.
        Returns zero or more Detection objects (empty = all nominal).
        """
        raise NotImplementedError

    def check_drift(
        self,
        parameters: Dict[str, Any],
        recent: pd.DataFrame,
        signals: List[Dict[str, Any]],
    ) -> Optional[DriftResult]:
        """Optional: detect whether live input distribution has drifted from
        the training distribution. Default: not implemented (returns None)."""
        return None

    # ── helpers shared by detectors ────────────────────────────────────────
    @staticmethod
    def pivot(history: pd.DataFrame) -> pd.DataFrame:
        """Long [time,tag_id,value] -> wide [time index, one col per tag]."""
        if history.empty:
            return pd.DataFrame()
        wide = history.pivot_table(index="time", columns="tag_id",
                                   values="value", aggfunc="last")
        return wide.sort_index()
