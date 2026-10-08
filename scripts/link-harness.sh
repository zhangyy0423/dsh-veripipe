#!/usr/bin/env bash
# Dev only: link the @deepseek-ai/* peers, zod and TypeScript from a local
# deepseek-harness checkout so `npm run build` can type-check src/ against the
# same packages the host loads at runtime. The links live in the gitignored
# node_modules/ and are never published or needed for installation.
# Usage: DSH_HARNESS=/path/to/deepseek-harness bash scripts/link-harness.sh
set -euo pipefail

harness="${DSH_HARNESS:?set DSH_HARNESS to a built deepseek-harness checkout}"
cd "$(dirname "$0")/.."
[ -d "$harness/packages/core/tools" ] || { echo "not a deepseek-harness checkout: $harness" >&2; exit 2; }

mkdir -p node_modules/@deepseek-ai node_modules/.bin
link() { ln -sfn "$harness/$2" "node_modules/$1"; }
link @deepseek-ai/cordis vendor/cordis
link @deepseek-ai/cosmokit vendor/cosmokit
link @deepseek-ai/schemastery vendor/schemastery
link @deepseek-ai/dsh-agent packages/core/agent
link @deepseek-ai/dsh-invariants packages/runtime-diagnostics/invariants
link @deepseek-ai/dsh-session packages/core/session
link @deepseek-ai/dsh-session-projection packages/session/session-projection
link @deepseek-ai/dsh-tools packages/core/tools

zod="$(ls -d "$harness"/node_modules/.pnpm/zod@4.4.3/node_modules/zod 2>/dev/null | head -1)"
[ -n "$zod" ] || { echo "zod@4.4.3 not found under $harness/node_modules/.pnpm" >&2; exit 2; }
ln -sfn "$zod" node_modules/zod
ts="$(cd "$harness/node_modules/typescript" 2>/dev/null && pwd -P)"
[ -n "$ts" ] || { echo "typescript not found under $harness/node_modules" >&2; exit 2; }
ln -sfn "$ts" node_modules/typescript
ln -sfn ../typescript/bin/tsc node_modules/.bin/tsc
echo "linked against $harness (tsc $(node_modules/.bin/tsc -v))"
