import type { ClassName, DecompileResult, OpenJarResult } from './krak-client.mjs';

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
}

/** Synchronous Pyodide driver used inside the worker; also usable directly in Node. */
export declare class KrakCore {
  static create(options: KrakCoreOptions): Promise<KrakCore>;
  private constructor();
  readonly stubPaths: string[];
  openJar(bytes: Bytes): OpenJarResult;
  decompile(jarId: number, className: ClassName): DecompileResult;
  closeJar(jarId: number): void;
}
