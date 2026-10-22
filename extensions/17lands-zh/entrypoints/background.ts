import { browser } from 'wxt/browser';
import { CardService } from '../src/card-service';
import { IndexedMetadataStore, PersistentImageStore } from '../src/persistent-cache';
import { createMessageHandler } from '../src/runtime-handler';

export default defineBackground(() => {
  const service = new CardService(new IndexedMetadataStore(), new PersistentImageStore());
  const handle = createMessageHandler(service, browser.runtime.id, browser.runtime.getURL('/popup.html'));
  // Returning true keeps MV3's response channel alive through IDB/network awaits in Chrome and Firefox.
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    void handle(message, sender).then(respond).catch(() => respond({ error: '消息无效或本地服务不可用' }));
    return true;
  });
});
