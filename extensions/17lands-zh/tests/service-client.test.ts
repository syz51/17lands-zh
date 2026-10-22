import { describe, expect, test } from 'bun:test';
import { createServiceClient } from '../src/service-client';
import { ID, OTHER, PNG_DATA_URL, card } from './cache-fixture';
import { MAX_IMAGE_BYTES } from '../src/cache-contract';

const english = (id = ID, face = 'front') => `https://cards.scryfall.io/large/${face}/${id[0]}/${id[1]}/${id}.jpg`;
const result = (id: string) => ({ id, card: card(id), origin: 'api', revision: 'r1', fallback: false });
describe('content/background identity transport', () => {
  test('batches different printings, deduplicates faces and only transports identities', async () => {
    const messages: Record<string, unknown>[] = [];
    const client = createServiceClient(async (message) => {
      const m = message as Record<string, unknown>; messages.push(m);
      if (m.type === '17lands-zh:lookup') return (m.ids as string[]).map(result);
      return { dataUrl: PNG_DATA_URL, origin: 'api' };
    });
    const [a, b, repeated] = await Promise.all([client.resolve(english()), client.resolve(english(OTHER)), client.resolve(english())]);
    expect(a).toEqual(repeated); expect(b.url).toStartWith('data:image/');
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ type: '17lands-zh:lookup', ids: [ID, OTHER] });
    expect(messages[1]).toEqual({ type: '17lands-zh:image', id: ID, face: 'front' });
    expect(messages[2]).toEqual({ type: '17lands-zh:image', id: OTHER, face: 'front' });
    await client.resolve(english(ID, 'back')); expect(messages).toHaveLength(4); // Metadata lookup only; API has no back face.
    expect(messages.at(-1)).toEqual({ type: '17lands-zh:lookup', ids: [ID] });
    client.dispose();
  });

  test('preserves face identity and Chinese text when a background image fails', async () => {
    const back = { ...card().faces[0]!, face: 'back' as const, name_zh: '背面' };
    const client = createServiceClient(async (message) => {
      const m = message as Record<string, unknown>;
      if (m.type === '17lands-zh:lookup') return [{ ...result(ID), card: { ...card(), faces: [...card().faces, back] } }];
      expect(m.face).toBe('back'); throw new Error('Failed');
    });
    expect((await client.resolve(english(ID, 'back'))).face?.name_zh).toBe('背面'); client.dispose();
  });

  test('disposal and clear invalidate async responses; malformed or oversized payloads cannot become image URLs', async () => {
    let finish: ((value: unknown) => void) | undefined;
    const client = createServiceClient(async () => new Promise((resolve) => { finish = resolve; }));
    const old = client.resolve(english());
    await new Promise((resolve) => setTimeout(resolve, 15)); client.clear(); finish!([result(ID)]);
    expect(await old).toEqual({});
    const queued = client.resolve(english()); client.dispose(); expect(await queued).toEqual({});
    for (const dataUrl of ['https://evil.test/a', 'data:image/svg+xml;base64,AAAA', `data:image/webp;base64,${'A'.repeat(MAX_IMAGE_BYTES * 2)}`]) {
      const c = createServiceClient(async (message) => (message as { type: string }).type.endsWith('lookup') ? [result(ID)] : { dataUrl });
      const value = await c.resolve(english()); expect(value.url).toBeUndefined(); expect(value.face?.name_zh).toBe('平原'); c.dispose();
    }
  });
});
