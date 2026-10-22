#!/bin/bash
# Build dsh-compaction-prep: link checkout seams into node_modules, then tsc src → lib.
# Requires DSH_CHECKOUT pointing at a dsh source checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
node -e "const fs=require('fs');fs.rmSync('node_modules/@standard-schema',{recursive:true,force:true})"
link_pkg @deepseek-ai/cordis vendor/cordis
link_pkg cosmokit vendor/cosmokit
link_pkg @deepseek-ai/schemastery vendor/schemastery
link_pkg @deepseek-ai/dsh-tools packages/core/tools
link_pkg @deepseek-ai/dsh-session packages/core/session
link_pkg @deepseek-ai/dsh-agent packages/core/agent
link_pkg @deepseek-ai/dsh-llm packages/llm/llm
link_pkg @deepseek-ai/dsh-compaction packages/compaction/compaction
link_pkg @deepseek-ai/dsh-settings packages/settings/settings
link_pkg @deepseek-ai/dsh-token-meter packages/llm/token-meter
link_pkg @types/node node_modules/@types/node

echo "=== Vendoring billion-context-dsh (dist copy + own package.json) ==="
rm -rf node_modules/billion-context-dsh
mkdir -p node_modules/billion-context-dsh
cp "$ROOT/../billion-context-dsh/dist/index.js" node_modules/billion-context-dsh/index.js
cp "$ROOT/../billion-context-dsh/dist/index.d.ts" node_modules/billion-context-dsh/index.d.ts
cat > node_modules/billion-context-dsh/package.json <<'PKG'
{
  "name": "billion-context-dsh",
  "version": "0.2.27",
  "type": "module",
  "main": "./index.js",
  "types": "./index.d.ts",
  "exports": { ".": { "types": "./index.d.ts", "default": "./index.js" } }
}
PKG

STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
if [ -n "$STD_SCHEMA" ]; then
  node -e "
    const fs = require('fs');
    fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
    fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
    fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
  " "$STD_SCHEMA/node_modules/@standard-schema/spec"
else
  echo "build: @standard-schema/spec not found; skipLibCheck should cover it" >&2
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json
echo "=== Build complete ==="
ls -la lib/ lib/types/ 2>/dev/null
