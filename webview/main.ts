import type { GraphIssue, GraphLink, GraphModel, GraphSource, HostMessage, LinkCategory, SyncDiff, ViewOptions, WebviewMessage } from '../src/shared/model';
import { UI_ICONS } from './icons';
import { GROUP_HEADER, layout, LayoutEdge, LayoutNode, LayoutResult, LayoutStrategy, Point } from './layout';
import { computeLens, fmtAge, hasSprintData, LensId, LensMark, LENSES } from './lens';
import { BLOCK_LABELS, BLOCK_SEVERITY, BlockState, isBlocking, linkBlockState, normalizeStageOverrides, Stage, STAGE_LABELS, stageOf, worse } from '../src/shared/stages';
import { dashArray, ICONS, iconMarkup, LINK_LABELS, PRIORITY, TypeStyle, TypeStyles } from './typeStyles';
import cssText from './styles.css';
import { descriptionBlock, DescriptionState, fitDescription, HoverCard } from './hovercard';
import { sanitizeDescription } from './sanitize';
import { Tooltips } from './tooltip';
import { FilterPanel, FilterPrefs } from './filterPanel';
import { ScopePanel } from './scopePanel';

// Inline (same-origin) stylesheet: lets SVG export read the rules back via CSSOM.
const styleEl = document.createElement('style');
styleEl.textContent = cssText;
document.head.appendChild(styleEl);

// ── VS Code bridge & persisted state ─────────────────────────────────────────
declare function acquireVsCodeApi(): {
  postMessage(m: WebviewMessage): void;
  getState(): unknown;
  setState(s: unknown): void;
};
const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage) => vscode.postMessage(m);

interface UiState {
  direction: ViewOptions['direction'];
  mode: ViewOptions['hierarchyMode'];
  routing: ViewOptions['edgeRouting'];
  showLabels: boolean;
  hideDone: boolean;
  linksAffectLayout: boolean;
  showHierarchy: boolean;
  hiddenTypes: string[];
  hiddenLinks: string[];
  legendOpen: boolean;
  minimap: boolean;
  /** Cross links: always, only for the selected/hovered ticket, or automatically when there are many. */
  linkVisibility?: 'all' | 'selection' | 'auto';
  lens?: LensId;
  strategy?: LayoutStrategy;
  drawerWidth?: number;
  filterPrefs?: FilterPrefs;
}
interface Persisted {
  source?: GraphSource;
  ui?: UiState;
}

const injected = (window as unknown as { __JIRA_GRAPH_STATE__?: Persisted }).__JIRA_GRAPH_STATE__ ?? {};
const saved = (vscode.getState() as Persisted | undefined) ?? {};
const persisted: Persisted = { ...saved, source: injected.source ?? saved.source };
const saveState = () => vscode.setState({ source: persisted.source, ui } satisfies Persisted);

// ── Runtime state ───────────────────────────────────────────────────────────
let ui: UiState = persisted.ui ?? {
  direction: 'DOWN',
  mode: 'edges',
  routing: 'ORTHOGONAL',
  showLabels: true,
  hideDone: false,
  linksAffectLayout: true,
  showHierarchy: true,
  hiddenTypes: [],
  hiddenLinks: [],
  legendOpen: true,
  minimap: true,
};
let uiFromHost = !persisted.ui;

let model: GraphModel | undefined;
let styles = new TypeStyles();
let byKey = new Map<string, GraphIssue>();
let childrenOf = new Map<string, string[]>();
let lay: LayoutResult | undefined;
let visible: { issues: GraphIssue[]; links: GraphLink[] } = { issues: [], links: [] };
let selected: string | undefined;
/** Details panel open: it then follows the selection until closed. Selecting alone never opens it. */
let detailsOpen = false;
let focus: { key: string; hops: number } | undefined;
let highlight: Set<string> | undefined;
const hiddenKeys = new Set<string>();
const collapsed = new Set<string>();
let blocked = new Set<string>();
/** Worst still-blocking state per blocked ticket (colours its badge). */
let blockedBy = new Map<string, BlockState>();
/** Block state per visible link id (including aggregated links). */
let linkStates = new Map<string, BlockState>();
let blockingKeys = new Set<string>();
let stageOverrides: Record<string, Stage> = {};
const stageOfIssue = (i: GraphIssue): Stage => stageOf(i, stageOverrides);
let cycleEdges = new Set<string>();
let cycles: string[][] = [];
/** Status counts of all descendants, for the progress bar on parents. */
let rollups = new Map<string, { new: number; indeterminate: number; done: number }>();
const AUTO_LINK_LIMIT = 40;
let linksFocused = false;
let lensMarks = new Map<string, LensMark>();
const LENS_ORDER: LensId[] = ['none', 'progress', 'completion', 'planning'];

function recomputeLens() {
  const id = ui.lens ?? 'none';
  lensMarks = model ? computeLens(id, { issues: model.issues, links: model.links, byKey, rollups }) : new Map();
  svg.classList.toggle('lens', id !== 'none');
  app.dataset.lens = id;
  LENS_ORDER.forEach((l) => svg.classList.toggle(`lens-${l}`, l === id));
}
const view = { x: 0, y: 0, k: 1 };
let layoutToken = 0;
let firstLayout = true;

const styleOf = (i: GraphIssue): TypeStyle => styles.of(i);

// ── DOM skeleton ────────────────────────────────────────────────────────────
const NS = 'http://www.w3.org/2000/svg';
const XHTML = 'http://www.w3.org/1999/xhtml';
const app = document.getElementById('app')!;
app.innerHTML = `
<header class="toolbar">
  <div class="title"><span class="title-text">Jira Graph</span><span class="stats"></span></div>
  <button class="live" data-action="syncNow" data-tip-fn="live" aria-label="Live sync"><span class="dot"></span><span class="live-text">live</span></button>
  <button class="scopebtn" hidden data-tip="Load scope" data-tip-desc="What this graph loads from its query: sprint work always, the most relevant backlog tickets, recently done work. Click to change." aria-label="Load scope">${UI_ICONS.target}<span class="scope-sum"></span><span class="caret">▾</span></button>
  <div class="spacer"></div>
  <div class="filterbox" role="search">
    <span class="fb-icon">${UI_ICONS.search}</span>
    <input type="search" placeholder="Filter tickets…" spellcheck="false" aria-label="Filter tickets" data-tip="Filter" data-kbd="/" data-tip-desc="Key, title, assignee, status, type, label or sprint. Enter / Shift+Enter step through matches, Esc clears, ↓ goes to the list." />
    <button data-fb="facets" data-tip="Filter options" data-tip-desc="Stage, type, status, assignee, priority, sprint, labels, flags" aria-label="Filter options">${UI_ICONS.funnel}<span class="fb-badge" hidden></span></button>
    <span class="fb-count" aria-live="polite"></span>
    <button data-fb="prev" data-tip="Previous match" data-kbd="Shift+F3" aria-label="Previous match" disabled>${UI_ICONS.chevL}</button>
    <button data-fb="next" data-tip="Next match" data-kbd="F3" aria-label="Next match" disabled>${UI_ICONS.chevR}</button>
    <button data-fb="list" data-tip="Results list" data-tip-desc="Show or hide the list of matching tickets" aria-label="Results list">${UI_ICONS.list}</button>
  </div>
  <div class="seg" data-opt="mode">
    <button data-v="edges" data-tip="Tree" data-tip-desc="Parent → child drawn as edges in a layered layout" aria-label="Tree layout">${UI_ICONS.tree}</button>
    <button data-v="nested" data-tip="Nested" data-tip-desc="Children drawn inside their parent: initiative ⊃ epic ⊃ story ⊃ sub-task" aria-label="Nested layout">${UI_ICONS.nested}</button>
  </div>
  <div class="seg" data-opt="direction">
    <button data-v="DOWN" data-tip="Top → bottom" data-tip-desc="Parents and blockers above what they lead to" aria-label="Top to bottom">${UI_ICONS.down}</button>
    <button data-v="RIGHT" data-tip="Left → right" data-tip-desc="Reads like a timeline or tech tree" aria-label="Left to right">${UI_ICONS.right}</button>
  </div>
  <select data-opt="strategy" data-tip-fn="strategy" aria-label="Layout strategy">
    <option value="explicit">View: explicit</option>
    <option value="hybrid">View: hybrid</option>
    <option value="compact">View: compact</option>
  </select>
  <select data-opt="lens" data-tip-fn="lens" aria-label="Lens">
    <option value="none">Lens: none</option>
    <option value="progress">Lens: progress</option>
    <option value="completion">Lens: completion</option>
    <option value="planning">Lens: planning</option>
  </select>
  <select data-opt="linkVisibility" data-tip-fn="links" aria-label="Link visibility">
    <option value="auto">Links: auto</option>
    <option value="all">Links: all</option>
    <option value="selection">Links: selected only</option>
  </select>
  <div class="group">
    <button data-action="zoomOut" data-tip="Zoom out" data-kbd="−" aria-label="Zoom out">${UI_ICONS.zoomOut}</button>
    <button data-action="zoomReset" class="zoom-level" data-tip="Reset zoom to 100%" data-kbd="0" data-tip-desc="Scroll or pinch to zoom around the cursor" aria-label="Reset zoom">100%</button>
    <button data-action="zoomIn" data-tip="Zoom in" data-kbd="+" aria-label="Zoom in">${UI_ICONS.zoomIn}</button>
    <button data-action="fit" data-tip="Fit to screen" data-kbd="F" aria-label="Fit to screen">${UI_ICONS.fit}</button>
  </div>
  <div class="group">
    <button data-action="export" data-tip="Export" data-tip-desc="SVG image, Mermaid diagram, visible keys or a key-in JQL" aria-label="Export">${UI_ICONS.export}</button>
    <button data-action="refresh" data-tip="Reload from Jira" data-tip-desc="Full reload of the query. Changes normally arrive through live sync." aria-label="Reload">${UI_ICONS.refresh}</button>
    <button data-action="more" data-tip="More view options" data-tip-desc="Link labels, hide done, layout by links, minimap, edge routing, collapse / expand all" aria-label="More view options">${UI_ICONS.more}</button>
  </div>
</header>
<div class="progress"><div></div></div>
<div class="banner"></div>
<main class="stage">
  <svg class="canvas" xmlns="${NS}">
    <defs></defs>
    <g class="viewport"><g class="l-groups"></g><g class="l-edges"></g><g class="l-labels"></g><g class="l-nodes"></g></g>
  </svg>
  <section class="legend"></section>
  <canvas class="minimap" width="200" height="130" data-tip="Minimap" data-tip-desc="Click or drag to move the view"></canvas>
  <aside class="drawer"></aside>
  <div class="nodebar" role="toolbar" aria-label="Ticket actions">
    <button data-nb="details" data-tip="Details" data-kbd="Enter" data-tip-desc="Open the details panel; it then follows your selection">${UI_ICONS.info}</button>
    <button data-nb="jira" data-tip="Open in Jira" data-kbd="⌘/Ctrl Enter" data-tip-desc="Also: double-click the ticket">${UI_ICONS.open}</button>
    <button data-nb="more" data-tip="More actions" data-tip-desc="Also: right-click the ticket">${UI_ICONS.more}</button>
  </div>
  <div class="drawer-resizer" role="separator" aria-orientation="vertical" aria-label="Resize details panel" tabindex="0" data-tip="Resize details panel" data-tip-desc="Drag to resize · double-click to reset\nArrow keys when focused (Shift: faster)"></div>
  <div class="overlay"></div>
  <div class="menu" role="menu"></div>
  <div class="toast"></div>
</main>`;

const $ = <T extends Element>(sel: string) => app.querySelector(sel) as T;
const svg = $<SVGSVGElement>('.canvas');
const viewport = $<SVGGElement>('.viewport');
const layers = {
  groups: $<SVGGElement>('.l-groups'),
  edges: $<SVGGElement>('.l-edges'),
  labels: $<SVGGElement>('.l-labels'),
  nodes: $<SVGGElement>('.l-nodes'),
};
const stage = $<HTMLElement>('.stage');
const drawer = $<HTMLElement>('.drawer');
const legend = $<HTMLElement>('.legend');
const banner = $<HTMLElement>('.banner');
const overlay = $<HTMLElement>('.overlay');
const menu = $<HTMLElement>('.menu');
const toastEl = $<HTMLElement>('.toast');
const minimap = $<HTMLCanvasElement>('.minimap');
const tips = new Tooltips(app);
/** Sanitised descriptions by key; fetched on demand, dropped when the issue changes. */
const descriptions = new Map<string, DescriptionState>();
let descriptionLines = 4;
let drawerDescExpanded = false;
/** Latest request id per key; responses to older requests are ignored. */
const descRequests = new Map<string, number>();
let descSeq = 0;
/** A failed fetch is shown, but retried when the ticket is shown again after this long. */
const DESC_RETRY_MS = 5000;
const descFailedAt = new Map<string, number>();

/** Whether the ticket's description should be (re)fetched now. */
function needsDescription(key: string): boolean {
  const cur = descriptions.get(key);
  if (!cur) return true;
  return 'error' in cur && Date.now() - (descFailedAt.get(key) ?? 0) > DESC_RETRY_MS;
}

