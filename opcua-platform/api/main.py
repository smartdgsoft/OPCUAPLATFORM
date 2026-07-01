"""OPC UA Platform — FastAPI Backend (feature-flag driven)"""
from __future__ import annotations
import os
from contextlib import asynccontextmanager
import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from prometheus_fastapi_instrumentator import Instrumentator

from src.auth.router import router as auth_router
from src.routers import tags, assets, history, alarms, analytics, ws, opcua_mgmt
from src.routers import write, methods, servers as servers_router
from src.routers import twin as twin_router
from src.routers import predictive as predictive_router
from src.routers import closed_loop as closed_loop_router
from src.routers import connectivity as connectivity_router
from src.routers import problem_templates as templates_router
from src.routers import calibration as calibration_router
from src.db.database import init_db, close_db
from src.config.settings import settings
from src.utils.logging import configure_logging

configure_logging(settings.log_level)
logger = structlog.get_logger(__name__)

FEATURE_WRITE   = os.getenv("FEATURE_WRITE",   "true").lower()  == "true"
FEATURE_METHODS = os.getenv("FEATURE_METHODS", "true").lower()  == "true"
FEATURE_MULTI   = os.getenv("FEATURE_MULTI_SERVER","false").lower() == "true"
FEATURE_TWIN    = os.getenv("FEATURE_DIGITAL_TWIN","false").lower() == "true"
FEATURE_PRED    = os.getenv("FEATURE_TWIN_PREDICTIVE","false").lower() == "true"
FEATURE_CL_ADV  = os.getenv("FEATURE_CLOSED_LOOP_ADVISORY","false").lower() == "true"
FEATURE_HUB     = os.getenv("FEATURE_CONNECTOR_HUB","false").lower() == "true"
FEATURE_TMPL    = os.getenv("FEATURE_PROBLEM_TEMPLATES","false").lower() == "true"

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("startup", write=FEATURE_WRITE, methods=FEATURE_METHODS, multi_server=FEATURE_MULTI)
    await init_db()
    yield
    await close_db()

app = FastAPI(
    title="OPC UA Industrial Platform API",
    description="Full-control OPC UA historian — read, write, method calls, multi-server",
    version="3.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins_list,
    allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

Instrumentator().instrument(app).expose(app, endpoint="/api/metrics")

# ── Core routers (always active) ──────────────────────────────────────────
app.include_router(auth_router,        prefix="/api/auth",      tags=["auth"])
app.include_router(tags.router,        prefix="/api/tags",       tags=["tags"])
app.include_router(assets.router,      prefix="/api/assets",     tags=["assets"])
app.include_router(history.router,     prefix="/api/history",    tags=["history"])
app.include_router(alarms.router,      prefix="/api/alarms",     tags=["alarms"])
app.include_router(analytics.router,   prefix="/api/analytics",  tags=["analytics"])
app.include_router(opcua_mgmt.router,  prefix="/api/opcua",      tags=["opc-ua-client"])
app.include_router(ws.router,          prefix="/ws",             tags=["websocket"])
app.include_router(servers_router.router, prefix="/api/servers", tags=["servers"])

# ── Feature-gated routers ─────────────────────────────────────────────────
if FEATURE_WRITE:
    app.include_router(write.router,   prefix="/api/write",      tags=["write"])
    logger.info("feature_enabled", feature="write")

if FEATURE_METHODS:
    app.include_router(methods.router, prefix="/api/methods",    tags=["methods"])
    logger.info("feature_enabled", feature="methods")

if FEATURE_TWIN:
    app.include_router(twin_router.router, prefix="/api/twin",   tags=["digital-twin"])
    logger.info("feature_enabled", feature="digital_twin")

if FEATURE_PRED:
    app.include_router(predictive_router.router, prefix="/api/predictive", tags=["predictive"])
    logger.info("feature_enabled", feature="twin_predictive")

if FEATURE_CL_ADV:
    app.include_router(closed_loop_router.router, prefix="/api/closed-loop", tags=["closed-loop"])
    logger.info("feature_enabled", feature="closed_loop_advisory")

if FEATURE_HUB:
    app.include_router(connectivity_router.router, prefix="/api/connectivity", tags=["connectivity"])
    logger.info("feature_enabled", feature="connector_hub")

if FEATURE_TMPL:
    app.include_router(templates_router.router, prefix="/api/templates", tags=["problem-templates"])
    app.include_router(calibration_router.router, prefix="/api/calibration", tags=["calibration"])
    logger.info("feature_enabled", feature="problem_templates")

@app.get("/api/health")
async def health():
    return {
        "status": "ok", "version": "3.0.0",
        "features": {
            "write": FEATURE_WRITE,
            "methods": FEATURE_METHODS,
            "multi_server": FEATURE_MULTI,
        }
    }

@app.get("/api/features")
async def features():
    """Discover which features are enabled — used by the frontend to show/hide UI."""
    return {
        "write":         FEATURE_WRITE,
        "methods":       FEATURE_METHODS,
        "multi_server":  FEATURE_MULTI,
        "digital_twin":  FEATURE_TWIN,
        "twin_predictive": FEATURE_PRED,
        "closed_loop_advisory": FEATURE_CL_ADV,
        "connector_hub": FEATURE_HUB,
        "problem_templates": FEATURE_TMPL,
        "kafka":         os.getenv("KAFKA_ENABLED","false").lower() == "true",
        "alarm_eval":    os.getenv("FEATURE_ALARM_EVAL","true").lower() == "true",
        "scheduler":     os.getenv("FEATURE_SCHEDULER","false").lower() == "true",
        "edge_sync":     os.getenv("FEATURE_EDGE_SYNC","false").lower() == "true",
    }
