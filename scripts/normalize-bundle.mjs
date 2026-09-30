import { readFileSync, writeFileSync } from 'node:fs';

// The bundled GitHub SDK includes trailing spaces in a multiline error string.
// Normalize the checked-in Action bundle after every build.
const bundle = new URL('../dist/index.js', import.meta.url);
writeFileSync(bundle, readFileSync(bundle, 'utf8').replace(/[\t ]+$/gm, ''));
