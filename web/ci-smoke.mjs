// CI smoke test: runs the built assets under Pyodide in Node and checks that modern-Java
// handling works. Usage: node web/ci-smoke.mjs <test.jar>
import { readFile } from 'node:fs/promises';
import { loadPyodide } from 'pyodide';
import { KrakCore } from './public/krak-core.mjs';

const dir = new URL('./public/', import.meta.url);
const core = await KrakCore.create({
  loadPyodide,
  krakatauZip: await readFile(new URL('krakatau-py.zip', dir)),
  stubs: [{ name: 'jdk.jar', bytes: await readFile(new URL('jdk-stubs.jar', dir)) }],
});
const { jarId, classes } = core.openJar(await readFile(process.argv[2]));
const src = {};
let failed = 0;
for (const name of classes) {
  const r = core.decompile(jarId, name);
  if (r.error) { failed++; console.error(`FAIL ${name}\n${r.error}`); }
  src[name] = r.source ?? '';
}
const all = Object.values(src).join('\n');
const checks = {
  'no class failed': failed === 0,
  'no invokedynamic placeholders': !all.includes('/*invokedynamic*/'),
  'lambdas inlined': all.includes(' -> ') && !/lambda\$\w+\$\d+\(/.test(all),
  'string concat rebuilt': all.includes('"Hello " + '),
  'records': /\brecord \S+\(/.test(all),
  'sealed': all.includes('sealed interface'),
  'super method refs': all.includes('super.greet('),
};
let ok = true;
for (const [what, pass] of Object.entries(checks)) {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${what}`);
  ok &&= pass;
}
console.log(`${classes.length} classes`);
process.exit(ok ? 0 : 1);
