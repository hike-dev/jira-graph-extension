import type { GraphIssue } from '../src/shared/model';
import { STAGE_LABELS, type Stage } from '../src/shared/stages';
import {
  activeCount, EMPTY_FILTER, facetCount, facetOptions, FacetKey, FilterContext, FilterState, FLAG_LABELS, FlagId,
  isActive, matchesFilter, NONE, sortMatches, SortKey,
} from './filter';
import { UI_ICONS } from './icons';

// Toolbar filter box + facet popover + a collapsible, resizable results list with prev/next stepping.

export interface FilterPrefs {
  filter?: FilterState;
  sort?: SortKey;
  listWidth?: number;
  listCollapsed?: boolean;
  listHidden?: boolean;
}

export interface FilterPanelContext {
  app: HTMLElement;
  stage: HTMLElement;
  issues: () => GraphIssue[];
  filterCtx: () => FilterContext;
  /** Layout position of a visible ticket (undefined when it is not drawn). */
  position: (key: string) => { x: number; y: number } | undefined;
  typeInfo: (i: GraphIssue) => { label: string; icon: string };
  typeInfoByKey: (typeKey: string) => { label: string; icon: string } | undefined;
  stageOf: (i: GraphIssue) => Stage;
  avatarColor: (name: string) => string;
  initials: (name: string) => string;
  selected: () => string | undefined;
  navigate: (key: string) => void;
  details: (key: string) => void;
  hover: (key: string | undefined) => void;
  changed: (hideModeChanged: boolean) => void;
  save: (prefs: FilterPrefs) => void;
}

const LIST_DEFAULT = 340;
const LIST_MIN = 240;

export class FilterPanel {
  filter: FilterState;
  private sort: SortKey;
  private width: number;
  private collapsed: boolean;
  private hidden: boolean;
  private matches: GraphIssue[] = [];
  private index = -1;
  readonly matchSet = new Set<string>();
  private readonly input: HTMLInputElement;
  private readonly box: HTMLElement;
  private readonly pop: HTMLElement;
  private readonly list: HTMLElement;
  private debounce = 0;

  constructor(private readonly c: FilterPanelContext, prefs: FilterPrefs) {
    this.filter = { ...EMPTY_FILTER, ...(prefs.filter ?? {}) };
    this.sort = prefs.sort ?? 'graph';
    this.width = prefs.listWidth ?? LIST_DEFAULT;
    this.collapsed = !!prefs.listCollapsed;
    this.hidden = !!prefs.listHidden;

    this.box = c.app.querySelector<HTMLElement>('.filterbox')!;
    this.input = this.box.querySelector('input')!;
    this.input.value = this.filter.text;
    this.pop = document.createElement('div');
    this.pop.className = 'fpop';
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', 'Filter options');
    c.app.appendChild(this.pop);
    this.list = document.createElement('section');
    this.list.className = 'results';
    this.list.setAttribute('aria-label', 'Filter results');
    c.stage.appendChild(this.list);
    this.wire();
    this.applyWidth();
  }

  get active(): boolean {
    return isActive(this.filter);
  }

  /** Recompute matches (model, layout or filter changed) and re-render the box, list and popover. */
  refresh() {
    const issues = this.c.issues();
    const fc = this.c.filterCtx();
    const found = this.active ? issues.filter((i) => matchesFilter(i, this.filter, fc)) : [];
    const current = this.matches[this.index]?.key;
    this.matches = sortMatches(found, this.sort, { stage: this.c.stageOf, position: this.c.position });
    this.matchSet.clear();
    for (const m of this.matches) this.matchSet.add(m.key);
    // Keep the current item across refreshes; follow the selection when it is a match.
    const sel = this.c.selected();
    const keep = current ?? sel;
    this.index = keep ? this.matches.findIndex((m) => m.key === keep) : -1;
    this.renderBox();
    this.renderList();
    if (this.pop.classList.contains('open')) this.renderPop();
  }

