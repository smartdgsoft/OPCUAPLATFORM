"""
Condition Monitoring template (honest predictive maintenance).

The day-one-useful form of predictive maintenance: needs NO failure history.
For each measurement signal it learns a healthy baseline, then:
  - tracks the degradation trend (is it drifting toward a limit?)
  - estimates time-to-threshold (linear extrapolation of the trend)
  - reports a health score 0..1

Maturity is explicit and honest:
  - cold_start: < a little history -> baseline only, low confidence
  - warming:    enough for a stable baseline + early trend
  - mature:     stable trend estimate; time-to-threshold is meaningful

True RUL (remaining useful life) requires labelled past failures. This template
does NOT claim RUL — it predicts "time until this signal crosses its limit at
the current trend", which is honest and useful without failure labels. When a
customer later has failure history, a 'rul' model swaps in via the same engine.

Permissive OSS only: numpy, pandas.
"""
from __future__ import annotations
from typing import Any, Dict, List
import numpy as np
import pandas as pd

from .base import (ProblemTemplate, ModelState, Output,
                   COLD_START, WARMING, MATURE)


class ConditionMonitoringTemplate(ProblemTemplate):
    key = "condition_monitoring"
    name = "Condition Monitoring (Predictive Maintenance)"
    objective_types = ["detect", "predict"]
    description = ("Learns healthy baselines for equipment signals, tracks "
                   "degradation trend, and predicts time-to-threshold. Works "
                   "from day one with no failure history.")

    # ── model: per-measurement baseline + trend ─────────────────────────────
    def refresh_model(self, config: Dict[str, Any], history: pd.DataFrame,
                      bindings: Dict[str, Any]) -> ModelState:
        wide = self.pivot(history)
        measurements = self.inputs_by_role(config, "measurement")
        model_cfg = config.get("model", {})
        min_samples = int(model_cfg.get("min_samples", 100))
        warming_samples = int(model_cfg.get("warming_samples", 500))
        mature_samples = int(model_cfg.get("mature_samples", 2000))

        params: Dict[str, Any] = {"signals": {}}
        metrics: Dict[str, Any] = {"signals": {}}
        total = 0

        for tid in measurements:
            if tid not in wide.columns:
                continue
            s = wide[tid].dropna().astype(float)
            n = int(s.shape[0])
            if n < min_samples:
                metrics["signals"][tid] = {"trained": False, "n": n}
                continue
            mean = float(s.mean()); std = float(s.std(ddof=1)) if n > 1 else 0.0
            # trend: slope of value vs time (per hour) via least squares
            t = (s.index.astype("int64") // 10**9).to_numpy(dtype=float)  # seconds
            t = (t - t.min()) / 3600.0  # hours from start
            slope, intercept = np.polyfit(t, s.to_numpy(), 1) if n > 2 else (0.0, mean)
            params["signals"][tid] = {
                "mean": mean, "std": std,
                "p05": float(s.quantile(0.05)), "p95": float(s.quantile(0.95)),
                "slope_per_hour": float(slope), "intercept": float(intercept),
                "label": bindings.get(tid, {}).get("label", tid),
                "unit": bindings.get(tid, {}).get("unit") or "",
            }
            metrics["signals"][tid] = {"trained": True, "n": n,
                                       "slope_per_hour": float(slope)}
            total += n

        if not params["signals"]:
            return ModelState(parameters=params, metrics=metrics, sample_count=total,
                              maturity=COLD_START, confidence=0.0)

        # maturity from the smallest signal's sample count (weakest link)
        ns = [m["n"] for m in metrics["signals"].values() if m.get("trained")]
        min_n = min(ns) if ns else 0
        if min_n >= mature_samples:
            maturity, conf = MATURE, 0.9
        elif min_n >= warming_samples:
            maturity, conf = WARMING, 0.6
        else:
            maturity, conf = COLD_START, 0.3
        metrics["signals_trained"] = len(params["signals"])
        metrics["min_samples_seen"] = min_n
        return ModelState(parameters=params, metrics=metrics, sample_count=total,
                          maturity=maturity, confidence=conf)

    # ── evaluate: health + degradation + time-to-threshold ──────────────────
    def evaluate(self, config: Dict[str, Any], model: ModelState,
                 recent: pd.DataFrame, bindings: Dict[str, Any]) -> List[Output]:
        sig_params = model.parameters.get("signals", {})
        if recent.empty or not sig_params:
            return []
        wide = self.pivot(recent)
        objective = config.get("objective", {})
        # per-signal limits: objective.bounds can be {tag_id: {min,max}} or global
        bounds = objective.get("bounds", {})
        out: List[Output] = []

        for tid, p in sig_params.items():
            if tid not in wide.columns:
                continue
            s = wide[tid].dropna().astype(float)
            if s.empty:
                continue
            current = float(s.iloc[-1])
            label = p["label"]; unit = p.get("unit") or ""
            std = p["std"] or 1e-9

            # health score: how far current sits within the healthy band (0..1)
            z = abs(current - p["mean"]) / std
            health = float(max(0.0, 1.0 - z / 6.0))   # z=6 -> health 0

            # limit for time-to-threshold: explicit bound or mean+3std
            lim = None
            b = bounds.get(tid) if isinstance(bounds, dict) else None
            if b and isinstance(b, dict):
                lim = b.get("max")
            if lim is None:
                lim = p["mean"] + 3 * std

            # degradation trend from the learned slope
            slope = p["slope_per_hour"]
            detail_bits = [f"{label} = {current:.3g}{unit}",
                           f"health {health:.0%}"]
            severity = "info"
            ttt_hours = None

            if abs(slope) > 1e-9 and lim is not None:
                # hours until current value reaches the limit at this slope
                gap = lim - current
                if (slope > 0 and gap > 0) or (slope < 0 and gap < 0):
                    ttt_hours = float(gap / slope)
                    if ttt_hours > 0:
                        detail_bits.append(f"~{ttt_hours:.0f}h to limit at current trend")
                        if ttt_hours < 24:
                            severity = "critical"
                        elif ttt_hours < 168:
                            severity = "warning"

            if z >= 5:
                severity = "critical"
            elif z >= 3 and severity == "info":
                severity = "warning"

            # health output (always)
            out.append(Output(
                output_type="health", severity=severity,
                title=f"{label}: health {health:.0%}",
                detail="; ".join(detail_bits),
                value=health, confidence=model.confidence, maturity=model.maturity,
                unit_key=None,
                payload={"current": current, "mean": p["mean"], "std": std, "z": z,
                         "slope_per_hour": slope, "limit": lim,
                         "time_to_threshold_h": ttt_hours, "signal": label},
            ))

            # prediction output when a meaningful time-to-threshold exists
            if ttt_hours is not None and ttt_hours > 0 and severity in ("warning", "critical"):
                days = ttt_hours / 24.0
                out.append(Output(
                    output_type="predict", severity=severity,
                    title=f"{label}: approaching limit",
                    detail=(f"At the current trend, {label} reaches its limit "
                            f"({lim:.3g}{unit}) in ~{days:.1f} days. "
                            f"[{model.maturity}, confidence {model.confidence:.0%}]"),
                    value=float(ttt_hours), confidence=model.confidence,
                    maturity=model.maturity,
                    payload={"time_to_threshold_h": ttt_hours, "limit": lim,
                             "slope_per_hour": slope, "signal": label,
                             "note": "trend extrapolation, not failure-history RUL"},
                ))
        return out
