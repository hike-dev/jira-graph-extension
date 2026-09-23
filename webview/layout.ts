import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { GraphIssue, GraphLink, LinkCategory, ViewOptions } from '../src/shared/model';
import type { TypeStyle } from './typeStyles';

export interface Point {
  x: number;
  y: number;
}

export interface LayoutNode {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Compound node that contains its children (nested mode). */
  group: boolean;
  depth: number;
}

export interface LayoutEdge {
  id: string;
  kind: LinkCategory | 'hierarchy';
  from: string;
  to: string;
  label?: string;
  points: Point[];
  labelPos?: Point;
  spline: boolean;
}

export interface LayoutFrame {
  /** Parent whose packed children the frame surrounds; empty for the "no parent" grid. */
  parent: string;
  label?: string;
  /** Fan cluster: synthetic id used as the endpoint of its bundled edge, and the tickets inside. */
  id?: string;
  members?: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutResult {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  /** Tree mode: frames around children packed into a grid under their parent. */
  frames: LayoutFrame[];
  width: number;
  height: number;
}

export interface LayoutInput {
  issues: GraphIssue[];
  links: GraphLink[];
  styleOf: (i: GraphIssue) => TypeStyle;
  measure: (text: string) => number;
  direction: ViewOptions['direction'];
  mode: ViewOptions['hierarchyMode'];
  routing: ViewOptions['edgeRouting'];
  showHierarchy: boolean;
  showLabels: boolean;
  /**
   * When true, dependency ("blocks") links shape node placement. Other link types, and large
   * fan-ins, are always drawn on top so they cannot stretch a layer into a very long row.
   */
  linksAffectLayout: boolean;
  /**
   * explicit — every relation shapes the layout and nothing is packed (full relations overview).
   * hybrid   — every relation shapes the layout; only tickets without any relation are packed.
   * compact  — only dependencies shape the layout; fan-ins and unconnected tickets are packed.
   */
  strategy?: LayoutStrategy;
  /** Ids of the links fed to ELK (computed by `layout`). */
  elkLinks?: Set<string>;
}

export type LayoutStrategy = 'explicit' | 'hybrid' | 'compact';

export const GROUP_HEADER = 64;
const PAD = 14;

export function nodeSize(style: TypeStyle): { w: number; h: number } {
  if (style.size === 'large') return { w: 280, h: 84 };
  if (style.size === 'small') return { w: 220, h: 60 };
  return { w: 256, h: 78 };
}

const elk = new ELK();

type EdgeMeta = Omit<LayoutEdge, 'points' | 'labelPos' | 'spline'>;
type Part = LayoutResult & { overlay: EdgeMeta[]; lone?: boolean };

/** A node with more than this many single-link neighbours draws those links as overlays. */
const FAN = 6;
/** Containers with at least this many unconnected leaves pack them into a grid. */
const GRID_MIN = 6;

function pickLayoutLinks(input: LayoutInput): Set<string> {
  if (!input.linksAffectLayout) return new Set();
  const keys = new Set(input.issues.map((i) => i.key));
  if ((input.strategy ?? 'hybrid') !== 'compact') {
    // Explicit relations: every visible link takes part in the layout.
    return new Set(input.links.filter((l) => l.from !== l.to && keys.has(l.from) && keys.has(l.to)).map((l) => l.id));
  }
  const hasChildren = new Set(input.issues.map((i) => i.parentKey).filter((k): k is string => !!k && keys.has(k)));
  const byKey = new Map(input.issues.map((i) => [i.key, i]));
  const top = (k: string) => {
    const seen = new Set<string>();
    for (let p = byKey.get(k)?.parentKey; p && keys.has(p) && !seen.has(p); p = byKey.get(p)?.parentKey) seen.add(p), (k = p);
    return k;
  };
  // Compact, nested mode: containers are the structure, so only links inside one top-level container shape
  // the layout; links between containers are overlays and each container packs independently.
  const cand = input.links.filter(
    (l) => l.category === 'blocks' && l.from !== l.to && keys.has(l.from) && keys.has(l.to) && (input.mode !== 'nested' || top(l.from) === top(l.to)),
  );
  const degree = new Map<string, number>();
  for (const l of cand) for (const k of [l.from, l.to]) degree.set(k, (degree.get(k) ?? 0) + 1);
  const isLeaf = (k: string) => degree.get(k) === 1 && !hasChildren.has(k);
  const fans = new Map<string, string[]>();
  for (const l of cand) {
    for (const [hub, leaf] of [[l.from, l.to], [l.to, l.from]]) {
      if (!isLeaf(leaf) || isLeaf(hub)) continue;
      if (!fans.has(hub)) fans.set(hub, []);
      fans.get(hub)!.push(l.id);
    }
  }
  const dropped = new Set([...fans.values()].filter((ids) => ids.length > FAN).flat());
  return new Set(cand.filter((l) => !dropped.has(l.id)).map((l) => l.id));
}

export async function layout(raw: LayoutInput): Promise<LayoutResult> {
  const input = { ...raw, elkLinks: pickLayoutLinks(raw) };
  // ELK does not separate connected components under INCLUDE_CHILDREN, so for nested mode
  // lay out each component on its own and shelf-pack them. (Packed nested mode needs no split.)
  const parts = input.mode === 'nested' && input.linksAffectLayout ? await Promise.all(components(input).map(async (c) => ({ ...(await layoutPart({ ...input, ...c })), lone: c.lone }))) : [await layoutPart(input)];
  const merged = pack(parts);
  const seen = new Set<string>();
  for (const m of parts.flatMap((p) => p.overlay)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const a = merged.nodes.get(m.from);
    const b = merged.nodes.get(m.to);
    if (!a || !b) continue;
    const pts = overlayCurve(a, b);
    merged.edges.push({ ...m, points: pts, labelPos: input.showLabels ? bezierMid(pts) : undefined, spline: true });
  }
  return merged;
}

function components(input: LayoutInput): { issues: GraphIssue[]; links: GraphLink[]; lone: boolean }[] {
  const byKey = new Map(input.issues.map((i) => [i.key, i]));
  const top = (k: string) => {
    const seen = new Set<string>();
    let t = k;
    for (let p = byKey.get(t)?.parentKey; p && byKey.has(p) && !seen.has(p); p = byKey.get(p)?.parentKey) seen.add(p), (t = p);
    return t;
  };
  const uf = new Map<string, string>();
  const find = (k: string): string => {
    const p = uf.get(k) ?? k;
    if (p === k) return k;
    const r = find(p);
    uf.set(k, r);
    return r;
  };
  for (const l of input.links) {
    if (input.elkLinks?.has(l.id) && byKey.has(l.from) && byKey.has(l.to)) uf.set(find(top(l.from)), find(top(l.to)));
  }
  const groups = new Map<string, GraphIssue[]>();
  for (const i of input.issues) {
    const r = find(top(i.key));
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }
  // Lone tickets go into one shared part, where the leaf grid packs them together
  // (explicit keeps each one as its own component, as before).
  const parents = new Set(input.issues.map((i) => i.parentKey).filter(Boolean));
  const lone = input.strategy === 'explicit' ? [] : [...groups.values()].filter((g) => g.length === 1 && !parents.has(g[0].key)).flat();
  const parts = [...groups.values()].filter((g) => !(g.length === 1 && !parents.has(g[0].key)));
  if (lone.length) parts.push(lone);
  return parts.map((issues) => {
    const isLone = issues === lone;
    const keys = new Set(issues.map((i) => i.key));
    // Links spanning components (only when links do not affect layout) are drawn as overlays after packing.
    return { issues, lone: isLone, links: input.links.filter((l) => keys.has(l.from) || keys.has(l.to)) };
  });
}

const GAP = 56;

function pack(parts: Part[]): LayoutResult {
  if (parts.length === 1) return parts[0];
  const area = parts.reduce((a, p) => a + (p.width + GAP) * (p.height + GAP), 0);
  const maxW = Math.max(Math.sqrt(area * 1.6), ...parts.map((p) => p.width));
  const sorted = [...parts].sort((a, b) => Number(!!a.lone) - Number(!!b.lone) || b.height - a.height);
  const nodes = new Map<string, LayoutNode>();
  const edges: LayoutEdge[] = [];
  const frames: LayoutFrame[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let width = 0;
  for (const p of sorted) {
    if (x > 0 && x + p.width > maxW) (x = 0), (y += rowH + GAP), (rowH = 0);
    for (const n of p.nodes.values()) nodes.set(n.key, { ...n, x: n.x + x, y: n.y + y });
    for (const e of p.edges) {
      edges.push({
        ...e,
        points: e.points.map((pt) => ({ x: pt.x + x, y: pt.y + y })),
        labelPos: e.labelPos && { x: e.labelPos.x + x, y: e.labelPos.y + y },
      });
    }
    for (const f of p.frames) frames.push({ ...f, x: f.x + x, y: f.y + y });
    width = Math.max(width, x + p.width);
    rowH = Math.max(rowH, p.height);
    x += p.width + GAP;
  }
  return { nodes, edges, frames, width, height: y + rowH };
}

async function layoutPart(input: LayoutInput): Promise<Part> {
  const { issues, links, styleOf, direction, mode } = input;
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const parentOf = (k: string) => {
    const p = byKey.get(k)?.parentKey;
    return p && byKey.has(p) && p !== k ? p : undefined;
  };

  const rootOptions: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': direction,
    'elk.edgeRouting': input.routing,
    'elk.spacing.nodeNode': '28',
    'elk.spacing.edgeNode': '16',
    'elk.spacing.edgeEdge': '10',
    'elk.spacing.componentComponent': '56',
    'elk.spacing.edgeLabel': '4',
    'elk.layered.spacing.nodeNodeBetweenLayers': '68',
    'elk.layered.spacing.edgeNodeBetweenLayers': '18',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.mergeEdges': 'false',
    'elk.edgeLabels.inline': 'true',
    'elk.separateConnectedComponents': 'true',
    'elk.json.shapeCoords': 'ROOT',
    'elk.json.edgeCoords': 'ROOT',
  };

  // ── Nodes ────────────────────────────────────────────────────────────────
  const groups = new Set<string>();
  if (mode === 'nested') for (const i of issues) {
    const p = parentOf(i.key);
    if (p) groups.add(p);
  }
  const depthOf = (k: string): number => {
    let d = 0;
    for (let p = parentOf(k); p && mode === 'nested'; p = parentOf(p)) d++;
    return d;
  };

  const elkNodes = new Map<string, ElkNode>();
  for (const i of issues) {
    const s = nodeSize(styleOf(i));
    const n: ElkNode = groups.has(i.key)
      ? {
          id: i.key,
          children: [],
          layoutOptions: {
            'elk.padding': `[top=${GROUP_HEADER + PAD},left=${PAD},bottom=${PAD},right=${PAD}]`,
          },
        }
      : { id: i.key, width: s.w, height: s.h };
    elkNodes.set(i.key, n);
  }
  const root: ElkNode = { id: '__root', layoutOptions: rootOptions, children: [], edges: [] };
  // Nested + "links shape layout": one hierarchical layered run so ELK routes edges across containers.
  // Nested without it: each container packs its children compactly and links are drawn as overlays.
  const packed = mode === 'nested' && !input.linksAffectLayout;
  if (mode === 'nested') rootOptions['elk.hierarchyHandling'] = packed ? 'SEPARATE_CHILDREN' : 'INCLUDE_CHILDREN';
  if (packed) {
    const rect = { 'elk.algorithm': 'rectpacking', 'elk.aspectRatio': '1.6', 'elk.spacing.nodeNode': '22' };
    Object.assign(rootOptions, rect, { 'elk.spacing.nodeNode': '48' });
    for (const k of groups) Object.assign(elkNodes.get(k)!.layoutOptions!, rect);
  }
  for (const i of issues) {
    const p = mode === 'nested' ? parentOf(i.key) : undefined;
    (p ? elkNodes.get(p)! : root).children!.push(elkNodes.get(i.key)!);
  }

  // ── Edges ────────────────────────────────────────────────────────────────
  const isAncestor = (a: string, b: string) => {
    for (let p = parentOf(b); p; p = parentOf(p)) if (p === a) return true;
    return false;
  };
  const meta = new Map<string, EdgeMeta>();
  const overlay: EdgeMeta[] = [];
  const label = (text: string) =>
    input.showLabels ? [{ text, width: input.measure(text) + 10, height: 16 }] : undefined;

  const gridOptions = (aspect: string) => ({
    'elk.hierarchyHandling': 'SEPARATE_CHILDREN',
    'elk.algorithm': 'rectpacking',
    'elk.aspectRatio': aspect,
    'elk.spacing.nodeNode': '20',
    'elk.padding': '[top=0,left=0,bottom=0,right=0]',
  });
  const strategy = input.strategy ?? 'hybrid';
  const grids = strategy !== 'explicit';
  // Hybrid packs only tickets without any relation; compact also packs tickets whose relations are overlays.
  const related = new Set(
    (strategy === 'hybrid' ? links : links.filter((l) => input.elkLinks?.has(l.id))).flatMap((l) => [l.from, l.to]),
  );
  const hierarchyGrids = new Set<string>();
  if (mode === 'edges' && input.showHierarchy) {
    const kids = new Map<string, string[]>();
    for (const i of issues) {
      const p = parentOf(i.key);
      if (p) kids.set(p, [...(kids.get(p) ?? []), i.key]);
    }
    const hierEdge = (from: string, to: string, meta: EdgeMeta) => {
      meta && root.edges!.push({
        id: meta.id,
        sources: [from],
        targets: [to],
        layoutOptions: { 'elk.layered.priority.direction': '10', 'elk.layered.priority.shortness': '10', 'elk.layered.priority.straightness': '5' },
      });
    };
    for (const [p, list] of kids) {
      // Many childless, unlinked children would form one very long row: pack them under a single connector.
      const leaves = list.filter((k) => !kids.has(k) && !related.has(k));
      const packKids = grids && leaves.length >= GRID_MIN ? new Set(leaves) : new Set<string>();
      for (const k of list) {
        if (packKids.has(k)) continue;
        const id = `h:${p}>${k}`;
        const m: EdgeMeta = { id, kind: 'hierarchy', from: p, to: k };
        meta.set(id, m);
        hierEdge(p, k, m);
      }
      if (!packKids.size) continue;
      const gid = `__grid:${p}`;
      hierarchyGrids.add(gid);
      const moved = root.children!.filter((n) => packKids.has(n.id));
      root.children = [...root.children!.filter((n) => !packKids.has(n.id)), { id: gid, children: moved, layoutOptions: gridOptions('2.4') }];
      const m: EdgeMeta = { id: `h:${p}>${gid}`, kind: 'hierarchy', from: p, to: gid };
      meta.set(m.id, m);
      hierEdge(p, gid, m);
    }
  }
  // ── Hybrid fan clusters: many tickets whose only relation is the same link to one hub are packed
  // into a framed cluster joined to the hub by one bundled edge ("relates to ×40"). ──
  const bundled = new Set<string>();
  const fanFrames = new Map<string, { hub: string; label: string; members: string[] }>();
  if (strategy === 'hybrid' && input.linksAffectLayout) {
    const inLayout = links.filter((l) => l.from !== l.to && byKey.has(l.from) && byKey.has(l.to) && input.elkLinks?.has(l.id));
    const degree = new Map<string, number>();
    for (const l of inLayout) for (const k of [l.from, l.to]) degree.set(k, (degree.get(k) ?? 0) + 1);
    const hasKids = new Set(issues.map((i) => parentOf(i.key)).filter((k): k is string => !!k));
    const treeBound = (k: string) => mode === 'edges' && input.showHierarchy && (!!parentOf(k) || hasKids.has(k));
    const leafOk = (k: string) => degree.get(k) === 1 && !groups.has(k) && !hasKids.has(k) && !treeBound(k);
    const buckets = new Map<string, { hub: string; leafIsSource: boolean; container: string; label: string; category: LinkCategory; links: GraphLink[] }>();
    for (const l of inLayout) {
      for (const [leaf, hub, leafIsSource] of [[l.from, l.to, true], [l.to, l.from, false]] as const) {
        if (!leafOk(leaf) || leafOk(hub)) continue;
        const container = mode === 'nested' ? parentOf(leaf) ?? '__root' : '__root';
        const id = `${hub}|${l.category}|${leafIsSource}|${container}`;
        if (!buckets.has(id)) buckets.set(id, { hub, leafIsSource, container, label: l.label, category: l.category, links: [] });
        buckets.get(id)!.links.push(l);
      }
    }
    let n = 0;
    for (const b of buckets.values()) {
      if (b.links.length <= FAN) continue;
      const gid = `__fan:${n++}`;
      const members = b.links.map((l) => (b.leafIsSource ? l.from : l.to));
      const memberSet = new Set(members);
      const container = b.container === '__root' ? root : elkNodes.get(b.container)!;
      const moved = container.children!.filter((c) => memberSet.has(c.id));
      container.children = [...container.children!.filter((c) => !memberSet.has(c.id)), { id: gid, children: moved, layoutOptions: gridOptions('1.8') }];
      b.links.forEach((l) => bundled.add(l.id));
      const text = `${b.label} ×${members.length}`;
      const m: EdgeMeta = { id: `l:${gid}`, kind: b.category, from: b.leafIsSource ? gid : b.hub, to: b.leafIsSource ? b.hub : gid, label: text };
      meta.set(m.id, m);
      root.edges!.push({ id: m.id, sources: [m.from], targets: [m.to], labels: label(text) });
      fanFrames.set(gid, { hub: b.hub, label: `${members.length} × ${b.leafIsSource ? `${b.label} ${b.hub}` : `${b.hub} ${b.label}`}`, members });
    }
  }

  for (const l of links) {
    if (l.from === l.to || bundled.has(l.id)) continue;
    const m = { id: `l:${l.id}`, kind: l.category, from: l.from, to: l.to, label: l.label };
    // Links reaching into another component are drawn as overlays once all parts are packed.
    if (!byKey.has(l.from) || !byKey.has(l.to)) {
      overlay.push(m);
      continue;
    }
    const nestedConflict = mode === 'nested' && (isAncestor(l.from, l.to) || isAncestor(l.to, l.from));
    if (!input.elkLinks?.has(l.id) || nestedConflict) {
      overlay.push(m);
      continue;
    }
    meta.set(m.id, m);
    const e: ElkExtendedEdge = { id: m.id, sources: [l.from], targets: [l.to], labels: label(l.label) };
    root.edges!.push(e);
  }

  // ── Grids: unconnected leaves are rect-packed instead of stretching a single layer ──
  if (!packed && grids) {
    const touched = new Set([...root.edges!.flatMap((e) => [...e.sources, ...e.targets]), ...related]);
    const statusRank = { indeterminate: 0, new: 1, done: 2 } as const;
    const sizeRank = { large: 0, normal: 1, small: 2 } as const;
    const order = (a: ElkNode, b: ElkNode) => {
      const ia = byKey.get(a.id)!;
      const ib = byKey.get(b.id)!;
      return (
        sizeRank[styleOf(ia).size] - sizeRank[styleOf(ib).size] ||
        statusRank[ia.statusCategory] - statusRank[ib.statusCategory] ||
        ia.key.localeCompare(ib.key, undefined, { numeric: true })
      );
    };
    for (const c of [root, ...[...groups].map((k) => elkNodes.get(k)!)]) {
      const leaves = c.children!.filter((n) => !n.children && !touched.has(n.id)).sort(order);
      if (leaves.length < GRID_MIN) continue;
      const set = new Set(leaves);
      c.children = [
        ...c.children!.filter((n) => !set.has(n)),
        {
          id: `__grid:${c.id}`,
          children: leaves,
          layoutOptions: gridOptions(c === root ? '1.6' : '2.2'),
        },
      ];
    }
  }

  const out = await elk.layout(root);

  // ── Collect ──────────────────────────────────────────────────────────────
  const nodes = new Map<string, LayoutNode>();
  const frames: LayoutFrame[] = [];
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
      if (c.id.startsWith('__fan:')) {
        const f = fanFrames.get(c.id)!;
        frames.push({ parent: f.hub, id: c.id, members: f.members, label: f.label, x: (c.x ?? 0) - 12, y: (c.y ?? 0) - 34, w: (c.width ?? 0) + 24, h: (c.height ?? 0) + 46 });
        walk(c);
        continue;
      }
      if (c.id.startsWith('__grid:')) {
        if (hierarchyGrids.has(c.id)) {
          frames.push({ parent: c.id.slice('__grid:'.length), x: (c.x ?? 0) - 10, y: (c.y ?? 0) - 10, w: (c.width ?? 0) + 20, h: (c.height ?? 0) + 20 });
        } else if (c.id === '__grid:__root') {
          const n = c.children?.length ?? 0;
          frames.push({ parent: '', label: `${strategy === 'hybrid' ? 'No relations' : 'Unconnected'} · ${n}`, x: (c.x ?? 0) - 12, y: (c.y ?? 0) - 34, w: (c.width ?? 0) + 24, h: (c.height ?? 0) + 46 });
        }
        walk(c);
        continue;
      }
      nodes.set(c.id, {
        key: c.id,
        x: c.x ?? 0,
        y: c.y ?? 0,
        w: c.width ?? 0,
        h: c.height ?? 0,
        group: groups.has(c.id),
        depth: depthOf(c.id),
      });
      walk(c);
    }
  };
  walk(out);

  const edges: LayoutEdge[] = [];
  const collectEdges = (n: ElkNode) => {
    for (const e of (n.edges ?? []) as ElkExtendedEdge[]) {
      const m = meta.get(e.id);
      const sec = e.sections?.[0];
      if (!m || !sec) continue;
      const lbl = e.labels?.[0];
      edges.push({
        ...m,
        points: [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint],
        labelPos: lbl && lbl.x !== undefined ? { x: lbl.x + (lbl.width ?? 0) / 2, y: lbl.y! + (lbl.height ?? 0) / 2 } : undefined,
        spline: input.routing === 'SPLINES',
      });
    }
    (n.children ?? []).forEach(collectEdges);
  };
  collectEdges(out);

  return { nodes, edges, frames, width: out.width ?? 0, height: out.height ?? 0, overlay };
}