  /** Selection changed elsewhere (click on the graph): make it the current item when it matches. */
  syncSelection() {
    const sel = this.c.selected();
    const i = sel ? this.matches.findIndex((m) => m.key === sel) : -1;
    if (i !== this.index) {
      this.index = i;
      this.renderBox();
      this.markCurrent(true);
    }
  }

  step(dir: 1 | -1) {
    if (!this.matches.length) return;
    this.index = this.index < 0 ? (dir > 0 ? 0 : this.matches.length - 1) : (this.index + dir + this.matches.length) % this.matches.length;
    const key = this.matches[this.index].key;
    this.renderBox();
    this.markCurrent(true);
    this.c.navigate(key);
  }

  focusInput() {
    this.input.focus();
    this.input.select();
  }

  clear() {
    const hideWas = this.filter.mode === 'hide';
    this.filter = { ...EMPTY_FILTER, mode: this.filter.mode };
    this.input.value = '';
    this.commit(hideWas);
  }

  closePopover() {
    this.pop.classList.remove('open');
    this.box.querySelector('[data-fb="facets"]')?.classList.remove('on');
  }

  // ── internals ──────────────────────────────────────────────────────────────
  private commit(relayout = this.filter.mode === 'hide') {
    this.index = -1;
    this.save();
    // Matches first: "show only matches" reads matchSet while it relayouts.
    this.refresh();
    this.c.changed(relayout);
  }

  private save() {
    this.c.save({ filter: this.filter, sort: this.sort, listWidth: this.width, listCollapsed: this.collapsed, listHidden: this.hidden });
  }

