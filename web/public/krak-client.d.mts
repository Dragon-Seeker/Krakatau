/** Internal class name, e.g. "com/example/Foo" or "com/example/Foo$Inner". */
export type ClassName = string;

export interface KrakClientOptions {
  /** URL of krak.worker.mjs. Defaults to the file next to krak-client.mjs; cross-origin URLs are supported. */
  workerURL?: string | URL;
  /** Pyodide runtime directory. Defaults to jsDelivr (the pinned version). */
  pyodideURL?: string;
  /** URL of krakatau-py.zip. Relative URLs resolve against the page; unset uses the file next to the worker. */
  krakatauURL?: string;
  /** Library stub jars (see tools/make_stubs.py). Unset uses jdk-stubs.jar next to the worker. */
  stubURLs?: string[];
  /**
   * External source for classes that aren't in the jar/workspace/stubs (game jar, loader, other
   * mods...). Gets an internal name like "net/minecraft/world/entity/Entity"; return the class
   * file's bytes, or null/undefined if unknown. May be async. Runs on your thread; answers are
   * cached in the worker until setClassResolver is called again.
   */
  resolveClass?: ClassResolver;
  /** Force JSPI on/off for class resolution (default: auto-detect). Mainly for testing. */
  useJSPI?: boolean;
}

export type ClassResolver = (name: ClassName) => ClassBytes | null | undefined | Promise<ClassBytes | null | undefined>;

export interface OpenJarResult {
  jarId: number;
  classes: ClassName[];
}

export interface DecompileResult {
  /** Java source, or null if the whole class failed. Individual failed methods are emitted as comments. */
  source: string | null;
  /** Error message / Python traceback when the class failed. */
  error: string | null;
}

/** Bytes of a .class file (or anything that can be viewed as bytes). */
export type ClassBytes = ArrayBuffer | ArrayBufferView;

export interface DecompileClassResult extends DecompileResult {
  /** Internal name read from the class file itself, e.g. "com/example/Foo"; null if unreadable. */
  className: ClassName | null;
}

export interface DecompileClassOptions {
  /** Other class files visible for this call only (supertypes, interfaces, nest mates). Optional. */
  classpath?: ClassBytes[];
  /** A workspace, or an opened jar's id, whose classes should also be visible. */
  workspace?: KrakWorkspace | number;
}

/** A reusable classpath of in-memory classes, e.g. all classes of the mod being reviewed. */
export declare class KrakWorkspace {
  private constructor();
  readonly id: number;
  /** Add class files that stay visible to later calls. Returns their internal names. */
  addClasses(classes: ClassBytes[]): Promise<ClassName[]>;
  decompileClass(bytes: ClassBytes, options?: { classpath?: ClassBytes[] }): Promise<DecompileClassResult>;
  close(): Promise<void>;
}

/** Promise-based client that runs the decompiler in a module Web Worker. */
export declare class KrakClient {
  constructor(options?: KrakClientOptions);
  readonly worker: Worker;
  /**
   * Resolves once Pyodide, the decompiler and the stubs are loaded (~3 s cold). `jspi` tells
   * whether classes are resolved mid-decompile (JSPI) or by re-running with the fetched classes.
   */
  readonly ready: Promise<{ ready: true; jspi: boolean }>;
  /** Set or clear (null) the external class source; see KrakClientOptions.resolveClass. */
  setClassResolver(fn: ClassResolver | null): Promise<void>;
  /** Load a jar. An ArrayBuffer is transferred to the worker and becomes unusable (detached) afterwards. */
  openJar(bytes: ArrayBuffer | Uint8Array): Promise<OpenJarResult>;
  decompile(jarId: number, className: ClassName): Promise<DecompileResult>;
  closeJar(jarId: number): Promise<void>;
  /** Decompile one class file already in memory. Bytes are copied, so your buffer stays usable. */
  decompileClass(bytes: ClassBytes, options?: DecompileClassOptions): Promise<DecompileClassResult>;
  createWorkspace(): Promise<KrakWorkspace>;
  terminate(): void;
}

/** Messages accepted by krak.worker.mjs, for callers writing their own client. */
export type KrakRequest =
  | { id: number; type: 'init'; pyodideURL?: string; krakatauURL?: string; stubURLs?: string[]; hasResolver?: boolean }
  | { id: number; type: 'setResolver'; enabled: boolean }
  | { type: 'resolvedClass'; reqId: number; bytes: ClassBytes | null }
  | { id: number; type: 'openJar'; bytes: ArrayBuffer }
  | { id: number; type: 'decompile'; jarId: number; className: ClassName }
  | { id: number; type: 'closeJar'; jarId: number }
  | { id: number; type: 'createWorkspace' }
  | { id: number; type: 'addClasses'; workspaceId: number; classes: ClassBytes[] }
  | { id: number; type: 'decompileClass'; bytes: ClassBytes; classpath?: ClassBytes[]; workspaceId?: number };

/** Messages posted back by krak.worker.mjs. */
export type KrakResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
  | { type: 'resolveClass'; reqId: number; name: ClassName };
