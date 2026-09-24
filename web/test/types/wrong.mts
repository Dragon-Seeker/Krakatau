import { KrakClient } from 'krakatau-web';
const k = new KrakClient();
// @ts-expect-error jarId must be a number
k.decompile('1', 'a/B');
// @ts-expect-error classpath must be bytes, not names
k.decompileClass(new Uint8Array(), { classpath: ['a/B'] });
// @ts-expect-error a resolver must return bytes, not a string
new KrakClient({ resolveClass: async () => 'nope' });
// @ts-expect-error no such option
new KrakClient({ krakatauUrl: 'x' });
