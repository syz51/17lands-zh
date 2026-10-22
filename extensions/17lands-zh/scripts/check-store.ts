import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Prevent accidentally uploading the default loopback build or extra permissions.
const output = resolve(import.meta.dir, '../.output/chrome-mv3');
const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
if (manifest.manifest_version !== 3 || !same(manifest.permissions ?? [], ['storage']) ||
  !same(manifest.host_permissions ?? [], ['https://17lands.syzroy.com/*', 'https://images.mtgch.com/*', 'https://cards.scryfall.io/*']) ||
  !same(manifest.content_scripts.flatMap((script: { matches: string[] }) => script.matches), ['https://17lands.com/*', 'https://www.17lands.com/*'])) {
  throw new Error('Store build must use the reviewed HTTPS origins and minimum permissions.');
}
for (const size of [16, 32, 48, 128]) {
  const path = manifest.icons?.[size];
  if (typeof path !== 'string' || path.includes('..')) throw new Error(`Missing ${size}px icon`);
  const png = await readFile(resolve(output, path.replace(/^\/+/, '')));
  if (png.toString('hex', 0, 8) !== '89504e470d0a1a0a' || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
    throw new Error(`Invalid ${size}px PNG icon`);
  }
}
console.log(`Store manifest and PNG icons verified: ${manifest.version}`);
