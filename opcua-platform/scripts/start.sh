#!/usr/bin/env bash
# ================================================================
# OPC UA Platform — Quick Start Script
# ================================================================
set -euo pipefail

BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check prerequisites
command -v docker >/dev/null 2>&1 || error "Docker not found. Install from https://docs.docker.com/get-docker/"
command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || error "Docker Compose v2 not found."

# Create .env from example if not exists
if [ ! -f .env ]; then
  warn ".env not found — copying from .env.example"
  cp .env.example .env
  warn "Please edit .env with your OPC UA server details before continuing."
  echo ""
  read -p "Press Enter to continue with defaults (demo mode), or Ctrl+C to edit .env first..."
fi

info "Generating JWT secret..."
JWT=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || openssl rand -hex 32)
sed -i "s/replace_with_64_char_random_hex_string_here/$JWT/" .env 2>/dev/null || true

info "Starting platform services..."
docker compose pull --quiet
docker compose up -d --build

info "Waiting for TimescaleDB to be healthy..."
until docker compose exec timescaledb pg_isready -U opcua_admin -d opcua >/dev/null 2>&1; do
  sleep 2
  echo -n "."
done
echo ""
ok "TimescaleDB ready"

info "Waiting for API..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/api/health >/dev/null 2>&1; then
    break
  fi
  sleep 2
  echo -n "."
done
echo ""
ok "API ready"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}OPC UA Platform is running!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Dashboard:   http://localhost:3000"
echo "  API Docs:    http://localhost:8000/api/docs"
echo "  Grafana:     http://localhost:3001"
echo "  Metrics:     http://localhost:9090 (OPC UA client)"
echo ""
echo "  Default login: admin / Admin@123"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
