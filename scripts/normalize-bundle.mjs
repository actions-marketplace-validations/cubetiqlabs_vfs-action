import { readFileSync, writeFileSync } from 'node:fs';

// The bundled GitHub SDK includes trailing spaces in a multiline error string.
// Normalize the checked-in Action bundles after every build.
for (const file of ['../dist/index.js', '../dist/upload/index.js', '../dist/download/index.js']) {
  const bundle = new URL(file, import.meta.url);
  writeFileSync(bundle, readFileSync(bundle, 'utf8').replace(/[\t ]+$/gm, ''));
}
