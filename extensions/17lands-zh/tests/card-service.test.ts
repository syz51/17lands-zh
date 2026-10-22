import { describe, expect, test } from 'bun:test';
import { API_ORIGIN, MAX_IMAGE_BYTES, allowedImage, parseCard, parseStatus } from '../src/cache-contract';
import { CardService } from '../src/card-service';
import { createMessageHandler } from '../src/runtime-handler';
import { ID, IMAGE, OTHER, PNG_DATA_URL, MemoryImages, MemoryMetadata, apiStatus, card, corruptRaster, decodeFixture, json, validRaster } from './cache-fixture';
import type { RasterDecoder } from '../src/raster-decoder';

function fixture() {
  const metadata = new MemoryMetadata(); const images = new MemoryImages();
  let time = 100_000; let revision = 'r1'; let offline = false; let ready = true;
  let missing = false; let invalid = false; let notModified = false; let imageResponse: (() => Response) | undefined;
  const requests: { url: string; init?: RequestInit }[] = [];
  let active = 0; let maximum = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    if (offline) throw new Error('offline');
    if (url.endsWith('/v1/status')) return json(apiStatus(revision, ready));
    if (url.startsWith(`${API_ORIGIN}/v1/cards?`)) {
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1)); active--;
      if (notModified) return new Response(null, { status: 304 });
      const ids = new URL(url).searchParams.get('ids')!.split(',');
      return json({ schema_version: invalid ? 2 : 1, revision, cards: missing ? [] : ids.map((id) => card(id)), missing: missing ? ids : [] }, { etag: `"${revision}"` });
    }
    if (url.startsWith('https://')) return imageResponse?.() ?? new Response(validRaster().bytes.slice().buffer, { headers: { 'content-type': 'image/png' } });
    throw new Error('Unexpected URL');
  }) as typeof fetch;
  const create = (decoder: RasterDecoder = decodeFixture) => new CardService(metadata, images, fetcher, () => time, decoder);
  return { metadata, images, requests, create, get maximum() { return maximum; }, advance: (ms: number) => { time += ms; },
    setOffline: (value: boolean) => { offline = value; }, setRevision: (value: string) => { revision = value; },
    setMissing: (value: boolean) => { missing = value; }, setInvalid: () => { invalid = true; }, setNotModified: () => { notModified = true; },
    setReady: (value: boolean) => { ready = value; }, imageResponse: (value: () => Response) => { imageResponse = value; } };
}

