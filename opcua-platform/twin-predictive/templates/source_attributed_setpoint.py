"""
Source-Attributed Setpoint template (the nozzle-giveaway shape).

Generalizes: a measured output is attributed to one of N units (nozzles, lanes,
heads, spindles, cavities); each unit is monitored against a target; when a unit
drifts off-target, the model PRESCRIBES the setting change to bring it back,
using a learned (or calibrated/datasheet) gain. Advisory — routed to approval.

Attribution: the connector already splits the measurement per-unit via its
key_column (e.g. weight:nozzle=1..4), so each unit is its own stream/tag. This
template consumes those per-unit streams directly — attribution falls out of
ingestion, exactly as designed.

The gain (output-per-unit-of-setting) makes "the model suggests the value" real:
  recommended_setting = current_setting + (target - measured) / gain
Honest about gain source + confidence + maturity; always clamps.

Permissive OSS only: numpy, pandas.
"""
from __future__ import annotations
from typing import Any, Dict, List
import numpy as np
import pandas as pd

from .base import (ProblemTemplate, ModelState, Output,
                   COLD_START, WARMING, MATURE)


class SourceAttributedSetpointTemplate(ProblemTemplate):
    key = "source_attributed_setpoint"
    name = "Source-Attributed Setpoint (Giveaway / Multi-Unit)"
    objective_types = ["detect", "prescribe"]
    description = ("Monitors a measured output per unit (nozzle/lane/head), "
                   "detects which unit drifts off target, and prescribes the "
                   "setting change to correct it using a learned gain. Advisory.")

    # ── model: per-unit baseline + gain ─────────────────────────────────────
    def refresh_model(self, config: Dict[str, Any], history: pd.DataFrame,
                      bindings: Dict[str, Any]) -> ModelState:
        wide = self.pivot(history)
        measurements = self.inputs_by_role(config, "measurement")  # per-unit weight streams
        settings = self.inputs_by_role(config, "setting")          # per-unit setting streams (optional)
        model_cfg = config.get("model", {})
        min_samples = int(model_cfg.get("min_samples", 50))

        params: Dict[str, Any] = {"units": {}}
        metrics: Dict[str, Any] = {"units": {}}
        total = 0

        # pair each measurement unit with its setting unit if provided (by index)
        setting_map = dict(zip(measurements, settings)) if settings else {}

        for tid in measurements:
            if tid not in wide.columns:
                continue
            m = wide[tid].dropna().astype(float)
            n = int(m.shape[0])
            if n < min_samples:
                metrics["units"][tid] = {"trained": False, "n": n}
                continue

            unit_entry = {
                "mean": float(m.mean()), "std": float(m.std(ddof=1)) if n > 1 else 0.0,
                "label": bindings.get(tid, {}).get("label", tid),
                "unit": bindings.get(tid, {}).get("unit") or "",
                "gain": None, "gain_source": None,
            }

            # learn gain from history if a paired setting stream exists and varies
            stid = setting_map.get(tid)
            if stid and stid in wide.columns:
                joined = pd.concat([m.rename("y"), wide[stid].rename("x")], axis=1).dropna()
                if joined.shape[0] >= min_samples and joined["x"].std() > 1e-9:
                    # slope of measurement vs setting = gain (output per unit setting)
                    slope, _ = np.polyfit(joined["x"].to_numpy(), joined["y"].to_numpy(), 1)
                    if abs(slope) > 1e-9:
                        unit_entry["gain"] = float(slope)
                        unit_entry["gain_source"] = "learned"

            # fall back to configured/datasheet gain
            if unit_entry["gain"] is None:
                action = config.get("action", {})
                dg = action.get("datasheet_gain")
                if dg:
                    unit_entry["gain"] = float(dg)
                    unit_entry["gain_source"] = "datasheet"

            params["units"][tid] = unit_entry
            metrics["units"][tid] = {"trained": True, "n": n,
                                     "gain": unit_entry["gain"],
                                     "gain_source": unit_entry["gain_source"]}
            total += n

        if not params["units"]:
            return ModelState(parameters=params, metrics=metrics, sample_count=total,
                              maturity=COLD_START, confidence=0.0)

        # maturity: need a learned gain on every unit to be "mature"
        gains = [u["gain"] for u in params["units"].values()]
        learned = [u for u in params["units"].values() if u["gain_source"] == "learned"]
        if all(g is not None for g in gains) and len(learned) == len(gains):
            maturity, conf = MATURE, 0.85
        elif any(g is not None for g in gains):
            maturity, conf = WARMING, 0.55
        else:
            maturity, conf = COLD_START, 0.25
        metrics["units_trained"] = len(params["units"])
        return ModelState(parameters=params, metrics=metrics, sample_count=total,
                          maturity=maturity, confidence=conf)

    # ── evaluate: detect off-target unit + prescribe setting change ──────────
    def evaluate(self, config: Dict[str, Any], model: ModelState,
                 recent: pd.DataFrame, bindings: Dict[str, Any]) -> List[Output]:
        import structlog
        _log = structlog.get_logger("template.setpoint")
        units = model.parameters.get("units", {})
        if recent.empty or not units:
            _log.info("setpoint_eval_skip", reason="empty_recent_or_units",
                      recent_rows=int(recent.shape[0]), units=len(units))
            return []
        wide = self.pivot(recent)
        objective = config.get("objective", {})
        target = objective.get("target")          # SKU target weight
        bounds = objective.get("bounds", {})       # {min, max} spec limits
        action = config.get("action", {})
        settings = self.inputs_by_role(config, "setting")
        measurements = self.inputs_by_role(config, "measurement")
        setting_map = dict(zip(measurements, settings)) if settings else {}
        deadband = float(objective.get("deadband", 0.0))
        _log.info("setpoint_eval_start", target=target, unit_tids=list(units.keys()),
                  wide_cols=[str(c) for c in wide.columns], deadband=deadband)
        out: List[Output] = []

        for tid, p in units.items():
            if tid not in wide.columns or target is None:
                _log.info("setpoint_unit_skip", tid=tid, in_cols=(tid in wide.columns),
                          target_is_none=(target is None))
                continue
            m = wide[tid].dropna().astype(float)
            if m.empty:
                _log.info("setpoint_unit_skip", tid=tid, reason="no_recent_values")
                continue
            measured = float(m.tail(min(len(m), 20)).mean())  # smoothed recent measurement
            label = p["label"]; unit = p.get("unit") or ""
            error = target - measured

            # within deadband / spec -> nothing to do
            lo = bounds.get("min") if isinstance(bounds, dict) else None
            hi = bounds.get("max") if isinstance(bounds, dict) else None
            if abs(error) <= deadband:
                _log.info("setpoint_unit_ok_ontarget", tid=tid, measured=measured,
                          target=target, error=error, deadband=deadband)
                continue
            _log.info("setpoint_unit_offtarget", tid=tid, measured=measured, error=error)

            direction = "under" if error > 0 else "over"
            sev = "warning"
            if (lo is not None and measured < lo) or (hi is not None and measured > hi):
                sev = "critical"

            # detect output (always when off-target)
            out.append(Output(
                output_type="detect", severity=sev,
                title=f"{label}: {direction}-filling",
                detail=f"{label} averaging {measured:.3g}{unit} vs target {target:.3g}{unit} "
                       f"(error {error:+.3g}{unit})",
                value=measured, confidence=model.confidence, maturity=model.maturity,
                unit_key=bindings.get(tid, {}).get("stream_key", tid),
                payload={"measured": measured, "target": target, "error": error,
                         "direction": direction, "label": label},
            ))

            # prescribe output when we have a gain and a writable setting target
            gain = p.get("gain")
            stid = setting_map.get(tid)
            target_tag = action.get("target_tag_map", {}).get(tid) or stid
            target_server = action.get("target_server_id")
            if gain and abs(gain) > 1e-9 and target_tag:
                current_setting = None
                if stid and stid in wide.columns:
                    sv = wide[stid].dropna().astype(float)
                    if not sv.empty:
                        current_setting = float(sv.iloc[-1])
                if current_setting is None:
                    current_setting = float(action.get("assumed_setting", 0.0))

                delta = error / gain
                # clamp the step
                max_step = action.get("max_step")
                if max_step is not None and abs(delta) > max_step:
                    delta = max_step if delta > 0 else -max_step
                recommended = current_setting + delta

                # clamp to safe setting bounds
                smin = action.get("setting_min"); smax = action.get("setting_max")
                clamped = False
                if smin is not None and recommended < smin:
                    recommended, clamped = smin, True
                if smax is not None and recommended > smax:
                    recommended, clamped = smax, True

                out.append(Output(
                    output_type="prescribe", severity=sev,
                    title=f"{label}: adjust setting",
                    detail=(f"Set {label} control to {recommended:.4g} "
                            f"(from {current_setting:.4g}) to correct {error:+.3g}{unit}. "
                            f"gain={gain:.4g} [{p['gain_source']}], "
                            f"{model.maturity}, confidence {model.confidence:.0%}"
                            f"{' — safety-clamped' if clamped else ''}"),
                    value=float(recommended), confidence=model.confidence,
                    maturity=model.maturity,
                    unit_key=bindings.get(tid, {}).get("stream_key", tid),
                    actionable=True, target_tag_id=target_tag,
                    target_server_id=target_server,
                    clamps={"min": smin, "max": smax} if (smin is not None or smax is not None) else None,
                    payload={"measured": measured, "target": target, "error": error,
                             "current_setting": current_setting, "delta": delta,
                             "gain": gain, "gain_source": p["gain_source"],
                             "clamped": clamped, "label": label},
                ))
        return out
