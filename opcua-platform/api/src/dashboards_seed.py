"""
Seed layout for the 'Fevicol SH — Production Line 1' dashboard.

This is a config, not code: it reproduces the NEXUS OPS operations screen as a
dashboard layout. Every widget carries per-widget `demo` values so the screen
looks complete immediately; each also carries an (empty) binding ready to be
pointed at a real tag_id / stream_key, at which point it goes live and the DEMO
badge disappears. Positions use a 12-column grid.
"""

GOLD = "#e8a830"; TEAL = "#2dd4a8"; CYAN = "#22d3ee"; ROSE = "#f472b6"; AMBER = "#f59e0b"

FEVICOL_LAYOUT = {
    "grid": {"cols": 12, "row_height": 38},
    "theme": "nexus_dark",
    "header": {
        "title": "Fevicol SH — Production Line 1",
        "subtitle": "Mahul Works, Mumbai — Batch FC-240847 in progress",
        "products": ["Fevicol SH", "Fevicol MR", "HI-TACK", "Aqua"],
        "ranges": ["1H", "6H", "24H", "7D"],
    },
    "widgets": [
        # ── Batch progress bar (full width) — no real source yet, demo ──
        {"id": "batch", "type": "batch_bar", "title": "Active Batch",
         "pos": {"x": 0, "y": 0, "w": 12, "h": 2},
         "binding": {"mode": "static"},
         "demo": {"batch_id": "FC-240847", "phase": "Polymerization", "progress": 62,
                  "elapsed": "2h 14m", "remaining": "~1h 22m", "yield": "8,420 L"}},

        # ── KPI row (5 across) ──
        {"id": "kpi_visc", "type": "kpi", "title": "Viscosity",
         "pos": {"x": 0, "y": 2, "w": 2, "h": 3}, "options": {"color": GOLD, "decimals": 0, "badge": "Spec"},
         "binding": {"mode": "live", "tag_id": None, "stream_key": None,
                     "spec": {"min": 4500, "max": 5200, "unit": "cP"}},
         "demo": {"value": 4850, "series": [4600, 4720, 4810, 4780, 4850, 4900, 4850]}},
        {"id": "kpi_ph", "type": "kpi", "title": "pH Value",
         "pos": {"x": 2, "y": 2, "w": 2, "h": 3}, "options": {"color": TEAL, "decimals": 2, "badge": "OK"},
         "binding": {"mode": "live", "tag_id": None, "stream_key": None,
                     "spec": {"min": 6.8, "max": 7.5, "unit": ""}},
         "demo": {"value": 7.2, "series": [7.0, 7.1, 7.15, 7.2, 7.18, 7.22, 7.2]}},
        {"id": "kpi_solids", "type": "kpi", "title": "Solids %",
         "pos": {"x": 4, "y": 2, "w": 2, "h": 3}, "options": {"color": CYAN, "decimals": 1, "badge": "Stable"},
         "binding": {"mode": "live", "tag_id": None, "stream_key": None,
                     "spec": {"min": 47, "max": 50, "unit": "% w/w"}},
         "demo": {"value": 48.3, "series": [47.8, 48.0, 48.2, 48.3, 48.1, 48.4, 48.3]}},
        {"id": "kpi_bond", "type": "kpi", "title": "Bond Strength",
         "pos": {"x": 6, "y": 2, "w": 2, "h": 3}, "options": {"color": ROSE, "decimals": 0, "badge": "Good"},
         "binding": {"mode": "live", "tag_id": None, "stream_key": None,
                     "spec": {"min": 150, "max": None, "unit": "N/cm²"}},
         "demo": {"value": 182, "series": [172, 176, 180, 178, 182, 185, 182]}},
        {"id": "kpi_oee", "type": "kpi", "title": "Line OEE",
         "pos": {"x": 8, "y": 2, "w": 2, "h": 3}, "options": {"color": AMBER, "decimals": 1, "suffix": "%", "badge": "1.4%"},
         "binding": {"mode": "static", "spec": {"min": 89, "max": None, "unit": "%"}},
         "demo": {"value": 91.7, "series": [89, 90, 90.5, 91, 91.7, 92, 91.7]}},

        # ── Reactor R-101 gauges (4 in a 2x2, right of KPIs) ──
        {"id": "g_temp", "type": "gauge", "title": "Temp",
         "pos": {"x": 10, "y": 2, "w": 1, "h": 3},
         "binding": {"mode": "live", "tag_id": None, "stream_key": None,
                     "spec": {"min": 0, "max": 120, "warn": 85, "crit": 95, "unit": "°C"}},
         "options": {"color": GOLD}, "demo": {"value": 78}},
        {"id": "g_agit", "type": "gauge", "title": "Agitator",
         "pos": {"x": 11, "y": 2, "w": 1, "h": 3},
         "binding": {"mode": "live", "tag_id": None, "stream_key": None,
                     "spec": {"min": 0, "max": 120, "warn": 100, "crit": 110, "unit": "RPM"}},
         "options": {"color": TEAL}, "demo": {"value": 64}},
        {"id": "g_press", "type": "gauge", "title": "Pressure",
         "pos": {"x": 10, "y": 5, "w": 1, "h": 3},
         "binding": {"mode": "live", "tag_id": None, "stream_key": None,
                     "spec": {"min": 0, "max": 3, "warn": 2.2, "crit": 2.6, "unit": "bar"}},
         "options": {"color": CYAN}, "demo": {"value": 1.2}},
        {"id": "g_cool", "type": "gauge", "title": "Cooling",
         "pos": {"x": 11, "y": 5, "w": 1, "h": 3},
         "binding": {"mode": "live", "tag_id": None, "stream_key": None,
                     "spec": {"min": 0, "max": 80, "warn": 55, "crit": 65, "unit": "°C"}},
         "options": {"color": ROSE}, "demo": {"value": 42}},

        # ── Quality trends (multi-series line) ──
        {"id": "trend", "type": "trend", "title": "Quality Trends",
         "pos": {"x": 0, "y": 5, "w": 10, "h": 6},
         "binding": {"mode": "history", "resolution": "min1", "range": "1H",
                     "tag_ids": [], "stream_keys": [],
                     "series": [
                         {"label": "Viscosity (cP)", "color": GOLD},
                         {"label": "pH", "color": TEAL},
                         {"label": "Solids %", "color": CYAN},
                         {"label": "Temp °C", "color": ROSE}]},
         "demo": {"points": 30}},

        # ── Active alarms ──
        {"id": "alarms", "type": "alarm_list", "title": "Active Alarms",
         "pos": {"x": 0, "y": 11, "w": 4, "h": 7},
         "binding": {"mode": "alarms", "filter": {"active_only": True}},
         "demo": {"rows": [
             {"id": "AL-1081", "tag": "VT-101-TEMP", "desc": "Reactor R-101 temperature approaching high limit (82°C)", "severity": "critical", "time": "14:32:07", "acked": False},
             {"id": "AL-1079", "tag": "FT-204-FLOW", "desc": "PVA dosing flow rate below minimum threshold", "severity": "critical", "time": "14:28:43", "acked": False},
             {"id": "AL-1076", "tag": "LT-302-LEVEL", "desc": "Homogenizer feed tank T-302 level low", "severity": "warning", "time": "14:15:22", "acked": False},
             {"id": "AL-1074", "tag": "MT-401-VIB", "desc": "Filling pump P-401 vibration above warning", "severity": "warning", "time": "14:05:11", "acked": True},
             {"id": "AL-1071", "tag": "pH-QC-01", "desc": "In-line pH reading trending downward (7.05)", "severity": "info", "time": "13:52:30", "acked": False}]}},

        # ── Equipment status ──
        {"id": "equip", "type": "equipment_list", "title": "Equipment Status",
         "pos": {"x": 4, "y": 11, "w": 4, "h": 7},
         "binding": {"mode": "assets", "filter": {}},
         "demo": {"rows": [
             {"tag": "R-101", "name": "Polymerization Reactor", "type": "Reactor", "status": "batching", "load": 78},
             {"tag": "R-102", "name": "Pre-Mix Vessel", "type": "Mixer", "status": "running", "load": 45},
             {"tag": "T-201", "name": "PVA Solution Tank", "type": "Tank", "status": "running", "load": 62},
             {"tag": "T-202", "name": "Acrylic Emulsion Tank", "type": "Tank", "status": "running", "load": 55},
             {"tag": "T-203", "name": "Additive Dosing Tank", "type": "Tank", "status": "warning", "load": 28},
             {"tag": "H-301", "name": "Homogenizer", "type": "Homogenizer", "status": "running", "load": 70},
             {"tag": "T-302", "name": "Hold Tank", "type": "Tank", "status": "warning", "load": 35},
             {"tag": "P-401", "name": "Filling Pump", "type": "Pump", "status": "running", "load": 82},
             {"tag": "FL-401", "name": "Filling Machine #1", "type": "Filler", "status": "running", "load": 88},
             {"tag": "FL-402", "name": "Filling Machine #2", "type": "Filler", "status": "stopped", "load": 0},
             {"tag": "LB-401", "name": "Labeling Machine", "type": "Labeler", "status": "running", "load": 76},
             {"tag": "CP-401", "name": "Capping Machine", "type": "Capper", "status": "fault", "load": 0}]}},

        # ── Rich P&ID schematic (HTML-matching layout, live values on nodes) ──
        {"id": "pid", "type": "schematic", "title": "Process Schematic",
         "pos": {"x": 8, "y": 11, "w": 4, "h": 7},
         "binding": {"mode": "live", "tag_ids": [], "stream_keys": []},
         "options": {
             "nodes": [
                 {"id": "T201", "type": "tank",    "label": "PVA",         "sub": "T-201",  "fx": 0.08, "fy": 0.35, "col": GOLD, "value_tag": None, "demo": 62, "unit": "%"},
                 {"id": "T202", "type": "tank",    "label": "Acrylic",     "sub": "T-202",  "fx": 0.08, "fy": 0.72, "col": CYAN, "value_tag": None, "demo": 55, "unit": "%"},
                 {"id": "R102", "type": "mixer",   "label": "Pre-Mix",     "sub": "R-102",  "fx": 0.24, "fy": 0.52, "col": TEAL, "value_tag": None, "demo": 45, "unit": "%"},
                 {"id": "R101", "type": "reactor", "label": "Reactor",     "sub": "R-101",  "fx": 0.44, "fy": 0.52, "col": GOLD, "value_tag": None, "demo": 78, "unit": "°C", "status": "batching"},
                 {"id": "T203", "type": "tank",    "label": "Additives",   "sub": "T-203",  "fx": 0.44, "fy": 0.16, "col": ROSE, "value_tag": None, "demo": 28, "unit": "%"},
                 {"id": "T302", "type": "tank",    "label": "Cool & Hold", "sub": "T-302",  "fx": 0.63, "fy": 0.52, "col": CYAN, "value_tag": None, "demo": 35, "unit": "%", "status": "warning"},
                 {"id": "H301", "type": "mixer",   "label": "Homogenizer", "sub": "H-301",  "fx": 0.79, "fy": 0.52, "col": TEAL, "value_tag": None, "demo": 80, "unit": "%"},
                 {"id": "FL401","type": "filler",  "label": "Fill",        "sub": "FL-401", "fx": 0.94, "fy": 0.35, "col": GOLD, "value_tag": None, "demo": 73, "unit": "%"},
                 {"id": "LB401","type": "box",     "label": "Pack",        "sub": "LB-401", "fx": 0.94, "fy": 0.72, "col": "#9a958a", "value_tag": None, "demo": 65, "unit": "%"}
             ],
             "edges": [
                 {"from": "T201", "to": "R102"}, {"from": "T202", "to": "R102"},
                 {"from": "R102", "to": "R101"}, {"from": "T203", "to": "R101"},
                 {"from": "R101", "to": "T302"}, {"from": "T302", "to": "H301"},
                 {"from": "H301", "to": "FL401"}, {"from": "FL401", "to": "LB401"}
             ]
         },
         "demo": {"active": True}},
    ],
}
