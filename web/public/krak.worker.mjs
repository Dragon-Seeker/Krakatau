// Module worker: new Worker(new URL('./krak.worker.mjs', import.meta.url), { type: 'module' })
// Messages in:  { id, type: 'init' | 'openJar' | 'decompile' | 'closeJar', ...args }
// Messages out: { id, ok: true, result } | { id, ok: false, error }
import { KrakCore } from './krak-core.mjs';

const DEFAULT_PYODIDE = 'https://cdn.jsdelivr.net/npm/pyodide@314.0.7/';
let core = null;

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.arrayBuffer();
}

const handlers = {
  async init({ pyodideURL = DEFAULT_PYODIDE, krakatauURL, stubURLs = [] }) {
    if (core) return { ready: true };
    const base = new URL(pyodideURL, self.location.href).href;
    const { loadPyodide } = await import(new URL('pyodide.mjs', base).href);
    const [krakatauZip, ...stubBytes] = await Promise.all(
      [krakatauURL, ...stubURLs].map((u) => fetchBytes(new URL(u, self.location.href).href)));
    const stubs = stubBytes.map((bytes, i) => ({ name: `stub${i}.jar`, bytes }));
    core = await KrakCore.create({ loadPyodide, indexURL: base, krakatauZip, stubs });
    return { ready: true };
  },
  openJar: ({ bytes }) => core.openJar(bytes),
  decompile: ({ jarId, className }) => core.decompile(jarId, className),
  closeJar: ({ jarId }) => core.closeJar(jarId),
};

// Requests are handled strictly one at a time; Python is single-threaded anyway.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
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
