/** Copy only the compiled Angular browser assets into the Worker build. */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve(import.meta.dirname, '../../front-end/dist/arabica-demo-ui/browser');
const destination = resolve(import.meta.dirname, '../public');
await stat(resolve(source, 'index.html'));
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
console.log('Prepared Angular assets for Worker');