/** Small action bar above a hovered ticket's top-right corner: Details · Open in Jira · More. */
const nodebar = (() => {
  const el = app.querySelector<HTMLElement>('.nodebar')!;
  let key: string | undefined;
  let showTimer = 0;
  let hideTimer = 0;
  const SHOW_MS = 150;
  const GRACE_MS = 220;
  const anchorOf = (k: string) => nodeEls.get(k)?.querySelector('.g-card, .g-group-head') ?? nodeEls.get(k);
  const place = () => {
    const a = key ? anchorOf(key) : undefined;
    if (!a) return hide();
    const r = a.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(s.width - w - 6, Math.max(6, r.right - s.left - w));
    const top = r.top - s.top - h - 4 < 4 ? r.top - s.top + 4 : r.top - s.top - h - 4;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    el.classList.remove('open');
    key = undefined;
  }
  el.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  el.addEventListener('pointerleave', () => {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, GRACE_MS);
  });
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-nb]');
    if (!b || !key) return;
    const k = key;
    const r = b.getBoundingClientRect();
    hide();
    card.hide();
    if (b.dataset.nb === 'details') openDetails(k);
    if (b.dataset.nb === 'jira') post({ type: 'openIssue', key: k });
    if (b.dataset.nb === 'more') {
      select(k);
      showMenu(k, r.left, r.bottom + 4);
      e.stopPropagation();
    }
  });
  return {
    enter(k: string) {
      clearTimeout(hideTimer);
      if (k === key && el.classList.contains('open')) return;
      clearTimeout(showTimer);
      showTimer = window.setTimeout(() => {
        key = k;
        el.classList.add('open');
        place();
      }, el.classList.contains('open') ? 0 : SHOW_MS);
    },
    leave() {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hide, GRACE_MS);
    },
    hide,
    place,
  };
})();

function requestDescription(key: string, force = false) {
  if (!force && !needsDescription(key)) return;
  const reqId = ++descSeq;
  descRequests.set(key, reqId);
  descriptions.set(key, { loading: true });
  post({ type: 'describe', key, reqId });
}

/** Forget every description (full reload): each is re-requested when shown; the host re-validates by `updated`. */
function resetDescriptions() {
  descriptions.clear();
  descRequests.clear();
  descFailedAt.clear();
}
const card = new HoverCard(stage, {
  issue: (k) => byKey.get(k),
  links: () => model?.links ?? [],
  childrenOf: (k) => childrenOf.get(k) ?? [],
  rollup: (k) => rollups.get(k),
  blocked: (k) => blocked.has(k),
  blockerSummary: (k) => blockerSummary(k),
  blockState: (k) => blockedBy.get(k),
  linkState: (from, to) => {
    const l = model?.links.find((x) => x.category === 'blocks' && x.from === from && x.to === to);
    return l ? linkBlockState(l, byKey, stageOverrides) : undefined;
  },
  stageLabel: (i) => STAGE_LABELS[stageOfIssue(i)],
  lens: (k) => lensMarks.get(k),
  lensLabel: () => ((ui.lens ?? 'none') === 'none' ? undefined : LENSES[ui.lens!].label),
  chain: (k) => chainOf(k, model?.links ?? []),
  styleOf,
  avatarColor,
  initials,
  anchor: (k) => nodeEls.get(k)?.querySelector('.g-card, .g-group-head') ?? nodeEls.get(k),
  onReveal: (k) => revealKey(k),
  onOpen: (k) => post({ type: 'openIssue', key: k }),
  onUrl: (url) => post({ type: 'openUrl', url }),
  description: (k) => descriptions.get(k),
  requestDescription: (k) => requestDescription(k),
  needsDescription,
  descriptionLines: () => descriptionLines,
});

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, parent?: Element | null): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// ── Measuring ───────────────────────────────────────────────────────────────
const measureCtx = document.createElement('canvas').getContext('2d')!;
const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
function measure(text: string, font = `11px ${fontFamily}`): number {
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

// ── Markers ─────────────────────────────────────────────────────────────────
const EDGE_KINDS: (LinkCategory | 'hierarchy')[] = ['hierarchy', 'blocks', 'relates', 'duplicates', 'clones', 'other'];
{
  const defs = svg.querySelector('defs')!;
  for (const k of EDGE_KINDS) {
    const m = el('marker', { id: `m-${k}`, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, defs);
    m.setAttribute('markerWidth', k === 'hierarchy' ? '9' : '11');
    m.setAttribute('markerHeight', k === 'hierarchy' ? '9' : '11');
    el('path', { d: k === 'hierarchy' ? 'M1,1.5 L9,5 L1,8.5' : 'M0,0 L10,5 L0,10 z', class: `mk k-${k}` }, m);
  }
  for (const st of BLOCK_SEVERITY) {
    const m = el('marker', { id: `m-b-${st}`, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 11, markerHeight: 11, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' }, defs);
    el('path', { d: st === 'resolved' ? 'M1,1.5 L9,5 L1,8.5' : 'M0,0 L10,5 L0,10 z', class: `mk b-${st}` }, m);
  }
  const hatch = el('pattern', { id: 'stub-hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('rect', { width: 8, height: 8, class: 'hatch-bg' }, hatch);
  el('line', { x1: 0, y1: 0, x2: 0, y2: 8, class: 'hatch-line' }, hatch);
}

// ── Model processing ────────────────────────────────────────────────────────
function indexModel(m: GraphModel) {
  byKey = new Map(m.issues.map((i) => [i.key, i]));
  childrenOf = new Map();
  for (const i of m.issues) {
    if (i.parentKey && byKey.has(i.parentKey)) {
      if (!childrenOf.has(i.parentKey)) childrenOf.set(i.parentKey, []);
      childrenOf.get(i.parentKey)!.push(i.key);
    }
  }
  blocked = new Set();
  blockedBy = new Map();
  blockingKeys = new Set();
  for (const l of m.links) {
    const st = linkBlockState(l, byKey, stageOverrides);
    if (st && isBlocking(st)) {
      blocked.add(l.to);
      blockingKeys.add(l.from);
      blockedBy.set(l.to, worse(blockedBy.get(l.to), st));
    }
  }
  ({ cycles, cycleEdges } = findCycles(m.links.filter((l) => l.category === 'blocks')));
  rollups = new Map();
  const roll = (k: string, seen: Set<string>): { new: number; indeterminate: number; done: number } => {
    const cached = rollups.get(k);
    if (cached) return cached;
    const r = { new: 0, indeterminate: 0, done: 0 };
    for (const c of childrenOf.get(k) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      r[byKey.get(c)!.statusCategory]++;
      const sub = roll(c, seen);
      r.new += sub.new;
      r.indeterminate += sub.indeterminate;
      r.done += sub.done;
    }
    // Left-out children of a scoped graph still count toward progress.
    const om = m.scopeInfo?.omitted[k];
    if (om) {
      r.new += om.new;
      r.indeterminate += om.indeterminate;
      r.done += om.done;
    }
    rollups.set(k, r);
    return r;
  };
  for (const k of new Set([...childrenOf.keys(), ...Object.keys(m.scopeInfo?.omitted ?? {})])) roll(k, new Set([k]));
}

/** Tarjan SCC over "blocks" links; any SCC with more than one issue is a dependency cycle. */
function findCycles(links: GraphLink[]): { cycles: string[][]; cycleEdges: Set<string> } {
  const adj = new Map<string, string[]>();
  for (const l of links) {
    if (!adj.has(l.from)) adj.set(l.from, []);
    adj.get(l.from)!.push(l.to);
  }
  let idx = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const strong = (v: string) => {
    index.set(v, idx);
    low.set(v, idx++);
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) out.push(scc);
    }
  };
  for (const v of adj.keys()) if (!index.has(v)) strong(v);
  const member = new Map<string, number>();
  out.forEach((scc, i) => scc.forEach((k) => member.set(k, i)));
  const edges = new Set<string>();
  for (const l of links) if (member.has(l.from) && member.get(l.from) === member.get(l.to)) edges.add(`l:${l.id}`);
  return { cycles: out, cycleEdges: edges };
}

function neighbourhood(start: string, hops: number): Set<string> {
  const seen = new Set([start]);
  let frontier = [start];
  const adj = new Map<string, string[]>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a)!.push(b);
  };
  for (const l of model!.links) add(l.from, l.to), add(l.to, l.from);
  for (const i of model!.issues) if (i.parentKey && byKey.has(i.parentKey)) add(i.key, i.parentKey), add(i.parentKey, i.key);
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const k of frontier) for (const n of adj.get(k) ?? []) if (!seen.has(n)) seen.add(n), next.push(n);
    frontier = next;
  }
  return seen;
}

function computeVisible() {
  if (!model) return { issues: [], links: [] };
  const inFocus = focus ? neighbourhood(focus.key, focus.hops) : undefined;
  const pass = (i: GraphIssue) =>
    i.key === selected ||
    i.key === focus?.key ||
    ((!inFocus || inFocus.has(i.key)) &&
      !hiddenKeys.has(i.key) &&
      !ui.hiddenTypes.includes(styleOf(i).key) &&
      !(ui.hideDone && i.statusCategory === 'done'));
  // Filter "show only matches": matches plus their ancestors (context), nothing else.
  let only: Set<string> | undefined;
  if (filterPanel?.active && filterPanel.filter.mode === 'hide') {
    only = new Set();
    for (const k of filterPanel.matchSet) {
      only.add(k);
      for (let p = byKey.get(k)?.parentKey; p && byKey.has(p) && !only.has(p); p = byKey.get(p)?.parentKey) only.add(p);
    }
  }
  const shown = new Set(model.issues.filter((i) => pass(i) && (!only || only.has(i.key) || i.key === selected)).map((i) => i.key));

  // Collapsed ancestors swallow their descendants; links are re-attached to the ancestor.
  const rep = (k: string): string | undefined => {
    let r: string | undefined = shown.has(k) ? k : undefined;
    for (let p = byKey.get(k)?.parentKey; p && byKey.has(p); p = byKey.get(p)?.parentKey) {
      if (collapsed.has(p) && shown.has(p)) r = p;
    }
    return r;
  };
  const issues = model.issues.filter((i) => shown.has(i.key) && rep(i.key) === i.key);
  const links = new Map<string, GraphLink>();
  linkStates = new Map();
  for (const l of model.links) {
    if (ui.hiddenLinks.includes(l.category)) continue;
    const from = rep(l.from);
    const to = rep(l.to);
    if (!from || !to || from === to) continue;
    const st = linkBlockState(l, byKey, stageOverrides);
    if (from === l.from && to === l.to) {
      links.set(l.id, l);
      if (st) linkStates.set(l.id, st);
      continue;
    }
    const id = `agg:${from}>${to}:${l.category}`;
    const prev = links.get(id);
    const n = prev ? Number(/×(\d+)$/.exec(prev.label)?.[1] ?? 1) + 1 : 1;
    links.set(id, { ...l, id, from, to, label: n > 1 ? `${l.label} ×${n}` : l.label });
    // A merged link shows its most severe member.
    if (st) linkStates.set(id, worse(linkStates.get(id), st));
  }
  return { issues, links: [...links.values()] };
}

// ── Layout & render ─────────────────────────────────────────────────────────
async function relayout(opts: { fit?: boolean } = {}) {
  if (!model) return;
  const token = ++layoutToken;
  visible = computeVisible();
  let result: LayoutResult;
  try {
    result = await layout({
      issues: visible.issues,
      links: visible.links,
      styleOf,
      measure: (t) => measure(t),
      direction: ui.direction,
      mode: ui.mode,
      routing: ui.routing,
      showHierarchy: ui.showHierarchy,
      showLabels: ui.showLabels,
      linksAffectLayout: ui.linksAffectLayout,
      strategy: ui.strategy ?? 'hybrid',
    });
  } catch (e) {
    showError(`Layout failed: ${(e as Error).message ?? e}`);
    return;
  }
  if (token !== layoutToken) return;
  card.hide();
  nodebar.hide();
  lay = result;
  render();
  renderLegend();
  renderBanner();
  renderStats();
  if (opts.fit || firstLayout) fit(!firstLayout);
  firstLayout = false;
  filterPanel?.refresh();
  drawMinimap();
}

const nodeEls = new Map<string, SVGGElement>();
// eslint-disable-next-line prefer-const -- assigned once the DOM and helpers exist (see init at the end)
let filterPanel: FilterPanel;
// eslint-disable-next-line prefer-const -- assigned at init
let scopePanel: ScopePanel;

function render() {
  if (!lay || !model) return;
  const keep = new Set<string>();
  const groupsSorted = [...lay.nodes.values()].sort((a, b) => a.depth - b.depth);
  for (const n of groupsSorted) {
    const issue = byKey.get(n.key)!;
    keep.add(n.key);
    let g = nodeEls.get(n.key);
    const fresh = !g;
    if (!g) {
      g = el('g', { 'data-key': n.key });
      g.classList.add('enter');
      nodeEls.set(n.key, g);
    }
    (n.group ? layers.groups : layers.nodes).appendChild(g);
    if (fresh) g.style.transition = 'none';
    g.style.transform = `translate(${n.x}px, ${n.y}px)`;
    if (fresh) requestAnimationFrame(() => (g!.style.transition = ''));
    drawNode(g, issue, n);
  }
  for (const [k, g] of nodeEls) {
    if (!keep.has(k)) {
      g.remove();
      nodeEls.delete(k);
    }
  }

  layers.edges.replaceChildren();
  layers.labels.replaceChildren();
  layers.groups.querySelectorAll('.g-frame').forEach((f) => f.remove());
  for (const f of lay.frames) {
    const parent = byKey.get(f.parent);
    const fg = el('g', { class: 'g-frame', 'data-parent': f.parent });
    layers.groups.insertBefore(fg, layers.groups.firstChild);
    if (parent) fg.style.setProperty('--type', styleOf(parent).color);
    el('rect', { x: f.x, y: f.y, width: f.w, height: f.h, rx: 12 }, fg);
    if (f.label) el('text', { class: 'g-frame-label', x: f.x + 14, y: f.y + 21 }, fg).textContent = f.label;
    el('title', {}, fg).textContent = f.id ? `${f.label} — bundled into one edge` : f.parent ? `Children of ${f.parent} without other relations` : 'Tickets without a parent or layout relations';
    if (f.id) fg.classList.add('fan');
  }
  for (const e of lay.edges) drawEdge(e);
  const crossLinks = lay.edges.filter((e) => e.kind !== 'hierarchy').length;
  const mode = ui.linkVisibility ?? 'auto';
  // Auto hides links only in the compact strategy; explicit and hybrid exist to show relations.
  linksFocused = mode === 'selection' || (mode === 'auto' && (ui.strategy ?? 'hybrid') === 'compact' && crossLinks > AUTO_LINK_LIMIT);
  svg.classList.toggle('links-focus', linksFocused);
  applyClasses();
}

