import type { GraphIssue, GraphLink } from '../src/shared/model';
import type { LensMark } from './lens';
import { fmtAge } from './lens';
import { iconMarkup, PRIORITY, TypeStyle } from './typeStyles';

// Rich ticket card shown after hovering a ticket for `delayMs`. It stays open while the pointer
// moves into it, so its keys can be clicked; it closes on leave, pan, zoom, click or Escape.

export interface HoverCardContext {
  issue: (key: string) => GraphIssue | undefined;
  links: () => GraphLink[];
  childrenOf: (key: string) => string[];
  rollup: (key: string) => { new: number; indeterminate: number; done: number } | undefined;
  blocked: (key: string) => boolean;
  blockerSummary: (key: string) => string;
  /** Worst still-blocking state of a ticket (colours the alert). */
  blockState: (key: string) => string | undefined;
  /** State of the blocks link from → to, for the stage dot on relation chips. */
  linkState: (from: string, to: string) => string | undefined;
  stageLabel: (i: GraphIssue) => string;
  lens: (key: string) => LensMark | undefined;
  lensLabel: () => string | undefined;
  chain: (key: string) => { up: Map<string, number>; down: Map<string, number> };
  styleOf: (i: GraphIssue) => TypeStyle;
  avatarColor: (name: string) => string;
  initials: (name: string) => string;
  /** Node element for positioning. */
  anchor: (key: string) => Element | undefined;
  onReveal: (key: string) => void;
  onOpen: (key: string) => void;
  onUrl: (url: string) => void;
  /** Description state: undefined → not requested yet (the card requests it). */
  description: (key: string) => DescriptionState | undefined;
  requestDescription: (key: string) => void;
  /** True when there is no description yet, or the last attempt failed and may be retried. */
  needsDescription: (key: string) => boolean;
  descriptionLines: () => number;
}

export type DescriptionState = { loading: true } | { html: string } | { error: string };

/**
 * Collapsible description block, shared by the hover card and the details drawer.
 * Collapsed to `lines` lines with a fade; the toggle only shows when the text overflows (see fitDescription).
 */
export function descriptionBlock(state: DescriptionState | undefined, lines: number, expanded: boolean): string {
  const head = '<div class="desc-label">Description</div>';
  if (!state || 'loading' in state) {
    return `<div class="desc loading">${head}<div class="desc-skeleton"><i></i><i></i><i style="width:62%"></i></div></div>`;
  }
  if ('error' in state) return `<div class="desc">${head}<div class="desc-empty">Could not load the description: ${esc(state.error)}</div></div>`;
  if (!state.html.trim()) return `<div class="desc">${head}<div class="desc-empty">No description</div></div>`;
  return `<div class="desc${expanded ? ' expanded' : ' collapsed'}" style="--desc-lines:${lines}">${head}
    <div class="desc-body">${state.html}</div>
    <button class="desc-toggle" data-desc-toggle="1" aria-expanded="${expanded}">${expanded ? 'Show less' : 'Show more'}</button>
  </div>`;
}

/** Hide the toggle and fade when the collapsed text fits anyway. */
export function fitDescription(root: Element) {
  const d = root.querySelector<HTMLElement>('.desc.collapsed');
  const body = d?.querySelector<HTMLElement>('.desc-body');
  if (!d || !body) return;
  d.classList.toggle('fits', body.scrollHeight <= body.clientHeight + 2);
}

const GRACE_MS = 180;
/** Moving from one ticket to another while a card is open switches quickly. */
const WARM_DELAY = 180;

export class HoverCard {
  private readonly el: HTMLDivElement;
  private key: string | undefined;
  private pending: string | undefined;
  private showTimer = 0;
  private hideTimer = 0;
  private lastClosed = 0;
  private descExpanded = false;
  delayMs = 1000;
  enabled = true;

