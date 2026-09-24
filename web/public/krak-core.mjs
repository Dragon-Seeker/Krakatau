// Environment-agnostic core: drives the Python decompiler inside a Pyodide instance.
// Used by krak.worker.mjs in the browser, and can be imported directly in Node for testing.

const GLUE = `
from Krakatau.api import Session
_sessions = {}

def open_jar(jar_id, path, stub_paths):
    old = _sessions.pop(jar_id, None)
    if old is not None:
        old.close()
    _sessions[jar_id] = Session([path] + list(stub_paths))
    return Session.list_classes(path)

def decompile(jar_id, name):
    return _sessions[jar_id].decompile(name)

def close_jar(jar_id):
    s = _sessions.pop(jar_id, None)
    if s is not None:
        s.close()
`;

// Accept ArrayBuffer, any typed array, or a Node Buffer (which Pyodide rejects) as a plain Uint8Array.
function toU8(bytes) {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export class KrakCore {
  /**
   * @param {object} opts
   * @param {Function} opts.loadPyodide  loadPyodide from the pyodide package
   * @param {string}  [opts.indexURL]    where Pyodide's runtime files live (browser)
   * @param {ArrayBuffer|Uint8Array} opts.krakatauZip  zip containing the Krakatau/ package
   * @param {{name: string, bytes: ArrayBuffer|Uint8Array}[]} [opts.stubs]  library stub jars
   */
  static async create({ loadPyodide, indexURL, krakatauZip, stubs = [] }) {
    const py = await loadPyodide(indexURL ? { indexURL } : {});
    py.unpackArchive(toU8(krakatauZip), 'zip', { extractDir: '/krak' });
    py.FS.mkdirTree('/stubs');
    py.FS.mkdirTree('/jars');
    const stubPaths = stubs.map(({ name, bytes }) => {
      const path = `/stubs/${name}`;
      py.FS.writeFile(path, toU8(bytes));
      return path;
    });
    py.runPython("import sys\nif '/krak' not in sys.path: sys.path.insert(0, '/krak')");
    const glue = py.globals.get('dict')();
    py.runPython(GLUE, { globals: glue });
    return new KrakCore(py, glue, stubPaths);
  }

  constructor(py, glue, stubPaths) {
    this.py = py;
    this.glue = glue;
    this.stubPaths = stubPaths;
    this.nextId = 1;
  }

  /** Load a jar; returns { jarId, classes: string[] } (internal names like "com/example/Foo"). */
  openJar(bytes) {
    const jarId = this.nextId++;
    const path = `/jars/${jarId}.jar`;
    this.py.FS.writeFile(path, toU8(bytes));
    const stubs = this.py.toPy(this.stubPaths);
    try {
      const res = this.glue.get('open_jar')(jarId, path, stubs);
      const classes = res.toJs();
      res.destroy();
      return { jarId, classes };
    } finally {
      stubs.destroy();
    }
  }

  /** Decompile one class; returns { source: string|null, error: string|null }. */
  decompile(jarId, className) {
    const res = this.glue.get('decompile')(jarId, className);
    try {
      const out = res.toJs({ dict_converter: Object.fromEntries });
      return { source: out.source ?? null, error: out.error ?? null };
    } finally {
      res.destroy();
    }
  }

  closeJar(jarId) {
    this.glue.get('close_jar')(jarId);
    try { this.py.FS.unlink(`/jars/${jarId}.jar`); } catch { /* already gone */ }
  }
}
