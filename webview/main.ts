import type { GraphIssue, GraphLink, GraphModel, GraphSource, HostMessage, LinkCategory, ViewOptions, WebviewMessage } from '../src/shared/model';
import { UI_ICONS } from './icons';
import { GROUP_HEADER, layout, LayoutEdge, LayoutNode, LayoutResult, Point } from './layout';
import { dashArray, ICONS, iconMarkup, LINK_LABELS, PRIORITY, TypeStyle, TypeStyles } from './typeStyles';
import cssText from './styles.css';

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
let focus: { key: string; hops: number } | undefined;
let highlight: Set<string> | undefined;
const hiddenKeys = new Set<string>();
const collapsed = new Set<string>();
let searchText = '';
let matches: string[] = [];
let matchIdx = -1;
let blocked = new Set<string>();
let cycleEdges = new Set<string>();
let cycles: string[][] = [];
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
  <div class="spacer"></div>
  <label class="search"><input type="search" placeholder="Search key, title, assignee, label…" spellcheck="false" /><span class="count"></span></label>
  <div class="seg" data-opt="mode">
    <button data-v="edges" title="Hierarchy as edges">${UI_ICONS.tree}</button>
    <button data-v="nested" title="Hierarchy as nested containers">${UI_ICONS.nested}</button>
  </div>
  <div class="seg" data-opt="direction">
    <button data-v="DOWN" title="Top → bottom">${UI_ICONS.down}</button>
    <button data-v="RIGHT" title="Left → right">${UI_ICONS.right}</button>
  </div>
  <select data-opt="routing" title="Edge routing">
    <option value="ORTHOGONAL">Orthogonal</option>
    <option value="SPLINES">Splines</option>
    <option value="POLYLINE">Polyline</option>
  </select>
  <div class="group">
    <button class="toggle" data-toggle="showLabels" title="Link labels">${UI_ICONS.labels}</button>
    <button class="toggle" data-toggle="hideDone" title="Hide done issues">${UI_ICONS.done}</button>
    <button class="toggle" data-toggle="linksAffectLayout" title="Cross links shape the layout (off: hierarchy-only layout, links drawn on top)">${UI_ICONS.magnet}</button>
    <button class="toggle" data-toggle="minimap" title="Minimap">${UI_ICONS.minimap}</button>
  </div>
  <div class="group">
    <button data-action="collapseAll" title="Collapse to top level">${UI_ICONS.collapse}</button>
    <button data-action="expandAll" title="Expand all groups">${UI_ICONS.expand}</button>
  </div>
  <div class="group">
    <button data-action="zoomOut" title="Zoom out (-)">${UI_ICONS.zoomOut}</button>
    <button data-action="zoomReset" class="zoom-level" title="Reset zoom (0)">100%</button>
    <button data-action="zoomIn" title="Zoom in (+)">${UI_ICONS.zoomIn}</button>
    <button data-action="fit" title="Fit to screen (F)">${UI_ICONS.fit}</button>
  </div>
  <div class="group">
    <button data-action="export" title="Export">${UI_ICONS.export}</button>
    <button data-action="refresh" title="Reload from Jira">${UI_ICONS.refresh}</button>
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
  <canvas class="minimap" width="200" height="130"></canvas>
  <aside class="drawer"></aside>
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
const searchInput = $<HTMLInputElement>('.search input');

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | undefined> = {}, parent?: Element): SVGElementTagNameMap[K] {
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
  for (const l of m.links) {
    const a = byKey.get(l.from);
    const b = byKey.get(l.to);
    if (l.category === 'blocks' && a && b && a.statusCategory !== 'done' && b.statusCategory !== 'done') blocked.add(l.to);
  }
  ({ cycles, cycleEdges } = findCycles(m.links.filter((l) => l.category === 'blocks')));
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
  const shown = new Set(model.issues.filter(pass).map((i) => i.key));

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
  for (const l of model.links) {
    if (ui.hiddenLinks.includes(l.category)) continue;
    const from = rep(l.from);
    const to = rep(l.to);
    if (!from || !to || from === to) continue;
    if (from === l.from && to === l.to) {
      links.set(l.id, l);
      continue;
    }
    const id = `agg:${from}>${to}:${l.category}`;
    const prev = links.get(id);
    const n = prev ? Number(/×(\d+)$/.exec(prev.label)?.[1] ?? 1) + 1 : 1;
    links.set(id, { ...l, id, from, to, label: n > 1 ? `${l.label} ×${n}` : l.label });
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
    });
  } catch (e) {
    showError(`Layout failed: ${(e as Error).message ?? e}`);
    return;
  }
  if (token !== layoutToken) return;
  lay = result;
  render();
  renderLegend();
  renderBanner();
  renderStats();
  if (opts.fit || firstLayout) fit(!firstLayout);
  firstLayout = false;
  updateSearch(false);
  drawMinimap();
}