function drawNode(g: SVGGElement, i: GraphIssue, n: LayoutNode) {
  const s = styleOf(i);
  const w = n.w;
  const h = n.group ? GROUP_HEADER : n.h;
  g.replaceChildren();
  g.setAttribute('class', [
    'g-node',
    n.group ? 'g-group' : '',
    `t-${s.key.replace(/[^\w-]/g, '_')}`,
    `s-${i.statusCategory}`,
    i.loaded ? '' : 'stub',
    blocked.has(i.key) ? 'blocked' : '',
    lensMarks.get(i.key) ? `lens-${lensMarks.get(i.key)!.level}` : '',
    lensMarks.get(i.key)?.outline ? `lens-${lensMarks.get(i.key)!.outline}` : '',
  ].filter(Boolean).join(' '));
  g.style.setProperty('--type', s.color);

  // Details come from the hover card; the node itself carries no native tooltip.
  g.setAttribute('aria-label', `${i.key} ${i.type} ${i.status}: ${i.summary}`);

  el('rect', { class: 'g-select', x: -5, y: -5, width: w + 10, height: n.h + 10, rx: s.radius + 5 }, g);
  const lensMark = lensMarks.get(i.key);
  if (lensMark?.level === 'primary') el('rect', { class: 'g-lens-ring', x: -3.5, y: -3.5, width: w + 7, height: (n.group ? h : n.h) + 7, rx: s.radius + 3.5 }, g);
  const dash = dashArray(s);
  if (n.group) {
    el('rect', { class: 'g-group-bg', width: w, height: n.h, rx: s.radius }, g);
    el('rect', { class: 'g-group-head', width: w, height: h, rx: s.radius }, g);
    el('line', { class: 'g-group-sep', x1: 0, x2: w, y1: h, y2: h }, g);
  } else {
    el('rect', { class: 'g-card', width: w, height: h, rx: s.radius }, g);
  }
  // Status stripe along the left edge: status is readable at a glance, independent of the type border.
  el('rect', { class: 'g-stripe', x: 4, y: 9, width: 3.5, height: h - 18, rx: 1.75 }, g);
  el('rect', { class: 'g-border', width: w, height: n.h, rx: s.radius, 'stroke-width': s.width, 'stroke-dasharray': dash }, g);
  if (s.border === 'double') {
    el('rect', { class: 'g-border', x: 3.5, y: 3.5, width: w - 7, height: n.h - 7, rx: Math.max(0, s.radius - 3), 'stroke-width': s.width }, g);
  }

  // Zoomed-out tile: a status-coloured block with a key that stays readable (see applyView / --inv).
  const tile = el('foreignObject', { class: 'g-tile', x: 0, y: 0, width: w, height: h }, g);
  const tdiv = document.createElementNS(XHTML, 'div') as HTMLDivElement;
  tdiv.className = `tile st-${i.statusCategory}`;
  const maxFs = n.group ? h * 0.5 : Math.min(h * 0.46, (w - 20) / (i.key.length * 0.6));
  tdiv.style.setProperty('--maxfs', `${maxFs.toFixed(1)}px`);
  tdiv.textContent = n.group && i.summary ? `${i.key} · ${i.summary}` : i.key;
  tile.appendChild(tdiv);

  const det = el('g', { class: 'g-detail' }, g);

  // Header row: [icon] KEY [priority]            [avatar] [STATUS]
  const iconG = el('g', { class: 'g-icon', transform: 'translate(12 11) scale(1.25)' }, det);
  iconG.style.color = s.color;
  el('rect', { width: 16, height: 16, rx: 3.5, fill: s.color }, iconG);
  iconG.insertAdjacentHTML('beforeend', ICONS[s.icon]);

  const key = el('text', { class: 'g-key', x: 40, y: 26 }, det);
  key.textContent = i.key;
  let cursor = 40 + measure(i.key, `600 12.5px ${fontFamily}`) + 6;

  const pr = i.priority ? PRIORITY[i.priority.toLowerCase()] : undefined;
  if (pr) {
    const p = el('path', { class: 'g-priority', d: pr.path, transform: `translate(${cursor} 15)`, stroke: pr.color }, det);
    cursor += 16;
  }

  let right = w - 12;
  if (i.status) {
    const text = i.status.length > 16 ? `${i.status.slice(0, 15)}…` : i.status;
    const tw = measure(text.toUpperCase(), `700 10px ${fontFamily}`) + 14;
    const pill = el('g', { class: `g-status st-${i.statusCategory}`, transform: `translate(${right - tw} 11)` }, det);
    el('rect', { width: tw, height: 18, rx: 4 }, pill);
    el('text', { x: tw / 2, y: 12.5 }, pill).textContent = text.toUpperCase();
    right -= tw + 6;
  }
  if (i.assignee && right - 20 > cursor) {
    const av = el('g', { class: 'g-avatar', transform: `translate(${right - 10} 20)` }, det);
    el('circle', { r: 10, fill: avatarColor(i.assignee) }, av);
    el('text', { y: 3.6 }, av).textContent = initials(i.assignee);
  }

  // Summary (HTML for wrapping + ellipsis)
  const lines = n.group || s.size === 'small' ? 1 : 2;
  const fo = el('foreignObject', { x: 12, y: 36, width: w - 24, height: lines * 17 + 2 }, det);
  const div = document.createElementNS(XHTML, 'div') as HTMLDivElement;
  div.className = `g-summary lines-${lines}${i.summary ? '' : ' empty'}`;
  div.textContent = i.summary || 'Not loaded — double-click to expand';
  fo.appendChild(div);

  // Lens badges straddle the bottom-left border.
  let badgesEnd = 0;
  if (lensMark?.badges.length) {
    let bx = 10;
    const by = (n.group ? h : n.h) - 8;
    for (const b of lensMark.badges) {
      const bw = measure(b.text, `600 10px ${fontFamily}`) + 12;
      const bg = el('g', { class: `g-lbadge tone-${b.tone}`, transform: `translate(${bx} ${by})` }, g);
      el('rect', { width: bw, height: 16, rx: 8 }, bg);
      el('text', { x: bw / 2, y: 11.5 }, bg).textContent = b.text;
      bx += bw + 4;
    }
    badgesEnd = bx;
  }

  // Progress of all descendants: done | in progress | to do.
  const r = rollups.get(i.key);
  const total = r ? r.new + r.indeterminate + r.done : 0;
  if (r && total) {
    const bx = Math.max(12, badgesEnd + 2);
    const bw = Math.max(20, w - bx - 12 - (n.group ? 60 : 0));
    const by = n.group ? h - 1.5 : n.h - 6;
    const bar = el('g', { class: 'g-rollup', transform: `translate(${bx} ${by})` }, g);
    el('rect', { class: 'track', width: bw, height: 3, rx: 1.5 }, bar);
    let x = 0;
    for (const cat of ['done', 'indeterminate'] as const) {
      const segW = (r[cat] / total) * bw;
      if (segW > 0) el('rect', { class: `seg st-${cat}`, x, width: segW, height: 3, rx: 1.5 }, bar);
      x += segW;
    }
  }

  // "+N" left out by the load scope: click loads them.
  const om = model?.scopeInfo?.omitted[i.key];
  if (om && om.backlog + om.done > 0) {
    const n = om.backlog + om.done;
    const label = `+${n}`;
    const tw = measure(label, `700 10.5px ${fontFamily}`) + 14;
    const more = el('g', { class: 'g-more', transform: `translate(10 -9)` }, g);
    el('rect', { width: tw, height: 18, rx: 9 }, more);
    el('text', { x: tw / 2, y: 12.6 }, more).textContent = label;
    more.setAttribute('data-tip', `${n} more not loaded`);
    more.setAttribute('data-tip-desc', `${[om.backlog ? `${om.backlog} open` : '', om.done ? `${om.done} done` : ''].filter(Boolean).join(' · ')} under ${i.key}, left out by the load scope.\nClick to load them.`);
  }

  // Badges
  if (blocked.has(i.key)) {
    const b = el('g', { class: `g-badge blocked b-${blockedBy.get(i.key) ?? 'todo'}`, transform: `translate(${w - 2} -2)` }, g);
    el('circle', { r: 9 }, b);
    el('rect', { x: -4.5, y: -1.4, width: 9, height: 2.8, rx: 1 }, b);
  }
  const kids = childrenOf.get(i.key)?.length ?? 0;
  if (kids) {
    const isCollapsed = collapsed.has(i.key);
    const label = isCollapsed ? `▸ ${kids}` : `▾ ${kids}`;
    const tw = measure(label, `600 10.5px ${fontFamily}`) + 14;
    const [tx, ty] = n.group ? [w - tw - 12, GROUP_HEADER - 9] : ui.direction === 'DOWN' ? [w - tw - 10, n.h - 9] : [w - tw / 2 - 9, n.h / 2 - 9];
    const t = el('g', { class: `g-toggle${isCollapsed ? ' collapsed' : ''}`, transform: `translate(${tx} ${ty})` }, g);
    el('rect', { width: tw, height: 18, rx: 9 }, t);
    el('text', { x: tw / 2, y: 12.6 }, t).textContent = label;
    t.setAttribute('data-tip', isCollapsed ? `Expand ${kids} children` : `Collapse ${kids} children`);
    t.setAttribute('data-kbd', 'Space');
    t.setAttribute('data-tip-desc', isCollapsed ? 'Show the tickets inside' : 'Fold them into this ticket; their links move here');
  }
  if (!i.loaded) {
    const x = el('g', { class: 'g-expand', transform: `translate(${w} ${h / 2})` }, g);
    el('circle', { r: 10 }, x);
    el('path', { d: 'M-4.5 0h9M0-4.5v9' }, x);
    x.setAttribute('data-tip', 'Load this ticket');
    x.setAttribute('data-kbd', 'E');
    x.setAttribute('data-tip-desc', 'It was found through a relation; load it with its parent, children and links');
  }
}

function drawEdge(e: LayoutEdge) {
  const d = e.spline ? splinePath(e.points) : roundedPath(e.points, 8);
  const bst = e.kind === 'blocks' ? edgeBlockState(e) : undefined;
  const g = el('g', { class: `g-edge k-${e.kind}${bst ? ` b-${bst}` : ''}${cycleEdges.has(e.id) ? ' cycle' : ''}${e.id.startsWith('l:agg:') ? ' agg' : ''}`, 'data-from': e.from, 'data-to': e.to }, layers.edges);
  el('path', { class: 'hit', d }, g);
  el('path', { class: 'line', d, 'marker-end': e.kind === 'relates' ? undefined : bst ? `url(#m-b-${bst})` : `url(#m-${e.kind})` }, g);
  const nm = (k: string) => (k.startsWith('__fan:') ? `${lay?.frames.find((f) => f.id === k)?.members?.length ?? ''} tickets` : k);
  const summ = (k: string) => byKey.get(k)?.summary ?? '';
  const head = e.kind !== 'hierarchy' ? `${nm(e.from)} ${e.label} ${nm(e.to)}` : e.to.startsWith('__grid:') ? `${e.from} → its packed children` : `${e.from} is parent of ${e.to}`;
  g.setAttribute('data-tip', bst === 'critical' ? `⚠ ${head}` : head);
  const blocker = byKey.get(e.from);
  const since = blocker?.statusChangedAt ? ` · ${fmtAge((Date.now() - Date.parse(blocker.statusChangedAt)) / 86_400_000)} in status` : '';
  const desc = [
    bst && `${BLOCK_LABELS[bst]}${blocker && !e.from.startsWith('__') ? ` — ${blocker.status}${since}` : ''}`,
    summ(e.from) && `${e.from}: ${summ(e.from)}`,
    summ(e.to) && `${e.to}: ${summ(e.to)}`,
  ].filter(Boolean).join('\n');
  if (desc) g.setAttribute('data-tip-desc', desc);
  if (e.labelPos && e.label) {
    const lw = measure(e.label) + 10;
    const lg = el('g', { class: `g-elabel k-${e.kind}`, transform: `translate(${e.labelPos.x} ${e.labelPos.y})`, 'data-from': e.from, 'data-to': e.to }, layers.labels);
    el('rect', { x: -lw / 2, y: -8, width: lw, height: 16, rx: 8 }, lg);
    el('text', { y: 3.8 }, lg).textContent = e.label;
  }
}

/** Block state of a drawn edge: the link's own, or the worst member of a fan cluster. */
function edgeBlockState(e: LayoutEdge): BlockState | undefined {
  const own = linkStates.get(e.id.replace(/^l:/, ''));
  if (own) return own;
  const fanId = e.from.startsWith('__fan:') ? e.from : e.to.startsWith('__fan:') ? e.to : undefined;
  const members = fanId ? new Set(lay?.frames.find((f) => f.id === fanId)?.members) : undefined;
  if (!members) return undefined;
  let st: BlockState | undefined;
  for (const l of visible.links) {
    if (l.category !== 'blocks' || !(members.has(l.from) || members.has(l.to))) continue;
    const s1 = linkStates.get(l.id);
    if (s1) st = worse(st, s1);
  }
  return st;
}

function roundedPath(p: Point[], r: number): string {
  if (p.length < 2) return '';
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1];
    const b = p[i];
    const c = p[i + 1];
    const d1 = Math.hypot(b.x - a.x, b.y - a.y);
    const d2 = Math.hypot(c.x - b.x, c.y - b.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const p1 = { x: b.x + ((a.x - b.x) / d1) * rr, y: b.y + ((a.y - b.y) / d1) * rr };
    const p2 = { x: b.x + ((c.x - b.x) / d2) * rr, y: b.y + ((c.y - b.y) / d2) * rr };
    d += ` L${p1.x},${p1.y} Q${b.x},${b.y} ${p2.x},${p2.y}`;
  }
  const last = p[p.length - 1];
  return `${d} L${last.x},${last.y}`;
}

