"""
Problem template registry — maps template_key to a template class.

Adding a new problem class = implement ProblemTemplate + register here.
Nothing else in the engine, schema, or API changes. This is the seam that makes
the platform "not limited to one problem".
"""
from __future__ import annotations
from typing import Dict, List, Type

from .base import ProblemTemplate
from .condition_monitoring import ConditionMonitoringTemplate
from .source_attributed_setpoint import SourceAttributedSetpointTemplate

_REGISTRY: Dict[str, Type[ProblemTemplate]] = {
    ConditionMonitoringTemplate.key: ConditionMonitoringTemplate,
    SourceAttributedSetpointTemplate.key: SourceAttributedSetpointTemplate,
}


def get_template(key: str) -> ProblemTemplate:
    cls = _REGISTRY.get(key)
    if cls is None:
        raise ValueError(f"Unknown template '{key}'. Available: {', '.join(_REGISTRY)}")
    return cls()


def available_templates() -> List[dict]:
    return [{"key": c.key, "name": c.name, "objective_types": c.objective_types,
             "description": c.description} for c in _REGISTRY.values()]