const nodeEls = new Map<string, SVGGElement>();

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
  for (const e of lay.edges) drawEdge(e);
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
  ].filter(Boolean).join(' '));
  g.style.setProperty('--type', s.color);

  const title = el('title', {}, g);
  title.textContent = `${i.key} · ${i.type} · ${i.status}\n${i.summary}${i.assignee ? `\n👤 ${i.assignee}` : ''}${i.loaded ? '' : '\n(not loaded — double-click to expand)'}`;

  el('rect', { class: 'g-select', x: -5, y: -5, width: w + 10, height: n.h + 10, rx: s.radius + 5 }, g);
  const dash = dashArray(s);
  if (n.group) {
    el('rect', { class: 'g-group-bg', width: w, height: n.h, rx: s.radius }, g);
    el('rect', { class: 'g-group-head', width: w, height: h, rx: s.radius }, g);
    el('line', { class: 'g-group-sep', x1: 0, x2: w, y1: h, y2: h }, g);
  } else {
    el('rect', { class: 'g-card', width: w, height: h, rx: s.radius }, g);
  }
  el('rect', { class: 'g-border', width: w, height: n.h, rx: s.radius, 'stroke-width': s.width, 'stroke-dasharray': dash }, g);
  if (s.border === 'double') {
    el('rect', { class: 'g-border', x: 3.5, y: 3.5, width: w - 7, height: n.h - 7, rx: Math.max(0, s.radius - 3), 'stroke-width': s.width }, g);
  }

  // Header row: [icon] KEY [priority]            [avatar] [STATUS]
  const iconG = el('g', { class: 'g-icon', transform: 'translate(12 11) scale(1.25)' }, g);
  iconG.style.color = s.color;
  el('rect', { width: 16, height: 16, rx: 3.5, fill: s.color }, iconG);
  iconG.insertAdjacentHTML('beforeend', ICONS[s.icon]);

  const key = el('text', { class: 'g-key', x: 40, y: 26 }, g);
  key.textContent = i.key;
  let cursor = 40 + measure(i.key, `600 12.5px ${fontFamily}`) + 6;

  const pr = i.priority ? PRIORITY[i.priority.toLowerCase()] : undefined;
  if (pr) {
    const p = el('path', { class: 'g-priority', d: pr.path, transform: `translate(${cursor} 15)`, stroke: pr.color }, g);
    el('title', {}, p).textContent = `Priority: ${i.priority}`;
    cursor += 16;
  }

  let right = w - 12;
  if (i.status) {
    const text = i.status.length > 16 ? `${i.status.slice(0, 15)}…` : i.status;
    const tw = measure(text.toUpperCase(), `700 10px ${fontFamily}`) + 14;
    const pill = el('g', { class: `g-status st-${i.statusCategory}`, transform: `translate(${right - tw} 11)` }, g);
    el('rect', { width: tw, height: 18, rx: 4 }, pill);
    el('text', { x: tw / 2, y: 12.5 }, pill).textContent = text.toUpperCase();
    right -= tw + 6;
  }
  if (i.assignee && right - 20 > cursor) {
    const av = el('g', { class: 'g-avatar', transform: `translate(${right - 10} 20)` }, g);
    el('circle', { r: 10, fill: avatarColor(i.assignee) }, av);
    el('text', { y: 3.6 }, av).textContent = initials(i.assignee);
    el('title', {}, av).textContent = i.assignee;
  }

  // Summary (HTML for wrapping + ellipsis)
  const lines = n.group || s.size === 'small' ? 1 : 2;
  const fo = el('foreignObject', { x: 12, y: 36, width: w - 24, height: lines * 17 + 2 }, g);
  const div = document.createElementNS(XHTML, 'div') as HTMLDivElement;
  div.className = `g-summary lines-${lines}${i.summary ? '' : ' empty'}`;
  div.textContent = i.summary || 'Not loaded — double-click to expand';
  fo.appendChild(div);

  // Badges
  if (blocked.has(i.key)) {
    const b = el('g', { class: 'g-badge blocked', transform: `translate(${w - 2} -2)` }, g);
    el('circle', { r: 9 }, b);
    el('rect', { x: -4.5, y: -1.4, width: 9, height: 2.8, rx: 1 }, b);
    el('title', {}, b).textContent = 'Blocked by an unresolved issue';
  }
  const kids = childrenOf.get(i.key)?.length ?? 0;
  if (kids) {
    const isCollapsed = collapsed.has(i.key);
    const label = isCollapsed ? `▸ ${kids}` : `▾ ${kids}`;
    const tw = measure(label, `600 10.5px ${fontFamily}`) + 14;
    const [tx, ty] = n.group ? [w - tw - 12, GROUP_HEADER - 11] : ui.direction === 'DOWN' ? [w / 2 - tw / 2, n.h - 9] : [w - tw / 2 - 9, n.h / 2 - 9];
    const t = el('g', { class: `g-toggle${isCollapsed ? ' collapsed' : ''}`, transform: `translate(${tx} ${ty})` }, g);
    el('rect', { width: tw, height: 18, rx: 9 }, t);
    el('text', { x: tw / 2, y: 12.6 }, t).textContent = label;
    el('title', {}, t).textContent = isCollapsed ? `Expand ${kids} children` : `Collapse ${kids} children`;
  }
  if (!i.loaded) {
    const x = el('g', { class: 'g-expand', transform: `translate(${w} ${h / 2})` }, g);
    el('circle', { r: 10 }, x);
    el('path', { d: 'M-4.5 0h9M0-4.5v9' }, x);
    el('title', {}, x).textContent = 'Load this issue and its relations';
  }
}

