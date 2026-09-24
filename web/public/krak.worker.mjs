// Module worker: new Worker(new URL('./krak.worker.mjs', import.meta.url), { type: 'module' })
// Messages in:  { id, type: 'init' | 'openJar' | 'decompile' | 'closeJar', ...args }
// Messages out: { id, ok: true, result } | { id, ok: false, error }
import { KrakCore } from './krak-core.mjs';

const DEFAULT_PYODIDE = 'https://cdn.jsdelivr.net/npm/pyodide@314.0.7/';
// Resolve against this module's real URL, not self.location: when loaded from a CDN the
// worker runs inside a same-origin blob: wrapper, and relative URLs must still hit the CDN.
const HERE = import.meta.url;
let core = null;

// Class requests forwarded to the page's resolveClass (functions can't cross threads).
let nextResolveId = 1;
const resolving = new Map();
function askPage(name) {
  return new Promise((resolve) => {
    const reqId = nextResolveId++;
    resolving.set(reqId, resolve);
    self.postMessage({ type: 'resolveClass', reqId, name });
  });
}

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.arrayBuffer();
}

const handlers = {
  async init({ pyodideURL = DEFAULT_PYODIDE, krakatauURL = './krakatau-py.zip', stubURLs = ['./jdk-stubs.jar'], hasResolver = false, useJSPI }) {
    if (core) return { ready: true };
    const base = new URL(pyodideURL, HERE).href;
    const { loadPyodide } = await import(new URL('pyodide.mjs', base).href);
    const [krakatauZip, ...stubBytes] = await Promise.all(
      [krakatauURL, ...stubURLs].map((u) => fetchBytes(new URL(u, HERE).href)));
    const stubs = stubBytes.map((bytes, i) => ({ name: `stub${i}.jar`, bytes }));
    core = await KrakCore.create({ loadPyodide, indexURL: base, krakatauZip, stubs,
      resolveClass: hasResolver ? askPage : undefined, useJSPI });
    return { ready: true, jspi: core.jspi };
  },
  openJar: ({ bytes }) => core.openJar(bytes),
  decompile: ({ jarId, className }) => core.decompile(jarId, className),
  closeJar: ({ jarId }) => core.closeJar(jarId),
  setResolver: ({ enabled }) => core.setClassResolver(enabled ? askPage : null),
  createWorkspace: () => core.createWorkspace(),
  addClasses: ({ workspaceId, classes }) => core.addClasses(workspaceId, classes),
  decompileClass: ({ bytes, workspaceId, classpath }) => core.decompileClass(bytes, { id: workspaceId, classpath }),
};

// Requests are handled strictly one at a time; Python is single-threaded anyway.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  // Answers to resolveClass requests bypass the queue: the request that asked is still running.
  if (data.type === 'resolvedClass') {
    const resolve = resolving.get(data.reqId);
    resolving.delete(data.reqId);
    resolve?.(data.bytes ?? null);
    return;
  }
  const { id, type, ...args } = data;
  queue = queue.then(async () => {
    try {
      if (type !== 'init' && !core) throw new Error('Worker not initialised; send "init" first');
      const handler = handlers[type];
      if (!handler) throw new Error(`Unknown message type: ${type}`);
      self.postMessage({ id, ok: true, result: await handler(args) });
    } catch (err) {
      self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
    }
  });
};
