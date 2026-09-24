#!/usr/bin/env bash
# Packs web/public exactly as it would be published, installs it into a scratch project and
# type-checks browser, Node and CDN-URL usage. Wrong calls are marked @ts-expect-error, so
# declarations that are too loose (e.g. `any`) fail this check too.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PUB="$HERE/../../public"
TMP="$(mktemp -d)"
TGZ="$(cd "$PUB" && npm pack --silent --pack-destination "$TMP")"
cd "$TMP"
npm init -y >/dev/null
npm install --silent --no-save typescript @types/node "pyodide@${PYODIDE_VERSION:-314.0.7}" "$TMP/$TGZ"
cp "$HERE"/*.mts . && cp "$PUB/krakatau-cdn.d.ts" .
for res in "bundler esnext" "nodenext nodenext"; do
  set -- $res
  npx tsc --noEmit --strict --skipLibCheck false --lib es2022,dom --target es2022 --moduleResolution $1 --module $2 browser.mts wrong.mts
  npx tsc --noEmit --strict --skipLibCheck --lib esnext --types node --target es2022 --moduleResolution $1 --module $2 node.mts
  echo "types OK ($1)"
done
npx tsc --noEmit --strict --lib es2022,dom --target es2022 --module esnext --moduleResolution bundler cdn.mts krakatau-cdn.d.ts
echo "CDN URL types OK"