function drawEdge(e: LayoutEdge) {
  const d = e.spline ? splinePath(e.points) : roundedPath(e.points, 8);
  const g = el('g', { class: `g-edge k-${e.kind}${cycleEdges.has(e.id) ? ' cycle' : ''}${e.id.startsWith('l:agg:') ? ' agg' : ''}`, 'data-from': e.from, 'data-to': e.to }, layers.edges);
  el('path', { class: 'hit', d }, g);
  el('path', { class: 'line', d, 'marker-end': e.kind === 'relates' ? undefined : `url(#m-${e.kind})` }, g);
  el('title', {}, g).textContent = e.kind === 'hierarchy' ? `${e.from} is parent of ${e.to}` : `${e.from} ${e.label} ${e.to}`;
  if (e.labelPos && e.label) {
    const lw = measure(e.label) + 10;
    const lg = el('g', { class: `g-elabel k-${e.kind}`, transform: `translate(${e.labelPos.x} ${e.labelPos.y})`, 'data-from': e.from, 'data-to': e.to }, layers.labels);
    el('rect', { x: -lw / 2, y: -8, width: lw, height: 16, rx: 8 }, lg);
    el('text', { y: 3.8 }, lg).textContent = e.label;
  }
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

function applyClasses() {
  const related = new Set<string>();
  const focusKey = hovered ?? selected;
  if (focusKey) {
    related.add(focusKey);
    layers.edges.querySelectorAll<SVGGElement>('.g-edge').forEach((e) => {
      const hit = e.dataset.from === focusKey || e.dataset.to === focusKey;
      e.classList.toggle('hl', hit);
      if (hit) related.add(e.dataset.from!), related.add(e.dataset.to!);
    });
    layers.labels.querySelectorAll<SVGGElement>('.g-elabel').forEach((e) =>
      e.classList.toggle('hl', e.dataset.from === focusKey || e.dataset.to === focusKey),
    );
  } else {
    layers.edges.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'));
    layers.labels.querySelectorAll('.hl').forEach((e) => e.classList.remove('hl'));
  }
  const spot = highlight ?? (searchText ? new Set(matches) : undefined);
  for (const [k, g] of nodeEls) {
    g.classList.toggle('selected', k === selected);
    g.classList.toggle('hl', related.has(k));
    g.classList.toggle('match', !!spot?.has(k));
  }
  svg.classList.toggle('hovering', !!hovered);
  svg.classList.toggle('spotlight', !!spot);
}

function select(key: string | undefined, opts: { center?: boolean; notify?: boolean } = {}) {
  selected = key;
  applyClasses();
  renderDrawer();
  if (key && opts.center) centerOn(key);
  if (opts.notify !== false) post({ type: 'select', key });
}

// ── View transform ──────────────────────────────────────────────────────────
function applyView() {
  viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  $<HTMLButtonElement>('.zoom-level').textContent = `${Math.round(view.k * 100)}%`;
  svg.classList.toggle('far', view.k < 0.45);
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
  const left = ui.legendOpen && legend.offsetWidth ? legend.offsetWidth + 12 : 0;
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
const keyAt = (t: EventTarget | null) => (t as Element | null)?.closest?.<SVGGElement>('.g-node')?.dataset.key;

svg.addEventListener('pointerdown', (e) => {
  hideMenu();
  if (e.button !== 0 || keyAt(e.target)) return;
  pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  svg.setPointerCapture(e.pointerId);
  svg.classList.add('panning');
});
svg.addEventListener('pointermove', (e) => {
  if (!pan) return;
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
  view.x = pan.vx + dx;
  view.y = pan.vy + dy;
  anim++;
  applyView();
});
svg.addEventListener('pointerup', (e) => {
  if (pan && !pan.moved && !keyAt(e.target)) {
    highlight = undefined;
    select(undefined);
  }
  pan = undefined;
  svg.classList.remove('panning');
});
svg.addEventListener('wheel', (e) => {
  e.preventDefault();
  anim++;
  if (e.ctrlKey || e.metaKey || e.deltaMode === 1) {
    const r = svg.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0035)), e.clientX - r.left, e.clientY - r.top);
  } else {
    view.x -= e.deltaX;
    view.y -= e.deltaY;
    applyView();
  }
}, { passive: false });