  constructor(
    private readonly stage: HTMLElement,
    private readonly ctx: HoverCardContext,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'hovercard';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-live', 'polite');
    stage.appendChild(this.el);
    this.el.addEventListener('pointerenter', () => clearTimeout(this.hideTimer));
    this.el.addEventListener('pointerleave', () => this.scheduleHide());
    this.el.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const toggle = (e.target as Element).closest('[data-desc-toggle]');
      if (toggle) {
        this.descExpanded = !this.descExpanded;
        this.refresh();
        return;
      }
      const url = (e.target as Element).closest<HTMLElement>('[data-url]');
      if (url) {
        e.preventDefault();
        this.ctx.onUrl(url.dataset.url!);
        return;
      }
      const t = (e.target as Element).closest<HTMLElement>('[data-reveal], [data-open]');
      if (!t) return;
      e.preventDefault();
      this.hide();
      if (t.dataset.reveal) this.ctx.onReveal(t.dataset.reveal);
      if (t.dataset.open) this.ctx.onOpen(t.dataset.open);
    });
  }

  get openKey(): string | undefined {
    return this.el.classList.contains('open') ? this.key : undefined;
  }

  /** Pointer entered a ticket. */
  enter(key: string) {
    clearTimeout(this.hideTimer);
    if (!this.enabled || key === this.openKey) return;
    if (this.pending === key) return;
    clearTimeout(this.showTimer);
    this.pending = key;
    const warm = !!this.openKey || Date.now() - this.lastClosed < 300;
    this.showTimer = window.setTimeout(() => this.show(key), warm ? WARM_DELAY : this.delayMs);
  }

  /** Pointer left the ticket (it may be heading into the card). */
  leave() {
    clearTimeout(this.showTimer);
    this.pending = undefined;
    this.scheduleHide();
  }

  /** Keyboard: show immediately for a key (e.g. the selection), or toggle off. */
  toggleNow(key: string) {
    if (this.openKey === key) return this.hide();
    this.show(key);
  }

  hide() {
    clearTimeout(this.showTimer);
    clearTimeout(this.hideTimer);
    this.pending = undefined;
    if (this.el.classList.contains('open')) this.lastClosed = Date.now();
    this.el.classList.remove('open');
    this.key = undefined;
  }

  /** Re-render in place if the open ticket changed (live sync). */
  refresh() {
    const k = this.openKey;
    if (!k) return;
    const cur = this.ctx.issue(k);
    if (!cur || !this.ctx.anchor(k)) return this.hide();
    const scroll = this.el.scrollTop;
    this.el.innerHTML = this.render(cur);
    fitDescription(this.el);
    this.place(k);
    this.el.scrollTop = scroll;
  }

  private scheduleHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), GRACE_MS);
  }

  private show(key: string) {
    this.pending = undefined;
    const i = this.ctx.issue(key);
    if (!i || !this.ctx.anchor(key)) return;
    if (this.key !== key) this.descExpanded = false;
    this.key = key;
    if (this.ctx.needsDescription(key)) this.ctx.requestDescription(key);
    this.el.innerHTML = this.render(i);
    fitDescription(this.el);
    this.el.classList.add('open');
    this.place(key);
  }

  /** Beside the ticket (right, else left), top-aligned, clamped inside the stage. */
  private place(key: string) {
    const a = this.ctx.anchor(key)!.getBoundingClientRect();
    const s = this.stage.getBoundingClientRect();
    const c = this.el.getBoundingClientRect();
    const gap = 12;
    let left = a.right + gap;
    let side = 'right';
    if (left + c.width > s.right - 8) {
      left = a.left - gap - c.width;
      side = 'left';
    }
    if (left < s.left + 8) {
      // Very large node (zoomed in): overlap its right edge instead.
      left = Math.max(s.left + 8, Math.min(s.right - c.width - 8, a.right - c.width));
      side = 'over';
    }
    const top = Math.min(Math.max(a.top, s.top + 8), s.bottom - c.height - 8);
    this.el.style.left = `${left - s.left}px`;
    this.el.style.top = `${Math.max(8, top - s.top)}px`;
    this.el.dataset.side = side;
  }

  private render(i: GraphIssue): string {
    const c = this.ctx;
    const s = c.styleOf(i);
    const pr = i.priority ? PRIORITY[i.priority.toLowerCase()] : undefined;
    const now = Date.now();
    const rows: string[] = [];
    const row = (label: string, value: string) => rows.push(`<dt>${label}</dt><dd>${value}</dd>`);

    row('Assignee', i.assignee ? `<span class="hc-avatar" style="background:${c.avatarColor(i.assignee)}">${esc(c.initials(i.assignee))}</span>${esc(i.assignee)}` : '<i>Unassigned</i>');
    if (i.priority) {
      row('Priority', `${pr ? `<svg width="12" height="12" viewBox="0 0 12 12"><path d="${pr.path}" fill="none" stroke="${pr.color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>` : ''}${esc(i.priority)}`);
    }
    if (i.statusChangedAt) row('In status', `${fmtAge((now - Date.parse(i.statusChangedAt)) / 86_400_000)} <span class="hc-muted">since ${fmtDate(i.statusChangedAt)}</span>`);
    if (i.resolvedAt) row('Resolved', fmtDate(i.resolvedAt));
    if (i.sprints?.length) {
      row('Sprint', i.sprints.map((sp) => `<span class="hc-tag sprint-${sp.state}" title="${sp.state} sprint">${esc(sp.name)}</span>`).join(' '));
    }
    if (i.dueDate) {
      const overdue = i.statusCategory !== 'done' && Date.parse(i.dueDate) < now;
      row('Due', `<span class="${overdue ? 'hc-bad' : ''}">${fmtDate(i.dueDate)}${overdue ? ' · overdue' : ''}</span>`);
    }
    if (i.storyPoints !== undefined) row('Points', String(i.storyPoints));
    if (i.fixVersions?.length) row('Version', i.fixVersions.map((v) => `<span class="hc-tag">${esc(v)}</span>`).join(' '));
    if (i.labels.length) row('Labels', i.labels.map((l) => `<span class="hc-tag">${esc(l)}</span>`).join(' '));
    if (i.updated) row('Updated', `${relTime(i.updated)}`);

    // Hierarchy
    const parent = i.parentKey ? c.issue(i.parentKey) : undefined;
    const kids = c.childrenOf(i.key);
    const r = c.rollup(i.key);
    const total = r ? r.new + r.indeterminate + r.done : 0;
    const hierarchy: string[] = [];
    if (parent) hierarchy.push(`<div class="hc-line"><span class="hc-muted">Parent</span>${chip(parent, c)}</div>`);
    if (total) {
      const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
      hierarchy.push(`<div class="hc-line"><span class="hc-muted">${kids.length} child${kids.length === 1 ? '' : 'ren'} · ${total} below</span>
        <span class="hc-bar" title="${r!.done} done · ${r!.indeterminate} in progress · ${r!.new} to do"><i class="done" style="width:${pct(r!.done)}"></i><i class="ind" style="width:${pct(r!.indeterminate)}"></i></span>
        <span class="hc-muted">${Math.round((r!.done / total) * 100)}%</span></div>`);
    }

    // Relations, grouped by direction + label
    const groups = new Map<string, { key: string; state?: string }[]>();
    for (const l of c.links()) {
      if (l.from === i.key) groups.set(l.label, [...(groups.get(l.label) ?? []), { key: l.to, state: c.linkState(l.from, l.to) }]);
      else if (l.to === i.key) {
        const t = inverse(l.label);
        groups.set(t, [...(groups.get(t) ?? []), { key: l.from, state: c.linkState(l.from, l.to) }]);
      }
    }
    const relations = [...groups].map(([label, items]) => {
      const keys = items.map((x) => x.key);
      const shown = items.slice(0, 3).map((x) => (c.issue(x.key) ? chip(c.issue(x.key)!, c, x.state) : `<span class="hc-chip">${esc(x.key)}</span>`)).join('');
      const more = keys.length > 3 ? `<span class="hc-muted">+${keys.length - 3}</span>` : '';
      return `<div class="hc-rel"><span class="hc-rel-label">${esc(label)}</span><div class="hc-chips">${shown}${more}</div></div>`;
    });

    const { up, down } = c.chain(i.key);
    const openUp = [...up.keys()].filter((k) => c.issue(k)?.statusCategory !== 'done').length;
    const chain = up.size || down.size
      ? `<div class="hc-chain">${up.size ? `<span class="up">⬆ requires ${up.size}${openUp !== up.size ? ` · ${openUp} open` : ''}</span>` : ''}${down.size ? `<span class="down">⬇ unlocks ${down.size}</span>` : ''}</div>`
      : '';

    const lens = c.lens(i.key);
    const lensLabel = c.lensLabel();
    const lensHtml = lens?.badges.length && lensLabel
      ? `<div class="hc-lens"><span class="hc-muted">${esc(lensLabel)}</span>${lens.badges.map((b) => `<span class="lbadge tone-${b.tone}">${esc(b.text)}</span><span class="hc-lens-why">${esc(b.title)}</span>`).join('')}</div>`
      : '';

    const alerts = [
      c.blocked(i.key) ? `<div class="hc-alert bad b-${c.blockState(i.key)}">${esc(c.blockerSummary(i.key))}</div>` : '',
      i.loaded ? '' : `<div class="hc-alert info">Not loaded yet — double-click or press <kbd>E</kbd> to load it and its relations</div>`,
    ].join('');

    return `
      <div class="hc-accent" style="--type:${s.color}"></div>
      <div class="hc-head" style="--type:${s.color}">
        ${iconMarkup(s, 18)}
        <a class="hc-key" href="#" data-open="${esc(i.key)}" title="Open in Jira">${esc(i.key)}</a>
        <span class="hc-type">${esc(i.type)}</span>
        <span class="pill st-${i.statusCategory}">${esc(i.status || '—')}</span>
      </div>
      <div class="hc-summary">${esc(i.summary || '(no summary loaded)')}</div>
      ${alerts}
      ${i.loaded ? descriptionBlock(c.description(i.key), c.descriptionLines(), this.descExpanded) : ''}
      <dl class="hc-grid">${rows.join('')}</dl>
      ${hierarchy.length ? `<div class="hc-section">${hierarchy.join('')}</div>` : ''}
      ${relations.length || chain ? `<div class="hc-section">${chain}${relations.join('')}</div>` : ''}
      ${lensHtml ? `<div class="hc-section">${lensHtml}</div>` : ''}
      <div class="hc-foot">
        <span><kbd>Click</kbd> select</span><span><kbd>Enter</kbd> details</span><span><kbd>Dbl-click</kbd> Jira</span><span><kbd>Right-click</kbd> actions</span>
      </div>`;
  }
}

function chip(x: GraphIssue, c: HoverCardContext, blockState?: string): string {
  const dot = blockState ? `<span class="hc-bdot b-${blockState}"></span>` : '';
  const stage = blockState ? ` · ${c.stageLabel(x)}` : '';
  return `<button class="hc-chip s-${x.statusCategory}" data-reveal="${esc(x.key)}" title="${esc(`${x.key} · ${x.status}${stage}\n${x.summary}`)}">${dot}${iconMarkup(c.styleOf(x), 12)}<b>${esc(x.key)}</b></button>`;
}

const INVERSE: Record<string, string> = {
  blocks: 'is blocked by',
  duplicates: 'is duplicated by',
  clones: 'is cloned by',
  causes: 'is caused by',
  'relates to': 'relates to',
  tests: 'is tested by',
};
function inverse(label: string): string {
  return INVERSE[label.toLowerCase()] ?? `${label} (inward)`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function relTime(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  const f = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 60) return 'just now';
  if (s < 3600) return f.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return f.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return f.format(-Math.round(s / 86400), 'day');
  return fmtDate(iso);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
