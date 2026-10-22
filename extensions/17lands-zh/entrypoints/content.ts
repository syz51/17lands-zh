import { browser } from 'wxt/browser';
import { createImageLoader } from '../src/image-loader';
import { ImageReplacer } from '../src/image-replacer';
import { createServiceClient } from '../src/service-client';

export default defineContentScript({
  matches: ['https://www.17lands.com/*', 'https://17lands.com/*'],
  runAt: 'document_idle',
  async main(ctx) {
    const loader = createImageLoader();
    const client = createServiceClient((message) => browser.runtime.sendMessage(message));
    const replacer = new ImageReplacer(document, loader.load, client.resolve);
    let revision = 0;

    const onChanged: Parameters<typeof browser.storage.onChanged.addListener>[0] = (changes, area) => {
      if (area === 'local' && changes.enabled) {
        revision++;
        replacer.setEnabled(changes.enabled.newValue !== false);
      }
    };
    const onMessage: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (message, sender, respond) => {
      if (sender.id !== browser.runtime.id || sender.url !== browser.runtime.getURL('/popup.html') ||
        message?.type !== '17lands-zh:retry' || Object.keys(message).length !== 1) return;
      loader.clear();
      client.clear();
      replacer.refresh();
      respond({ ok: true });
    };
    browser.storage.onChanged.addListener(onChanged);
    browser.runtime.onMessage.addListener(onMessage);
    // Refresh visible cards on a bounded schedule so long-open drafts see new revisions/recovered service.
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loader.clear(); client.clear(); replacer.refresh();
    }, 5 * 60_000);
    ctx.onInvalidated(() => {
      replacer.dispose();
      loader.dispose();
      client.dispose();
      clearInterval(interval);
      browser.storage.onChanged.removeListener(onChanged);
      browser.runtime.onMessage.removeListener(onMessage);
    });

    const initialRevision = revision;
    const { enabled } = await browser.storage.local.get('enabled');
    if (ctx.isValid && revision === initialRevision) replacer.setEnabled(enabled !== false);
  },
});