  private wire() {
    this.input.addEventListener('input', () => {
      clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => {
        this.filter = { ...this.filter, text: this.input.value };
        this.commit();
      }, 120);
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        if (this.input.value) {
          this.input.value = '';
          this.filter = { ...this.filter, text: '' };
          this.commit();
        } else this.input.blur();
      } else if (e.key === 'ArrowDown' && this.matches.length && !this.hidden) {
        e.preventDefault();
        this.list.querySelector<HTMLElement>('.rr')?.focus();
      }
    });
    this.box.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-fb]');
      if (!b) return;
      const a = b.dataset.fb;
      if (a === 'prev') this.step(-1);
      if (a === 'next') this.step(1);
      if (a === 'facets') {
        e.stopPropagation();
        this.togglePopover();
      }
      if (a === 'list') {
        this.hidden = !this.hidden;
        this.save();
        this.renderBox();
        this.renderList();
      }
    });

    // Popover
    this.pop.addEventListener('click', (e) => {
      e.stopPropagation();
      const chip = (e.target as Element).closest<HTMLElement>('[data-facet]');
      if (chip) {
        const facet = chip.dataset.facet as FacetKey;
        const v = chip.dataset.value!;
        const cur = this.filter[facet] as string[];
        this.filter = { ...this.filter, [facet]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
        this.commit();
        return;
      }
      const mode = (e.target as Element).closest<HTMLElement>('[data-mode]');
      if (mode) {
        this.filter = { ...this.filter, mode: mode.dataset.mode as FilterState['mode'] };
        this.commit(true);
        return;
      }
      if ((e.target as Element).closest('[data-clear]')) this.clear();
    });
    document.addEventListener('click', (e) => {
      if (!this.pop.contains(e.target as Node) && !this.box.contains(e.target as Node)) this.closePopover();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pop.classList.contains('open')) {
        this.closePopover();
        e.stopPropagation();
      }
    }, true);

    // Results list
    this.list.addEventListener('click', (e) => {
      const t = e.target as Element;
      if (t.closest('[data-rl="collapse"]')) {
        this.collapsed = !this.collapsed;
        this.save();
        this.renderList();
        return;
      }
      if (t.closest('[data-rl="close"]')) {
        this.hidden = true;
        this.save();
        this.renderBox();
        this.renderList();
        return;
      }
      if (t.closest('[data-rl="prev"]')) return this.step(-1);
      if (t.closest('[data-rl="next"]')) return this.step(1);
      if (t.closest('[data-rl="clear"]')) return this.clear();
      const info = t.closest<HTMLElement>('[data-rdetails]');
      if (info) return this.c.details(info.dataset.rdetails!);
      const row = t.closest<HTMLElement>('.rr');
      if (row) this.goTo(Number(row.dataset.i));
    });
    this.list.addEventListener('dblclick', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('.rr');
      if (row) this.c.details(row.dataset.key!);
    });
    this.list.addEventListener('change', (e) => {
      const sel = (e.target as Element).closest<HTMLSelectElement>('[data-rl="sort"]');
      if (!sel) return;
      this.sort = sel.value as SortKey;
      this.save();
      this.refresh();
    });
    this.list.addEventListener('pointerover', (e) => this.c.hover((e.target as Element).closest<HTMLElement>('.rr')?.dataset.key));
    this.list.addEventListener('pointerleave', () => this.c.hover(undefined));
    this.list.addEventListener('keydown', (e) => {
      const row = (e.target as Element).closest<HTMLElement>('.rr');
      if (!row) return;
      const i = Number(row.dataset.i);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const j = Math.min(this.matches.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
        this.goTo(j);
        this.list.querySelector<HTMLElement>(`.rr[data-i="${j}"]`)?.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.c.details(row.dataset.key!);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        this.input.focus();
      }
    });
    // Wheel inside the list scrolls the list, not the canvas.
    this.list.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    // Resize handle (right edge)
    this.list.addEventListener('pointerdown', (e) => {
      const h = (e.target as Element).closest('.results-resizer');
      if (!h || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        (h as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Capture can be refused; dragging still works while over the handle.
      }
      this.c.stage.classList.add('resizing-list');
      const left = this.c.stage.getBoundingClientRect().left;
      const move = (ev: PointerEvent) => {
        this.width = ev.clientX - left;
        this.applyWidth();
      };
      const up = () => {
        h.removeEventListener('pointermove', move as EventListener);
        this.c.stage.classList.remove('resizing-list');
        this.save();
      };
      h.addEventListener('pointermove', move as EventListener);
      h.addEventListener('pointerup', up, { once: true });
      h.addEventListener('pointercancel', up, { once: true });
    });
    this.list.addEventListener('dblclick', (e) => {
      if (!(e.target as Element).closest('.results-resizer')) return;
      this.width = LIST_DEFAULT;
      this.applyWidth();
      this.save();
    });
    window.addEventListener('resize', () => this.applyWidth());
  }

  private goTo(i: number) {
    if (!this.matches[i]) return;
    this.index = i;
    this.renderBox();
    this.markCurrent(true);
    this.c.navigate(this.matches[i].key);
  }

  private applyWidth() {
    const max = Math.max(LIST_MIN, Math.round(this.c.stage.clientWidth * 0.5));
    this.width = Math.round(Math.min(max, Math.max(LIST_MIN, this.width)));
    this.c.stage.style.setProperty('--results-w', `${this.width}px`);
  }

  private togglePopover() {
    const open = !this.pop.classList.contains('open');
    this.pop.classList.toggle('open', open);
    this.box.querySelector('[data-fb="facets"]')?.classList.toggle('on', open);
    if (open) {
      this.renderPop();
      const r = this.box.getBoundingClientRect();
      const w = this.pop.offsetWidth;
      this.pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
      this.pop.style.top = `${r.bottom + 6}px`;
    }
  }

  private renderBox() {
    const n = this.matches.length;
    const active = this.active;
    this.box.classList.toggle('active', active);
    const count = this.box.querySelector<HTMLElement>('.fb-count')!;
    count.textContent = active ? (n ? `${this.index >= 0 ? this.index + 1 : '–'} / ${n}` : 'no match') : '';
    count.classList.toggle('none', active && !n);
    const badge = this.box.querySelector<HTMLElement>('.fb-badge')!;
    const fc = facetCount(this.filter);
    badge.textContent = fc ? String(fc) : '';
    badge.hidden = !fc;
    for (const b of this.box.querySelectorAll<HTMLButtonElement>('[data-fb="prev"], [data-fb="next"]')) b.disabled = !n;
    this.box.querySelector('[data-fb="list"]')?.classList.toggle('on', active && !this.hidden);
  }

  private renderList() {
    const show = this.active && !this.hidden;
    this.c.stage.classList.toggle('results-open', show && !this.collapsed);
    this.c.stage.classList.toggle('results-collapsed', show && this.collapsed);
    this.list.classList.toggle('open', show);
    this.list.classList.toggle('collapsed', this.collapsed);
    if (!show) {
      this.list.innerHTML = '';
      return;
    }
    const n = this.matches.length;
    const sortOpt = (v: SortKey, l: string) => `<option value="${v}"${this.sort === v ? ' selected' : ''}>${l}</option>`;
    const rows = this.matches.map((i, idx) => {
      const t = this.c.typeInfo(i);
      const st = this.c.stageOf(i);
      const drawn = !!this.c.position(i.key);
      return `<div class="rr${idx === this.index ? ' cur' : ''}${drawn ? '' : ' offview'}" role="option" tabindex="-1" data-i="${idx}" data-key="${esc(i.key)}" aria-selected="${idx === this.index}">
        ${t.icon}<b class="rr-key">${esc(i.key)}</b>
        <span class="rr-status st-${st}" title="${esc(`${i.status} · ${STAGE_LABELS[st]}`)}"><i></i>${esc(i.status)}</span>
        <span class="rr-sum" title="${esc(i.summary)}">${esc(i.summary)}</span>
        ${drawn ? '' : `<span class="rr-off" title="Not in the current view (collapsed, filtered or hidden) — selecting reveals it">${UI_ICONS.hide}</span>`}
        ${i.assignee ? `<span class="rr-av" style="background:${this.c.avatarColor(i.assignee)}" title="${esc(i.assignee)}">${esc(this.c.initials(i.assignee))}</span>` : '<span class="rr-av none" title="Unassigned"></span>'}
        <button class="rr-info" data-rdetails="${esc(i.key)}" title="Details (Enter)" aria-label="Details">${UI_ICONS.info}</button>
      </div>`;
    }).join('');
    this.list.innerHTML = `
      <header class="rl-head">
        <button class="icon" data-rl="collapse" title="${this.collapsed ? 'Expand list' : 'Collapse list'}" aria-expanded="${!this.collapsed}">${this.collapsed ? '▸' : '▾'}</button>
        <span class="rl-title">${n ? `${n} match${n === 1 ? '' : 'es'}` : 'No matches'}</span>
        <span class="rl-pos">${n && this.index >= 0 ? `${this.index + 1} / ${n}` : ''}</span>
        <button class="icon" data-rl="prev" title="Previous match (Shift+Enter / Shift+F3)" ${n ? '' : 'disabled'}>‹</button>
        <button class="icon" data-rl="next" title="Next match (Enter / F3)" ${n ? '' : 'disabled'}>›</button>
        <button class="icon" data-rl="close" title="Hide list (the filter stays)">${UI_ICONS.close}</button>
      </header>
      <div class="rl-bar">
        <label>Sort <select data-rl="sort" title="Order of the list and of stepping">
          ${sortOpt('graph', 'Graph order')}${sortOpt('key', 'Key')}${sortOpt('stage', 'Stage')}${sortOpt('updated', 'Recently updated')}${sortOpt('priority', 'Priority')}
        </select></label>
        <span class="rl-spacer"></span>
        <button class="rl-clear" data-rl="clear" title="Clear the filter">Clear filter</button>
      </div>
      <div class="rl-body" role="listbox" aria-label="Matching tickets">${rows || '<div class="rl-empty">Nothing matches. Loosen the text or the filter options.</div>'}</div>
      <div class="results-resizer" role="separator" aria-orientation="vertical" title="Drag to resize · double-click to reset"></div>`;
    this.markCurrent(false);
  }

  private markCurrent(scroll: boolean) {
    this.list.querySelectorAll('.rr.cur').forEach((r) => r.classList.remove('cur'));
    const row = this.list.querySelector<HTMLElement>(`.rr[data-i="${this.index}"]`);
    row?.classList.add('cur');
    const pos = this.list.querySelector<HTMLElement>('.rl-pos');
    if (pos) pos.textContent = this.matches.length && this.index >= 0 ? `${this.index + 1} / ${this.matches.length}` : '';
    if (scroll && row) row.scrollIntoView({ block: 'nearest' });
  }

  private renderPop() {
    const fc = this.c.filterCtx();
    const opts = facetOptions(this.c.issues(), this.filter, fc);
    const on = (facet: FacetKey, v: string) => (this.filter[facet] as string[]).includes(v);
    const chip = (facet: FacetKey, o: { value: string; label: string; count: number }, lead = '', tip = '') =>
      `<button class="fchip${on(facet, o.value) ? ' on' : ''}${o.count ? '' : ' zero'}" data-facet="${facet}" data-value="${esc(o.value)}" aria-pressed="${on(facet, o.value)}"${tip ? ` title="${esc(tip)}"` : ''}>${lead}<span>${esc(o.label)}</span><em>${o.count}</em></button>`;
    const section = (title: string, facet: FacetKey, body: string, many = false) =>
      body ? `<div class="fsec${many ? ' many' : ''}"><h6>${title}${(this.filter[facet] as string[]).length ? ` <span class="fsel">${(this.filter[facet] as string[]).length}</span>` : ''}</h6><div class="fchips">${body}</div></div>` : '';
    const stages = opts.stages.map((o) => chip('stages', { ...o, label: STAGE_LABELS[o.value as Stage] }, `<i class="sdot st-${o.value}"></i>`)).join('');
    const types = opts.types.map((o) => {
      const t = this.c.typeInfoByKey(o.value);
      return chip('types', { ...o, label: t?.label ?? o.value }, t?.icon ?? '');
    }).join('');
    const statuses = opts.statuses.map((o) => chip('statuses', o)).join('');
    const assignees = opts.assignees.map((o) =>
      chip('assignees', o, o.value === NONE ? '<i class="fav none"></i>' : `<i class="fav" style="background:${this.c.avatarColor(o.value)}">${esc(this.c.initials(o.value))}</i>`)).join('');
    const priorities = opts.priorities.map((o) => chip('priorities', o)).join('');
    const sprints = opts.sprints.map((o) => chip('sprints', o)).join('');
    const labels = opts.labels.map((o) => chip('labels', o)).join('');
    const flags = opts.flags.map((o) => chip('flags', o, '', FLAG_LABELS[o.value as FlagId][1])).join('');
    const mode = this.filter.mode;
    this.pop.innerHTML = `
      <div class="fpop-head">
        <span>Filter</span>
        <div class="seg small" role="radiogroup" aria-label="Match mode">
          <button data-mode="dim" class="${mode === 'dim' ? 'on' : ''}" title="Highlight matches, fade the rest">Dim others</button>
          <button data-mode="hide" class="${mode === 'hide' ? 'on' : ''}" title="Show only matches (their parents stay as context)">Show only matches</button>
        </div>
        <span class="rl-spacer"></span>
        <button class="rl-clear" data-clear="1" ${activeCount(this.filter) ? '' : 'disabled'}>Clear all</button>
      </div>
      <div class="fpop-body">
        ${section('Stage', 'stages', stages)}
        ${section('Type', 'types', types)}
        ${section('Status', 'statuses', statuses, true)}
        ${section('Assignee', 'assignees', assignees, true)}
        ${section('Priority', 'priorities', priorities)}
        ${section('Sprint', 'sprints', sprints, true)}
        ${section('Labels', 'labels', labels, true)}
        ${section('Flags', 'flags', flags)}
      </div>
      <div class="fpop-foot">Values in a group are combined with <b>or</b>, groups with <b>and</b>. Numbers show what each choice would match.</div>`;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}
