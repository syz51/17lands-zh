import { expect, test } from 'bun:test';
import type { CardService } from '../src/card-service';
import { createMessageHandler } from '../src/runtime-handler';
import { statsCards, statsQuery } from './stats-fixture';

const site = { id: 'extension', url: 'https://www.17lands.com/site_draft/example', tab: {} };
const popup = { id: 'extension', url: 'chrome-extension://extension/popup.html' };

test('stats messages accept only validated 17Lands content and exact bounded message schemas', async () => {
  const calls: unknown[] = [];
  const stats = { query: async (...args: unknown[]) => { calls.push(['query', ...args]); return { fixture: true } as never; },
    retry: async (...args: unknown[]) => { calls.push(['retry', ...args]); return null; } };
  const handle = createMessageHandler({} as CardService, 'extension', popup.url, stats);
  expect(await handle({ type: '17lands-zh:stats', query: statsQuery, cards: statsCards }, site)).toEqual({ fixture: true });
  await handle({ type: '17lands-zh:stats', query: statsQuery, cards: [] }, site);
  await handle({ type: '17lands-zh:stats-retry', query: statsQuery }, site);
  expect(calls).toHaveLength(3);
  const badMessages = [
    { type: '17lands-zh:stats', query: statsQuery, cards: statsCards, url: 'https://evil.test' },
    { type: '17lands-zh:stats', query: { ...statsQuery, expansion: undefined }, cards: [] },
    { type: '17lands-zh:stats', query: { ...statsQuery, extra: true }, cards: [] },
    { type: '17lands-zh:stats', query: statsQuery, cards: Array(65).fill(statsCards[0]) },
    { type: '17lands-zh:stats', query: statsQuery, cards: [{ ...statsCards[0], name: 'x'.repeat(201) }] },
    { type: '17lands-zh:stats', query: statsQuery, cards: [{ ...statsCards[0], face: 'side' }] },
    { type: '17lands-zh:stats', query: statsQuery, cards: [{ ...statsCards[0], id: 'no' }] },
    { type: '17lands-zh:stats', query: statsQuery },
    { type: '17lands-zh:stats-retry', query: statsQuery, cards: [] },
    { type: '17lands-zh:stats-retry' },
  ];
  for (const message of badMessages) await expect(handle(message, site)).rejects.toThrow();
  for (const sender of [popup, { ...site, id: 'other' }, { ...site, tab: undefined },
    { ...site, url: 'https://www.17lands.com.evil/' }, { ...site, url: 'http://17lands.com/' },
    { ...site, url: 'https://17lands.com:444/' }, { ...site, url: 'https://user@17lands.com/' }]) {
    await expect(handle({ type: '17lands-zh:stats', query: statsQuery, cards: [] }, sender)).rejects.toThrow();
    await expect(handle({ type: '17lands-zh:stats-retry', query: statsQuery }, sender)).rejects.toThrow();
  }
  expect(calls).toHaveLength(3);
  const oldHandler = createMessageHandler({} as CardService, 'extension', popup.url);
  await expect(oldHandler({ type: '17lands-zh:stats', query: statsQuery, cards: [] }, site)).rejects.toThrow();
});
