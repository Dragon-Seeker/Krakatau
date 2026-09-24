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
