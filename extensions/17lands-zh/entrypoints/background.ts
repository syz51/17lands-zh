import { browser } from 'wxt/browser';
import { CardService } from '../src/card-service';
import { IndexedMetadataStore, PersistentImageStore } from '../src/persistent-cache';
import { createMessageHandler } from '../src/runtime-handler';
import { StatsService } from '../src/stats-service';
import { IndexedStatsStore } from '../src/stats-store';

export default defineBackground(() => {
  const service = new CardService(new IndexedMetadataStore(), new PersistentImageStore());
  const stats = new StatsService(new IndexedStatsStore(), (ids) => service.lookup(ids), async () => {
    const settings = await browser.storage.local.get('statsMockExpansion');
    return { statsMockExpansion: typeof settings.statsMockExpansion === 'string' ? settings.statsMockExpansion : null };
  }, undefined, undefined, (ids) => service.peek(ids));
  const handle = createMessageHandler(service, browser.runtime.id, browser.runtime.getURL('/popup.html'), stats);
  // Returning true keeps MV3's response channel alive through IDB/network awaits in Chrome and Firefox.
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    void handle(message, sender).then(respond).catch(() => respond({ error: '消息无效或本地服务不可用' }));
    return true;
  });
});
