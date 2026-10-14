import { readFile } from 'node:fs/promises';
import { loadPyodide } from 'pyodide';
import { KrakCore } from 'krakatau-web/core';

const core = await KrakCore.create({ loadPyodide, krakatauZip: await readFile('x.zip') }); // Buffer is accepted
const { jarId } = core.openJar(await readFile('y.jar'));
const src: string | null = (await core.decompile(jarId, 'a/B')).source;
core.setClassResolver(async (name) => (name.startsWith('net/minecraft/') ? readFile(`mc/${name}.class`) : null));
void src;
const mapped = await core.decompileMapped(jarId, 'a/B');
const offsets: number[] = mapped.methods.flatMap((m) => m.lines.map(([offset]) => offset));
void offsets;
