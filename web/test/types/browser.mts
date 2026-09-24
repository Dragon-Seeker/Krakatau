import { KrakClient, type DecompileResult, type KrakRequest } from 'krakatau-web';

export async function run(file: File): Promise<string> {
  const krak = new KrakClient({ stubURLs: ['/stubs/mc-stubs.jar'] });
  await krak.ready;
  const { jarId, classes } = await krak.openJar(await file.arrayBuffer());
  const r: DecompileResult = await krak.decompile(jarId, classes[0]);
  await krak.closeJar(jarId);
  const msg: KrakRequest = { id: 1, type: 'decompile', jarId, className: 'a/B' };
  void msg;
  return r.source ?? r.error ?? '';
}

export async function single(bytes: Uint8Array, siblings: Uint8Array[]) {
  const krak = new KrakClient({ resolveClass: async (name) => (name === 'a/B' ? siblings[0] : null) });
  const { jspi } = await krak.ready;
  void jspi;
  await krak.setClassResolver((name) => (name.length ? null : undefined)); // sync resolvers are fine too
  const one = await krak.decompileClass(bytes, { classpath: siblings });
  const name: string | null = one.className;
  const ws = await krak.createWorkspace();
  const added: string[] = await ws.addClasses(siblings);
  const two = await ws.decompileClass(bytes);
  await ws.close();
  return [name, added, two.source];
}
