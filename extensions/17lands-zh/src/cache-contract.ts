export const API_ORIGIN = 'http://127.0.0.1:17317';
export const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_METADATA = 2000;
export const MAX_IMAGES = 160;
export const MAX_IMAGE_CACHE_BYTES = 64 * 1024 * 1024;
export type FaceSide = 'front' | 'back';
export type CardFace = {
  face: FaceSide; name_zh: string | null; type_line_zh: string | null; oracle_text_zh: string | null;
  image_url: string | null; image_kind: 'exact' | 'alternate' | 'unavailable'; source: string; source_url: string | null;
};
export type Card = {
  printing_id: string; oracle_id: string | null; english_name: string; set_code: string;
  collector_number: string; layout: string; faces: CardFace[]; updated_at: string;
};
export type ApiStatus = {
  schema_version: 1; revision: string; ready: boolean; card_count: number; last_success_at: string | null;
  next_refresh_at: string | null; refresh_state: string; last_error: string | null;
};
export type LookupResult = { id: string; card: Card | null; origin: 'api' | 'cache' | 'stale' | 'unavailable'; revision: string | null; fallback: boolean };
export type ServiceStatus = {
  state: 'online' | 'empty' | 'offline'; revision: string | null; checkedAt: number; lastError: string | null;
  metadataCount: number; imageCount: number; imageBytes: number; api?: ApiStatus;
  lastResult?: 'api' | 'cache' | 'stale' | 'direct' | 'unavailable';
};

export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function str(value: unknown, max = 512): value is string { return typeof value === 'string' && value.length <= max; }
function nullable(value: unknown, max = 512): value is string | null { return value === null || str(value, max); }
export function allowedImage(url: unknown): url is string {
  if (!str(url, 2048)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash &&
      ['images.mtgch.com', 'cards.scryfall.io'].includes(u.hostname);
  } catch { return false; }
}
export function parseCard(value: unknown): Card {
  if (!record(value) || !str(value.printing_id) || !UUID_RE.test(value.printing_id) ||
    !(value.oracle_id === null || (str(value.oracle_id) && UUID_RE.test(value.oracle_id))) ||
    !str(value.english_name) || !str(value.set_code, 32) || !str(value.collector_number, 64) ||
    !str(value.layout, 64) || !str(value.updated_at, 64) || !Array.isArray(value.faces) ||
    value.faces.length < 1 || value.faces.length > 2) throw new Error('卡牌数据格式无效');
  const sides = new Set<string>();
  const faces: CardFace[] = value.faces.map((f: unknown) => {
    if (!record(f) || (f.face !== 'front' && f.face !== 'back') || sides.has(f.face) ||
      !nullable(f.name_zh) || !nullable(f.type_line_zh) || !nullable(f.oracle_text_zh, 16000) ||
      !(f.image_url === null || allowedImage(f.image_url)) ||
      !['exact', 'alternate', 'unavailable'].includes(String(f.image_kind)) ||
      !str(f.source) || !nullable(f.source_url, 2048) ||
      (f.image_kind === 'unavailable') !== (f.image_url === null)) throw new Error('牌面数据格式无效');
    sides.add(f.face);
    return { face: f.face, name_zh: f.name_zh, type_line_zh: f.type_line_zh, oracle_text_zh: f.oracle_text_zh,
      image_url: f.image_url, image_kind: f.image_kind as CardFace['image_kind'], source: f.source, source_url: f.source_url };
  });
  return { printing_id: value.printing_id.toLowerCase(), oracle_id: value.oracle_id?.toLowerCase() ?? null,
    english_name: value.english_name, set_code: value.set_code, collector_number: value.collector_number,
    layout: value.layout, faces, updated_at: value.updated_at };
}
export function parseStatus(value: unknown): ApiStatus {
  if (!record(value) || value.schema_version !== 1 || !str(value.revision, 256) || typeof value.ready !== 'boolean' ||
    !Number.isSafeInteger(value.card_count) || (value.card_count as number) < 0 || !nullable(value.last_success_at, 64) ||
    !nullable(value.next_refresh_at, 64) || !str(value.refresh_state) || !nullable(value.last_error, 2000)) throw new Error('服务状态格式无效');
  return { schema_version: 1, revision: value.revision, ready: value.ready, card_count: value.card_count as number,
    last_success_at: value.last_success_at, next_refresh_at: value.next_refresh_at, refresh_state: value.refresh_state, last_error: value.last_error };
}

export async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel(); throw new Error('响应过大');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('响应过大'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function boundedJson(response: Response, maximum = 4 * 1024 * 1024): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('响应并非 JSON');
  return JSON.parse(new TextDecoder().decode(await boundedBytes(response, maximum)));
}
