import { KrakClient } from 'krakatau-web';
const k = new KrakClient();
// @ts-expect-error jarId must be a number
k.decompile('1', 'a/B');
// @ts-expect-error no such option
new KrakClient({ krakatauUrl: 'x' });
