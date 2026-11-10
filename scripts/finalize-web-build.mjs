import { readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../offline-dist/', import.meta.url));

// The standalone entry uses offline.html locally; hosts serve index.html at /.
await rename(path.join(output, 'offline.html'), path.join(output, 'index.html'));

async function removeSyncDuplicates(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (/ \d+(?=\.[^.]+$|$)/.test(entry.name)) {
      await rm(target, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await removeSyncDuplicates(target);
    }
  }
}
await removeSyncDuplicates(output);
for (const asset of ['index.html', 'pdf-assets/pdf.worker.min.mjs', 'ocr/worker.min.js', 'office-assets/NotoSansSC-Regular.ttf']) {
  if (!(await stat(path.join(output, asset))).isFile()) throw new Error(`Missing deployment asset: ${asset}`);
}
console.log('Static website ready in offline-dist/');
