#!/usr/bin/env bash
# ================================================================
# OPC UA Platform — Scaling Utility
# Usage:
#   bash scripts/scale.sh consumers 4      # Scale DB writer consumers to 4
#   bash scripts/scale.sh api 3            # Scale API to 3 instances
#   bash scripts/scale.sh kafka-consumers 6 # Scale Kafka consumers to 6
#   bash scripts/scale.sh status           # Show all container health
#   bash scripts/scale.sh throughput       # Show live ingestion throughput
# ================================================================
set -euo pipefail

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }

COMMAND="${1:-status}"
SCALE="${2:-1}"

case "$COMMAND" in

  consumers | kafka-consumers)
    info "Scaling Kafka consumers to $SCALE instances..."
    # Docker Compose: add kafka-consumer-N services manually
    # Kubernetes:
    if kubectl get ns opcua-platform &>/dev/null 2>&1; then
      kubectl scale deployment kafka-consumer -n opcua-platform --replicas="$SCALE"
      ok "Kafka consumers scaled to $SCALE"
    else
      warn "Not in Kubernetes mode. To add consumers in Docker Compose:"
      echo "  1. Copy kafka-consumer-1 block in docker-compose.scale.yml"
      echo "  2. Rename to kafka-consumer-$SCALE"
      echo "  3. docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d"
    fi
    ;;

  api)
    info "Scaling API to $SCALE instances..."
    if kubectl get ns opcua-platform &>/dev/null 2>&1; then
      kubectl scale deployment api -n opcua-platform --replicas="$SCALE"
      ok "API scaled to $SCALE"
    else
      warn "Docker Compose: add api-N services in docker-compose.scale.yml then re-up"
    fi
    ;;

  status)
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}  OPC UA Platform — Service Status${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    docker compose -f docker-compose.scale.yml ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || \
    docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
    echo ""
    ;;

  throughput)
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${BLUE}  Live Ingestion Throughput${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Rows written in last minute
    ROWS=$(curl -sf "http://localhost:9090/api/v1/query?query=rate(opcua_rows_written_total[1m])*60" \
      2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['result'][0]['value'][1])" 2>/dev/null || echo "N/A")

    QUEUE=$(curl -sf "http://localhost:9090/api/v1/query?query=opcua_queue_depth" \
      2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data']['result'][0]['value'][1])" 2>/dev/null || echo "N/A")

    echo "  Rows/minute:   $ROWS"
    echo "  Queue depth:   $QUEUE"
    echo ""
    echo "  Full metrics:  http://localhost:9090"
    echo "  Grafana:       http://localhost:3001"
    echo "  Kafka UI:      http://localhost:9080"
    echo "  HAProxy stats: http://localhost:8404/stats"
    echo ""
    ;;

  upgrade)
    info "Rebuilding and restarting services with zero downtime..."
    docker compose -f docker-compose.yml -f docker-compose.scale.yml build
    docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --no-deps
    ok "Upgrade complete"
    ;;

  logs)
    SERVICE="${2:-opcua-client}"
    docker compose -f docker-compose.scale.yml logs -f --tail=100 "$SERVICE"
    ;;

  *)
    echo "Usage: bash scripts/scale.sh [consumers|api|status|throughput|upgrade|logs] [N]"
    exit 1
    ;;
esac
