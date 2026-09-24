import { readFile } from 'node:fs/promises';
import { loadPyodide } from 'pyodide';
import { KrakCore } from 'krakatau-web/core';

const core = await KrakCore.create({ loadPyodide, krakatauZip: await readFile('x.zip') }); // Buffer is accepted
const { jarId } = core.openJar(await readFile('y.jar'));
const src: string | null = core.decompile(jarId, 'a/B').source;
void src;