function splinePath(p: Point[]): string {
  if (p.length >= 4 && (p.length - 1) % 3 === 0) {
    let d = `M${p[0].x},${p[0].y}`;
    for (let i = 1; i < p.length; i += 3) d += ` C${p[i].x},${p[i].y} ${p[i + 1].x},${p[i + 1].y} ${p[i + 2].x},${p[i + 2].y}`;
    return d;
  }
  // Catmull-Rom through the points.
  let d = `M${p[0].x},${p[0].y}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] ?? p[i];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[i + 2] ?? p2;
    d += ` C${p1.x + (p2.x - p0.x) / 6},${p1.y + (p2.y - p0.y) / 6} ${p2.x - (p3.x - p1.x) / 6},${p2.y - (p3.y - p1.y) / 6} ${p2.x},${p2.y}`;
  }
  return d;
}

function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 45%)`;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

// ── Highlight / selection classes ───────────────────────────────────────────
let hovered: string | undefined;

/**
 * Tech-tree style chains over "blocks" links: everything the ticket transitively needs (prerequisites)
 * and everything it transitively unlocks. Depth = number of steps away.
 */
function chainOf(key: string, links: GraphLink[] = visible.links): { up: Map<string, number>; down: Map<string, number> } {
  const walk = (dir: 'up' | 'down') => {
    const out = new Map<string, number>();
    let frontier = [key];
    for (let depth = 1; frontier.length && depth < 50; depth++) {
      const next: string[] = [];
      for (const k of frontier) {
        for (const l of links) {
          if (l.category !== 'blocks') continue;
          const other = dir === 'up' ? (l.to === k ? l.from : undefined) : l.from === k ? l.to : undefined;
          if (other && other !== key && !out.has(other)) out.set(other, depth), next.push(other);
        }
      }
      frontier = next;
    }
    return out;
  };
  return { up: walk('up'), down: walk('down') };
}

function applyClasses() {
  const related = new Set<string>();
  const focusKey = hovered ?? selected;
  const chain = focusKey ? chainOf(focusKey) : { up: new Map<string, number>(), down: new Map<string, number>() };
  // Fan clusters: their bundled edge ends at a synthetic id standing for all members.
  const fanMembers = new Map<string, string[]>();
  const fanOf = new Map<string, string>();
  for (const f of lay?.frames ?? []) {
    if (!f.id || !f.members) continue;
    fanMembers.set(f.id, f.members);
    f.members.forEach((m) => fanOf.set(m, f.id!));
  }
  const inSet = (set: Map<string, number>, id: string) => set.has(id) || !!fanMembers.get(id)?.some((m) => set.has(m));
  const isFocus = (id: string) => id === focusKey || fanOf.get(focusKey ?? '') === id;
  if (focusKey) {
    related.add(focusKey);
    for (const k of [...chain.up.keys(), ...chain.down.keys()]) related.add(k);
    layers.edges.querySelectorAll<SVGGElement>('.g-edge').forEach((e) => {
      const parent = byKey.get(focusKey)?.parentKey;
      const toGrid = !!parent && e.dataset.to === `__grid:${parent}`;
      const f = e.dataset.from!;
      const t = e.dataset.to!;
      const inChain =
        e.classList.contains('k-blocks') &&
        ((inSet(chain.up, f) && (isFocus(t) || inSet(chain.up, t))) || ((isFocus(f) || inSet(chain.down, f)) && inSet(chain.down, t)));
      const hit = isFocus(f) || isFocus(t) || toGrid || inChain;
      e.classList.toggle('hl', hit);
      e.classList.toggle('chain', inChain);
      if (hit) for (const id of [f, t]) fanMembers.get(id)?.forEach((m) => related.add(m));
      if (hit) related.add(e.dataset.from!), related.add(e.dataset.to!);
    });
    layers.labels.querySelectorAll<SVGGElement>('.g-elabel').forEach((e) =>
      e.classList.toggle('hl', isFocus(e.dataset.from!) || isFocus(e.dataset.to!)),
    );
  } else {
    layers.edges.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl', 'chain'));
    layers.labels.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'));
  }
  const spot = highlight ?? (filterPanel?.active ? filterPanel.matchSet : undefined);
  for (const [k, g] of nodeEls) {
    g.classList.toggle('selected', k === selected);
    g.classList.toggle('hl', related.has(k));
    g.classList.toggle('chain-up', chain.up.has(k));
    g.classList.toggle('chain-down', chain.down.has(k));
    g.classList.toggle('match', !!spot?.has(k));
  }
  // Selection keeps the hover-style neighbourhood highlight until it is cleared.
  svg.classList.toggle('hovering', !!focusKey);
  svg.classList.toggle('spotlight', !!spot);
}

function openDetails(key: string) {
  detailsOpen = true;
  select(key);
}

function closeDetails() {
  detailsOpen = false;
  renderDrawer();
}

function select(key: string | undefined, opts: { center?: boolean; notify?: boolean } = {}) {
  if (key !== selected) drawerDescExpanded = false;
  if (!key) detailsOpen = false;
  queueMicrotask(() => filterPanel?.syncSelection());
  selected = key;
  if (key && card.openKey === key) card.hide();
  applyClasses();
  renderDrawer();
  if (key && opts.center) centerOn(key);
  if (opts.notify !== false) post({ type: 'select', key });
}

// ── View transform ──────────────────────────────────────────────────────────
function applyView() {
  viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  $<HTMLButtonElement>('.zoom-level').textContent = `${Math.round(view.k * 100)}%`;
  const far = view.k < 0.45;
  svg.classList.toggle('far', far);
  if (far) svg.style.setProperty('--inv', (1 / view.k).toFixed(3));
  drawMinimap();
}

let anim = 0;
function animateTo(target: { x: number; y: number; k: number }, ms = 320) {
  const from = { ...view };
  const t0 = performance.now();
  const id = ++anim;
  const step = (t: number) => {
    if (id !== anim) return;
    const p = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - p, 3);
    view.x = from.x + (target.x - from.x) * e;
    view.y = from.y + (target.y - from.y) * e;
    view.k = from.k + (target.k - from.k) * e;
    applyView();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function stageSize() {
  const r = svg.getBoundingClientRect();
  const drawerW = stage.classList.contains('drawer-open') ? drawer.offsetWidth : 0;
  return { w: r.width - drawerW, h: r.height };
}

function fit(animated = true) {
  if (!lay) return;
  const { w, h } = stageSize();
  const pad = 32;
  // Keep the graph clear of the floating legend.
  const resultsW = stage.classList.contains('results-open') ? stage.querySelector<HTMLElement>('.results')?.offsetWidth ?? 0 : 0;
  const legendW = ui.legendOpen && legend.offsetWidth ? legend.offsetWidth + 12 : 0;
  const left = resultsW ? resultsW + legendW : legendW;
  const aw = w - left - pad * 2;
  const k = Math.max(0.08, Math.min(1.15, aw / Math.max(lay.width, 1), (h - pad * 2) / Math.max(lay.height, 1)));
  const target = { k, x: left + pad + (aw - lay.width * k) / 2, y: Math.max(pad, (h - lay.height * k) / 2) };
  if (animated) animateTo(target);
  else Object.assign(view, target), applyView();
}

function centerOn(key: string) {
  const n = lay?.nodes.get(key);
  if (!n) return;
  const { w, h } = stageSize();
  const k = Math.max(view.k, 0.85);
  const cy = n.group ? n.y + GROUP_HEADER / 2 : n.y + n.h / 2;
  animateTo({ k, x: w / 2 - (n.x + n.w / 2) * k, y: h / 2 - cy * k });
}

function zoomAt(factor: number, cx?: number, cy?: number) {
  const { w, h } = stageSize();
  const px = cx ?? w / 2;
  const py = cy ?? h / 2;
  const k = Math.min(3, Math.max(0.05, view.k * factor));
  view.x = px - ((px - view.x) * k) / view.k;
  view.y = py - ((py - view.y) * k) / view.k;
  view.k = k;
  applyView();
}

// ── Pointer interaction ─────────────────────────────────────────────────────
let pan: { x: number; y: number; vx: number; vy: number; moved: boolean } | undefined;
/** Set when a drag ends so the click that follows it does not select or toggle anything. */
let suppressClick = false;
const keyAt = (t: EventTarget | null) => (t as Element | null)?.closest?.<SVGGElement>('.g-node')?.dataset.key;

// Dragging pans from anywhere, including on top of tickets. A press without movement stays a click.
svg.addEventListener('pointerdown', (e) => {
  hideMenu();
  card.hide();
  if (e.button !== 0) return;
  pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
});
svg.addEventListener('pointermove', (e) => {
  if (!pan) return;
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;
  if (!pan.moved) {
    if (Math.abs(dx) + Math.abs(dy) <= 4) return;
    // Capture only once it is a drag: capturing on press would retarget the click away from the ticket.
    pan.moved = true;
    card.hide();
    nodebar.hide();
    tips.suppress(true);
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  }
  view.x = pan.vx + dx;
  view.y = pan.vy + dy;
  anim++;
  applyView();
});
const endPan = (e: PointerEvent) => {
  if (pan?.moved) {
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
  } else if (pan && e.type === 'pointerup' && !keyAt(e.target)) {
    highlight = undefined;
    select(undefined);
  }
  pan = undefined;
  svg.classList.remove('panning');
  tips.suppress(false);
};
svg.addEventListener('pointerup', endPan);
svg.addEventListener('pointercancel', endPan);
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  card.hide();
  nodebar.hide();
  anim++;
  // Scroll (and pinch) zooms around the cursor; Shift+scroll pans.
  if (e.shiftKey) {
    view.x -= e.deltaX || e.deltaY;
    view.y -= e.deltaX ? e.deltaY : 0;
    applyView();
    return;
  }
  const r = svg.getBoundingClientRect();
  const step = e.deltaMode === 1 ? 0.05 : e.ctrlKey ? 0.01 : 0.0022;
  zoomAt(Math.exp(-e.deltaY * step), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

svg.addEventListener('click', (e) => {
  if (suppressClick) return;
  const key = keyAt(e.target);
  if (!key) return;
  const t = e.target as Element;
  if (t.closest('.g-toggle')) {
    toggleCollapse(key);
    return;
  }
  if (t.closest('.g-expand')) {
    post({ type: 'expand', keys: [key] });
    return;
  }
  if (t.closest('.g-more')) {
    post({ type: 'loadMore', parent: key });
    return;
  }
  highlight = undefined;
  select(key);
});
svg.addEventListener('dblclick', (e) => {
  const key = keyAt(e.target);
  if (!key) return;
  const i = byKey.get(key)!;
  if (!i.loaded) post({ type: 'expand', keys: [key] });
  else post({ type: 'openIssue', key });
});
svg.addEventListener('contextmenu', (e) => {
  const key = keyAt(e.target);
  if (!key) return;
  e.preventDefault();
  select(key);
  showMenu(key, e.clientX, e.clientY);
});
svg.addEventListener('pointerover', (e) => {
  const key = keyAt(e.target);
  if (key !== hovered) {
    hovered = key;
    applyClasses();
  }
  // Ticket card: not over a container's body, not while dragging, not for the ticket already in the drawer.
  const onGroupBody = (e.target as Element).classList?.contains('g-group-bg');
  const inDrawer = key === selected && detailsOpen;
  if (key && !onGroupBody && !inDrawer && !pan && !menu.classList.contains('open')) card.enter(key);
  else card.leave();
  if (key && !onGroupBody && !pan) nodebar.enter(key);
  else nodebar.leave();
});
svg.addEventListener('pointerleave', () => {
  hovered = undefined;
  applyClasses();
  card.leave();
  nodebar.leave();
});

function toggleCollapse(key: string) {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  void relayout();
}

// ── Context menu ────────────────────────────────────────────────────────────
type MenuItem = { label: string; icon: string; run: () => void; hint?: string } | 'sep';

function issueActions(key: string): MenuItem[] {
  const i = byKey.get(key)!;
  const kids = childrenOf.get(key)?.length ?? 0;
  const items: MenuItem[] = [
    { label: 'Show details', icon: UI_ICONS.info, hint: 'Enter', run: () => openDetails(key) },
    { label: 'Open in Jira', icon: UI_ICONS.open, hint: 'dbl-click', run: () => post({ type: 'openIssue', key }) },
    { label: i.loaded ? 'Load more relations' : 'Load issue & relations', icon: UI_ICONS.plus, hint: 'E', run: () => post({ type: 'expand', keys: [key] }) },
    'sep',
    { label: 'Focus neighbourhood', icon: UI_ICONS.focus, run: () => setFocus(key, focus?.hops ?? 2) },
    { label: 'Filter to its relations…', icon: UI_ICONS.funnel, run: () => filterPanel.setAnchor(key) },
    { label: 'New graph from here', icon: UI_ICONS.graph, run: () => post({ type: 'graphFrom', key }) },
  ];
  if (kids) items.push({ label: collapsed.has(key) ? `Expand ${kids} children` : `Collapse ${kids} children`, icon: collapsed.has(key) ? UI_ICONS.expand : UI_ICONS.collapse, run: () => toggleCollapse(key) });
  items.push(
    'sep',
    { label: 'Copy key', icon: UI_ICONS.copy, run: () => post({ type: 'copy', text: key }) },
    { label: 'Copy link', icon: UI_ICONS.copy, run: () => post({ type: 'copy', text: i.url }) },
    { label: 'Hide', icon: UI_ICONS.hide, hint: 'H', run: () => hideKey(key) },
  );
  return items;
}

function showMenu(key: string, x: number, y: number) {
  const items = issueActions(key);
  menu.innerHTML = `<div class="menu-title">${esc(key)}</div>` + items
    .map((it, idx) => (it === 'sep' ? '<hr/>' : `<button data-i="${idx}">${it.icon}<span>${esc(it.label)}</span>${it.hint ? `<kbd>${it.hint}</kbd>` : ''}</button>`))
    .join('');
  menu.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.addEventListener('click', () => {
      hideMenu();
      (items[Number(b.dataset.i)] as Exclude<MenuItem, 'sep'>).run();
    }),
  );
  const r = stage.getBoundingClientRect();
  menu.classList.add('open');
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.min(x - r.left, r.width - mw - 8)}px`;
  menu.style.top = `${Math.min(y - r.top, r.height - mh - 8)}px`;
}

function hideMenu() {
  menu.classList.remove('open', 'more');
}

function hideKey(key: string) {
  hiddenKeys.add(key);
  if (selected === key) select(undefined);
  void relayout();
}

function setFocus(key: string | undefined, hops = 2) {
  focus = key ? { key, hops } : undefined;
  void relayout({ fit: true });
}

// ── Drawer (details) ────────────────────────────────────────────────────────
const DRAWER_DEFAULT = 360;
const DRAWER_MIN = 280;
const resizer = $<HTMLElement>('.drawer-resizer');

function drawerMax(): number {
  return Math.max(DRAWER_MIN, Math.round(stage.clientWidth * 0.75));
}

function setDrawerWidth(w: number, persist = false) {
  const width = Math.round(Math.min(drawerMax(), Math.max(DRAWER_MIN, w)));
  stage.style.setProperty('--drawer-w', `${width}px`);
  resizer.setAttribute('aria-valuenow', String(width));
  resizer.setAttribute('aria-valuemin', String(DRAWER_MIN));
  resizer.setAttribute('aria-valuemax', String(drawerMax()));
  drawMinimap();
  if (persist) {
    ui.drawerWidth = width;
    saveState();
  }
}
resizer.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  try {
    resizer.setPointerCapture(e.pointerId);
  } catch {
    // Capture can be refused (e.g. the pointer is already gone); dragging still works while over the handle.
  }
  stage.classList.add('resizing');
  card.hide();
  tips.suppress(true);
  const right = stage.getBoundingClientRect().right;
  const move = (ev: PointerEvent) => setDrawerWidth(right - ev.clientX);
  const up = () => {
    resizer.removeEventListener('pointermove', move);
    stage.classList.remove('resizing');
    tips.suppress(false);
    setDrawerWidth(drawer.offsetWidth, true);
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', up, { once: true });
  resizer.addEventListener('pointercancel', up, { once: true });
});
resizer.addEventListener('dblclick', () => setDrawerWidth(DRAWER_DEFAULT, true));
resizer.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 64 : 16;
  if (e.key === 'ArrowLeft') setDrawerWidth(drawer.offsetWidth + step, true);
  else if (e.key === 'ArrowRight') setDrawerWidth(drawer.offsetWidth - step, true);
  else if (e.key === 'Home') setDrawerWidth(DRAWER_DEFAULT, true);
  else return;
  e.preventDefault();
  e.stopPropagation();
});
// Keep the drawer within bounds when the panel shrinks.
window.addEventListener('resize', () => setDrawerWidth(ui.drawerWidth ?? DRAWER_DEFAULT));

/** Open blockers of a ticket, worst first, as "Blocked by PLAT-7 (In Progress), SHOP-23 (Ready for Testing)". */
function blockers(key: string): { issue: GraphIssue; state: BlockState }[] {
  const out: { issue: GraphIssue; state: BlockState }[] = [];
  for (const l of model?.links ?? []) {
    if (l.to !== key || l.category !== 'blocks') continue;
    const st = linkBlockState(l, byKey, stageOverrides);
    const b = byKey.get(l.from);
    if (st && b && isBlocking(st)) out.push({ issue: b, state: st });
  }
  return out.sort((a, b) => BLOCK_SEVERITY.indexOf(a.state) - BLOCK_SEVERITY.indexOf(b.state));
}

function blockerSummary(key: string): string {
  const list = blockers(key);
  if (!list.length) return 'Blocked by an unresolved issue';
  const lead = list[0].state === 'critical' ? 'Work started, but blocked by ' : 'Blocked by ';
  return lead + list.map((x) => `${x.issue.key} (${x.issue.status})`).join(', ');
}

function chainSummary(key: string): string {
  if (!model) return '';
  const { up, down } = chainOf(key, model.links);
  if (!up.size && !down.size) return '';
  const openUp = [...up.keys()].filter((k) => byKey.get(k)?.statusCategory !== 'done');
  const depth = Math.max(0, ...[...up.values()]);
  return `<div class="d-chain">
    <span class="chain-up-chip" title="Transitive blockers (prerequisites)">⬆ requires ${up.size}${openUp.length !== up.size ? ` · ${openUp.length} open` : ''}${depth > 1 ? ` · ${depth} steps deep` : ''}</span>
    <span class="chain-down-chip" title="Everything this transitively unblocks">⬇ unlocks ${down.size}</span>
  </div>`;
}

function renderDrawer() {
  const i = detailsOpen && selected ? byKey.get(selected) : undefined;
  stage.classList.toggle('drawer-open', !!i);
  if (!i || !model) {
    drawer.innerHTML = '';
    return;
  }
  const s = styleOf(i);
  const parent = i.parentKey ? byKey.get(i.parentKey) : undefined;
  const kids = (childrenOf.get(i.key) ?? []).map((k) => byKey.get(k)!);
  const out = model.links.filter((l) => l.from === i.key);
  const inc = model.links.filter((l) => l.to === i.key);
  const chip = (k: string) => {
    const x = byKey.get(k);
    if (!x) return esc(k);
    return `<button class="chip s-${x.statusCategory}" data-goto="${esc(k)}" title="${esc(x.summary)}">${iconMarkup(styleOf(x), 14)}<b>${esc(k)}</b><span>${esc(x.summary)}</span></button>`;
  };
  const group = (title: string, keys: string[]) => (keys.length ? `<h4>${esc(title)}</h4><div class="chips">${keys.map(chip).join('')}</div>` : '');
  const grouped = new Map<string, string[]>();
  for (const l of out) grouped.set(`${l.label}`, [...(grouped.get(l.label) ?? []), l.to]);
  for (const l of inc) {
    const title = inverse(l.label);
    grouped.set(title, [...(grouped.get(title) ?? []), l.from]);
  }
  const updated = i.updated ? relTime(i.updated) : '';
  drawer.innerHTML = `
    <div class="d-head" style="--type:${s.color}">
      ${iconMarkup(s, 20)}
      <a class="d-key" href="#" data-open="${esc(i.key)}">${esc(i.key)}</a>
      <span class="d-type">${esc(i.type)}</span>
      <button class="icon d-close" title="Close (Esc)">${UI_ICONS.close}</button>
    </div>
    <h3 class="d-summary">${esc(i.summary || '(not loaded)')}</h3>
    ${chainSummary(i.key)}
    ${i.loaded ? descriptionBlock(descriptions.get(i.key), descriptionLines, drawerDescExpanded) : ''}
    ${blocked.has(i.key) ? `<div class="d-alert b-${blockedBy.get(i.key)}">${UI_ICONS.warn}<span>${esc(blockerSummary(i.key))}</span></div>` : ''}
    <dl class="d-grid">
      <dt>Status</dt><dd><span class="pill st-${i.statusCategory}">${esc(i.status || '—')}</span></dd>
      ${lensMarks.get(i.key)?.badges.length ? `<dt>${esc(LENSES[ui.lens ?? 'none'].label)}</dt><dd>${lensMarks.get(i.key)!.badges.map((b) => `<span class="lbadge tone-${b.tone}" title="${esc(b.title)}">${esc(b.text)}</span> <small>${esc(b.title)}</small>`).join('<br/>')}</dd>` : ''}
      <dt>Priority</dt><dd>${esc(i.priority ?? '—')}</dd>
      ${i.statusChangedAt ? `<dt>In status</dt><dd>${fmtAge((Date.now() - Date.parse(i.statusChangedAt)) / 86_400_000)} (since ${new Date(i.statusChangedAt).toLocaleDateString()})</dd>` : ''}
      ${i.resolvedAt ? `<dt>Resolved</dt><dd>${new Date(i.resolvedAt).toLocaleDateString()}</dd>` : ''}
      ${i.sprints?.length ? `<dt>Sprints</dt><dd>${i.sprints.map((sp) => `<span class="tag sprint-${sp.state}" title="${sp.state}">${esc(sp.name)}</span>`).join(' ')}</dd>` : ''}
      ${i.dueDate ? `<dt>Due</dt><dd>${new Date(i.dueDate).toLocaleDateString()}</dd>` : ''}
      ${i.fixVersions?.length ? `<dt>Fix version</dt><dd>${i.fixVersions.map((v) => `<span class="tag">${esc(v)}</span>`).join(' ')}</dd>` : ''}
      <dt>Assignee</dt><dd>${i.assignee ? `<span class="avatar" style="background:${avatarColor(i.assignee)}">${initials(i.assignee)}</span>${esc(i.assignee)}` : '<i>Unassigned</i>'}</dd>
      ${i.storyPoints !== undefined ? `<dt>Points</dt><dd>${i.storyPoints}</dd>` : ''}
      ${i.labels.length ? `<dt>Labels</dt><dd>${i.labels.map((l) => `<span class="tag">${esc(l)}</span>`).join(' ')}</dd>` : ''}
      ${updated ? `<dt>Updated</dt><dd>${updated}</dd>` : ''}
    </dl>
    <div class="d-actions">
      <button class="primary" data-act="open">${UI_ICONS.open}Open in Jira</button>
      <button data-act="expand">${UI_ICONS.plus}${i.loaded ? 'More relations' : 'Load'}</button>
      <button data-act="focus">${UI_ICONS.focus}Focus</button>
      <button data-act="graph">${UI_ICONS.graph}New graph</button>
    </div>
    ${parent ? group('Parent', [parent.key]) : i.parentKey ? group('Parent', [i.parentKey]) : ''}
    ${group(`Children (${kids.length})`, kids.map((k) => k.key))}
    ${[...grouped].map(([t, keys]) => group(t, keys)).join('')}
    ${i.loaded ? '' : '<p class="d-note">This issue was discovered through a relation and has not been loaded yet.</p>'}
  `;
  if (i.loaded) requestDescription(i.key);
  fitDescription(drawer);
  drawer.querySelector('[data-desc-toggle]')?.addEventListener('click', () => {
    drawerDescExpanded = !drawerDescExpanded;
    renderDrawer();
  });
  drawer.querySelectorAll<HTMLElement>('[data-url]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      post({ type: 'openUrl', url: a.dataset.url! });
    }),
  );
  drawer.querySelector('.d-close')!.addEventListener('click', () => closeDetails());
  drawer.querySelector('[data-open]')!.addEventListener('click', (e) => {
    e.preventDefault();
    post({ type: 'openIssue', key: i.key });
  });
  drawer.querySelectorAll<HTMLButtonElement>('[data-goto]').forEach((b) =>
    b.addEventListener('click', () => revealKey(b.dataset.goto!)),
  );
  drawer.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      const act = b.dataset.act;
      if (act === 'open') post({ type: 'openIssue', key: i.key });
      if (act === 'expand') post({ type: 'expand', keys: [i.key] });
      if (act === 'focus') setFocus(i.key, focus?.hops ?? 2);
      if (act === 'graph') post({ type: 'graphFrom', key: i.key });
    }),
  );
}

const INVERSE: Record<string, string> = {
  blocks: 'is blocked by',
  duplicates: 'is duplicated by',
  clones: 'is cloned by',
  causes: 'is caused by',
  'relates to': 'relates to',
  tests: 'is tested by',
  'split to': 'split from',
};
function inverse(label: string): string {
  return INVERSE[label.toLowerCase()] ?? `${label} (inward)`;
}

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const f = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 3600) return f.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return f.format(-Math.round(s / 3600), 'hour');
  if (s < 86400 * 30) return f.format(-Math.round(s / 86400), 'day');
  return new Date(iso).toLocaleDateString();
}

/** Makes a key visible (clearing filters that hide it) and centers it. */
function revealKey(key: string) {
  const i = byKey.get(key);
  if (!i) return;
  let changed = false;
  if (!lay?.nodes.has(key)) {
    hiddenKeys.delete(key);
    const t = styleOf(i).key;
    if (ui.hiddenTypes.includes(t)) (ui.hiddenTypes = ui.hiddenTypes.filter((x) => x !== t)), (changed = true);
    if (ui.hideDone && i.statusCategory === 'done') (ui.hideDone = false), (changed = true);
    if (focus && !neighbourhood(focus.key, focus.hops).has(key)) focus = undefined;
    for (let p = i.parentKey; p; p = byKey.get(p)?.parentKey) collapsed.delete(p);
    changed = true;
  }
  if (changed) {
    saveState();
    syncToolbar();
    void relayout().then(() => select(key, { center: true }));
  } else select(key, { center: true });
}

// ── Legend ──────────────────────────────────────────────────────────────────
function lensLegend(): string {
  const id = ui.lens ?? 'none';
  if (id === 'none') return '';
  const info = LENSES[id];
  const counts = { primary: 0, context: 0, muted: 0 };
  for (const i of visible.issues) {
    const m = lensMarks.get(i.key);
    if (m) counts[m.level]++;
  }
  const row = (r: (typeof info.legend)[number]) => {
    const sample = r.badge
      ? `<span class="lbadge tone-${r.badge.tone}">${esc(r.badge.text)}</span>`
      : r.outline
        ? `<span class="lsample outline-${r.outline}"></span>`
        : `<span class="lsample level-${r.level}"></span>`;
    const n = r.level && !r.badge && !r.outline ? `<em>${counts[r.level]}</em>` : '';
    return `<div class="lrow">${sample}<span>${esc(r.text)}</span>${n}</div>`;
  };
  return `<h5>Lens · ${esc(info.label)}</h5><p class="lens-hint">${esc(info.hint)}</p>${info.legend.map(row).join('')}`;
}

function stateDesc(st: BlockState): string {
  const stages = (want: Stage) => [...new Set((model?.issues ?? []).filter((i) => stageOfIssue(i) === want).map((i) => i.status))].join(', ') || '—';
  switch (st) {
    case 'critical': return 'Thick pulsing red: the blocked ticket is already in progress while its blocker has not started.';
    case 'todo': return `Solid red. Blocker statuses: ${stages('todo')}`;
    case 'dev': return `Orange, dashes flowing. Blocker statuses: ${stages('dev')}`;
    case 'test': return `Amber, dots flowing slowly. Blocker statuses: ${stages('test')}`;
    case 'stale': return 'Grey dashed: the blocked ticket is done although its blocker is still open.';
    case 'resolved': return 'Thin faded green: the blocker is done.';
  }
}

function renderLegend() {
  if (!model) return;
  const types = new Map<string, { style: TypeStyle; count: number }>();
  for (const i of model.issues) {
    const s = styleOf(i);
    const t = types.get(s.key) ?? { style: s, count: 0 };
    t.count++;
    types.set(s.key, t);
  }
  const linkCounts = new Map<string, number>();
  for (const l of model.links) linkCounts.set(l.category, (linkCounts.get(l.category) ?? 0) + 1);
  const hierarchyCount = model.issues.filter((i) => i.parentKey && byKey.has(i.parentKey)).length;

  const borderSample = (s: TypeStyle) => {
    const dash = dashArray(s);
    const inner = s.border === 'double' ? `<rect x="4" y="4" width="26" height="10" rx="${Math.max(0, s.radius / 3 - 2)}" fill="none" stroke="${s.color}" stroke-width="1.2"/>` : '';
    return `<svg width="34" height="18" viewBox="0 0 34 18"><rect x="1.5" y="1.5" width="31" height="15" rx="${s.radius / 2.5}" fill="none" stroke="${s.color}" stroke-width="${Math.min(s.width, 2.5)}" ${dash ? `stroke-dasharray="${dash}"` : ''} stroke-linecap="round"/>${inner}</svg>`;
  };
  const lineSample = (k: string) =>
    `<svg width="34" height="12" viewBox="0 0 34 12" class="g-edge k-${k}"><path class="line" d="M2 6 H26" ${k === 'relates' ? '' : `marker-end="url(#m-${k})"`}/></svg>`;

  const typeRows = [...types.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ style: s, count }) => {
      const off = ui.hiddenTypes.includes(s.key);
      return `<button class="row${off ? ' off' : ''}" data-type="${esc(s.key)}" data-tip="${esc(s.label)} · ${count}" data-tip-desc="${esc(`${s.border === 'double' ? 'Double' : s.border[0].toUpperCase() + s.border.slice(1)} ${s.color} border.\nClick to ${off ? 'show' : 'hide'} these tickets.`)}">${iconMarkup(s, 16)}${borderSample(s)}<span>${esc(s.label)}</span><em>${count}</em></button>`;
    })
    .join('');
  const rows: string[] = [];
  if (ui.mode === 'edges' && hierarchyCount) {
    rows.push(`<button class="row${ui.showHierarchy ? '' : ' off'}" data-hier="1" data-tip="Parent → child · ${hierarchyCount}" data-tip-desc="Click to ${ui.showHierarchy ? 'hide' : 'show'} hierarchy edges (Tree mode)">${lineSample('hierarchy')}<span>${LINK_LABELS.hierarchy}</span><em>${hierarchyCount}</em></button>`);
  }
  for (const k of ['blocks', 'relates', 'duplicates', 'clones', 'other'] as LinkCategory[]) {
    const c = linkCounts.get(k);
    if (!c) continue;
    const off = ui.hiddenLinks.includes(k);
    rows.push(`<button class="row${off ? ' off' : ''}" data-link="${k}" data-tip="${LINK_LABELS[k]} · ${c}" data-tip-desc="Click to ${off ? 'show' : 'hide'} these links">${lineSample(k)}<span>${LINK_LABELS[k]}</span><em>${c}</em></button>`);
    if (k === 'blocks' && !off) {
      // Break blocking links down by blocker state (the colour and line style on the graph).
      const byState = new Map<BlockState, number>();
      for (const l of model.links) {
        const st = linkBlockState(l, byKey, stageOverrides);
        if (st) byState.set(st, (byState.get(st) ?? 0) + 1);
      }
      const short: Record<BlockState, string> = { critical: '⚠ started, blocker not', todo: 'not started', dev: 'in development', test: 'in testing', stale: 'blocked one done', resolved: 'resolved' };
      for (const st of BLOCK_SEVERITY) {
        const n = byState.get(st);
        if (!n) continue;
        rows.push(`<div class="row sub" data-tip="${esc(BLOCK_LABELS[st])}" data-tip-desc="${esc(stateDesc(st))}"><svg width="26" height="12" viewBox="0 0 26 12" class="g-edge k-blocks b-${st}"><path class="line" d="M2 6 H20" marker-end="url(#m-b-${st})"/></svg><span>${esc(short[st])}</span><em>${n}</em></div>`);
      }
    }
  }

  legend.classList.toggle('collapsed', !ui.legendOpen);
  legend.innerHTML = `
    <button class="legend-head">Legend <span>${ui.legendOpen ? '▾' : '▸'}</span></button>
    <div class="legend-body">
      ${lensLegend()}
      <h5>Issue types</h5>${typeRows}
      ${rows.length ? `<h5>Relations</h5>${rows.join('')}` : ''}
      <h5>Status</h5>
      <div class="statuses"><span class="pill st-new" data-tip="To do" data-tip-desc="Status category “To Do”: grey stripe and pill">To do</span><span class="pill st-indeterminate" data-tip="In progress" data-tip-desc="Any in-progress status (In Progress, In Review, …): blue stripe and tint">In progress</span><span class="pill st-done" data-tip="Done" data-tip-desc="Status category “Done”: green stripe, key struck through">Done</span></div>
      <div class="badges"><span data-tip="Blocked" data-tip-desc="Red badge: an open ticket blocks this open ticket"><span class="badge-blocked"></span> blocked</span> <span data-tip="Not loaded" data-tip-desc="Hatched card: found through a relation; press + or double-click to load"><span class="badge-stub"></span> not loaded</span></div>
      <p class="help">Click selects · <kbd>Enter</kbd> or ⓘ details · double-click opens Jira · right-click for actions · scroll / pinch to zoom · drag to pan · <kbd>L</kbd> lens · <kbd>/</kbd> filter · <kbd>F3</kbd> next match · <kbd>F</kbd> fit · arrows move selection</p>
    </div>`;
  legend.querySelector('.legend-head')!.addEventListener('click', () => {
    ui.legendOpen = !ui.legendOpen;
    saveState();
    renderLegend();
  });
  legend.querySelectorAll<HTMLButtonElement>('[data-type]').forEach((b) =>
    b.addEventListener('click', () => {
      const t = b.dataset.type!;
      ui.hiddenTypes = ui.hiddenTypes.includes(t) ? ui.hiddenTypes.filter((x) => x !== t) : [...ui.hiddenTypes, t];
      saveState();
      void relayout();
    }),
  );
  legend.querySelectorAll<HTMLButtonElement>('[data-link]').forEach((b) =>
    b.addEventListener('click', () => {
      const t = b.dataset.link!;
      ui.hiddenLinks = ui.hiddenLinks.includes(t) ? ui.hiddenLinks.filter((x) => x !== t) : [...ui.hiddenLinks, t];
      saveState();
      void relayout();
    }),
  );
  legend.querySelector('[data-hier]')?.addEventListener('click', () => {
    ui.showHierarchy = !ui.showHierarchy;
    saveState();
    void relayout();
  });
}

// ── Banner & stats ──────────────────────────────────────────────────────────
function renderBanner() {
  if (!model) return;
  const parts: string[] = [];
  if (ui.lens === 'planning' && !hasSprintData(model.issues)) {
    parts.push(`<span class="warn">${UI_ICONS.warn} No sprint data on these tickets — check the <b>jiraGraph.sprintField</b> setting (Cloud default customfield_10020)</span>`);
  }
  const si = model.scopeInfo;
  if (si) {
    const doneTxt = si.config.doneDays < 0 ? 'all' : si.config.doneDays === 0 ? 'none' : `${si.done.shown} of ${si.done.total}`;
    parts.push(`<span class="info" data-tip="Sprint scope" data-tip-desc="Loaded by the scope, not cut by a limit. Change it with the Scope button; +N chips load a parent's left-out tickets.">${UI_ICONS.target} <span>Sprint scope: ${si.sprint.shown} sprint · ${si.backlog.shown} of ${si.backlog.total} backlog · done ${doneTxt}${si.context ? ` · ${si.context} context` : ''}.&nbsp;</span><button data-b="scope">Change</button></span>`);
  }
  const t = model.truncation;
  if (t) {
    // Only reported when Jira said more exists, or expansion really skipped something because of the limit.
    // The graph holds `limit` tickets when it is cut; suggest room for what was left out, plus 10%.
    const suggest = Math.min(2000, Math.ceil(((t.queryTotal ?? t.limit + Math.max(t.skipped, 1)) * 1.1) / 100) * 100);
    const raise = suggest > t.limit ? ` <button data-b="raise" data-to="${suggest}">Raise limit to ${suggest}</button>` : '';
    if (t.queryMore) {
      const of = t.queryTotal !== undefined ? `${t.queryTotal}` : `more than ${t.queryLoaded}`;
      parts.push(`<span class="warn" data-tip="Issue limit reached" data-tip-desc="The query matches ${esc(of)} tickets; the graph loads at most ${t.limit} (jiraGraph.maxIssues). Narrow the query or raise the limit.">${UI_ICONS.warn} <span>Showing ${t.queryLoaded} of ${esc(of)} tickets matching the query.&nbsp;</span>${raise}</span>`);
    } else if (t.skipped || t.childrenCut) {
      const what = [t.skipped ? `${t.skipped} related ticket${t.skipped === 1 ? '' : 's'} shown as placeholders` : '', t.childrenCut ? 'some children not loaded' : ''].filter(Boolean).join(' · ');
      parts.push(`<span class="info" data-tip="All query results are shown" data-tip-desc="Expansion stopped at ${t.limit} tickets (jiraGraph.maxIssues). Placeholders can be loaded with + or Load relations.">${UI_ICONS.graph} <span>${esc(what)} (limit ${t.limit}).&nbsp;</span>${raise}</span>`);
    }
  }
  if (linksFocused && lay) {
    const n = lay.edges.filter((e) => e.kind !== 'hierarchy').length;
    parts.push(`<span>${UI_ICONS.graph} ${n} links hidden until you select or hover a ticket <button data-b="alllinks">Show all</button></span>`);
  }
  if (cycles.length) {
    parts.push(`<span class="warn">${UI_ICONS.warn} ${cycles.length} dependency cycle${cycles.length > 1 ? 's' : ''}: ${cycles.map((c) => c.join(' ⇄ ')).slice(0, 2).map(esc).join(', ')} <button data-b="cycles">Show</button></span>`);
  }
  if (focus) {
    parts.push(`<span>${UI_ICONS.focus} Focus: <b>${esc(focus.key)}</b> · hops ${[1, 2, 3].map((h) => `<button data-hops="${h}" class="${focus!.hops === h ? 'on' : ''}">${h}</button>`).join('')} <button data-b="unfocus">Exit focus</button></span>`);
  }
  const hiddenCount = model.issues.length - visible.issues.length;
  const filtersOn = hiddenKeys.size || ui.hiddenTypes.length || ui.hideDone || ui.hiddenLinks.length || collapsed.size;
  if (filtersOn && hiddenCount > 0) parts.push(`<span>${hiddenCount} issue${hiddenCount > 1 ? 's' : ''} hidden by filters <button data-b="reset">Show all</button></span>`);
  banner.innerHTML = parts.join('');
  banner.classList.toggle('open', parts.length > 0);
  banner.querySelectorAll<HTMLButtonElement>('[data-b]').forEach((b) =>
    b.addEventListener('click', () => {
      const a = b.dataset.b;
      if (a === 'unfocus') setFocus(undefined);
      if (a === 'raise') post({ type: 'raiseLimit', to: Number(b.dataset.to) });
      // Deferred: this click must finish bubbling (outside-click closes popovers) before the panel opens.
      if (a === 'scope') setTimeout(() => $<HTMLButtonElement>('.scopebtn').click(), 0);
      if (a === 'alllinks') {
        ui.linkVisibility = 'all';
        saveState();
        syncToolbar();
        render();
        renderBanner();
      }
      if (a === 'cycles') {
        highlight = new Set(cycles.flat());
        applyClasses();
      }
      if (a === 'reset') {
        hiddenKeys.clear();
        collapsed.clear();
        ui.hiddenTypes = [];
        ui.hiddenLinks = [];
        ui.hideDone = false;
        saveState();
        syncToolbar();
        void relayout({ fit: true });
      }
    }),
  );
  banner.querySelectorAll<HTMLButtonElement>('[data-hops]').forEach((b) =>
    b.addEventListener('click', () => setFocus(focus!.key, Number(b.dataset.hops))),
  );
}

function renderStats() {
  if (!model) return;
  const loaded = model.issues.filter((i) => i.loaded).length;
  const stubs = model.issues.length - loaded;
  $<HTMLElement>('.title-text').textContent = model.title;
  $<HTMLElement>('.title-text').title = model.source.kind === 'jql' ? model.source.jql : model.title;
  $<HTMLElement>('.stats').innerHTML = [
    `${visible.issues.length}/${model.issues.length} issues`,
    `${model.links.length} links`,
    stubs ? `${stubs} not loaded` : '',
    blocked.size ? `<span class="bad">${blocked.size} blocked</span>` : '',
  ].filter(Boolean).join(' · ');
  const statsEl = $<HTMLElement>('.stats');
  statsEl.setAttribute('data-tip', model.title);
  statsEl.setAttribute('data-tip-desc', statsEl.textContent ?? '');
}

// ── Search ──────────────────────────────────────────────────────────────────

// ── Minimap ─────────────────────────────────────────────────────────────────
let mmScheduled = false;
function drawMinimap() {
  if (mmScheduled) return;
  mmScheduled = true;
  requestAnimationFrame(() => {
    mmScheduled = false;
    minimap.classList.toggle('hidden', !ui.minimap || !lay);
    if (!ui.minimap || !lay) return;
    const ctx = minimap.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const W = 200;
    const H = 130;
    if (minimap.width !== W * dpr) (minimap.width = W * dpr), (minimap.height = H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const s = Math.min((W - 12) / Math.max(lay.width, 1), (H - 12) / Math.max(lay.height, 1));
    const ox = (W - lay.width * s) / 2;
    const oy = (H - lay.height * s) / 2;
    for (const n of [...lay.nodes.values()].sort((a, b) => a.depth - b.depth)) {
      const st = styleOf(byKey.get(n.key)!);
      const lvl = lensMarks.get(n.key)?.level;
      ctx.globalAlpha = n.group ? 0.18 : n.key === selected ? 1 : lvl === 'muted' ? 0.2 : lvl === 'primary' ? 1 : 0.75;
      ctx.fillStyle = st.color;
      ctx.fillRect(ox + n.x * s, oy + n.y * s, Math.max(1.5, n.w * s), Math.max(1.5, n.h * s));
    }
    ctx.globalAlpha = 1;
    const { w, h } = stageSize();
    const fg = getComputedStyle(document.body).getPropertyValue('--vscode-focusBorder') || '#0af';
    ctx.strokeStyle = fg;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + (-view.x / view.k) * s, oy + (-view.y / view.k) * s, (w / view.k) * s, (h / view.k) * s);
    (minimap as unknown as { _map: object })._map = { s, ox, oy };
  });
}

let mmDrag = false;
const mmNavigate = (e: PointerEvent) => {
  const m = (minimap as unknown as { _map?: { s: number; ox: number; oy: number } })._map;
  if (!m) return;
  const r = minimap.getBoundingClientRect();
  const gx = (e.clientX - r.left - m.ox) / m.s;
  const gy = (e.clientY - r.top - m.oy) / m.s;
  const { w, h } = stageSize();
  anim++;
  view.x = w / 2 - gx * view.k;
  view.y = h / 2 - gy * view.k;
  applyView();
};
minimap.addEventListener('pointerdown', (e) => {
  mmDrag = true;
  minimap.setPointerCapture(e.pointerId);
  mmNavigate(e);
});
minimap.addEventListener('pointermove', (e) => mmDrag && mmNavigate(e));
minimap.addEventListener('pointerup', () => (mmDrag = false));

// ── Toolbar ─────────────────────────────────────────────────────────────────
function syncToolbar() {
  app.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
    const opt = seg.dataset.opt as 'mode' | 'direction';
    seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.v === ui[opt]));
  });
  $<HTMLSelectElement>('select[data-opt="linkVisibility"]').value = ui.linkVisibility ?? 'auto';
  $<HTMLSelectElement>('select[data-opt="lens"]').value = ui.lens ?? 'none';
  $<HTMLSelectElement>('select[data-opt="strategy"]').value = ui.strategy ?? 'hybrid';
  app.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => {
    b.classList.toggle('on', !!ui[b.dataset.toggle as keyof UiState]);
  });
}

app.querySelectorAll<HTMLElement>('.seg').forEach((seg) =>
  seg.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!b) return;
    const opt = seg.dataset.opt as 'mode' | 'direction';
    (ui as unknown as Record<string, string>)[opt] = b.dataset.v!;
    saveState();
    syncToolbar();
    void relayout({ fit: true });
  }),
);
function setLens(id: LensId) {
  ui.lens = id;
  saveState();
  syncToolbar();
  recomputeLens();
  render();
  renderLegend();
  renderBanner();
  renderDrawer();
  drawMinimap();
}
$<HTMLSelectElement>('select[data-opt="strategy"]').addEventListener('change', (e) => {
  ui.strategy = (e.target as HTMLSelectElement).value as LayoutStrategy;
  saveState();
  void relayout({ fit: true });
});
$<HTMLSelectElement>('select[data-opt="lens"]').addEventListener('change', (e) => setLens((e.target as HTMLSelectElement).value as LensId));
$<HTMLSelectElement>('select[data-opt="linkVisibility"]').addEventListener('change', (e) => {
  ui.linkVisibility = (e.target as HTMLSelectElement).value as UiState['linkVisibility'];
  saveState();
  render();
  renderBanner();
});
type ToggleKey = 'showLabels' | 'hideDone' | 'linksAffectLayout' | 'minimap';
function toggleOpt(k: ToggleKey) {
  ui[k] = !ui[k];
  saveState();
  syncToolbar();
  if (k === 'minimap') drawMinimap();
  else void relayout({ fit: k === 'linksAffectLayout' });
}

function setRouting(r: UiState['routing']) {
  ui.routing = r;
  saveState();
  void relayout();
}

/** Labelled view options: clearer than a row of icon toggles, and keeps the toolbar on one line. */
function showMoreMenu(x: number, y: number) {
  type Item = { label: string; desc?: string; on?: boolean; kbd?: string; run: () => void } | 'sep' | { heading: string };
  const items: Item[] = [
    { label: 'Link labels', desc: 'Relation names on links', on: ui.showLabels, run: () => toggleOpt('showLabels') },
    { label: 'Hide done', desc: 'Hide tickets in a Done status', on: ui.hideDone, run: () => toggleOpt('hideDone') },
    { label: 'Links shape the layout', desc: 'Off: hierarchy only, links on top', on: ui.linksAffectLayout, run: () => toggleOpt('linksAffectLayout') },
    { label: 'Minimap', on: ui.minimap, run: () => toggleOpt('minimap') },
    'sep',
    { heading: 'Edge routing' },
    { label: 'Orthogonal', on: ui.routing === 'ORTHOGONAL', run: () => setRouting('ORTHOGONAL') },
    { label: 'Splines', on: ui.routing === 'SPLINES', run: () => setRouting('SPLINES') },
    { label: 'Polyline', on: ui.routing === 'POLYLINE', run: () => setRouting('POLYLINE') },
    'sep',
    { label: 'Collapse all', desc: 'Fold every parent', run: () => runAction('collapseAll') },
    { label: 'Expand all', run: () => runAction('expandAll') },
  ];
  menu.innerHTML = items
    .map((it, i) =>
      it === 'sep' ? '<hr/>'
      : 'heading' in it ? `<div class="menu-title">${esc(it.heading)}</div>`
      : `<button data-i="${i}" role="menuitemcheckbox" aria-checked="${!!it.on}"><span class="check">${it.on ? UI_ICONS.check : ''}</span><span>${esc(it.label)}${it.desc ? `<small>${esc(it.desc)}</small>` : ''}</span></button>`,
    )
    .join('');
  menu.querySelectorAll<HTMLButtonElement>('button').forEach((btn) =>
    btn.addEventListener('click', () => {
      hideMenu();
      (items[Number(btn.dataset.i)] as { run: () => void }).run();
    }),
  );
  menu.classList.add('open', 'more');
  const r = stage.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x - r.left, r.width - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(4, y - r.top)}px`;
}

function runAction(a: string) {
  if (a === 'collapseAll') {
    // Collapsing every parent gives progressive disclosure: expanding one level reveals collapsed children.
    for (const k of childrenOf.keys()) collapsed.add(k);
    void relayout({ fit: true });
  }
  if (a === 'expandAll') {
    collapsed.clear();
    void relayout({ fit: true });
  }
}
app.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) =>
  b.addEventListener('click', (e) => {
    const a = b.dataset.action;
    if (a === 'zoomIn') zoomAt(1.25);
    if (a === 'zoomOut') zoomAt(0.8);
    if (a === 'zoomReset') zoomAt(1 / view.k);
    if (a === 'fit') fit();
    if (a === 'refresh') post({ type: 'refresh' });
    if (a === 'syncNow') post({ type: 'syncNow' });
    if (a === 'more') {
      const r = b.getBoundingClientRect();
      showMoreMenu(r.right - 260, r.bottom + 4);
      e.stopPropagation();
    }
    if (a === 'export') {
      const r = b.getBoundingClientRect();
      showExportMenu(r.left, r.bottom + 4);
      e.stopPropagation();
    }
  }),
);

