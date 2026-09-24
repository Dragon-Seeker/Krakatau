# Krakatau in the browser

Runs the patched Krakatau decompiler (Python) in a Web Worker via Pyodide.

## Build

    tools/build_web.sh /path/to/jdk      # writes web/public/krakatau-py.zip and jdk-stubs.jar

## Run the demo

    cd web/public && python3 -m http.server 8000
    # open http://localhost:8000/        (Pyodide loads from jsDelivr)

To self-host Pyodide instead (recommended for production / strict CSP), copy
`pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `python_stdlib.zip` and
`pyodide-lock.json` from the `pyodide@314.0.7` npm package into `web/public/pyodide/`
and open `http://localhost:8000/?pyodide=./pyodide/` (or pass `pyodideURL` to KrakClient).

Node smoke test: `cd web && npm i pyodide@314.0.7 && node node-test.mjs some.jar`

## Use in your own app

    import { KrakClient } from './krak-client.mjs';
    const krak = new KrakClient({ krakatauURL: '/krakatau-py.zip', stubURLs: ['/jdk-stubs.jar'] });
    const { jarId, classes } = await krak.openJar(await file.arrayBuffer());
    const { source, error } = await krak.decompile(jarId, 'com/example/Foo');
    await krak.closeJar(jarId);

Files: `krak-client.mjs` (main thread), `krak.worker.mjs` (worker, one request at a time),
`krak-core.mjs` (Pyodide driver; also importable in Node for tests/CLI use).

Extra stub jars (Minecraft, loader, library jars) improve cast/type output:

    python3 tools/make_stubs.py client.jar fabric-loader.jar -o mc-stubs.jar

Measured (Lithium, 699 classes, Java 25): ~3 s runtime startup, 65–400 ms per class,
output identical to CPython.

## Deploying via jsDelivr

`.github/workflows/web.yml` builds the assets, runs `web/ci-smoke.mjs` under Pyodide (the
release fails if lambdas, string concat, records etc. regress), and on a `web-v*` tag
publishes `web/public` to npm as `krakatau-web`. jsDelivr serves every npm version
automatically, so a release is:

    git tag web-v1.0.0 && git push origin web-v1.0.0

One-time setup: create the package on npmjs.com and add this repo/workflow as a Trusted
Publisher (or add an `NPM_TOKEN` secret and uncomment the env block in the workflow).
Rename the package in `web/public/package.json` if `krakatau-web` is taken.

Consumers then need no build step and no copies of the assets:

    import { KrakClient } from 'https://cdn.jsdelivr.net/npm/krakatau-web@1.0.0/krak-client.mjs';
    const krak = new KrakClient();   // zip + stubs load from the same CDN version

The client starts the worker through a same-origin `blob:` shim, because browsers don't
allow `new Worker()` on a cross-origin URL. Always pin an exact version: exact-version URLs
are cached permanently, while ranges and `@latest` are cached for a while and need a purge
(`https://purge.jsdelivr.net/npm/krakatau-web@latest/...`) after a release.
