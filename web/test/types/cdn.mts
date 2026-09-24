import { KrakClient } from 'https://cdn.jsdelivr.net/npm/krakatau-web@1.0.0/krak-client.mjs';
const krak = new KrakClient();
const { jarId } = await krak.openJar(new ArrayBuffer(0));
// @ts-expect-error still strictly typed through the URL
await krak.decompile(String(jarId), 'a/B');
