// Preview the actual built popup with local-only extension API doubles. Not part of the extension.
import { resolve, sep } from 'node:path';

const root = resolve(import.meta.dir, '../.output/chrome-mv3');
const apiDouble = `<script>
globalThis.chrome = {
  runtime: { async sendMessage() { return { state: 'online', revision: 'visual-fixture', metadataCount: 24, imageCount: 18, imageBytes: 1234, lastResult: 'cache' }; } },
  storage: { local: {
    async get() { return { enabled: localStorage.getItem('enabled') !== 'false' }; },
    async set(value) { localStorage.setItem('enabled', String(value.enabled)); }
  } },
  tabs: { async query() { return [{ id: 1 }]; }, async sendMessage() { return { ok: true }; } }
};
</script>`;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 4173,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/storage-qa.js' || url.pathname === '/raster-worker.js') {
      const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, url.pathname === '/storage-qa.js' ? 'storage-browser.ts' : 'raster-worker.ts')], target: 'browser' });
      return new Response(await result.outputs[0]!.text(), { headers: { 'content-type': 'text/javascript' } });
    }
    const filePath = resolve(root, `.${url.pathname === '/' ? '/popup.html' : url.pathname}`);
    if (!filePath.startsWith(root + sep)) return new Response('Not found', { status: 404 });
    const file = Bun.file(filePath);
    if (!(await file.exists())) return new Response('Not found', { status: 404 });
    if (filePath.endsWith('/popup.html')) {
      return new Response((await file.text()).replace('<head>', `<head>${apiDouble}`), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(file);
  },
});
console.log(`Popup QA: ${server.url}`);