function showExportMenu(x: number, y: number) {
  const items = [
    { label: 'Export as SVG…', icon: UI_ICONS.export, run: () => post({ type: 'exportSvg', svg: exportSvg() }) },
    { label: 'Copy as Mermaid', icon: UI_ICONS.copy, run: () => post({ type: 'copyMermaid' }) },
    { label: 'Copy visible keys', icon: UI_ICONS.copy, run: () => post({ type: 'copy', text: visible.issues.map((i) => i.key).join(', ') }) },
    { label: 'Copy JQL for visible', icon: UI_ICONS.copy, run: () => post({ type: 'copy', text: `key in (${visible.issues.filter((i) => i.loaded).map((i) => i.key).join(', ')})` }) },
  ];
  menu.innerHTML = items.map((it, i) => `<button data-i="${i}">${it.icon}<span>${it.label}</span></button>`).join('');
  menu.querySelectorAll<HTMLButtonElement>('button').forEach((btn) =>
    btn.addEventListener('click', () => {
      hideMenu();
      items[Number(btn.dataset.i)].run();
    }),
  );
  menu.classList.add('open');
  const r = stage.getBoundingClientRect();
  menu.style.left = `${Math.min(x - r.left, r.width - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.max(4, y - r.top)}px`;
}

document.addEventListener('click', (e) => {
  if (!menu.contains(e.target as Node)) hideMenu();
});

