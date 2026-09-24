import { readFile } from 'node:fs/promises';
import { loadPyodide } from 'pyodide';
import { KrakCore } from './public/krak-core.mjs';

const t0 = performance.now();
const core = await KrakCore.create({
  loadPyodide,
  krakatauZip: await readFile('public/krakatau-py.zip'),
  stubs: [{ name: 'jdk.jar', bytes: await readFile('public/jdk-stubs.jar') }],
});
const t1 = performance.now();
console.log(`startup ${(t1 - t0).toFixed(0)} ms`);

const { jarId, classes } = core.openJar(await readFile(process.argv[2]));
console.log(`${classes.length} classes`);
const limit = Number(process.argv[3] || classes.length);
let errors = 0, out = {};
const t2 = performance.now();
for (const name of classes.slice(0, limit)) {
  const r = await core.decompile(jarId, name);
  if (r.error) { errors++; if (errors < 3) console.log(name, r.error.slice(0, 300)); }
  out[name] = r.source;
}
const t3 = performance.now();
console.log(`decompiled ${limit} in ${(t3 - t2).toFixed(0)} ms, errors ${errors}`);
const first = process.argv[4];
if (first) console.log(out[first]);
await import('node:fs').then(fs => fs.writeFileSync('pyodide-out.json', JSON.stringify(out)));
