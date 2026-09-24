import type { ClassName, DecompileClassResult, DecompileResult, OpenJarResult } from './krak-client.mjs';

/** Anything with bytes: ArrayBuffer, a typed array, or a Node Buffer. */
export type Bytes = ArrayBuffer | ArrayBufferView;

export interface KrakCoreOptions {
  /** `loadPyodide` from the pyodide package (browser or Node). */
  loadPyodide: (options?: { indexURL?: string }) => Promise<unknown>;
  /** Pyodide runtime directory; omit in Node to use the installed package. */
  indexURL?: string;
  /** Contents of krakatau-py.zip. */
  krakatauZip: Bytes;
  /** Library stub jars, searched after the target jar. */
  stubs?: { name: string; bytes: Bytes }[];
  /** External class source; see setClassResolver. */
  resolveClass?: (name: ClassName) => Bytes | null | undefined | Promise<Bytes | null | undefined>;
  /** Force JSPI on/off (default: auto-detect WebAssembly.Suspending). */
  useJSPI?: boolean;
}

/** Synchronous Pyodide driver used inside the worker; also usable directly in Node. */
export declare class KrakCore {
  static create(options: KrakCoreOptions): Promise<KrakCore>;
  private constructor();
  readonly stubPaths: string[];
  /** Whether classes are resolved mid-decompile (JSPI) rather than by re-running. */
  readonly jspi: boolean;
  /** Set or clear the external class source. Answers are cached until this is called again. */
  setClassResolver(fn: ((name: ClassName) => Bytes | null | undefined | Promise<Bytes | null | undefined>) | null): void;
  openJar(bytes: Bytes): OpenJarResult;
  decompile(jarId: number, className: ClassName): Promise<DecompileResult>;
  closeJar(jarId: number): void;
  /** A classpath without a jar; returns an id usable wherever a jarId is. */
  createWorkspace(): number;
  /** Add class files to a workspace or jar; returns their internal names. */
  addClasses(id: number, classes: Bytes[]): ClassName[];
  /** Decompile one class file. Without an id a shared default workspace is used. */
  decompileClass(bytes: Bytes, options?: { id?: number; classpath?: Bytes[] }): Promise<DecompileClassResult>;
  close(id: number): void;
}