// ── Keyboard ────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.target as Element | null)?.closest?.('input, select, textarea')) return;
  if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key === 'f')) {
    e.preventDefault();
    filterPanel.focusInput();
  } else if (e.key === 'F3' || ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G'))) {
    e.preventDefault();
    filterPanel.step(e.shiftKey ? -1 : 1);
  } else if (e.key === 'f' || e.key === 'F') fit();
  else if (e.key === '+' || e.key === '=') zoomAt(1.2);
  else if (e.key === '-') zoomAt(1 / 1.2);
  else if (e.key === '0') zoomAt(1 / view.k);
  else if (e.key === 'Escape' && card.openKey) card.hide();
  else if ((e.key === 'i' || e.key === 'I') && (hovered ?? selected)) card.toggleNow((hovered ?? selected)!);
  else if (e.key === 'Escape') {
    hideMenu();
    nodebar.hide();
    if (detailsOpen) closeDetails();
    else if (highlight) (highlight = undefined), applyClasses();
    else if (selected) select(undefined);
    else if (focus) setFocus(undefined);
  } else if (e.key === 'l' || e.key === 'L') {
    const cur = LENS_ORDER.indexOf(ui.lens ?? 'none');
    setLens(LENS_ORDER[(cur + (e.shiftKey ? LENS_ORDER.length - 1 : 1)) % LENS_ORDER.length]);
  } else if (selected && (e.key === 'e' || e.key === 'E')) post({ type: 'expand', keys: [selected] });
  else if (selected && (e.key === 'h' || e.key === 'H')) hideKey(selected);
  else if (selected && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) post({ type: 'openIssue', key: selected });
  else if (selected && e.key === 'Enter') openDetails(selected);
  else if (selected && e.key === ' ') {
    e.preventDefault();
    if (childrenOf.has(selected)) toggleCollapse(selected);
  } else if (selected && e.key.startsWith('Arrow')) {
    e.preventDefault();
    moveSelection(e.key);
  }
});

