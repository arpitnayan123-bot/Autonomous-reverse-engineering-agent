#!/usr/bin/env bash
# REA one-command setup (Capability C6).
#   ./scripts/setup.sh           — core platform (deps, db, build check)
#   ./scripts/setup.sh --retools — also build the classical RE tool images
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== REA setup =="
command -v bun >/dev/null || { echo "bun is required: https://bun.sh"; exit 1; }

echo "-- 1/4 dependencies"
bun install

echo "-- 2/4 environment"
[ -f .env ] || { cp .env.example .env; echo "   created .env from .env.example (review it)"; }

echo "-- 3/4 database"
bun run db:generate
bun run db:push

echo "-- 4/4 seed content (bundled skills + model fallbacks)"
bun run skills:seed || true
bun -e 'import("./src/server/models/registry").then(async (m) => { await m.seedDefaults(); console.log("model registry seeded"); process.exit(0); })' || true

if [ "${1:-}" = "--retools" ]; then
  echo "-- building classical RE tool images (ghidra/rizin/pycdc/angr)"
  command -v docker >/dev/null || { echo "   docker not found — skipping (build later: see docker/README.md)"; }
  docker compose -f docker/docker-compose.yml --profile retools build || echo "   some images failed to build — see docker/README.md"
fi

echo ""
echo "REA is ready:  bun run dev    →  http://localhost:3000"
echo "Optional:      bun run bench  (benchmark + leaderboard sync), scripts/mcp-server.ts (MCP), vscode/ extension"
