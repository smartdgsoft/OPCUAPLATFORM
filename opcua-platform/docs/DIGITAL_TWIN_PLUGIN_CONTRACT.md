# Digital Twin — Module Plugin Contract

This document defines the seam that on-demand modules (predictive,
closed-loop advisory, simulation) integrate against. The built-in **status**
tier is the reference implementation of this contract, proving the seam works.

A module is a separate container, deployed only for customers/assets that
license it, gated by its own feature flag (the same pattern as
`FEATURE_MULTI_SERVER`). The core platform never ships a customer's module.

--------------------------------------------------------------------------
## 1. What a module may READ
--------------------------------------------------------------------------

**Live signal values** — Redis keys `tag:live:{tag_id}` (JSON):
```json
{ "value": 72.4, "quality": 192, "ts": "2026-06-29T05:00:00Z" }
```
A module discovers which tags belong to a twin via the twin's signals
(table `twin_signals`, or API `GET /api/twin/{twin_id}`).

**History** — TimescaleDB `tag_values` (join `tags` on `tag_id`), or the
read API `GET /api/history/{tag_id}?start=&end=`. Used for baselining,
feature engineering, and training.

**Twin definition & envelopes** — `GET /api/twin/{twin_id}` returns the
definition, its signals, manual/learned envelopes, and current health.

--------------------------------------------------------------------------
## 2. What a module WRITES
--------------------------------------------------------------------------

All derived results go to the `twin_outputs` table (and optionally a Redis
channel for live UI). A module MUST NOT write to `tag_values` or actuate
hardware directly.

`twin_outputs` row:
- `twin_id`        — which twin
- `module`         — your module name (e.g. `adhesive_predictive`)
- `output_type`    — `prediction` | `anomaly` | `recommendation` | `health`
- `tag_id`         — optional target tag (for a recommended setpoint)
- `severity`       — `info` | `warning` | `critical`
- `title`,`detail` — human-readable summary
- `payload`        — JSON: numbers, horizons, confidence, setpoints, etc.
- `requires_approval` — TRUE for closed-loop setpoint recommendations
- `approved`,`approved_by` — filled by the approval gate, never by the module

Live UI hint (optional): publish the same payload to Redis channel
`twin:outputs:{twin_id}` so the Digital Twin page updates without polling.

--------------------------------------------------------------------------
## 3. Closed-loop is ADVISORY by default
--------------------------------------------------------------------------

A closed-loop module does **not** call the write API directly. It emits a
`recommendation` output with `requires_approval=TRUE` and a target
`tag_id` + setpoint in `payload`. Actuation happens only after a human (or
a customer's safety-rated system) approves it through the existing
write-control + RBAC gate. Fully-automatic actuation is a separately gated,
per-customer, contractually-reviewed capability — never the default.

--------------------------------------------------------------------------
## 4. Registration
--------------------------------------------------------------------------

A module registers its `model_type` by creating/own a `twin_definitions`
row (or attaching to an existing one via `config`). The evaluator service
only computes the built-in `status` tier; module containers run their own
evaluation loops against this contract and write to `twin_outputs`.

--------------------------------------------------------------------------
## 5. Health semantics (status tier, reused by modules)
--------------------------------------------------------------------------

Per signal, given an envelope (min, max, optional target, warn band):
- `good`     — value strictly inside the inner (non-warn) band
- `warning`  — value inside [min,max] but within the warn band of a bound
- `bad`      — value outside [min,max]
- `stale`    — no fresh live value (older than the staleness window)
- `unknown`  — no envelope configured / no data

Asset rollup = worst signal state (bad > warning > good), with stale/unknown
surfaced separately. Modules may emit their own `health` outputs that the UI
shows alongside the status-tier rollup.
