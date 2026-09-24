// Environment-agnostic core: drives the Python decompiler inside a Pyodide instance.
// Used by krak.worker.mjs in the browser, and can be imported directly in Node.

const GLUE = `
from Krakatau.api import Session, class_header
from Krakatau.environment import Environment

try:
    from pyodide.ffi import run_sync, can_run_sync
except ImportError:  # not running under Pyodide
    run_sync = None
    can_run_sync = lambda: False

_sessions = {}
_stub_env = None        # stubs only, to tell whether a class is already available without asking
_resolver = None        # JS function(name) -> bytes | null | Promise<bytes | null>
_resolved = {}          # name -> bytes delivered by the resolver (shared by all sessions)
_known_missing = set()  # names the resolver said it doesn't have
_pending = []           # names needed but not fetchable synchronously (no JSPI); JS fetches them

def _is_null(x):
    return x is None or type(x).__name__ == 'JsNull'

def _b(x):
    '''JS typed array proxy (or anything bytes-like) -> bytes'''
    return bytes(x.to_py()) if hasattr(x, 'to_py') else bytes(x)

def _resolve(name):
    if name in _resolved:
        return _resolved[name]
    if _resolver is None or name in _known_missing:
        return None
    if not can_run_sync():
        # No JSPI: we can't wait here. Record the name; JS fetches it and re-runs the decompile.
        if name not in _pending:
            _pending.append(name)
        return None
    return _store(name, run_sync(_resolver(name)))  # JSPI: pause here until JS answers

def _store(name, result):
    if _is_null(result):
        _known_missing.add(name)
        return None
    data = _b(result)
    _resolved[name] = data
    return data

def _attach(session):
    session.env.resolver = _resolve if _resolver is not None else None
    return session

def init(stub_paths):
    global _stub_env
    _stub_env = Environment()
    for p in stub_paths:
        _stub_env.addToPath(p)
    _stub_env.__enter__()

def set_resolver(fn):
    global _resolver
    _resolver = fn
    _resolved.clear()
    _known_missing.clear()
    del _pending[:]
    for s in _sessions.values():
        _attach(s)

def take_pending():
    items = list(_pending)
    del _pending[:]
    return items

def supply(name, result):
    '''Store a resolver answer; returns supertypes we will need too and do not have yet.'''
    data = _store(name, result)
    if data is None:
        return []
    try:
        _, sup, ifaces = class_header(data)
    except Exception:
        return []
    wanted = []
    for n in ([sup] if sup else []) + ifaces:
        if n in _resolved or n in _known_missing:
            continue
        if _stub_env._searchPath(n) is not None:
            continue
        wanted.append(n)
    return wanted

def open_jar(jar_id, path, stub_paths):
    old = _sessions.pop(jar_id, None)
    if old is not None:
        old.close()
    _sessions[jar_id] = _attach(Session([path] + list(stub_paths)))
    return Session.list_classes(path)

def create_workspace(ws_id, stub_paths):
    _sessions[ws_id] = _attach(Session(list(stub_paths)))

def add_classes(ws_id, datas):
    return _sessions[ws_id].add_classes([_b(d) for d in datas])

def decompile(jar_id, name):
    return _sessions[jar_id].decompile(name)

def decompile_class(ws_id, data, classpath):
    return _sessions[ws_id].decompile_bytes(_b(data), [_b(c) for c in classpath])

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

// JSPI lets Python block on a JS promise mid-decompile. Feature-detect the engine support.
const HAS_JSPI = typeof WebAssembly !== 'undefined' && typeof WebAssembly.Suspending === 'function';
const MAX_ROUNDS = 16;

export class KrakCore {
  /**
   * @param {object} opts
   * @param {Function} opts.loadPyodide  loadPyodide from the pyodide package
   * @param {string}  [opts.indexURL]    where Pyodide's runtime files live (browser)
   * @param {ArrayBuffer|ArrayBufferView} opts.krakatauZip  zip containing the Krakatau/ package
   * @param {{name: string, bytes: ArrayBuffer|ArrayBufferView}[]} [opts.stubs]  library stub jars
   * @param {(name: string) => any} [opts.resolveClass]  external class source, see setClassResolver
   * @param {boolean} [opts.useJSPI]     force JSPI on/off (default: auto-detect)
   */
  static async create({ loadPyodide, indexURL, krakatauZip, stubs = [], resolveClass, useJSPI }) {
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
    const core = new KrakCore(py, glue, stubPaths, useJSPI ?? HAS_JSPI);
    core._py('init', stubPaths);
    if (resolveClass) core.setClassResolver(resolveClass);
    return core;
  }

  constructor(py, glue, stubPaths, jspi) {
    this.py = py;
    this.glue = glue;
    this.stubPaths = stubPaths;
    /** Whether classes are resolved mid-decompile (JSPI) rather than by re-running. */
    this.jspi = jspi;
    this.resolveClass = null;
    this.nextId = 1;
    this.defaultWorkspace = null;
  }

  // Call a glue function synchronously, converting array arguments to Python lists.
  // Only string arrays become Python lists; arrays of byte buffers stay JS proxies.
  _conv(args) {
    return args.map((a) => (Array.isArray(a) && a.every((x) => typeof x === 'string') ? this.py.toPy(a) : a));
  }

  _py(name, ...args) {
    const conv = this._conv(args);
    try {
      return this.glue.get(name)(...conv);
    } finally {
      conv.forEach((c, i) => c !== args[i] && c.destroy?.());
    }
  }

  // Call a glue function that may need classes from the resolver, and return its dict result.
  async _resolving(name, ...args) {
    const fn = this.glue.get(name);
    const conv = this._conv(args);
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = this.jspi && this.resolveClass ? await fn.callPromising(...conv) : fn(...conv);
        const pending = this.resolveClass ? this._takePending() : [];
        if (pending.length === 0 || round === MAX_ROUNDS - 1) {
          try {
            return res.toJs({ dict_converter: Object.fromEntries });
          } finally {
            res.destroy();
          }
        }
        res.destroy();
        await this._fetchClosure(pending);
      }
    } finally {
      conv.forEach((c, i) => c !== args[i] && c.destroy?.());
    }
  }

  _takePending() {
    const res = this.glue.get('take_pending')();
    try {
      return res.toJs(); // [name, ...]
    } finally {
      res.destroy();
    }
  }

  // Resolve the missing classes plus their not-yet-available supertypes, so the next run
  // usually needs no further round trips.
  async _fetchClosure(queue) {
    const supply = this.glue.get('supply');
    const seen = new Set(queue);
    while (queue.length) {
      const batch = queue;
      queue = [];
      const results = await Promise.all(batch.map(async (name) => {
        try { return await this.resolveClass(name); } catch { return null; }
      }));
      batch.forEach((name, i) => {
        const r = results[i];
        const wantedProxy = supply(name, r == null ? null : toU8(r));
        const wanted = wantedProxy.toJs();
        wantedProxy.destroy();
        for (const w of wanted) if (!seen.has(w)) { seen.add(w); queue.push(w); }
      });
    }
  }

  /**
   * Set an external source for classes the decompiler can't find in the jar, workspace or stubs,
   * e.g. the game jar, a loader, or another mod. Called with an internal name ("a/b/C"); return
   * the class file bytes, or null/undefined if unknown. May be async. Answers are cached until
   * the resolver is replaced. Pass null to remove.
   */
  setClassResolver(fn) {
    this.resolveClass = fn || null;
    // Python (JSPI path) gets a wrapper that always yields a plain Uint8Array or null.
    const wrapped = fn ? async (name) => {
      try {
        const r = await fn(name);
        return r == null ? null : toU8(r);
      } catch {
        return null;
      }
    } : null;
    this._py('set_resolver', wrapped);
  }

  /** Load a jar; returns { jarId, classes: string[] } (internal names like "com/example/Foo"). */
  openJar(bytes) {
    const jarId = this.nextId++;
    const path = `/jars/${jarId}.jar`;
    this.py.FS.writeFile(path, toU8(bytes));
    const res = this._py('open_jar', jarId, path, this.stubPaths);
    try {
      return { jarId, classes: res.toJs() };
    } finally {
      res.destroy();
    }
  }

  /** Decompile one class of an opened jar; resolves to { source, error }. */
  async decompile(jarId, className) {
    const out = await this._resolving('decompile', jarId, className);
    return { source: out.source ?? null, error: out.error ?? null };
  }

  /** A classpath without a jar; returns an id usable wherever a jarId is. */
  createWorkspace() {
    const id = this.nextId++;
    this._py('create_workspace', id, this.stubPaths);
    return id;
  }

  /** Add class files to a workspace or jar; returns their internal names. */
  addClasses(id, classes) {
    const res = this._py('add_classes', id, classes.map(toU8));
    try {
      return res.toJs();
    } finally {
      res.destroy();
    }
  }

  /**
   * Decompile one class file given as bytes. `classpath` class files are visible for this call only.
   * Without an id a shared default workspace is used (library stubs stay parsed between calls).
   */
  async decompileClass(bytes, { id, classpath = [] } = {}) {
    if (id == null) id = this.defaultWorkspace ??= this.createWorkspace();
    const out = await this._resolving('decompile_class', id, toU8(bytes), classpath.map(toU8));
    return { className: out.class_name ?? null, source: out.source ?? null, error: out.error ?? null };
  }

  /** Close a jar or workspace. */
  close(id) {
    this.closeJar(id);
  }

  closeJar(jarId) {
    this._py('close_jar', jarId);
    try { this.py.FS.unlink(`/jars/${jarId}.jar`); } catch { /* workspace, or already gone */ }
  }
}
