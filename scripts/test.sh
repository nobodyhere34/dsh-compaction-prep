#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -x "$CHECKOUT/node_modules/.bin/tsx" ]; then
  echo "test: set DSH_CHECKOUT to a deepseek-harness checkout with tsx installed" >&2
  exit 1
fi
cd "$ROOT"
export DSH_CHECKOUT="$CHECKOUT"
"$CHECKOUT/node_modules/.bin/tsx" --test tests/*.test.ts