/** Cubic curve between two boxes, leaving/entering through the facing borders. */
function overlayCurve(na: LayoutNode, nb: LayoutNode): Point[] {
  // Groups are anchored at their header card, so links to a parent do not start from inside it.
  const a = anchor(na);
  const b = anchor(nb);
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const p0 = clip(ca, cb, a);
  const p3 = clip(cb, ca, b);
  const dx = (p3.x - p0.x) * 0.35;
  const dy = (p3.y - p0.y) * 0.35;
  const bend = { x: -dy * 0.35, y: dx * 0.35 };
  return [p0, { x: p0.x + dx + bend.x, y: p0.y + dy + bend.y }, { x: p3.x - dx + bend.x, y: p3.y - dy + bend.y }, p3];
}

type Box = { x: number; y: number; w: number; h: number };

function anchor(n: LayoutNode): Box {
  return n.group ? { x: n.x, y: n.y, w: n.w, h: GROUP_HEADER } : n;
}

function clip(from: Point, to: Point, n: Box): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!dx && !dy) return from;
  const t = Math.min(dx ? n.w / 2 / Math.abs(dx) : Infinity, dy ? n.h / 2 / Math.abs(dy) : Infinity);
  return { x: from.x + dx * Math.min(t, 1), y: from.y + dy * Math.min(t, 1) };
}

function bezierMid(p: Point[]): Point {
  const [a, b, c, d] = p;
  return { x: (a.x + 3 * b.x + 3 * c.x + d.x) / 8, y: (a.y + 3 * b.y + 3 * c.y + d.y) / 8 };
}