svg.addEventListener('click', (e) => {
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
});
svg.addEventListener('pointerleave', () => {
  hovered = undefined;
  applyClasses();
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
    { label: 'Open in Jira', icon: UI_ICONS.open, hint: 'dbl-click', run: () => post({ type: 'openIssue', key }) },
    { label: i.loaded ? 'Load more relations' : 'Load issue & relations', icon: UI_ICONS.plus, hint: 'E', run: () => post({ type: 'expand', keys: [key] }) },
    'sep',
    { label: 'Focus neighbourhood', icon: UI_ICONS.focus, run: () => setFocus(key, focus?.hops ?? 2) },
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
  menu.classList.remove('open');
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
function renderDrawer() {
  const i = selected ? byKey.get(selected) : undefined;
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
    ${blocked.has(i.key) ? `<div class="d-alert">${UI_ICONS.warn}<span>Blocked by an unresolved issue</span></div>` : ''}
    <dl class="d-grid">
      <dt>Status</dt><dd><span class="pill st-${i.statusCategory}">${esc(i.status || '—')}</span></dd>
      <dt>Priority</dt><dd>${esc(i.priority ?? '—')}</dd>
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
  drawer.querySelector('.d-close')!.addEventListener('click', () => select(undefined));
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
      return `<button class="row${off ? ' off' : ''}" data-type="${esc(s.key)}" title="Click to ${off ? 'show' : 'hide'}">${iconMarkup(s, 16)}${borderSample(s)}<span>${esc(s.label)}</span><em>${count}</em></button>`;
    })
    .join('');
  const rows: string[] = [];
  if (ui.mode === 'edges' && hierarchyCount) {
    rows.push(`<button class="row${ui.showHierarchy ? '' : ' off'}" data-hier="1">${lineSample('hierarchy')}<span>${LINK_LABELS.hierarchy}</span><em>${hierarchyCount}</em></button>`);
  }
  for (const k of ['blocks', 'relates', 'duplicates', 'clones', 'other'] as LinkCategory[]) {
    const c = linkCounts.get(k);
    if (!c) continue;
    const off = ui.hiddenLinks.includes(k);
    rows.push(`<button class="row${off ? ' off' : ''}" data-link="${k}">${lineSample(k)}<span>${LINK_LABELS[k]}</span><em>${c}</em></button>`);
  }

  legend.classList.toggle('collapsed', !ui.legendOpen);
  legend.innerHTML = `
    <button class="legend-head">Legend <span>${ui.legendOpen ? '▾' : '▸'}</span></button>
    <div class="legend-body">
      <h5>Issue types</h5>${typeRows}
      ${rows.length ? `<h5>Relations</h5>${rows.join('')}` : ''}
      <h5>Status</h5>
      <div class="statuses"><span class="pill st-new">To do</span><span class="pill st-indeterminate">In progress</span><span class="pill st-done">Done</span></div>
      <div class="badges"><span class="badge-blocked"></span> blocked <span class="badge-stub"></span> not loaded</div>
      <p class="help">Drag / scroll to pan · ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+scroll or pinch to zoom · double-click opens · right-click for actions · <kbd>/</kbd> search · <kbd>F</kbd> fit · arrows move selection</p>
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
  if (model.truncated) parts.push(`<span class="warn">${UI_ICONS.warn} Truncated at ${model.issues.filter((i) => i.loaded).length} loaded issues (jiraGraph.maxIssues)</span>`);
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
}

// ── Search ──────────────────────────────────────────────────────────────────
function updateSearch(jump: boolean) {
  searchText = searchInput.value.trim().toLowerCase();
  if (!searchText || !model) {
    matches = [];
    $<HTMLElement>('.search .count').textContent = '';
  } else {
    const terms = searchText.split(/\s+/);
    matches = visible.issues
      .filter((i) => {
        const hay = `${i.key} ${i.summary} ${i.assignee ?? ''} ${i.status} ${i.type} ${i.labels.join(' ')}`.toLowerCase();
        return terms.every((t) => hay.includes(t));
      })
      .map((i) => i.key);
    if (matchIdx >= matches.length) matchIdx = -1;
    $<HTMLElement>('.search .count').textContent = matches.length ? `${matchIdx + 1 || '–'}/${matches.length}` : '0';
    if (jump && matches.length) {
      matchIdx = (matchIdx + 1) % matches.length;
      $<HTMLElement>('.search .count').textContent = `${matchIdx + 1}/${matches.length}`;
      select(matches[matchIdx], { center: true });
    }
  }
  applyClasses();
}

searchInput.addEventListener('input', () => {
  matchIdx = -1;
  updateSearch(false);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') updateSearch(true);
  if (e.key === 'Escape') {
    searchInput.value = '';
    updateSearch(false);
    searchInput.blur();
  }
});

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
      ctx.globalAlpha = n.group ? 0.18 : n.key === selected ? 1 : 0.75;
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
  $<HTMLSelectElement>('select[data-opt="routing"]').value = ui.routing;
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
$<HTMLSelectElement>('select[data-opt="routing"]').addEventListener('change', (e) => {
  ui.routing = (e.target as HTMLSelectElement).value as UiState['routing'];
  saveState();
  void relayout();
});
app.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) =>
  b.addEventListener('click', () => {
    const k = b.dataset.toggle as 'showLabels' | 'hideDone' | 'linksAffectLayout' | 'minimap';
    ui[k] = !ui[k];
    saveState();
    syncToolbar();
    if (k === 'minimap') drawMinimap();
    else void relayout({ fit: k === 'linksAffectLayout' });
  }),
);
app.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) =>
  b.addEventListener('click', (e) => {
    const a = b.dataset.action;
    if (a === 'zoomIn') zoomAt(1.25);
    if (a === 'zoomOut') zoomAt(0.8);
    if (a === 'zoomReset') zoomAt(1 / view.k);
    if (a === 'fit') fit();
    if (a === 'refresh') post({ type: 'refresh' });
    if (a === 'collapseAll') {
      // Collapsing every parent gives progressive disclosure: expanding one level reveals collapsed children.
      for (const k of childrenOf.keys()) collapsed.add(k);
      void relayout({ fit: true });
    }
    if (a === 'expandAll') {
      collapsed.clear();
      void relayout({ fit: true });
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
    searchInput.focus();
    searchInput.select();
  } else if (e.key === 'f' || e.key === 'F') fit();
  else if (e.key === '+' || e.key === '=') zoomAt(1.2);
  else if (e.key === '-') zoomAt(1 / 1.2);
  else if (e.key === '0') zoomAt(1 / view.k);
  else if (e.key === 'Escape') {
    hideMenu();
    if (highlight) (highlight = undefined), applyClasses();
    else if (selected) select(undefined);
    else if (focus) setFocus(undefined);
  } else if (selected && (e.key === 'e' || e.key === 'E')) post({ type: 'expand', keys: [selected] });
  else if (selected && (e.key === 'h' || e.key === 'H')) hideKey(selected);
  else if (selected && e.key === 'Enter') post({ type: 'openIssue', key: selected });
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
    case 'graph': {
      app.classList.remove('busy');
      overlay.classList.remove('open');
      const isNewSource = !model || JSON.stringify(model.source) !== JSON.stringify(m.model.source);
      model = m.model;
      persisted.source = m.model.source;
      styles = new TypeStyles(m.options.typeStyles);
      if (uiFromHost) {
        ui.direction = m.options.direction;
        ui.mode = m.options.hierarchyMode;
        ui.routing = m.options.edgeRouting;
        uiFromHost = false;
      }
      saveState();
      indexModel(model);
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
applyView();
showLoading('Loading…');
post({ type: 'ready' });
