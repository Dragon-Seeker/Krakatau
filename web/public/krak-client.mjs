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

export class KrakWorkspace {
  constructor(client, id) {
    this.client = client;
    this.id = id;
  }
  /** Add classfiles that stay visible to later decompiles in this workspace. Returns their names. */
  addClasses(classes) {
    return this.client._call('addClasses', { workspaceId: this.id, classes });
  }
  decompileClass(bytes, { classpath = [] } = {}) {
    return this.client.decompileClass(bytes, { classpath, workspace: this });
  }
  close() {
    return this.client._call('closeJar', { jarId: this.id });
  }
}

export class KrakClient {
  /**
   * @param {object} [opts]
   * @param {string|URL} [opts.workerURL]   defaults to krak.worker.mjs next to this file
   * @param {string} [opts.pyodideURL]      Pyodide runtime directory (default: jsDelivr)
   * @param {string} [opts.krakatauURL]     default: krakatau-py.zip next to the worker
   * @param {string[]} [opts.stubURLs]      default: [jdk-stubs.jar next to the worker]
   */
  constructor({ workerURL = new URL('./krak.worker.mjs', import.meta.url), pyodideURL, krakatauURL, stubURLs, resolveClass, useJSPI } = {}) {
    this.worker = startWorker(workerURL);
    this.resolveClass = resolveClass || null;
    const initOptions = {
      pyodideURL: absolute(pyodideURL),
      krakatauURL: absolute(krakatauURL),
      stubURLs: stubURLs && stubURLs.map(absolute),
      hasResolver: !!this.resolveClass,
      useJSPI,
    };
    this.pending = new Map();
    this.nextId = 1;
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'resolveClass') return this._answer(data);
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

  async _answer({ reqId, name }) {
    let bytes = null;
    try {
      const r = this.resolveClass ? await this.resolveClass(name) : null;
      if (r != null) bytes = r instanceof ArrayBuffer ? r : new Uint8Array(r.buffer, r.byteOffset, r.byteLength);
    } catch (err) {
      console.warn(`krakatau: resolveClass(${name}) failed`, err);
    }
    this.worker.postMessage({ type: 'resolvedClass', reqId, bytes }); // copied, not transferred
  }

  /**
   * Set (or clear with null) the external class source. Called with an internal name such as
   * "net/minecraft/world/entity/Entity"; return the class file bytes, or null if unknown. May be
   * async. Answers are cached in the worker until the resolver is changed.
   */
  async setClassResolver(fn) {
    this.resolveClass = fn || null;
    await this.ready;
    return this._call('setResolver', { enabled: !!fn });
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

  /**
   * Decompile a single classfile you already have in memory (e.g. read from a zip in JS).
   * The bytes are copied, not transferred, so your buffer stays usable.
   *
   * @param bytes      the .class file
   * @param options.classpath  other classfiles visible for this call only (supertypes, siblings);
   *                           optional, but improves casts and type output
   * @param options.workspace  a KrakWorkspace or jarId whose classes should also be visible
   */
  async decompileClass(bytes, { classpath = [], workspace } = {}) {
    await this.ready;
    const workspaceId = workspace == null ? undefined : (typeof workspace === 'number' ? workspace : workspace.id);
    return this._call('decompileClass', { bytes, classpath, workspaceId });
  }

  /** A reusable classpath of in-memory classes, for decompiling many classes from the same mod. */
  async createWorkspace() {
    await this.ready;
    return new KrakWorkspace(this, await this._call('createWorkspace'));
  }

  terminate() {
    this.worker.terminate();
  }
}
