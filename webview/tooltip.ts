// Lightweight hint tooltips for everything small: toolbar controls, legend rows, badges, edges.
//
// Any element can opt in with:
//   data-tip="Label"            short label (required)
//   data-tip-desc="…"           optional second line(s)
//   data-kbd="F"                optional shortcut, rendered as a key cap
//   data-tip-fn="name"          dynamic content from a registered generator (returns HTML)
// Existing `title` attributes and SVG <title> children are adopted on first hover, so the browser's
// native tooltip never competes with this one.

type TipFn = (el: Element) => string;

const SHOW_DELAY = 450;
/** After a tip closes, the next one within this window appears immediately ("warm" mode). */
const WARM_MS = 400;

export class Tooltips {
  private readonly el: HTMLDivElement;
  private readonly fns = new Map<string, TipFn>();
  private target: Element | undefined;
  private timer = 0;
  private lastHidden = 0;
  private suppressed = false;

  constructor(private readonly root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tip';
    this.el.setAttribute('role', 'tooltip');
    root.appendChild(this.el);
    root.addEventListener('pointerover', (e) => this.over(e));
    root.addEventListener('pointerout', (e) => this.out(e));
    for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) window.addEventListener(ev, () => this.hide(), { capture: true, passive: true });
    window.addEventListener('blur', () => this.hide());
  }

  register(name: string, fn: TipFn) {
    this.fns.set(name, fn);
  }

  /** While true (e.g. panning or a ticket card is open over the same spot) no hints appear. */
  suppress(v: boolean) {
    this.suppressed = v;
    if (v) this.hide();
  }

  hide() {
    clearTimeout(this.timer);
    if (this.el.classList.contains('open')) this.lastHidden = Date.now();
    this.el.classList.remove('open');
    this.target = undefined;
  }

  private over(e: PointerEvent) {
    const t = findTip(e.target as Element | null);
    if (!t || t === this.target) return;
    this.hide();
    if (this.suppressed || e.buttons) return;
    this.target = t;
    const delay = Date.now() - this.lastHidden < WARM_MS ? 0 : SHOW_DELAY;
    this.timer = window.setTimeout(() => this.show(t), delay);
  }

  private out(e: PointerEvent) {
    if (!this.target) return;
    const to = e.relatedTarget as Node | null;
    if (to && this.target.contains(to)) return;
    this.hide();
  }

  private show(t: Element) {
    if (!t.isConnected || this.suppressed) return;
    const html = this.content(t);
    if (!html) return;
    this.el.innerHTML = html;
    this.el.classList.add('open');
    this.place(t);
  }

  private content(t: Element): string {
    const fn = t.getAttribute('data-tip-fn');
    if (fn && this.fns.has(fn)) return this.fns.get(fn)!(t);
    const label = t.getAttribute('data-tip') ?? '';
    if (!label) return '';
    const desc = t.getAttribute('data-tip-desc');
    const kbd = t.getAttribute('data-kbd');
    return `<div class="tip-head"><span>${esc(label)}</span>${kbd ? kbd.split(' ').map((k) => `<kbd>${esc(k)}</kbd>`).join('') : ''}</div>${
      desc ? `<div class="tip-desc">${esc(desc).replace(/\n/g, '<br/>')}</div>` : ''
    }`;
  }

  /** Below the target by default; above when there is no room; always inside the viewport. */
  private place(t: Element) {
    const r = t.getBoundingClientRect();
    const tip = this.el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = r.bottom + 8;
    let side = 'below';
    if (top + tip.height > vh - 6) {
      top = r.top - tip.height - 8;
      side = 'above';
    }
    const left = Math.min(vw - tip.width - 6, Math.max(6, r.left + r.width / 2 - tip.width / 2));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${Math.max(6, top)}px`;
    this.el.dataset.side = side;
  }
}

/** Closest element carrying a tip, adopting native `title` / SVG <title> on the way. */
function findTip(start: Element | null): Element | undefined {
  for (let n: Element | null = start; n && n !== document.body; n = n.parentElement) {
    if (n.hasAttribute('data-tip') || n.hasAttribute('data-tip-fn')) return n;
    if (n.classList?.contains('no-tip')) return undefined;
    const title = n.getAttribute('title');
    if (title) {
      n.removeAttribute('title');
      if (!n.getAttribute('aria-label')) n.setAttribute('aria-label', title);
      adoptLabel(n, title);
      return n;
    }
    const svgTitle = [...n.children].find((c) => c.tagName.toLowerCase() === 'title');
    if (svgTitle) {
      const text = svgTitle.textContent ?? '';
      svgTitle.remove();
      adoptLabel(n, text);
      return n;
    }
  }
  return undefined;
}

/** "Fit to screen (F)" → label + key cap; "Label\nmore" → label + description. */
function adoptLabel(n: Element, text: string) {
  const [first, ...rest] = text.split('\n');
  const m = /^(.*?)\s*\(([^()]{1,12})\)\s*$/.exec(first);
  n.setAttribute('data-tip', m ? m[1] : first);
  if (m && !n.hasAttribute('data-kbd')) n.setAttribute('data-kbd', m[2]);
  if (rest.length && !n.hasAttribute('data-tip-desc')) n.setAttribute('data-tip-desc', rest.join('\n'));
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
