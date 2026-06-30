"""
Multivariate anomaly detector (Mahalanobis distance).

Where univariate looks at each signal alone, this models the *relationships
between* signals — the heart of real process-fault detection. For adhesive,
temperature↔viscosity↔pressure move together; a fault often shows as a broken
relationship while each signal is still individually "in range".

Method: learn the mean vector and (robust) covariance from history, then score
each live sample by Mahalanobis distance. Distances follow ~chi-square(df=k),
so thresholds are principled, not hand-tuned.

Uses scikit-learn's MinCovDet (robust covariance) when available, falling back
to empirical covariance. Permissive OSS only: numpy, pandas, scikit-learn.
"""
from __future__ import annotations
from typing import Any, Dict, List
import numpy as np
import pandas as pd

try:
    from sklearn.covariance import MinCovDet, EmpiricalCovariance
    _HAVE_SK = True
except Exception:  # pragma: no cover
    _HAVE_SK = False

from scipy.stats import chi2

from .base import BaseDetector, TrainResult, Detection


class MultivariateDetector(BaseDetector):
    method = "multivariate"

    @property
    def warn_p(self) -> float:
        # chi-square tail probability for 'warning' (e.g. 0.01 = 99th pctile)
        return float(self.config.get("warn_p", 0.01))

    @property
    def critical_p(self) -> float:
        return float(self.config.get("critical_p", 0.001))

    @property
    def min_samples(self) -> int:
        return int(self.config.get("min_samples", 300))

    @property
    def robust(self) -> bool:
        return bool(self.config.get("robust", True))

    def _resample(self, wide: pd.DataFrame) -> pd.DataFrame:
        """Align signals onto a common time grid so rows are comparable."""
        rule = str(self.config.get("resample", "1s"))
        wide = wide.sort_index()
        # forward-fill within a small limit so sparse signals still align
        res = wide.resample(rule).last().ffill(limit=5).dropna()
        return res

    def train(self, history: pd.DataFrame, signals: List[Dict[str, Any]]) -> TrainResult:
        wide = self.pivot(history)
        if wide.empty or wide.shape[1] < 2:
            raise ValueError("Multivariate model needs at least 2 signals with data")

        cols = [s["tag_id"] for s in signals if s["tag_id"] in wide.columns]
        wide = wide[cols]
        aligned = self._resample(wide)
        if aligned.shape[0] < self.min_samples:
            raise ValueError(f"Insufficient aligned samples ({aligned.shape[0]} < {self.min_samples})")

        X = aligned.values.astype(float)
        mean = X.mean(axis=0)

        if _HAVE_SK and self.robust and X.shape[0] > X.shape[1] * 5:
            est = MinCovDet(support_fraction=None, random_state=42).fit(X)
            cov = est.covariance_
            loc = est.location_
        elif _HAVE_SK:
            est = EmpiricalCovariance().fit(X)
            cov = est.covariance_
            loc = est.location_
        else:  # numpy fallback
            cov = np.cov(X, rowvar=False)
            loc = mean

        # Regularize for invertibility.
        k = cov.shape[0]
        cov_reg = cov + np.eye(k) * 1e-6
        try:
            inv = np.linalg.inv(cov_reg)
        except np.linalg.LinAlgError:
            inv = np.linalg.pinv(cov_reg)

        # Training-set Mahalanobis for a sanity metric.
        d = X - loc
        m2 = np.einsum("ij,jk,ik->i", d, inv, d)
        warn_thr = float(chi2.ppf(1 - self.warn_p, df=k))
        crit_thr = float(chi2.ppf(1 - self.critical_p, df=k))

        params = {
            "columns": cols,
            "location": loc.tolist(),
            "inv_cov": inv.tolist(),
            "k": k,
            "warn_threshold": warn_thr,
            "critical_threshold": crit_thr,
            "resample": str(self.config.get("resample", "1s")),
        }
        metrics = {
            "aligned_samples": int(aligned.shape[0]),
            "signals": cols,
            "train_md_mean": float(np.mean(m2)),
            "train_md_p99": float(np.percentile(m2, 99)),
            "warn_threshold": warn_thr,
            "critical_threshold": crit_thr,
            "robust": bool(_HAVE_SK and self.robust),
        }
        return TrainResult(parameters=params, metrics=metrics,
                           sample_count=int(aligned.shape[0]),
                           notes=f"multivariate model over {k} signals")

    def score(self, parameters: Dict[str, Any], recent: pd.DataFrame,
              signals: List[Dict[str, Any]]) -> List[Detection]:
        cols = parameters.get("columns", [])
        if not cols or recent.empty:
            return []
        wide = self.pivot(recent)
        for c in cols:
            if c not in wide.columns:
                return []  # need all signals present to score the relationship
        aligned = self._resample(wide[cols])
        if aligned.empty:
            return []

        loc = np.array(parameters["location"], dtype=float)
        inv = np.array(parameters["inv_cov"], dtype=float)
        k = int(parameters["k"])
        warn_thr = float(parameters["warn_threshold"])
        crit_thr = float(parameters["critical_threshold"])

        x = aligned.values[-1].astype(float)   # latest aligned sample
        d = x - loc
        m2 = float(d @ inv @ d)

        if m2 < warn_thr:
            return []

        severity = "critical" if m2 >= crit_thr else "warning"
        confidence = float(min(1.0, (m2 - warn_thr) / (crit_thr - warn_thr + 1e-9)))
        # Which signal contributes most to the distance (largest standardized term)?
        contrib = np.abs(inv @ d) * np.abs(d)
        worst_idx = int(np.argmax(contrib))
        worst_tag = cols[worst_idx]
        labels = {s["tag_id"]: (s.get("label") or s["tag_id"]) for s in signals}

        return [Detection(
            output_type="anomaly",
            severity=severity,
            title="Process relationship anomaly",
            detail=(f"Joint signal behaviour is abnormal "
                    f"(Mahalanobis {m2:.1f} vs warn {warn_thr:.1f}); "
                    f"largest contributor: {labels.get(worst_tag, worst_tag)}"),
            score=m2,
            confidence=confidence,
            tag_id=worst_tag,
            payload={
                "mahalanobis": m2, "warn_threshold": warn_thr,
                "critical_threshold": crit_thr, "k": k,
                "worst_contributor": worst_tag, "method": self.method,
                "values": dict(zip(cols, x.tolist())),
            },
        )]
