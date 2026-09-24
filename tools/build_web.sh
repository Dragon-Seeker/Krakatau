#!/usr/bin/env bash
# Builds the browser assets into web/public:
#   krakatau-py.zip   the Python decompiler package, unpacked into Pyodide at startup
#   jdk-stubs.jar     header-only JDK classes (needs JAVA_HOME or --jdk to point at a JDK)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${OUT:-$ROOT/web/public}"
JDK="${1:-${JAVA_HOME:-}}"
mkdir -p "$OUT"

rm -f "$OUT/krakatau-py.zip"
(cd "$ROOT" && python3 - "$OUT/krakatau-py.zip" <<'PY'
import os, sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk('Krakatau'):
        dirs[:] = [d for d in dirs if d not in ('__pycache__', 'assembler')]
        for f in files:
            if f.endswith('.py'):
                z.write(os.path.join(root, f))
PY
)
echo "wrote $OUT/krakatau-py.zip ($(du -h "$OUT/krakatau-py.zip" | cut -f1))"

if [ -n "$JDK" ]; then
  python3 "$ROOT/tools/make_stubs.py" --jdk "$JDK" --modules java.base -o "$OUT/jdk-stubs.jar"
else
  echo "No JDK given (pass a path or set JAVA_HOME); skipping jdk-stubs.jar"
fi
