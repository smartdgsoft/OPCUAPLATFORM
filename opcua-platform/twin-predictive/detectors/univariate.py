"""
Univariate drift / anomaly detector.

Per-signal statistical anomaly detection that needs NO labelled failures —
works from day one. For each signal it learns a robust baseline (median, MAD,
mean, std, quantiles) from history, then scores live values by:
  - robust z-score (|value - median| / (1.4826 * MAD))
  - EWMA drift of the recent window vs. the trained mean

Severity escalates with the score; confidence reflects how much training data
backed the baseline and how stable it was.

Permissive OSS only: numpy, pandas.
"""
from __future__ import annotations
from typing import Any, Dict, List
import numpy as np
import pandas as pd

from .base import BaseDetector, TrainResult, Detection, DriftResult


class UnivariateDriftDetector(BaseDetector):
    method = "univariate_drift"

    # ── config with sane defaults ──────────────────────────────────────────
    @property
    def z_warn(self) -> float:
        return float(self.config.get("z_warn", 3.0))

    @property
    def z_critical(self) -> float:
        return float(self.config.get("z_critical", 5.0))

    @property
    def ewma_alpha(self) -> float:
        return float(self.config.get("ewma_alpha", 0.3))

    @property
    def min_samples(self) -> int:
        return int(self.config.get("min_samples", 200))

    # ── training ───────────────────────────────────────────────────────────
    def train(self, history: pd.DataFrame, signals: List[Dict[str, Any]]) -> TrainResult:
        wide = self.pivot(history)
        if wide.empty:
            raise ValueError("No history to train on")

        params: Dict[str, Any] = {"signals": {}}
        metrics: Dict[str, Any] = {"signals": {}}
        total = 0

        for sig in signals:
            tid = sig["tag_id"]
            if tid not in wide.columns:
                continue
            series = wide[tid].dropna().astype(float)
            n = int(series.shape[0])
            if n < self.min_samples:
                metrics["signals"][tid] = {"trained": False, "reason": "insufficient_samples", "n": n}
                continue

            median = float(series.median())
            mad = float((series - median).abs().median())
            # MAD can be zero for flat signals; fall back to std to stay usable.
            std = float(series.std(ddof=1)) if n > 1 else 0.0
            robust_sigma = 1.4826 * mad if mad > 0 else (std if std > 0 else 1e-9)

            params["signals"][tid] = {
                "median": median,
                "mad": mad,
                "mean": float(series.mean()),
                "std": std,
                "robust_sigma": robust_sigma,
                "q01": float(series.quantile(0.01)),
                "q99": float(series.quantile(0.99)),
                "label": sig.get("label"),
                "unit": sig.get("unit"),
            }
            metrics["signals"][tid] = {"trained": True, "n": n,
                                       "median": median, "robust_sigma": robust_sigma}
            total += n

        if not params["signals"]:
            raise ValueError("No signal had enough data to train")

        metrics["signals_trained"] = len(params["signals"])
        return TrainResult(parameters=params, metrics=metrics, sample_count=total,
                           notes=f"univariate baseline for {len(params['signals'])} signal(s)")

    # ── scoring ────────────────────────────────────────────────────────────
    def score(self, parameters: Dict[str, Any], recent: pd.DataFrame,
              signals: List[Dict[str, Any]]) -> List[Detection]:
        sig_params = parameters.get("signals", {})
        if recent.empty or not sig_params:
            return []
        wide = self.pivot(recent)
        out: List[Detection] = []

        for sig in signals:
            tid = sig["tag_id"]
            p = sig_params.get(tid)
            if not p or tid not in wide.columns:
                continue
            series = wide[tid].dropna().astype(float)
            if series.empty:
                continue

            latest = float(series.iloc[-1])
            sigma = p["robust_sigma"] or 1e-9
            z = abs(latest - p["median"]) / sigma

            # EWMA of the recent window to catch slow drift the instantaneous
            # z-score might miss.
            ewma = float(series.ewm(alpha=self.ewma_alpha).mean().iloc[-1])
            ewma_z = abs(ewma - p["mean"]) / (p["std"] or sigma or 1e-9)

            eff = max(z, ewma_z)
            if eff < self.z_warn:
                continue  # nominal

            severity = "critical" if eff >= self.z_critical else "warning"
            # confidence: how decisively past the warn threshold, capped at 1.
            confidence = float(min(1.0, (eff - self.z_warn) / (self.z_critical - self.z_warn + 1e-9)))
            label = p.get("label") or sig.get("label") or tid
            unit = p.get("unit") or sig.get("unit") or ""
            direction = "above" if latest > p["median"] else "below"

            out.append(Detection(
                output_type="anomaly",
                severity=severity,
                title=f"{label}: drift detected",
                detail=(f"{label} is {direction} normal range "
                        f"(value {latest:.3g}{unit}, z={eff:.1f}, "
                        f"baseline {p['median']:.3g}±{sigma:.3g})"),
                score=float(eff),
                confidence=confidence,
                tag_id=tid,
                payload={
                    "value": latest, "z": z, "ewma": ewma, "ewma_z": ewma_z,
                    "median": p["median"], "robust_sigma": sigma,
                    "direction": direction, "method": self.method,
                },
            ))
        return out

    # ── model drift self-monitoring ────────────────────────────────────────
    def check_drift(self, parameters: Dict[str, Any], recent: pd.DataFrame,
                    signals: List[Dict[str, Any]]) -> DriftResult | None:
        sig_params = parameters.get("signals", {})
        if recent.empty or not sig_params:
            return None
        wide = self.pivot(recent)
        shifts = []
        detail = {}
        for tid, p in sig_params.items():
            if tid not in wide.columns:
                continue
            series = wide[tid].dropna().astype(float)
            if series.empty:
                continue
            cur_med = float(series.median())
            sigma = p["robust_sigma"] or 1e-9
            shift = abs(cur_med - p["median"]) / sigma
            shifts.append(shift)
            detail[tid] = {"baseline_median": p["median"], "current_median": cur_med, "shift_sigma": shift}
        if not shifts:
            return None
        drift_score = float(np.mean(shifts))
        return DriftResult(drift_score=drift_score, drifted=drift_score > 2.0, detail=detail)