describe('background local API and persistent cache', () => {
  test('default browser fetch retains the global receiver for metadata and images', async () => {
    const original = globalThis.fetch;
    const receivers: unknown[] = [];
    globalThis.fetch = (async function(this: unknown, input: string | URL | Request) {
      receivers.push(this);
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      const url = String(input);
      if (url.endsWith('/v1/status')) return json(apiStatus('r1', true));
      if (url.includes('/v1/cards?')) return json({ schema_version: 1, revision: 'r1', cards: [card(ID)], missing: [] });
      return new Response(validRaster().bytes.slice().buffer, { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    try {
      const service = new CardService(new MemoryMetadata(), new MemoryImages(), undefined, undefined, decodeFixture);
      expect((await service.image(ID, 'front')).dataUrl).toBe(PNG_DATA_URL);
      expect((await service.getStatus()).state).toBe('online');
      expect(receivers).toHaveLength(3);
      expect(receivers.every(receiver => receiver === globalThis)).toBe(true);
    } finally { globalThis.fetch = original; }
  });

  test('deduplicates across readers and limits every batch to 100 with two concurrent requests', async () => {
    const f = fixture(); const service = f.create();
    const ids = Array.from({ length: 250 }, (_, n) => `00000000-0000-0000-0000-${n.toString().padStart(12, '0')}`);
    const results = await Promise.all(ids.flatMap((id) => [service.lookup([id]), service.lookup([id])]));
    expect(results.flat().every((r) => r.origin === 'api')).toBe(true);
    const batches = f.requests.filter((r) => r.url.includes('/v1/cards?'));
    expect(batches.map((r) => new URL(r.url).searchParams.get('ids')!.split(',').length)).toEqual([100, 100, 50]);
    expect(f.maximum).toBe(2);
    expect(f.requests.filter((r) => r.url.endsWith('/v1/status'))).toHaveLength(1);
    expect(f.metadata.entries.size).toBe(250);
  });

  test('a new background instance reads durable positives without a network request', async () => {
    const f = fixture(); await f.create().lookup([ID]);
    f.requests.length = 0;
    const [result] = await f.create().lookup([ID]);
    expect(result!.origin).toBe('cache'); expect(result!.card?.printing_id).toBe(ID);
    expect(f.requests).toHaveLength(0);
  });

  test('keeps expired metadata and image blobs usable while offline and backs off across restart', async () => {
    const f = fixture(); const service = f.create();
    const image = await service.image(ID, 'front'); expect(image.dataUrl).toBe(PNG_DATA_URL);
    f.advance(25 * 60 * 60_000); f.setOffline(true);
    expect((await service.lookup([ID]))[0]!.origin).toBe('stale');
    const count = f.requests.length;
    const restarted = f.create();
    expect((await restarted.image(ID, 'front')).dataUrl).toBe(image.dataUrl);
    expect(f.requests).toHaveLength(count);
    expect((await restarted.getStatus()).state).toBe('offline');
    f.advance(60_001); f.setOffline(false);
    expect((await restarted.getStatus()).state).toBe('online');
  });

  test('a revision change revalidates positives and negatives before TTL', async () => {
    const f = fixture(); const service = f.create();
    f.setMissing(true); expect((await service.lookup([ID]))[0]!.card).toBeNull();
    f.setMissing(false); expect((await service.lookup([ID]))[0]!.card).toBeNull();
    f.advance(5 * 60_000 + 1); f.setRevision('r2');
    expect((await service.lookup([ID]))[0]!.revision).toBe('r2');
    expect((await service.lookup([ID]))[0]!.card?.english_name).toBe('Plains');
  });

  test('negative TTL is short; a matching ETag 304 renews an expired cached result', async () => {
    const f = fixture(); const service = f.create();
    f.setMissing(true); await service.lookup([ID]);
    f.advance(5 * 60_000 + 1); f.setMissing(false);
    expect((await service.lookup([ID]))[0]!.card).not.toBeNull();
    f.advance(25 * 60 * 60_000); f.setNotModified();
    expect((await service.lookup([ID]))[0]!.origin).toBe('api');
    const headers = new Headers(f.requests.at(-1)!.init?.headers);
    expect(headers.get('if-none-match')).toBe('"r1"');
    expect((await service.lookup([ID]))[0]!.origin).toBe('cache');
  });

  test('schema errors retain good stale entries and an unexpected 304 creates no false hits', async () => {
    const f = fixture(); const service = f.create(); await service.lookup([ID]);
    f.advance(25 * 60 * 60_000); f.setInvalid();
    const [result] = await service.lookup([ID]); expect(result!.origin).toBe('stale'); expect(result!.card?.english_name).toBe('Plains');
    expect((await service.getStatus()).state).toBe('offline');
    const fresh = fixture(); fresh.setNotModified();
    expect((await fresh.create().lookup([ID]))[0]!.card).toBeNull(); expect(fresh.metadata.entries.size).toBe(0);
  });

  test('uses the API alternate image for Plains and preserves back identity', async () => {
    const f = fixture(); const service = f.create();
    await service.image(OTHER, 'front');
    expect(f.requests.some((r) => r.url === IMAGE)).toBe(true);
    expect(f.requests.every((r) => !r.url.includes(`/front/d/4/${OTHER}`))).toBe(true);
    expect((await service.image(OTHER, 'back')).dataUrl).toBeNull();
    expect(f.requests.filter((r) => r.url === IMAGE)).toHaveLength(1);
  });

  test('direct mapping is labelled and is used only when the service is offline/empty', async () => {
    const empty = fixture(); empty.setReady(false);
    expect((await empty.create().image(ID, 'front')).origin).toBe('direct');
    expect(empty.requests.some((r) => r.url === IMAGE)).toBe(true);
    const online = fixture(); online.setMissing(true);
    expect((await online.create().image(ID, 'front')).dataUrl).toBeNull();
    expect(online.requests.some((r) => r.url.startsWith('https://'))).toBe(false);
  });

  test('deduplicates image fetches and rejects oversized or active content with short negative caching', async () => {
    const f = fixture(); const service = f.create();
    f.imageResponse(() => new Response('bad', { headers: { 'content-type': 'image/webp', 'content-length': String(MAX_IMAGE_BYTES + 1) } }));
    const results = await Promise.all([service.image(ID, 'front'), service.image(ID, 'front')]);
    expect(results.every((r) => r.dataUrl === null)).toBe(true);
    expect(f.requests.filter((r) => r.url === IMAGE)).toHaveLength(1);
    await service.image(ID, 'front'); expect(f.requests.filter((r) => r.url === IMAGE)).toHaveLength(1);
    f.advance(5 * 60_000 + 1);
    f.imageResponse(() => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }));
    expect((await service.image(ID, 'front')).dataUrl).toBeNull(); expect(f.images.entries.size).toBe(0);
    expect(f.requests.every((r) => r.init?.credentials === 'omit' && r.init?.redirect === 'error')).toBe(true);
  });

  test('waits for raster decoding before persistence or runtime data URL delivery', async () => {
    const f = fixture(); let allow!: () => void; let started!: () => void;
    const decoding = new Promise<void>((resolve) => { started = resolve; });
    const service = f.create(async (image) => { started(); await new Promise<void>((resolve) => { allow = resolve; }); await decodeFixture(image); });
    let delivered = false;
    const pending = service.image(ID, 'front').then((value) => { delivered = true; return value; });
    await decoding;
    expect(f.images.entries.size).toBe(0); expect(delivered).toBe(false);
    allow(); expect((await pending).dataUrl).toBe(PNG_DATA_URL); expect(f.images.entries.size).toBe(1);
  });

  test('corrupt HTTP 200 raster is never persisted, then explicit retry recovers and survives an offline worker restart', async () => {
    const f = fixture(); const service = f.create(); const bad = corruptRaster();
    f.imageResponse(() => new Response(bad.bytes.slice().buffer, { headers: { 'content-type': bad.mime } }));
    expect((await service.image(ID, 'front')).dataUrl).toBeNull(); expect(f.images.entries.size).toBe(0);
    f.imageResponse(() => new Response(validRaster().bytes.slice().buffer, { headers: { 'content-type': 'image/png' } }));
    expect((await service.image(ID, 'front')).dataUrl).toBeNull();
    expect(f.requests.filter((r) => r.url === IMAGE)).toHaveLength(1);
    await service.getStatus(true);
    expect((await service.image(ID, 'front')).dataUrl).toBe(PNG_DATA_URL);
    expect(f.requests.filter((r) => r.url === IMAGE)).toHaveLength(2);
    f.setOffline(true); f.advance(25 * 60 * 60_000);
    const restarted = f.create(); expect((await restarted.image(ID, 'front')).dataUrl).toBe(PNG_DATA_URL);
    expect(f.requests.filter((r) => r.url === IMAGE)).toHaveLength(2);
    expect(f.images.entries.size).toBe(1);
  });

  test('an old poisoned cache entry is evicted before refetch, including after service reconstruction', async () => {
    const f = fixture(); await f.create().lookup([ID]);
    await f.images.put(IMAGE, corruptRaster());
    const remove = f.images.delete.bind(f.images); let removed = false;
    f.images.delete = async (url) => { await remove(url); removed = true; };
    f.imageResponse(() => {
      expect(removed).toBe(true); expect(f.images.entries.has(IMAGE)).toBe(false);
      return new Response(validRaster().bytes.slice().buffer, { headers: { 'content-type': 'image/png' } });
    });
    expect((await f.create().image(ID, 'front')).dataUrl).toBe(PNG_DATA_URL); expect(removed).toBe(true);
    const count = f.requests.length; f.setOffline(true);
    expect((await f.create().image(ID, 'front')).dataUrl).toBe(PNG_DATA_URL); expect(f.requests).toHaveLength(count);
  });
});

test('untrusted API fields and image origins are strictly validated', () => {
  for (const url of ['http://images.mtgch.com/a', 'https://images.mtgch.com.evil/a', 'https://user@images.mtgch.com/a', 'https://127.0.0.1/a', 'data:image/png,x', 'https://images.mtgch.com:444/a']) expect(allowedImage(url)).toBe(false);
  const missing = card() as unknown as Record<string, unknown>; delete missing.layout;
  expect(() => parseCard(missing)).toThrow();
  expect(() => parseCard({ ...card(), faces: [...card().faces, ...card().faces] })).toThrow();
  expect(() => parseCard({ ...card(), faces: [{ ...card().faces[0], image_url: 'https://evil.test/a' }] })).toThrow();
  expect(() => parseStatus({ ...apiStatus(), schema_version: 2 })).toThrow();
});

test('message boundary rejects foreign senders, arbitrary URLs, invalid IDs and privileged page requests', async () => {
  const f = fixture(); const handle = createMessageHandler(f.create(), 'extension', 'chrome-extension://extension/popup.html');
  const site = { id: 'extension', url: 'https://www.17lands.com/site_draft/example', tab: {} };
  const popup = { id: 'extension', url: 'chrome-extension://extension/popup.html' };
  for (const [message, sender] of [
    [{ type: '17lands-zh:lookup', ids: [ID] }, { ...site, id: 'other' }],
    [{ type: '17lands-zh:lookup', ids: [ID] }, { ...site, url: 'https://17lands.com.evil/' }],
    [{ type: '17lands-zh:image', id: ID, face: 'front', url: 'https://evil.test' }, site],
    [{ type: '17lands-zh:image', id: ID, face: 'side' }, site],
    [{ type: '17lands-zh:lookup', ids: Array(101).fill(ID) }, site],
    [{ type: '17lands-zh:lookup', ids: ['localhost'] }, site],
    [{ type: '17lands-zh:retry-service' }, site],
    [{ type: '17lands-zh:lookup', ids: [ID] }, popup],
  ] as const) await expect(handle(message, sender)).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
  expect((await handle({ type: '17lands-zh:lookup', ids: [ID] }, site) as unknown[])).toHaveLength(1);
  expect((await handle({ type: '17lands-zh:status' }, popup) as { state: string }).state).toBe('online');
});
