// Native IndexedDB/CacheStorage QA in the local preview origin; true extension-origin QA belongs to the parent.
import { IndexedMetadataStore, PersistentImageStore } from '../src/persistent-cache';
import { MAX_IMAGES, MAX_METADATA } from '../src/cache-contract';
import { CardService } from '../src/card-service';
import { validateRaster } from '../src/raster-decoder';
import { IMAGE, ID, PNG_DATA_URL, MemoryMetadata, apiStatus, card, corruptRaster, json, validRaster } from './cache-fixture';

export async function runStorageQA() {
  const store = new IndexedMetadataStore();
  await store.put(Array.from({ length: MAX_METADATA + 1 }, (_, index) => ({ id: `qa-${index}`, card: card(), revision: 'qa', expires: 1000, used: index, etag: '"qa"' })));
  const evicted = (await store.get(['qa-0']))[0] === undefined;
  const newest = (await new IndexedMetadataStore().get([`qa-${MAX_METADATA}`]))[0];
  const count = await store.count();
  const images = new PersistentImageStore();
  await caches.open('17lands-zh-images-v0');
  for (let i = 0; i <= MAX_IMAGES; i++) await images.put(`https://images.mtgch.com/qa/${i}`, validRaster());
  const stats = await images.stats();
  const firstImageEvicted = (await images.get('https://images.mtgch.com/qa/0')) === undefined;
  const restored = await new PersistentImageStore().get(`https://images.mtgch.com/qa/${MAX_IMAGES}`);
  const oldVersionDeleted = !(await caches.keys()).includes('17lands-zh-images-v0');
  return { count, evicted, restoredPrinting: newest?.card?.printing_id === ID, stats, firstImageEvicted, imageRestored: restored?.bytes.length === validRaster().bytes.length, oldVersionDeleted };
}

/** Uses CardService's default production createImageBitmap decoder, not the Bun decoder double. */
export async function runRasterQA() {
  const metadata = new MemoryMetadata(); const images = new PersistentImageStore();
  let corrupt = true; let offline = false; let imageRequests = 0;
  const fetcher = (async (input: string | URL | Request) => {
    if (offline) throw new Error('offline');
    const url = String(input);
    if (url.endsWith('/v1/status')) return json(apiStatus());
    if (url.includes('/v1/cards?')) return json({ schema_version: 1, revision: 'r1', cards: [card()], missing: [] });
    if (url === IMAGE) {
      imageRequests++; const image = corrupt ? corruptRaster() : validRaster();
      return new Response(image.bytes.slice().buffer, { headers: { 'content-type': image.mime } });
    }
    throw new Error('Unexpected URL');
  }) as typeof fetch;
  await images.delete(IMAGE);
  let badRejected = false;
  try { await validateRaster(corruptRaster()); } catch { badRejected = true; }
  await validateRaster(validRaster());
  const service = new CardService(metadata, images, fetcher);
  const firstRejected = (await service.image(ID, 'front')).dataUrl === null;
  const corruptNotPersisted = (await images.get(IMAGE)) === undefined;
  corrupt = false; await service.getStatus(true);
  const retryRecovered = (await service.image(ID, 'front')).dataUrl === PNG_DATA_URL;
  await images.put(IMAGE, corruptRaster()); // Simulate a pre-fix v1 poisoned entry under the same key.
  const oldCacheRecovered = (await new CardService(metadata, images, fetcher).image(ID, 'front')).dataUrl === PNG_DATA_URL;
  const beforeOffline = imageRequests; offline = true;
  const offlineRestartGood = (await new CardService(metadata, new PersistentImageStore(), fetcher).image(ID, 'front')).dataUrl === PNG_DATA_URL;
  return { nativeDecoder: typeof createImageBitmap === 'function', badRejected, validAccepted: true, firstRejected, corruptNotPersisted,
    retryRecovered, oldCacheRecovered, offlineRestartGood, noOfflineImageFetch: beforeOffline === imageRequests, imageRequests };
}
