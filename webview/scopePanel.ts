import type { ScopeConfig, ScopeInfo } from '../src/shared/model';

// Toolbar "Scope" button + panel: what a scoped graph loads out of its query's universe.

export interface ScopePanelContext {
  app: HTMLElement;
  info: () => ScopeInfo | undefined;
  /** Whether the current graph can be scoped at all (JQL graphs). */
  scopable: () => boolean;
  apply: (scope: ScopeConfig) => void;
}

const DONE_STEPS: [number, string][] = [[0, 'None'], [7, '7 days'], [14, '14 days'], [30, '30 days'], [-1, 'All']];
const DEFAULT: ScopeConfig = { enabled: true, backlog: 50, doneDays: 14, future: true, context: true };

export function scopeSummary(cfg: ScopeConfig | undefined): string {
  if (!cfg?.enabled) return 'Whole query';
  const done = cfg.doneDays < 0 ? 'all done' : cfg.doneDays === 0 ? 'no done' : `done ${cfg.doneDays}d`;
  return `Sprint · +${cfg.backlog} backlog · ${done}`;
}

export class ScopePanel {
  private readonly btn: HTMLButtonElement;
  private readonly pop: HTMLElement;
  private draft: ScopeConfig | undefined;
  private timer = 0;

  constructor(private readonly c: ScopePanelContext) {
    this.btn = c.app.querySelector<HTMLButtonElement>('.scopebtn')!;
    this.pop = document.createElement('div');
    this.pop.className = 'fpop scopepop';
    this.pop.setAttribute('role', 'dialog');
    this.pop.setAttribute('aria-label', 'Load scope');
    c.app.appendChild(this.pop);
    this.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    this.pop.addEventListener('click', (e) => e.stopPropagation());
    this.pop.addEventListener('input', (e) => this.onInput(e));
    this.pop.addEventListener('change', (e) => this.onInput(e));
    this.pop.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-done], [data-scope-on]');
      if (!b || !this.draft) return;
      if (b.dataset.done !== undefined) this.draft = { ...this.draft, doneDays: Number(b.dataset.done) };
      if (b.dataset.scopeOn !== undefined) this.draft = { ...(this.c.info()?.config ?? DEFAULT), enabled: b.dataset.scopeOn === '1' };
      this.render();
      this.commit(0);
    });
    document.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pop.classList.contains('open')) {
        this.close();
        e.stopPropagation();
      }
    }, true);
  }

  /** New model: update the button and, if open, the panel. */
  refresh() {
    const info = this.c.info();
    this.btn.hidden = !this.c.scopable();
    this.btn.querySelector('.scope-sum')!.textContent = scopeSummary(info?.config);
    this.btn.classList.toggle('on', !!info);
    if (this.pop.classList.contains('open')) {
      this.draft = info?.config ?? this.draft;
      this.render();
    }
  }

  close() {
    this.pop.classList.remove('open');
  }

  private toggle() {
    if (this.pop.classList.contains('open')) return this.close();
    this.draft = { ...(this.c.info()?.config ?? { ...DEFAULT, enabled: false }) };
    this.pop.classList.add('open');
    this.render();
    const r = this.btn.getBoundingClientRect();
    this.pop.style.left = `${Math.max(8, Math.min(window.innerWidth - this.pop.offsetWidth - 8, r.left))}px`;
    this.pop.style.top = `${r.bottom + 6}px`;
  }

  private onInput(e: Event) {
    if (!this.draft) return;
    const t = e.target as HTMLInputElement;
    if (t.dataset.k === 'backlog') {
      this.draft = { ...this.draft, backlog: Math.max(0, Math.round(Number(t.value) || 0)) };
      const out = this.pop.querySelector<HTMLElement>('.sc-backlog-n');
      if (out) out.textContent = String(this.draft.backlog);
      this.commit(350);
    }
    if (t.dataset.k === 'future' && e.type === 'change') {
      this.draft = { ...this.draft, future: t.checked };
      this.commit(0);
    }
  }

  /** Debounced apply: the host re-selects from its index (no Jira query for scope changes). */
  private commit(delay: number) {
    clearTimeout(this.timer);
    const d = this.draft!;
    this.timer = window.setTimeout(() => this.c.apply(d), delay);
  }

  private render() {
    const info = this.c.info();
    const d = this.draft!;
    if (!d.enabled || !info) {
      this.pop.innerHTML = `
        <div class="fpop-head"><span>Load scope</span><span class="rl-spacer"></span>
          <div class="seg small"><button data-scope-on="1">Sprint scope</button><button class="on" data-scope-on="0">Whole query</button></div></div>
        <div class="fpop-body sc-off"><p>The graph loads the query as-is, up to the issue limit.</p>
          <p><b>Sprint scope</b> loads active and future sprints, the most relevant backlog tickets and recently done work, and keeps the rest as counts.</p></div>`;
      return;
    }
    const maxBacklog = Math.max(info.backlog.total, d.backlog);
    const shown = info.sprint.shown + info.context + info.backlog.shown + info.done.shown + info.requested;
    const seg = (n: number, cls: string, label: string) =>
      n ? `<i class="${cls}" style="flex:${n}" title="${label}: ${n}"></i>` : '';
    const free = Math.max(0, info.limit - shown);
    this.pop.innerHTML = `
      <div class="fpop-head"><span>Load scope</span><span class="rl-spacer"></span>
        <div class="seg small"><button class="on" data-scope-on="1">Sprint scope</button><button data-scope-on="0">Whole query</button></div></div>
      <div class="fpop-body">
        <div class="sc-row">
          <span class="sc-dot sc-sprint"></span><b>Sprint</b><span class="sc-meta">active${d.future ? ' + future' : ''}</span>
          <span class="rl-spacer"></span><span class="sc-count">${info.sprint.shown}<em> of ${info.sprint.total}</em></span><span class="sc-always">always</span>
        </div>
        <label class="sc-sub"><input type="checkbox" data-k="future" ${d.future ? 'checked' : ''}/> Include future sprints</label>
        <div class="sc-row">
          <span class="sc-dot sc-context"></span><b>Context</b><span class="sc-meta">parents and linked tickets</span>
          <span class="rl-spacer"></span><span class="sc-count">${info.context}</span><span class="sc-always">always</span>
        </div>
        <div class="sc-row">
          <span class="sc-dot sc-backlog"></span><b>Backlog</b><span class="sc-meta">most relevant first</span>
          <span class="rl-spacer"></span><span class="sc-count"><span class="sc-backlog-n">${d.backlog}</span><em> of ${info.backlog.total}</em></span>
        </div>
        <input class="sc-slider" type="range" min="0" max="${maxBacklog}" step="1" value="${Math.min(d.backlog, maxBacklog)}" data-k="backlog" aria-label="Backlog tickets to load" />
        <div class="sc-hint">Relevance: linked to sprint work +50 · same epic +20 · priority up to +30 · recently updated up to +20 · carried over +15 · due soon +25</div>
        <div class="sc-row">
          <span class="sc-dot sc-done"></span><b>Done</b><span class="sc-meta">${info.done.total} in the query</span>
          <span class="rl-spacer"></span><span class="sc-count">${info.done.shown}<em> of ${info.done.total}</em></span>
        </div>
        <div class="seg small sc-doneseg">${DONE_STEPS.map(([v, l]) => `<button data-done="${v}" class="${d.doneDays === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="sc-hint">Older done tickets still count in progress bars and are loaded when they explain something shown (a resolved blocker, a parent).</div>
        ${info.requested ? `<div class="sc-row"><span class="sc-dot sc-req"></span><b>Loaded on request</b><span class="rl-spacer"></span><span class="sc-count">${info.requested}</span></div>` : ''}
        <div class="sc-budget" title="${shown} of ${info.limit} (jiraGraph.maxIssues)">
          ${seg(info.sprint.shown, 'sc-sprint', 'Sprint')}${seg(info.context, 'sc-context', 'Context')}${seg(info.backlog.shown, 'sc-backlog', 'Backlog')}${seg(info.done.shown, 'sc-done', 'Done')}${seg(info.requested, 'sc-req', 'On request')}${seg(free, 'sc-free', 'Free')}
        </div>
        <div class="sc-budget-legend"><span>${shown} loaded</span><span>limit ${info.limit}</span></div>
      </div>
      <div class="fpop-foot">Chosen from ${info.indexed}${info.indexCapped ? ` of ${info.universeTotal ?? 'more'}` : ''} tickets in the query. Scope changes need no new Jira query. “+N” chips on the graph load a parent's left-out tickets.</div>`;
  }
}
