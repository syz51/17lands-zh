import type { CardFace } from './cache-contract';

type Entry = { face: CardFace; label: string; enter: () => void; leave: () => void };

/** A separate non-modal reading surface never intercepts the site's pick event or changes card alt text. */
export class ReadingPanel {
  private readonly entries = new Map<Element, Entry>();
  private host?: HTMLElement;
  private launcher?: HTMLButtonElement;
  private panel?: HTMLElement;
  private select?: HTMLSelectElement;
  private text?: HTMLElement;
  private pinned = false;
  private active?: Element;
  private hideTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly document: Document) {}

  set(element: Element, face: CardFace, label: string) {
    this.remove(element);
    if (!face.name_zh && !face.type_line_zh && !face.oracle_text_zh) return;
    this.ensure();
    const entry = { face, label, enter: () => { if (!this.pinned) this.show(element); }, leave: () => this.deferHide() };
    this.entries.set(element, entry);
    element.addEventListener('pointerenter', entry.enter);
    element.addEventListener('pointerleave', entry.leave);
    element.addEventListener('focusin', entry.enter);
    element.addEventListener('focusout', entry.leave);
    this.update();
  }
  remove(element: Element) {
    const entry = this.entries.get(element);
    if (!entry) return;
    for (const event of ['pointerenter', 'focusin']) element.removeEventListener(event, entry.enter);
    for (const event of ['pointerleave', 'focusout']) element.removeEventListener(event, entry.leave);
    this.entries.delete(element);
    if (this.active === element) { this.active = undefined; this.panel!.hidden = true; }
    this.update();
  }
  clear() {
    for (const element of this.entries.keys()) this.remove(element);
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = undefined; }
    this.pinned = false; this.active = undefined;
    if (this.panel) this.panel.hidden = true;
    this.launcher?.setAttribute('aria-expanded', 'false');
  }
  dispose() { this.clear(); if (this.hideTimer) clearTimeout(this.hideTimer); this.host?.remove(); }
  private update() {
    if (!this.host) return;
    this.host.hidden = this.entries.size === 0;
    this.launcher!.textContent = '查看中文牌文';
    const options = [...this.entries.values()].map((entry, index) => {
      const option = this.document.createElement('option'); option.value = String(index);
      option.textContent = `${entry.face.name_zh || entry.label}${entry.face.face === 'back' ? ' · 背面' : ''}`;
      return option;
    });
    this.select!.replaceChildren(...options);
  }
  private show(element: Element) {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const entry = this.entries.get(element);
    if (!entry || !this.panel) return;
    this.active = element; this.panel.hidden = false;
    this.launcher!.setAttribute('aria-expanded', 'true');
    this.select!.selectedIndex = [...this.entries.keys()].indexOf(element);
    const name = this.document.createElement('strong'); name.textContent = entry.face.name_zh || entry.label;
    const type = this.document.createElement('p'); type.textContent = entry.face.type_line_zh;
    const rules = this.document.createElement('p'); rules.textContent = entry.face.oracle_text_zh;
    const source = this.document.createElement('small'); source.textContent = `译文来源：${entry.face.source}；卡图保留英文。`;
    this.text!.replaceChildren(name, type, rules, source);
  }
  private deferHide() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.pinned && this.panel) { this.panel.hidden = true; this.launcher!.setAttribute('aria-expanded', 'false'); }
    }, 200);
  }
  private ensure() {
    if (this.host) return;
    this.host = this.document.createElement('div'); this.host.dataset.landsZhReader = '';
    // Isolate site CSS without injecting any untrusted HTML.
    const root = this.host.attachShadow({ mode: 'open' });
    const style = this.document.createElement('style');
    style.textContent = `:host{all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483646;font:14px/1.6 system-ui,sans-serif;color:#252721} :host([hidden]),[hidden]{display:none!important} button,select{font:inherit;color:inherit;background:#f7f8f3;border:1px solid #afbba4;border-radius:5px;padding:6px 10px} button{cursor:pointer} button:focus-visible,select:focus-visible{outline:2px solid #557b40;outline-offset:2px} section{width:min(320px,calc(100vw - 24px));max-height:55vh;overflow:auto;background:#f7f8f3;border:1px solid #afbba4;border-radius:5px;padding:14px;margin-bottom:8px;box-shadow:0 4px 18px #0003} header{display:flex;align-items:center;justify-content:space-between;gap:8px} select{width:100%;margin:10px 0} p{white-space:pre-wrap;margin:8px 0} small{color:#656b5f} @media(prefers-color-scheme:dark){:host{color:#ecefe6} section,button,select{background:#23271f;border-color:#68795b} small{color:#b3bcaa}}`;
    this.panel = this.document.createElement('section'); this.panel.hidden = true;
    this.panel.id = 'zh-reading'; this.panel.setAttribute('role', 'region'); this.panel.setAttribute('aria-label', '中文牌文');
    const header = this.document.createElement('header'); const title = this.document.createElement('strong'); title.textContent = '中文牌文';
    const close = this.document.createElement('button'); close.type = 'button'; close.textContent = '关闭';
    const hide = () => { this.pinned = false; this.panel!.hidden = true; this.launcher!.setAttribute('aria-expanded', 'false'); };
    close.addEventListener('click', () => { hide(); this.launcher!.focus(); });
    this.panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { hide(); this.launcher!.focus(); } });
    this.panel.addEventListener('pointerenter', () => { if (this.hideTimer) clearTimeout(this.hideTimer); });
    this.panel.addEventListener('pointerleave', () => this.deferHide());
    this.panel.addEventListener('focusin', () => { this.pinned = true; });
    header.append(title, close);
    this.select = this.document.createElement('select'); this.select.setAttribute('aria-label', '选择要阅读的卡牌');
    this.select.addEventListener('change', () => { const element = [...this.entries.keys()][this.select!.selectedIndex]; if (element) this.show(element); });
    this.text = this.document.createElement('div');
    this.panel.append(header, this.select, this.text);
    this.launcher = this.document.createElement('button'); this.launcher.type = 'button';
    this.launcher.setAttribute('aria-controls', 'zh-reading'); this.launcher.setAttribute('aria-expanded', 'false');
    this.launcher.addEventListener('click', () => {
      if (!this.panel!.hidden) { hide(); return; }
      this.pinned = true;
      const element = this.active ?? this.entries.keys().next().value;
      if (element) { this.show(element); this.select!.focus(); }
    });
    root.append(style, this.panel, this.launcher); this.document.documentElement.append(this.host);
  }
}
