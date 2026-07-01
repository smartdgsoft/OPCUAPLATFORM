"""
Problem Template interface — the abstraction that turns "a general engine" into
"solves many problem classes without new code each time".

A template declares how to fill the five slots (inputs, attribution, model,
objective, action) and implements two methods the engine calls:

  refresh_model(instance, history)  -> ModelState   (learn/refresh)
  evaluate(instance, model, recent) -> [Output]     (produce detect/predict/prescribe)

The engine handles the loop, data loading, persistence, maturity tracking, and
routing prescriptions into the closed-loop approval queue. Templates contain
only the problem-specific logic.

This is the seam that makes the platform extensible to predictive maintenance,
nozzle giveaway, and future problems: add a template, register it, done.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import pandas as pd


# ── maturity: honest state of what the model can do given available data ──────
COLD_START = "cold_start"   # no / insufficient history — low confidence, "learning"
WARMING = "warming"         # accumulating data — confidence rising
MATURE = "mature"           # enough data (incl. labelled events where needed)


@dataclass
class ModelState:
    """Portable learned parameters + provenance for one instance."""
    parameters: Dict[str, Any]
    metrics: Dict[str, Any] = field(default_factory=dict)
    sample_count: int = 0
    maturity: str = COLD_START
    confidence: float = 0.0


@dataclass
class Output:
    """One result from evaluating an instance."""
    output_type: str                 # detect | predict | prescribe | health
    severity: str = "info"           # info | warning | critical
    title: str = ""
    detail: str = ""
    value: Optional[float] = None    # prescribed setpoint | predicted metric | score
    confidence: float = 0.0
    maturity: str = COLD_START
    unit_key: Optional[str] = None   # attributed unit, e.g. "nozzle=3"; None = whole
    payload: Dict[str, Any] = field(default_factory=dict)
    # for prescribe outputs that should become an approvable recommendation:
    actionable: bool = False
    target_tag_id: Optional[str] = None
    target_server_id: Optional[str] = None
    clamps: Optional[Dict[str, float]] = None


class ProblemTemplate(ABC):
    """Base class every problem template implements."""

    #: template key matching problem_instances.template_key
    key: str = "base"
    name: str = "Base Template"
    #: which objective types this template can produce
    objective_types: List[str] = []
    #: human description for the catalog
    description: str = ""

    # ── what the engine needs to know to run the template ──────────────────
    @abstractmethod
    def refresh_model(self, config: Dict[str, Any], history: pd.DataFrame,
                      bindings: Dict[str, Any]) -> ModelState:
        """Learn or refresh the model from history.

        config: the instance's declarative slots. history: tidy frame
        [time, tag_id, value] over the train window. bindings: resolved stream
        metadata (labels, units, roles). Returns a ModelState (may be COLD_START
        with low confidence if data is insufficient — that's honest, not an error).
        """
        raise NotImplementedError

    @abstractmethod
    def evaluate(self, config: Dict[str, Any], model: ModelState,
                 recent: pd.DataFrame, bindings: Dict[str, Any]) -> List[Output]:
        """Evaluate recent data against the model + objective → outputs."""
        raise NotImplementedError

    # ── helpers shared by templates ────────────────────────────────────────
    @staticmethod
    def pivot(history: pd.DataFrame) -> pd.DataFrame:
        if history.empty:
            return pd.DataFrame()
        return history.pivot_table(index="time", columns="tag_id",
                                   values="value", aggfunc="last").sort_index()

    @staticmethod
    def inputs_by_role(config: Dict[str, Any], role: str) -> List[str]:
        """Return tag_ids of inputs with the given role."""
        return [i["tag_id"] for i in config.get("inputs", []) if i.get("role") == role]
