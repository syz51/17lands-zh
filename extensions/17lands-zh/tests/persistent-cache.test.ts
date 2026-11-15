import { afterEach, expect, test } from 'bun:test';
import { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_IMAGE_CACHE_BYTES } from '../src/cache-contract';
import { PersistentImageStore } from '../src/persistent-cache';
import { validRaster } from './cache-fixture';

// A CacheStorage stand-in that keeps insertion order and counts calls. URLs are synthetic.
function cacheStorage() {
  const store = new Map<string, Response>(); const calls = { match: 0, put: 0, keys: 0, delete: 0 };
  const url = (key: string | Request) => new Request(key).url;
  let failing = false; let stall: Promise<void> | undefined;
  const cache = {
    async match(key: string | Request) { calls.match++; return store.get(url(key))?.clone(); },
    async put(key: string | Request, value: Response) { calls.put++; if (failing) throw new Error('quota'); await stall; store.delete(url(key)); store.set(url(key), value); },
    async keys() { calls.keys++; return [...store.keys()].map((key) => new Request(key)); },
    async delete(key: string | Request) { calls.delete++; return store.delete(url(key)); },
  };
  Object.assign(globalThis, { caches: { async keys() { return []; }, async delete() { return true; }, async open() { return cache; } } });
  return { store, calls, failPut: (value: boolean) => { failing = value; },
    stallPut: () => { let release!: () => void; stall = new Promise<void>((done) => { release = done; }); return () => { stall = undefined; release(); }; },
    reset: () => { Object.assign(calls, { match: 0, put: 0, keys: 0, delete: 0 }); } };
}
afterEach(() => { delete (globalThis as { caches?: unknown }).caches; });
const image = (index: number) => `https://images.mtgch.com/synthetic/${index}`;
const size = validRaster().bytes.byteLength;

test('a full image cache evicts in insertion order without reading stored responses again', async () => {
  const f = cacheStorage(); const images = new PersistentImageStore();
  for (let index = 0; index < MAX_IMAGES; index++) await images.put(image(index), validRaster());
  f.reset();
  await Promise.all(Array.from({ length: 45 }, (_, index) => images.put(image(1000 + index), validRaster())));
  expect(f.calls).toEqual({ match: 0, put: 45, keys: 45, delete: 45 });
  expect([...f.store.keys()][0]).toBe(image(45)); expect([...f.store.keys()].at(-1)).toBe(image(1044));
  f.reset();
  expect(await images.stats()).toEqual({ imageCount: MAX_IMAGES, imageBytes: MAX_IMAGES * size });
  expect(f.calls).toEqual({ match: 0, put: 0, keys: 0, delete: 0 });
});

test('a replaced image moves to the end of the eviction order', async () => {
  const f = cacheStorage(); const images = new PersistentImageStore();
  for (let index = 0; index < MAX_IMAGES; index++) await images.put(image(index), validRaster());
  await images.put(image(0), validRaster());
  expect(await images.stats()).toEqual({ imageCount: MAX_IMAGES, imageBytes: MAX_IMAGES * size });
  await images.put(image(2000), validRaster());
  expect(f.store.has(image(0))).toBe(true); expect(f.store.has(image(1))).toBe(false);
});

test('a new worker reads stored sizes once, and a count that disagrees rebuilds them', async () => {
  const f = cacheStorage(); const first = new PersistentImageStore();
  for (let index = 0; index < 10; index++) await first.put(image(index), validRaster());
  f.reset(); const restarted = new PersistentImageStore();
  expect(await restarted.stats()).toEqual({ imageCount: 10, imageBytes: 10 * size });
  expect(f.calls.match).toBe(10);
  f.reset(); await restarted.put(image(10), validRaster()); await restarted.put(image(11), validRaster()); await restarted.delete(image(0));
  expect(await restarted.stats()).toEqual({ imageCount: 11, imageBytes: 11 * size });
  expect(f.calls.match).toBe(10);
  f.store.delete(image(5)); f.reset(); await restarted.put(image(12), validRaster());
  expect(await restarted.stats()).toEqual({ imageCount: 11, imageBytes: 11 * size });
  expect(f.calls.match).toBe(10);
});

test('the byte budget evicts the oldest images', async () => {
  const f = cacheStorage(); const images = new PersistentImageStore(); const bytes = new Uint8Array(MAX_IMAGE_BYTES);
  const fits = Math.floor(MAX_IMAGE_CACHE_BYTES / MAX_IMAGE_BYTES);
  for (let index = 0; index <= fits; index++) await images.put(image(index), { bytes, mime: 'image/png' });
  expect(await images.stats()).toEqual({ imageCount: fits, imageBytes: fits * MAX_IMAGE_BYTES });
  expect(f.store.has(image(0))).toBe(false); expect(f.store.has(image(1))).toBe(true);
});

test('a failed write leaves the totals unchanged and does not block later writes or the status read', async () => {
  const f = cacheStorage(); const images = new PersistentImageStore();
  await images.put(image(0), validRaster());
  f.failPut(true);
  await expect(images.put(image(1), validRaster())).rejects.toThrow('quota');
  expect(await images.stats()).toEqual({ imageCount: 1, imageBytes: size });
  f.failPut(false); await images.put(image(2), validRaster());
  expect(await images.stats()).toEqual({ imageCount: 2, imageBytes: 2 * size });
});

test('the status read does not wait for a stalled write', async () => {
  const f = cacheStorage(); const images = new PersistentImageStore();
  await images.put(image(0), validRaster());
  const release = f.stallPut(); const stalled = images.put(image(1), validRaster());
  expect(await images.stats()).toEqual({ imageCount: 1, imageBytes: size });
  release(); await stalled;
  expect(await images.stats()).toEqual({ imageCount: 2, imageBytes: 2 * size });
});
