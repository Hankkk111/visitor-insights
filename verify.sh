#!/usr/bin/env bash
# One-shot local check: install deps, run tests, build the warehouse and the web app.
# Output goes to the terminal and to verify.log.
set -uo pipefail
cd "$(dirname "$0")"
exec > >(tee verify.log) 2>&1

step() { echo; echo "===== $1 ====="; }
fail() { echo; echo "FAILED at: $1"; exit 1; }

step "Python"
PY=""
for c in python3.13 python3.12 python3.11 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'; then PY="$c"; break; fi
done
[ -n "$PY" ] || fail "Python 3.11+ not found (brew install python@3.12)"
"$PY" --version

step "Pipeline: install"
cd pipeline
[ -d .venv ] || "$PY" -m venv .venv
source .venv/bin/activate
pip install -q --upgrade pip && pip install -q -e ".[dev]" || fail "pip install"

step "Pipeline: lint + tests"
ruff check . || fail "ruff"
pytest -q || fail "pytest"

step "Pipeline: build warehouse (live APIs, falls back to offline)"
visitor-pipeline run --mode live || { echo "live mode failed, using offline"; visitor-pipeline run --mode offline || fail "pipeline run"; }
deactivate
cd ..

step "Web: install"
cd web
node --version
npm install --no-audit --no-fund || fail "npm install"

step "Web: tests"
npm test || fail "vitest"

step "Web: build"
npm run build || fail "next build"

step "Web: typecheck"
npm run typecheck || fail "tsc"

echo; echo "ALL CHECKS PASSED"
