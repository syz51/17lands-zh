import type { Card } from '../src/cache-contract';
import type { CachedImage, Control, ImageStore, MetadataEntry, MetadataStore } from '../src/persistent-cache';

export const ID = '9e72f397-2384-40f1-882b-f627664d97df';
export const OTHER = 'd4ebed0b-8060-4a7b-a060-5cfcd2172b16';
export const IMAGE = `https://images.mtgch.com/zhs/large/front/9/e/${ID}.webp`;
// Complete 1x1 RGBA PNG, including zlib stream and CRCs; also decoded by native browser QA.
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMwSpn2HwAEJAIsVIWyawAAAABJRU5ErkJggg==';
export const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
export function validRaster(): CachedImage { return { bytes: Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0)), mime: 'image/png' }; }
export function corruptRaster(): CachedImage { return { bytes: new Uint8Array([82, 73, 70, 70]), mime: 'image/webp' }; }
// Bun has no createImageBitmap. This deterministic injectable double only tests service ordering/recovery;
// storage-browser.ts tests the production native decoder against these same valid/corrupt bytes.
export async function decodeFixture(image: CachedImage): Promise<void> {
  const expected = validRaster();
  if (image.mime !== expected.mime || image.bytes.length !== expected.bytes.length || image.bytes.some((v, i) => v !== expected.bytes[i])) throw new Error('Invalid test raster');
}
export function card(id = ID): Card {
  return { printing_id: id, oracle_id: OTHER, english_name: 'Plains', set_code: 'fra', collector_number: '300', layout: 'normal', updated_at: '2026-10-22T00:00:00Z',
    faces: [{ face: 'front', name_zh: '平原', type_line_zh: '基本地 ～ 平原', oracle_text_zh: '{T}：加{W}。', image_url: IMAGE, image_kind: 'alternate', source: 'scryfall', source_url: null }] };
}
export function apiStatus(revision = 'r1', ready = true) {
  return { schema_version: 1, revision, ready, card_count: ready ? 1000 : 0, last_success_at: null, next_refresh_at: null, refresh_state: 'idle', last_error: null };
}
export class MemoryMetadata implements MetadataStore {
  entries = new Map<string, MetadataEntry>(); saved?: Control;
  async get(ids: string[]) { return ids.map((id) => this.entries.get(id)); }
  async put(entries: MetadataEntry[]) { for (const entry of entries) this.entries.set(entry.id, structuredClone(entry)); }
  async control() { return this.saved ? structuredClone(this.saved) : undefined; }
  async saveControl(value: Control) { this.saved = structuredClone(value); }
  async count() { return this.entries.size; }
}
export class MemoryImages implements ImageStore {
  entries = new Map<string, CachedImage>();
  async get(url: string) { return this.entries.get(url); }
  async put(url: string, image: CachedImage) { this.entries.set(url, image); }
  async delete(url: string) { this.entries.delete(url); }
  async stats() { return { imageCount: this.entries.size, imageBytes: [...this.entries.values()].reduce((n, image) => n + image.bytes.length, 0) }; }
}
export const json = (value: unknown, headers?: HeadersInit) => Response.json(value, { headers });
