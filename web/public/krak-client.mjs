// Promise-based main-thread client for krak.worker.mjs.
//
//   const krak = new KrakClient();   // assets default to files next to the worker
//   await krak.ready;
//   const { jarId, classes } = await krak.openJar(await file.arrayBuffer());
//   const { source, error } = await krak.decompile(jarId, classes[0]);
// Browsers won't start a Worker from another origin (e.g. a CDN), so in that case we start a
// tiny same-origin blob: worker whose only job is to import the real worker module.
function startWorker(url) {
  const abs = new URL(url, location.href);
  if (abs.origin === location.origin) return new Worker(abs, { type: 'module' });
  const shim = new Blob([`import ${JSON.stringify(abs.href)};`], { type: 'text/javascript' });
  const blobURL = URL.createObjectURL(shim);
  const worker = new Worker(blobURL, { type: 'module' });
  setTimeout(() => URL.revokeObjectURL(blobURL), 30000);
  return worker;
}

// Caller-supplied URLs are relative to the page; defaults (unset) are resolved by the worker
// relative to itself, so assets published next to the worker are found automatically.
const absolute = (u) => (u == null ? undefined : new URL(u, location.href).href);

export class KrakClient {
  /**
   * @param {object} [opts]
   * @param {string|URL} [opts.workerURL]   defaults to krak.worker.mjs next to this file
   * @param {string} [opts.pyodideURL]      Pyodide runtime directory (default: jsDelivr)
   * @param {string} [opts.krakatauURL]     default: krakatau-py.zip next to the worker
   * @param {string[]} [opts.stubURLs]      default: [jdk-stubs.jar next to the worker]
   */
  constructor({ workerURL = new URL('./krak.worker.mjs', import.meta.url), pyodideURL, krakatauURL, stubURLs } = {}) {
    this.worker = startWorker(workerURL);
    const initOptions = {
      pyodideURL: absolute(pyodideURL),
      krakatauURL: absolute(krakatauURL),
      stubURLs: stubURLs && stubURLs.map(absolute),
    };
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'Worker error'));
      this.pending.clear();
    };
    this.ready = this._call('init', initOptions);
  }

  _call(type, args = {}, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...args }, transfer);
    });
  }

  /** The buffer is transferred to the worker (it becomes unusable here). */
  async openJar(bytes) {
    await this.ready;
    const buf = bytes instanceof ArrayBuffer ? bytes : bytes.slice().buffer;
    return this._call('openJar', { bytes: buf }, [buf]);
  }

  async decompile(jarId, className) {
    await this.ready;
    return this._call('decompile', { jarId, className });
  }

  async closeJar(jarId) {
    await this.ready;
    return this._call('closeJar', { jarId });
  }

  terminate() {
    this.worker.terminate();
  }
}
