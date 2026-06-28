# OPC UA Industrial Platform

Enterprise-grade OPC UA historian with Kafka-powered high-throughput ingestion,
TimescaleDB time-series storage, real-time WebSocket dashboard, OEE analytics,
and full observability stack — all containerised with Docker Compose.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Feature Summary](#feature-summary)
3. [Quick Start (Development)](#quick-start-development)
4. [Production Scaled Deployment](#production-scaled-deployment)
5. [Kubernetes Deployment](#kubernetes-deployment)
6. [Configuration Reference](#configuration-reference)
7. [OPC UA Security](#opc-ua-security)
8. [Adding Tags](#adding-tags)
9. [API Reference](#api-reference)
10. [Frontend Pages](#frontend-pages)
11. [Scaling Guide](#scaling-guide)
12. [Observability](#observability)
13. [Data Retention](#data-retention)
14. [RBAC](#rbac)
15. [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    OPC UA Servers / PLCs                        │
│           (PLC, SCADA, DCS, Robots, Sensors, IoT)              │
└───────────────────────┬─────────────────────────────────────────┘
                        │ OPC UA pub/sub (X.509 + SignAndEncrypt)
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│               Python OPC UA Client (asyncua)                    │
│  • Node subscription + dead-band filtering                      │
│  • Local SQLite offline buffer (survives network outages)       │
│  • Prometheus metrics on :9090                                  │
└──────────┬──────────────────────────────────┬───────────────────┘
           │ Redis SETEX/PUBLISH               │ Kafka produce (lz4)
           ▼                                   ▼
┌──────────────────┐         ┌──────────────────────────────────┐
│  Redis Master    │         │  Kafka Cluster (3 brokers RF=3)  │
│  • Live tag cache│         │  • Topic: opcua.tag.values       │
│  • WebSocket     │         │  • 12 partitions (keyed by tag)  │
│    pub/sub       │         │  • 7-day retention               │
│  Redis Replica   │         └──────────────┬───────────────────┘
│  • Read scaling  │                         │ consumer group
└──────────────────┘          ┌──────────────┴──────────────┐
                              │  N × Kafka Consumer Workers  │
                              │  (asyncpg COPY to TimescaleDB)│
                              └──────────────┬───────────────┘
                                             │ asyncpg COPY
                                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    TimescaleDB Primary                           │
│  • tag_values hypertable (chunked daily, compressed >7 days)   │
│  • Continuous aggregates: 1-min, 1-hour, 1-day                  │
│  • 2-year raw data retention policy                             │
│  TimescaleDB Replica  ←── streaming replication                │
│  PgBouncer (connection pooling, 1000 clients → 50 DB conns)    │
└──────────────────────────────┬──────────────────────────────────┘
                               │ asyncpg (read replica for analytics)
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│               FastAPI Backend (N workers)                        │
│  • JWT + RBAC auth          • REST API                          │
│  • WebSocket live streaming  • Alarm evaluation                 │
│  • OEE / Analytics          • OPC UA management endpoints       │
│  HAProxy load balancer (least-conn, health checks)              │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│               React + TypeScript Frontend                        │
│  Dashboard · OPC UA Client UI · History · Alarms                │
│  Analytics · Assets · Tags                                      │
│  Nginx (SPA routing, gzip, static asset caching)               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    Observability Stack                            │
│  Prometheus · Alertmanager · Grafana · Loki · Promtail          │
│  Node Exporter · Postgres Exporter · Redis Exporter             │
│  Kafka Exporter · Custom OPC UA metrics                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Feature Summary

### OPC UA Client
- Custom Python client built on `asyncua`
- Async subscriptions to unlimited monitored items
- OPC UA security: None / Sign / SignAndEncrypt + Basic256Sha256 / Aes128Sha256RsaOaep
- Dead-band filtering (absolute + percentage) — reduces DB writes by up to 80%
- Exponential backoff reconnection — survives server restarts without data loss
- SQLite offline buffer — collects data during network partitions, replays on reconnect
- Prometheus metrics: values received, filtered, written, queue depth, reconnect count

### Ingestion Pipeline
- **Simple mode** (`KAFKA_ENABLED=false`): asyncpg COPY directly to TimescaleDB — good for <10k tags, <10k rows/sec
- **Kafka mode** (`KAFKA_ENABLED=true`): 3-broker Kafka cluster, N consumer workers, each writing 100k+ rows/sec — good for 100k+ tags, 1M+ rows/sec

### TimescaleDB
- Hypertable partitioned by day — queries automatically skip irrelevant chunks
- LZ4 compression after 7 days — 10x storage reduction
- Continuous aggregates: 1-minute, 1-hour, 1-day — dashboards never scan raw data
- Read replica for analytics — isolates OLAP queries from OLTP writes
- PgBouncer connection pooling — 1000 API connections → 50 real DB connections

### FastAPI Backend
- Async throughout (asyncpg, aioredis)
- JWT authentication, bcrypt passwords
- RBAC: ADMIN / ENGINEER / OPERATOR / VIEWER
- Smart history routing: auto-picks raw or aggregate table based on time window
- WebSocket live tag streaming via Redis pub/sub
- OPC UA management API: browse address space, read node values, server info, endpoint discovery
- Z-score anomaly detection, OEE calculation, statistical summaries

### React Dashboard
| Page | Description |
|------|-------------|
| Dashboard | Live KPI cards, WebSocket tag values, alarm banner |
| OPC UA Client | Connection status, address space browser, subscriptions, metrics, security |
| History | Multi-tag trend chart, time range picker, auto-resolution |
| Alarms | Active alarm table, one-click acknowledge |
| Analytics | OEE gauge, min/avg/max charts, statistical summaries |
| Assets | ISA-95 hierarchy tree with tag counts |
| Tags | Add/deactivate tags, node ID configuration |

### Observability
- Prometheus scrapes: OPC UA client, consumers, API, TimescaleDB, Redis, Kafka, host
- 15+ alert rules: disconnection, write errors, consumer lag, disk space, CPU/memory
- Alertmanager: email routing, critical vs warning channels, Slack webhook ready
- Loki + Promtail: all Docker container logs aggregated and searchable in Grafana
- Grafana: TimescaleDB + Prometheus + Loki datasources pre-provisioned

---

## Quick Start (Development)

Requires Docker Engine 24+ and Docker Compose v2.

```bash
# 1. Clone / unpack the project
cd opcua-platform

# 2. Configure environment
cp .env.example .env
# Edit .env: set OPC_SERVER_URL to your OPC UA server

# 3. Start (simple mode — no Kafka)
bash scripts/start.sh

# 4. Open the dashboard
open http://localhost:3000
```

Default login: `admin` / `Admin@123`

---

## Production Scaled Deployment

Uses: 3-broker Kafka, TimescaleDB primary + replica, Redis master + replica, 2 API instances, HAProxy, full observability.

```bash
# 1. Set production environment
cp .env.example .env
# Edit ALL values — especially:
#   POSTGRES_PASSWORD, REDIS_PASSWORD, JWT_SECRET, OPC_SERVER_URL

# 2. Start full scaled stack
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d

# 3. Check service status
bash scripts/scale.sh status

# 4. Check live ingestion throughput
bash scripts/scale.sh throughput
```

### Scaling consumers (more DB write throughput)

```bash
# Docker Compose: copy kafka-consumer-1 block, add kafka-consumer-3
# Then restart:
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d kafka-consumer-3

# Or use the scale script (Kubernetes):
bash scripts/scale.sh consumers 6
```

### Scaling the API

```bash
# Add api-3, api-4 to docker-compose.scale.yml
# HAProxy picks them up automatically on restart
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d api-3

# Kubernetes:
bash scripts/scale.sh api 5
```

---

## Kubernetes Deployment

```bash
# 1. Build images and push to your registry
docker build -t your-registry/opcua-client:latest  ./opcua-client
docker build -t your-registry/opcua-consumer:latest ./opcua-client -f opcua-client/Dockerfile.consumer
docker build -t your-registry/api:latest            ./api
docker build -t your-registry/frontend:latest       ./frontend

# 2. Update image refs in k8s/base/platform.yaml

# 3. Apply base manifests
kubectl apply -f k8s/base/platform.yaml

# 4. Patch secrets (never commit to git)
kubectl create secret generic opcua-secrets \
  --from-literal=POSTGRES_PASSWORD=<strong_pass> \
  --from-literal=REDIS_PASSWORD=<strong_pass> \
  --from-literal=JWT_SECRET=<64_char_hex> \
  -n opcua-platform \
  --dry-run=client -o yaml | kubectl apply -f -

# 5. Watch rollout
kubectl rollout status deployment/api -n opcua-platform
kubectl rollout status deployment/kafka-consumer -n opcua-platform

# 6. Scale consumers as needed
kubectl scale deployment kafka-consumer -n opcua-platform --replicas=8
```

HPAs auto-scale `api` (2–10 pods) and `kafka-consumer` (2–12 pods) based on CPU.

---

## Configuration Reference

| Variable | Default | Description |
|---|---|---|
| `OPC_SERVER_URL` | `opc.tcp://localhost:4840` | OPC UA server endpoint |
| `OPC_SECURITY_MODE` | `None` | None / Sign / SignAndEncrypt |
| `OPC_SECURITY_POLICY` | `None` | None / Basic256Sha256 / Aes128Sha256RsaOaep |
| `OPC_USERNAME` | _(empty)_ | OPC UA username (optional) |
| `OPC_PASSWORD` | _(empty)_ | OPC UA password (optional) |
| `PUBLISH_INTERVAL_MS` | `1000` | OPC UA subscription publishing interval |
| `BATCH_INSERT_SIZE` | `500` (direct) / `2000` (Kafka) | Rows per DB insert batch |
| `BUFFER_FLUSH_INTERVAL_S` | `5` | Max seconds between flushes |
| `KAFKA_ENABLED` | `false` | Enable Kafka ingestion path |
| `KAFKA_BOOTSTRAP_SERVERS` | `kafka-1:9092,...` | Kafka broker list |
| `POSTGRES_DSN` | _(see .env.example)_ | TimescaleDB connection string |
| `REDIS_URL` | _(see .env.example)_ | Redis connection URL |
| `JWT_SECRET` | _(must change)_ | 64-char random hex string |
| `JWT_EXPIRE_MINUTES` | `1440` | Token lifetime (24 hours) |
| `LOG_LEVEL` | `INFO` | DEBUG / INFO / WARNING / ERROR |

---

## OPC UA Security

### Recommended production configuration

```env
OPC_SECURITY_MODE=SignAndEncrypt
OPC_SECURITY_POLICY=Basic256Sha256
```

### Generate client certificate

```bash
cd opcua-client/certs

# Generate 2048-bit RSA key + self-signed cert
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout client_key.pem \
  -out client_cert.pem \
  -days 365 \
  -subj "/CN=OPCUAClient/O=MyOrganisation/C=IN" \
  -addext "subjectAltName=URI:urn:opcua-platform:client"
```

Trust `client_cert.pem` on your OPC UA server (vendor-specific process).
The OPC UA Client UI → Security tab has step-by-step guidance.

---

## Adding Tags

### Via dashboard

Go to **Tags** page → click **Add Tag** → enter NodeId, display name, unit, interval.

### Via API

```bash
# Get a token
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/token \
  -d "username=admin&password=Admin@123" | jq -r .access_token)

# Add a tag
curl -X POST http://localhost:8000/api/tags/ \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "node_id":            "ns=2;i=1001",
    "display_name":       "Motor Speed",
    "engineering_unit":   "rpm",
    "data_type":          "Double",
    "deadband_value":     5.0,
    "sample_interval_ms": 500
  }'
```

### Via SQL (bulk import)

```sql
INSERT INTO tags (node_id, display_name, engineering_unit, data_type, sample_interval_ms, deadband_value)
SELECT
  'ns=2;i=' || (1000 + g)::text,
  'Tag ' || g::text,
  'unit',
  'Double',
  1000,
  0.5
FROM generate_series(1, 10000) g;
```

The client picks up new tags automatically on next restart (or send a restart signal via the OPC UA Client UI).

---

## API Reference

### Authentication

```http
POST /api/auth/token
Content-Type: application/x-www-form-urlencoded

username=admin&password=Admin@123
```

Returns `{ access_token, token_type, user }`. Pass token as `Authorization: Bearer <token>`.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/token` | — | Login |
| GET | `/api/auth/me` | ✓ | Current user |
| POST | `/api/auth/users` | ADMIN | Create user |
| GET | `/api/tags/` | ✓ | List tags |
| POST | `/api/tags/` | ENGINEER+ | Create tag |
| GET | `/api/tags/live?tag_ids=a,b` | ✓ | Live values from Redis |
| DELETE | `/api/tags/{id}` | ENGINEER+ | Deactivate tag |
| GET | `/api/history/{tag_id}?start=&end=&resolution=auto` | ✓ | Tag history |
| GET | `/api/history/multi/query?tag_ids=a,b&start=&end=` | ✓ | Multi-tag history |
| GET | `/api/alarms/definitions` | ✓ | Alarm rules |
| POST | `/api/alarms/definitions` | ENGINEER+ | Create alarm rule |
| GET | `/api/alarms/events?state=ACTIVE` | ✓ | Alarm events |
| POST | `/api/alarms/events/{id}/acknowledge` | OPERATOR+ | Acknowledge |
| GET | `/api/analytics/summary?tag_ids=&start=&end=` | ✓ | Statistical summary |
| GET | `/api/analytics/trend?tag_id=&bucket_size=1 hour` | ✓ | Downsampled trend |
| GET | `/api/analytics/oee?asset_id=&start=&end=` | ✓ | OEE calculation |
| GET | `/api/analytics/anomalies?tag_id=&z_threshold=3` | ✓ | Z-score anomalies |
| GET | `/api/assets/` | ✓ | Asset hierarchy |
| POST | `/api/assets/` | ENGINEER+ | Create asset |
| GET | `/api/opcua/status` | ✓ | OPC UA client status |
| GET | `/api/opcua/metrics` | ✓ | Prometheus metrics |
| GET | `/api/opcua/server-info` | ✓ | OPC UA server info |
| GET | `/api/opcua/browse?node_id=i=85` | ✓ | Browse address space |
| GET | `/api/opcua/subscriptions` | ✓ | Active subscriptions |
| GET | `/api/opcua/endpoints?server_url=` | ✓ | Discover endpoints |
| POST | `/api/opcua/restart` | ENGINEER+ | Reconnect client |
| GET | `/api/opcua/node-value?node_id=` | ✓ | Read live node value |
| WS | `/ws/live?tag_ids=a,b,c` | token | WebSocket stream |

Full interactive docs: `http://localhost:8000/api/docs`

### History resolution

The `resolution` parameter auto-selects the right table:

| Time range | Table used |
|---|---|
| ≤ 3 hours | `tag_values` (raw) |
| 3h – 48h | `tag_values_1min` |
| 48h – 30d | `tag_values_1hour` |
| > 30d | `tag_values_1day` |

---

## Frontend Pages

| URL | Page | Description |
|-----|------|-------------|
| `/dashboard` | Live Dashboard | Real-time KPI cards, alarm banner, quality indicators |
| `/opcua` | OPC UA Client | 6-tab management UI (see below) |
| `/history` | History Viewer | Multi-tag trend chart with time range picker |
| `/alarms` | Alarm Management | Event table, acknowledge workflow |
| `/analytics` | Analytics | OEE, statistics, anomaly detection |
| `/assets` | Asset Hierarchy | ISA-95 tree with tag counts |
| `/tags` | Tag Registry | Add/manage OPC UA node subscriptions |

### OPC UA Client UI tabs

| Tab | Features |
|-----|----------|
| Connection | Status, server URL, security config, reconnect button, endpoint discovery |
| Server Info | Product name, manufacturer, version, namespace array |
| Address Space | Tree browser, node class icons, live value reader |
| Subscriptions | All subscribed tags, live values, quality badges |
| Metrics | All Prometheus counters, dead-band effectiveness gauge |
| Security | Risk levels, certificate setup guide with commands |

---

## Scaling Guide

### Throughput tiers

| Tags | Rows/sec | Recommended config |
|---|---|---|
| < 1,000 | < 1k/s | Simple mode (direct DB) — default `docker-compose.yml` |
| 1k–50k | 1k–50k/s | Kafka enabled, 2 consumers, PgBouncer |
| 50k–250k | 50k–500k/s | Kafka, 6 consumers, TimescaleDB HA, Redis replica |
| > 250k | > 500k/s | Kafka, 12 consumers, TimescaleDB multinode, Kubernetes HPA |

### Bottleneck identification

```bash
# Check queue depth (OPC UA client backed up?)
curl -s http://localhost:9090/api/v1/query?query=opcua_queue_depth | jq .

# Check consumer lag (Kafka consumers slow?)
curl -s http://localhost:9080  # Kafka UI → Consumer Groups → lag column

# Check DB write latency
curl -s "http://localhost:9090/api/v1/query?query=histogram_quantile(0.99,rate(consumer_batch_latency_sec_bucket[5m]))"

# Check TimescaleDB chunk compression
docker compose exec timescaledb-primary psql -U opcua_admin -d opcua -c \
  "SELECT chunk_name, compressed_total_size, uncompressed_total_size FROM chunk_compression_stats('tag_values');"
```

### Tuning dead-band filtering

Dead-band filtering is the most effective way to reduce write volume:

```sql
-- Set 0.5% deadband on all numeric tags
UPDATE tags SET deadband_pct = 0.5 WHERE data_type IN ('Double','Float','Int32');

-- Set absolute deadband on high-frequency tags
UPDATE tags SET deadband_value = 0.1, sample_interval_ms = 500
WHERE display_name LIKE '%Temperature%';
```

The Metrics tab shows what percentage of values are being filtered out.

### Kafka partition tuning

Default: 12 partitions → max 12 parallel consumers.
To increase: re-create the topic with more partitions (cannot reduce without data loss).

```bash
docker compose exec kafka-1 kafka-topics --bootstrap-server localhost:9092 \
  --alter --topic opcua.tag.values --partitions 24
```

Then scale consumers to match: `bash scripts/scale.sh consumers 24`

### TimescaleDB compression tuning

```sql
-- Increase compression aggressiveness
ALTER TABLE tag_values SET (
  timescaledb.compress,
  timescaledb.compress_orderby = 'time DESC',
  timescaledb.compress_segmentby = 'tag_id',
  timescaledb.compress_chunk_time_interval = '1 day'
);

-- Check compression ratio
SELECT
  pg_size_pretty(before_compression_total_bytes) AS before,
  pg_size_pretty(after_compression_total_bytes)  AS after,
  ROUND(100 - (after_compression_total_bytes::float / before_compression_total_bytes * 100), 1) AS pct_reduction
FROM hypertable_compression_stats('tag_values');
```

---

## Observability

### Service URLs

| Service | URL | Credentials |
|---|---|---|
| Platform dashboard | http://localhost:3000 | admin / Admin@123 |
| API docs (Swagger) | http://localhost:8000/api/docs | (JWT token) |
| Grafana | http://localhost:3001 | admin / admin_pass |
| Kafka UI | http://localhost:9080 | — |
| Prometheus | http://localhost:9090 | — |
| Alertmanager | http://localhost:9093 | — |
| HAProxy stats | http://localhost:8404/stats | admin / haproxy_stats_pass |
| Node metrics | http://localhost:9100/metrics | — |

### Key Grafana dashboards

Import these IDs from grafana.com:
- **1860** — Node Exporter Full (host metrics)
- **7589** — Kafka Overview
- **9628** — PostgreSQL Database
- **11835** — Redis Dashboard

### Key Prometheus queries

```promql
# OPC UA ingestion rate (rows/min)
rate(opcua_rows_written_total[1m]) * 60

# Dead-band filter effectiveness
rate(opcua_values_filtered_total[5m]) / rate(opcua_values_received_total[5m]) * 100

# API p99 latency
histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))

# Kafka consumer lag
kafka_consumergroup_lag{consumergroup="opcua-db-writers"}

# TimescaleDB active connections
pg_stat_activity_count{datname="opcua"}

# Redis memory usage %
redis_memory_used_bytes / redis_memory_max_bytes * 100
```

---

## Data Retention

| Layer | Default | Configure in |
|---|---|---|
| Raw tag values | 2 years | `init.sql` → `add_retention_policy` |
| Compressed raw (>7 days) | Forever (compressed) | `init.sql` → `add_compression_policy` |
| 1-minute aggregates | Forever | Continuous aggregate (no retention policy) |
| 1-hour aggregates | Forever | Continuous aggregate |
| 1-day aggregates | Forever | Continuous aggregate |
| Kafka topic | 7 days | `KAFKA_LOG_RETENTION_HOURS=168` |
| Prometheus | 30 days | `--storage.tsdb.retention.time=30d` |
| Loki logs | 30 days | `retention_period: 720h` |

To change raw retention:
```sql
SELECT remove_retention_policy('tag_values');
SELECT add_retention_policy('tag_values', INTERVAL '5 years');
```

---

## RBAC

| Role | Login | View Data | Ack Alarms | Manage Tags | Admin |
|---|---|---|---|---|---|
| VIEWER | ✓ | ✓ | — | — | — |
| OPERATOR | ✓ | ✓ | ✓ | — | — |
| ENGINEER | ✓ | ✓ | ✓ | Create/Delete | — |
| ADMIN | ✓ | ✓ | ✓ | Full | ✓ |

Create a new user:
```bash
curl -X POST http://localhost:8000/api/auth/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"operator@plant.com","username":"op1","password":"Secure@123","role_id":3}'
```

Roles: 1=ADMIN, 2=ENGINEER, 3=OPERATOR, 4=VIEWER

---

## Troubleshooting

### OPC UA client not connecting

```bash
# Check client logs
docker compose logs -f opcua-client

# Verify server is reachable
docker compose exec opcua-client python3 -c "
import asyncio
from asyncua import Client
async def test():
    async with Client('$OPC_SERVER_URL', timeout=5) as c:
        print('Connected:', await c.get_namespace_array())
asyncio.run(test())
"

# Use the Address Space Browser in the dashboard to test browsing
# → http://localhost:3000/opcua → Server Info tab
```

### TimescaleDB slow queries

```sql
-- Find slow queries
SELECT query, mean_exec_time, calls
FROM pg_stat_statements
ORDER BY mean_exec_time DESC LIMIT 10;

-- Check if continuous aggregates are refreshing
SELECT view_name, last_run_started_at, last_run_duration
FROM timescaledb_information.continuous_aggregate_stats;

-- Force refresh 1-minute aggregate for last hour
CALL refresh_continuous_aggregate('tag_values_1min',
  NOW() - INTERVAL '1 hour', NOW());
```

### Redis memory exhausted

```bash
docker compose exec redis-master redis-cli -a $REDIS_PASSWORD info memory

# Force eviction of old keys
docker compose exec redis-master redis-cli -a $REDIS_PASSWORD \
  config set maxmemory-policy allkeys-lru
```

### Kafka consumer lag growing

```bash
# Check lag in Kafka UI: http://localhost:9080
# Or via CLI:
docker compose exec kafka-1 kafka-consumer-groups \
  --bootstrap-server localhost:9092 \
  --group opcua-db-writers \
  --describe

# Add more consumers (edit docker-compose.scale.yml, add kafka-consumer-3, 4...)
docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d kafka-consumer-3
```

### WebSocket live updates not arriving

```bash
# Check Redis pub/sub is working
docker compose exec redis-master redis-cli -a $REDIS_PASSWORD \
  subscribe tag:updates

# Check WebSocket connection
# Open browser DevTools → Network → WS → look for /ws/live frames
```

---

## License

MIT — free to use, modify, and distribute.