/** Spatial navigation: jump to the nearest node in the arrow direction. */
function moveSelection(dir: string) {
  const cur = lay?.nodes.get(selected!);
  if (!cur || !lay) return;
  const c = { x: cur.x + cur.w / 2, y: cur.y + (cur.group ? GROUP_HEADER / 2 : cur.h / 2) };
  let best: string | undefined;
  let bestScore = Infinity;
  for (const n of lay.nodes.values()) {
    if (n.key === cur.key) continue;
    const p = { x: n.x + n.w / 2, y: n.y + (n.group ? GROUP_HEADER / 2 : n.h / 2) };
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const along = dir === 'ArrowRight' ? dx : dir === 'ArrowLeft' ? -dx : dir === 'ArrowDown' ? dy : -dy;
    const across = dir === 'ArrowRight' || dir === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const score = along + across * 2.5;
    if (score < bestScore) (bestScore = score), (best = n.key);
  }
  if (best) select(best, { center: true });
}

// ── Export ──────────────────────────────────────────────────────────────────
function exportSvg(): string {
  if (!lay) return '';
  const pad = 24;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', NS);
  clone.setAttribute('width', String(Math.ceil(lay.width + pad * 2)));
  clone.setAttribute('height', String(Math.ceil(lay.height + pad * 2)));
  clone.setAttribute('viewBox', `0 0 ${Math.ceil(lay.width + pad * 2)} ${Math.ceil(lay.height + pad * 2)}`);
  clone.setAttribute('class', `canvas ${document.body.className}`);
  clone.querySelector('.viewport')!.setAttribute('transform', `translate(${pad} ${pad})`);
  clone.querySelectorAll('.hl, .selected, .match, .enter').forEach((e) => e.classList.remove('hl', 'selected', 'match', 'enter'));
  clone.querySelectorAll<SVGGElement>('.g-node').forEach((g) => {
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(g.style.transform);
    if (m) g.setAttribute('transform', `translate(${m[1]} ${m[2]})`);
    g.style.removeProperty('transform');
    g.style.removeProperty('transition');
  });
  const cs = getComputedStyle(document.body);
  const resolve = (css: string) => {
    // Per-node variables (e.g. --type set inline on each node) stay as var() references.
    for (let n = 0; n < 4; n++) css = css.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g, (m, v: string, fb?: string) => cs.getPropertyValue(v).trim() || fb || (v === '--type' ? m : ''));
    return css;
  };
  const rules: string[] = [];
  for (const r of Array.from(styleEl.sheet?.cssRules ?? [])) if (/\.(g-|mk|hatch|canvas|st-)/.test(r.cssText)) rules.push(resolve(r.cssText));
  const style = document.createElementNS(NS, 'style');
  style.textContent = `:root, svg { ${['--bg', '--fg', '--muted', '--card', '--edge', '--c-blocks', '--c-relates', '--c-duplicates', '--c-clones', '--c-other', '--c-hierarchy', '--font', '--mono']
    .map((v) => `${v}: ${resolve(cs.getPropertyValue(v))};`).join(' ')} font-family: ${fontFamily}; }\n${rules.join('\n')}`;
  clone.insertBefore(style, clone.firstChild);
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', cs.getPropertyValue('--bg').trim() || '#fff');
  clone.insertBefore(bg, clone.querySelector('.viewport'));
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

