import { cardImagesIn, chineseImageUrl, replaceImages, restoreImages } from './card-images';
import { ReadingPanel } from './reading-panel';
import type { ImageResolution } from './service-client';

type Attribute = 'src' | 'srcset' | 'style';
type State = {
  original: string;
  applied?: string;
  replacements: Map<string, string>;
};

/** Changes presentation only: no fetch interception, card-name edits or click handlers. */
export class ImageReplacer {
  private readonly states = new Map<Element, Map<Attribute, State>>();
  private readonly observer: MutationObserver;
  private enabled = false;
  private disposed = false;
  private readonly reader: ReadingPanel;

  constructor(
    private readonly document: Document,
    private readonly load: (url: string) => Promise<boolean>,
    private readonly resolve?: (original: string) => Promise<ImageResolution>,
  ) {
    this.reader = new ReadingPanel(document);
    this.observer = new document.defaultView!.MutationObserver((mutations) => {
      if (!this.enabled) return;
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          this.process(mutation.target as Element, mutation.attributeName as Attribute);
        } else {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) this.scan(node as Element);
          }
        }
      }
      for (const element of this.states.keys()) {
        // Restore detached nodes too; a later re-insertion starts with the original URL.
        if (!element.isConnected) this.restore(element);
      }
    });
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'style'],
    });
  }

  setEnabled(enabled: boolean) {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this.scan(this.document.documentElement);
    else { this.restoreAll(); this.reader.clear(); }
  }

  refresh() {
    if (!this.enabled || this.disposed) return;
    this.restoreAll();
    this.reader.clear();
    this.scan(this.document.documentElement);
  }

  dispose() {
    this.disposed = true;
    this.enabled = false;
    this.observer.disconnect();
    this.restoreAll();
    this.reader.dispose();
  }

  private scan(root: Element) {
    const visit = (element: Element) => {
      if (element.tagName === 'IMG') this.process(element, 'src');
      if (element.tagName === 'IMG' || (element.tagName === 'SOURCE' && element.parentElement?.tagName === 'PICTURE')) {
        this.process(element, 'srcset');
      }
      if (element.hasAttribute('style')) this.process(element, 'style');
    };
    visit(root);
    root.querySelectorAll('img, picture source, [style*="scryfall.io"]').forEach(visit);
  }

  private process(element: Element, attribute: Attribute) {
    if (!this.enabled || this.disposed || !element.isConnected) return;
    if (attribute === 'src' && element.tagName !== 'IMG') return;
    if (attribute === 'srcset' && element.tagName !== 'IMG' && !(element.tagName === 'SOURCE' && element.parentElement?.tagName === 'PICTURE')) return;

    const current = element.getAttribute(attribute);
    const attributes = this.states.get(element);
    const previous = attributes?.get(attribute);
    if (previous && (current === previous.applied || (previous.applied === undefined && current === previous.original))) return;
    const ownsReader = (attribute === 'src' && element.tagName === 'IMG') || (attribute === 'style' && element.tagName !== 'IMG');
    if (ownsReader) this.reader.remove(element);

    // A framework may update an unrelated inline style while retaining our translated URL.
    const source = current && previous && attribute !== 'src'
      ? restoreImages(current, previous.replacements)
      : current;
    const replacements = source && (attribute !== 'src' || chineseImageUrl(source))
      ? cardImagesIn(source)
      : new Map<string, string>();
    if (!source || replacements.size === 0) {
      attributes?.delete(attribute);
      if (attributes?.size === 0) this.states.delete(element);
      return;
    }

    const state: State = { original: source, replacements: new Map() };
    const targetStates = attributes ?? new Map<Attribute, State>();
    targetStates.set(attribute, state);
    this.states.set(element, targetStates);

    void Promise.all([...replacements].map(async ([original, translated]) => {
      // Treat network failures as unavailable even if a custom loader rejects.
      const resolution = this.resolve ? await this.resolve(original).catch(() => ({} as ImageResolution)) : { url: translated };
      const available = resolution.url ? await this.load(resolution.url).catch(() => false) : false;
      return { original, translated: available ? resolution.url! : original, resolution };
    })).then((results) => {
      if (!this.enabled || this.disposed || !element.isConnected || this.states.get(element)?.get(attribute) !== state) return;
      if (element.getAttribute(attribute) !== current) return;
      state.replacements = new Map(results.filter((r) => r.original !== r.translated).map((r) => [r.original, r.translated]));
      state.applied = replaceImages(source, state.replacements);
      if (state.applied !== current) element.setAttribute(attribute, state.applied);
      const textFallback = results.find((r) => r.original === r.translated && r.resolution.face);
      if (ownsReader && textFallback?.resolution.face) this.reader.set(element, textFallback.resolution.face, element.getAttribute('alt') || '卡牌');
    });
  }

  private restore(element: Element) {
    this.reader.remove(element);
    const attributes = this.states.get(element);
    if (!attributes) return;
    this.states.delete(element);
    for (const [attribute, state] of attributes) {
      const current = element.getAttribute(attribute);
      if (state.applied === undefined || current === null) continue;
      if (current === state.applied) element.setAttribute(attribute, state.original);
      else if (attribute !== 'src') {
        const original = restoreImages(current, state.replacements);
        if (original !== current) element.setAttribute(attribute, original);
      }
    }
  }

  private restoreAll() {
    for (const element of this.states.keys()) this.restore(element);
  }
}
