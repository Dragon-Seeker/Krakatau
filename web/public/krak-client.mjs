// Promise-based main-thread client for krak.worker.mjs.
//
//   const krak = new KrakClient({ krakatauURL: './krakatau-py.zip', stubURLs: ['./jdk-stubs.jar'] });
//   await krak.ready;
//   const { jarId, classes } = await krak.openJar(await file.arrayBuffer());
//   const { source, error } = await krak.decompile(jarId, classes[0]);
export class KrakClient {
  constructor({ workerURL = new URL('./krak.worker.mjs', import.meta.url), ...initOptions } = {}) {
    this.worker = new Worker(workerURL, { type: 'module' });
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