// ── Overlays ────────────────────────────────────────────────────────────────
let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add('open');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('open'), 2800);
}

function showLoading(message: string) {
  if (model) {
    app.classList.add('busy');
    $<HTMLElement>('.progress').title = message;
    overlay.classList.remove('open');
  } else {
    overlay.innerHTML = `<div class="card"><div class="spinner"></div><p>${esc(message)}</p></div>`;
    overlay.classList.add('open');
  }
}

function showError(message: string) {
  app.classList.remove('busy');
  if (model) {
    toast(message);
    return;
  }
  overlay.innerHTML = `<div class="card error">${UI_ICONS.warn}<p>${esc(message)}</p><button class="primary">Retry</button></div>`;
  overlay.querySelector('button')!.addEventListener('click', () => post({ type: 'refresh' }));
  overlay.classList.add('open');
}

// ── Live sync ───────────────────────────────────────────────────────────────
let syncState: Extract<HostMessage, { type: 'syncState' }> | undefined;
let lastInteraction = 0;
let pendingRelayout: { flash: string[] } | undefined;
let lastActivityPost = 0;

/** Tell the host about user actions (throttled); it drives the sync cadence. */
function noteActivity() {
  lastInteraction = Date.now();
  if (lastInteraction - lastActivityPost > 1000) {
    lastActivityPost = lastInteraction;
    post({ type: 'activity' });
  }
}
for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) window.addEventListener(ev, noteActivity, { passive: true, capture: true });
app.querySelector('.filterbox input')!.addEventListener('input', noteActivity);

const interacting = () => !!pan || menu.classList.contains('open') || Date.now() - lastInteraction < 1500;

/** Relative time, compact: "now", "12s", "3m". */
function ago(t?: number): string {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 5 ? 'now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86_400)}d ago`;
}

function renderLive() {
  const btn = $<HTMLButtonElement>('.live');
  const st = syncState;
  if (!st) return;
  btn.dataset.phase = st.error ? 'error' : st.syncing ? 'syncing' : st.phase;
  const label = st.phase === 'off' ? 'sync off' : st.phase === 'paused' ? 'paused' : st.syncing ? 'syncing…' : `live · ${ago(st.lastSyncAt)}`;
  $<HTMLElement>('.live-text').textContent = st.error ? 'sync error' : label;
  const next = st.nextRunAt ? Math.max(0, Math.round((st.nextRunAt - Date.now()) / 1000)) : undefined;
  // Details are rendered by the 'live' tip generator (see registerTips).
}
setInterval(renderLive, 5000);

function registerTips() {
  const list = (current: string, items: [string, string, string][]) =>
    items.map(([v, name, desc]) => `<div class="tip-opt${v === current ? ' on' : ''}"><b>${esc(name)}</b><span>${esc(desc)}</span></div>`).join('');
  tips.register('strategy', () => `<div class="tip-head"><span>View strategy</span></div>${list(ui.strategy ?? 'hybrid', [
    ['explicit', 'Explicit', 'Every relation shapes the layout; nothing is packed'],
    ['hybrid', 'Hybrid', 'All relations explicit; only relation-less tickets and single-link fans are packed'],
    ['compact', 'Compact', 'Only dependencies shape the layout; other links drawn on top'],
  ])}`);
  tips.register('lens', () => `<div class="tip-head"><span>Lens</span><kbd>L</kbd></div>${list(ui.lens ?? 'none', [
    ['none', 'None', 'Plain graph'],
    ['progress', 'Progress', 'Work in progress, time in status, what blocks it'],
    ['completion', 'Completion', 'Recently done, unblocked, ready to close'],
    ['planning', 'Planning', 'Active sprint, next sprints, backlog, carried over, idle'],
  ])}`);
  tips.register('links', () => `<div class="tip-head"><span>Link visibility</span></div>${list(ui.linkVisibility ?? 'auto', [
    ['auto', 'Auto', `All links; in Compact, only the selected ticket's once there are more than ${AUTO_LINK_LIMIT}`],
    ['all', 'All', 'Always draw every link'],
    ['selection', 'Selected only', 'Links appear for the selected or hovered ticket'],
  ])}`);
  tips.register('routing', () => `<div class="tip-head"><span>Edge routing</span></div>${list(ui.routing, [
    ['ORTHOGONAL', 'Orthogonal', 'Right-angle connectors, like a circuit or tech tree'],
    ['SPLINES', 'Splines', 'Smooth curves'],
    ['POLYLINE', 'Polyline', 'Straight segments'],
  ])}`);
  tips.register('live', () => {
    const st = syncState;
    if (!st) return '<div class="tip-head"><span>Live sync</span></div>';
    const next = st.nextRunAt ? Math.max(0, Math.round((st.nextRunAt - Date.now()) / 1000)) : undefined;
    const mode =
      st.phase === 'off' ? 'Disabled (jiraGraph.sync.enabled)'
      : st.phase === 'paused' ? 'Paused — window unfocused or graph hidden'
      : st.phase === 'cooldown' ? 'Active — you interacted recently, checking often'
      : 'Idle — checking about once a minute';
    return `<div class="tip-head"><span>Live sync</span><kbd>click</kbd></div>
      <div class="tip-desc">${esc(mode)}<br/>Last sync: ${esc(ago(st.lastSyncAt))}${next !== undefined && st.phase !== 'paused' ? ` · next in ${next}s` : ''}${
        st.error ? `<br/><span class="tip-bad">${esc(st.error)}</span>` : ''
      }<br/><span class="tip-muted">Click to sync now</span></div>`;
  });
}
registerTips();

/** Apply an incremental update: redraw in place when the visible structure is unchanged, otherwise relayout when the user is not interacting. */
function applySync(next: GraphModel, diff: SyncDiff) {
  for (const k of [...diff.changed, ...diff.removed, ...diff.renamed.map(([o]) => o)]) {
    descriptions.delete(k);
    descRequests.delete(k);
  }
  if (card.openKey && diff.changed.includes(card.openKey)) requestDescription(card.openKey, true);
  if (selected && diff.changed.includes(selected) && selected !== card.openKey) requestDescription(selected, true);
  const prevKeys = new Set(visible.issues.map((i) => i.key));
  const prevLinks = new Set(visible.links.map((l) => l.id));
  const prevParents = new Map(visible.issues.map((i) => [i.key, i.parentKey]));
  const renamedFrom = new Map(diff.renamed);
  if (selected && renamedFrom.has(selected)) selected = renamedFrom.get(selected);
  const removedNow = diff.removed.filter((k) => prevKeys.has(k));

  model = next;
  indexModel(model);
  recomputeLens();
  scopePanel?.refresh();
  if (selected && !byKey.has(selected)) {
    toast(`${selected} is no longer available (deleted, moved or no access).`);
    selected = undefined;
  }
  const nv = computeVisible();
  const structural =
    nv.issues.length !== prevKeys.size ||
    nv.issues.some((i) => !prevKeys.has(i.key) || prevParents.get(i.key) !== i.parentKey) ||
    nv.links.length !== prevLinks.size ||
    nv.links.some((l) => !prevLinks.has(l.id));
  const flash = [...diff.changed, ...diff.added, ...diff.renamed.map(([, k]) => k)];
  const parts = [
    diff.changed.length ? `${diff.changed.length} changed` : '',
    diff.added.length ? `${diff.added.length} added` : '',
    diff.renamed.length ? `${diff.renamed.length} moved` : '',
    diff.removed.length ? `${diff.removed.length} removed (${diff.removed.slice(0, 3).join(', ')}${diff.removed.length > 3 ? '…' : ''})` : '',
  ].filter(Boolean);
  if (parts.length) toast(`Jira: ${parts.join(' · ')}`);

  if (!structural) {
    visible = nv;
    render();
    renderDrawer();
    renderLegend();
    renderBanner();
    renderStats();
    flashNodes(flash);
    card.refresh();
    filterPanel?.refresh();
    return;
  }
  // Removed tickets fade out in place before the layout closes the gap.
  for (const k of removedNow) nodeEls.get(k)?.classList.add('gone');
  pendingRelayout = { flash: [...(pendingRelayout?.flash ?? []), ...flash] };
  setTimeout(tryPendingRelayout, removedNow.length ? 900 : 0);
}

function tryPendingRelayout() {
  if (!pendingRelayout) return;
  if (interacting()) {
    setTimeout(tryPendingRelayout, 500);
    return;
  }
  const { flash } = pendingRelayout;
  pendingRelayout = undefined;
  renderDrawer();
  void relayout().then(() => flashNodes(flash));
}

function flashNodes(keys: string[]) {
  for (const k of keys) {
    const g = nodeEls.get(k);
    if (!g) continue;
    g.classList.remove('flash');
    void g.getBoundingClientRect();
    g.classList.add('flash');
    setTimeout(() => g.classList.remove('flash'), 2600);
  }
}

// ── Host messages ───────────────────────────────────────────────────────────
window.addEventListener('message', (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'loading':
      showLoading(m.message);
      break;
    case 'error':
      showError(m.message);
      break;
    case 'description':
      if (descRequests.get(m.key) !== m.reqId) break; // superseded or reset since it was asked for
      if (m.error !== undefined) descFailedAt.set(m.key, Date.now());
      else descFailedAt.delete(m.key);
      descriptions.set(m.key, m.error !== undefined ? { error: m.error } : { html: sanitizeDescription(m.html ?? '') });
      if (card.openKey === m.key) card.refresh();
      if (selected === m.key) renderDrawer();
      break;
    case 'syncState':
      syncState = m;
      renderLive();
      break;
    case 'graph': {
      if (m.reason === 'sync' && model && lay) {
        applySync(m.model, m.diff!);
        break;
      }
      app.classList.remove('busy');
      overlay.classList.remove('open');
      resetDescriptions();
      const isNewSource = !model || JSON.stringify(model.source) !== JSON.stringify(m.model.source);
      model = m.model;
      persisted.source = m.model.source;
      styles = new TypeStyles(m.options.typeStyles);
      if (m.cachedAt) toast(`Opened from cache (saved ${ago(m.cachedAt)}) — catching up with Jira…`);
      card.enabled = m.options.hover?.enabled ?? true;
      card.delayMs = m.options.hover?.delayMs ?? 1000;
      descriptionLines = m.options.hover?.descriptionLines ?? 4;
      stageOverrides = normalizeStageOverrides(m.options.statusStages);
      if (uiFromHost) {
        ui.direction = m.options.direction;
        ui.mode = m.options.hierarchyMode;
        ui.routing = m.options.edgeRouting;
        uiFromHost = false;
      }
      saveState();
      indexModel(model);
      recomputeLens();
      scopePanel?.refresh();
      if (selected && !byKey.has(selected)) selected = undefined;
      syncToolbar();
      renderDrawer();
      if (!model.issues.length) {
        const jql = model.source.kind === 'jql' ? model.source.jql : model.source.kind === 'keys' ? `key in (${model.source.keys.join(', ')})` : '';
        overlay.innerHTML = `<div class="card">${UI_ICONS.graph}<p><b>The query returned no issues.</b></p>${jql ? `<p><code>${esc(jql)}</code></p>` : ''}<p>Check the project key and filters in Jira's own issue search, or use <b>Jira Graph: Open Graph for Project…</b> to pick a project.</p></div>`;
        overlay.classList.add('open');
      }
      void relayout({ fit: m.reason === 'init' && isNewSource });
      break;
    }
    case 'focus':
      revealKey(m.key);
      break;
  }
});

window.addEventListener('resize', () => drawMinimap());

syncToolbar();
setDrawerWidth(ui.drawerWidth ?? DRAWER_DEFAULT);
scopePanel = new ScopePanel({
  app,
  info: () => model?.scopeInfo,
  scopable: () => model?.source.kind === 'jql',
  apply: (scope) => post({ type: 'setScope', scope }),
});
filterPanel = new FilterPanel(
  {
    app,
    stage,
    issues: () => model?.issues ?? [],
    links: () => model?.links ?? [],
    filterCtx: () => ({
      typeKey: (i) => styleOf(i).key,
      stage: stageOfIssue,
      blocked: (k) => blocked.has(k),
      blocking: (k) => blockingKeys.has(k),
      critical: (k) => blockedBy.get(k) === 'critical',
      hasChildren: (k) => childrenOf.has(k),
    }),
    position: (k) => {
      const n = lay?.nodes.get(k);
      return n ? { x: n.x, y: n.y } : undefined;
    },
    typeInfo: (i) => ({ label: styleOf(i).label, icon: iconMarkup(styleOf(i), 14) }),
    typeInfoByKey: (typeKey) => {
      const i = model?.issues.find((x) => styleOf(x).key === typeKey);
      return i ? { label: styleOf(i).label, icon: iconMarkup(styleOf(i), 14) } : undefined;
    },
    stageOf: stageOfIssue,
    avatarColor,
    initials,
    selected: () => selected,
    navigate: (k) => revealKey(k),
    details: (k) => {
      revealKey(k);
      openDetails(k);
    },
    hover: (k) => {
      hovered = k;
      applyClasses();
    },
    changed: (relayoutNeeded) => {
      if (relayoutNeeded) void relayout();
      else applyClasses();
    },
    save: (prefs) => {
      ui.filterPrefs = prefs;
      saveState();
    },
  },
  ui.filterPrefs ?? {},
);
applyView();
showLoading('Loading…');
post({ type: 'ready' });
