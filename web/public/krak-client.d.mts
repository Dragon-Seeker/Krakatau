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
}

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

/** Promise-based client that runs the decompiler in a module Web Worker. */
export declare class KrakClient {
  constructor(options?: KrakClientOptions);
  readonly worker: Worker;
  /** Resolves once Pyodide, the decompiler and the stubs are loaded (~3 s cold). */
  readonly ready: Promise<{ ready: true }>;
  /** Load a jar. An ArrayBuffer is transferred to the worker and becomes unusable (detached) afterwards. */
  openJar(bytes: ArrayBuffer | Uint8Array): Promise<OpenJarResult>;
  decompile(jarId: number, className: ClassName): Promise<DecompileResult>;
  closeJar(jarId: number): Promise<void>;
  terminate(): void;
}

/** Messages accepted by krak.worker.mjs, for callers writing their own client. */
export type KrakRequest =
  | { id: number; type: 'init'; pyodideURL?: string; krakatauURL?: string; stubURLs?: string[] }
  | { id: number; type: 'openJar'; bytes: ArrayBuffer }
  | { id: number; type: 'decompile'; jarId: number; className: ClassName }
  | { id: number; type: 'closeJar'; jarId: number };

/** Messages posted back by krak.worker.mjs. */
export type KrakResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
