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

export interface LayoutResult {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
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
  /** When false, cross links do not influence node placement and are drawn as overlays. */
  linksAffectLayout: boolean;
}

export const GROUP_HEADER = 58;
const PAD = 14;

export function nodeSize(style: TypeStyle): { w: number; h: number } {
  if (style.size === 'large') return { w: 280, h: 84 };
  if (style.size === 'small') return { w: 220, h: 60 };
  return { w: 256, h: 78 };
}

const elk = new ELK();

type EdgeMeta = Omit<LayoutEdge, 'points' | 'labelPos' | 'spline'>;
type Part = LayoutResult & { overlay: EdgeMeta[] };

export async function layout(input: LayoutInput): Promise<LayoutResult> {
  // ELK does not separate connected components under INCLUDE_CHILDREN, so for nested mode
  // lay out each component on its own and shelf-pack them. (Packed nested mode needs no split.)
  const parts = input.mode === 'nested' && input.linksAffectLayout ? await Promise.all(components(input).map((c) => layoutPart({ ...input, ...c }))) : [await layoutPart(input)];
  const merged = pack(parts);
  for (const m of parts.flatMap((p) => p.overlay)) {
    const a = merged.nodes.get(m.from);
    const b = merged.nodes.get(m.to);
    if (!a || !b) continue;
    const pts = overlayCurve(a, b);
    merged.edges.push({ ...m, points: pts, labelPos: input.showLabels ? bezierMid(pts) : undefined, spline: true });
  }
  return merged;
}

function components(input: LayoutInput): { issues: GraphIssue[]; links: GraphLink[] }[] {
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
  if (input.linksAffectLayout) {
    for (const l of input.links) if (byKey.has(l.from) && byKey.has(l.to)) uf.set(find(top(l.from)), find(top(l.to)));
  }
  const groups = new Map<string, GraphIssue[]>();
  for (const i of input.issues) {
    const r = find(top(i.key));
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }
  return [...groups.values()].map((issues) => {
    const keys = new Set(issues.map((i) => i.key));
    // Links spanning components (only when links do not affect layout) are drawn as overlays after packing.
    return { issues, links: input.links.filter((l) => keys.has(l.from) || keys.has(l.to)) };
  });
}

const GAP = 56;

function pack(parts: Part[]): LayoutResult {
  if (parts.length === 1) return parts[0];
  const area = parts.reduce((a, p) => a + (p.width + GAP) * (p.height + GAP), 0);
  const maxW = Math.max(Math.sqrt(area * 1.8), ...parts.map((p) => p.width));
  const sorted = [...parts].sort((a, b) => b.height - a.height);
  const nodes = new Map<string, LayoutNode>();
  const edges: LayoutEdge[] = [];
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
    width = Math.max(width, x + p.width);
    rowH = Math.max(rowH, p.height);
    x += p.width + GAP;
  }
  return { nodes, edges, width, height: y + rowH };
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

  if (mode === 'edges' && input.showHierarchy) {
    for (const i of issues) {
      const p = parentOf(i.key);
      if (!p) continue;
      const id = `h:${p}>${i.key}`;
      meta.set(id, { id, kind: 'hierarchy', from: p, to: i.key });
      root.edges!.push({
        id,
        sources: [p],
        targets: [i.key],
        layoutOptions: { 'elk.layered.priority.direction': '10', 'elk.layered.priority.shortness': '10', 'elk.layered.priority.straightness': '5' },
      });
    }
  }
  for (const l of links) {
    if (!byKey.has(l.from) || !byKey.has(l.to) || l.from === l.to) continue;
    const m = { id: `l:${l.id}`, kind: l.category, from: l.from, to: l.to, label: l.label };
    const nestedConflict = mode === 'nested' && (isAncestor(l.from, l.to) || isAncestor(l.to, l.from));
    if (!input.linksAffectLayout || nestedConflict) {
      overlay.push(m);
      continue;
    }
    meta.set(m.id, m);
    const e: ElkExtendedEdge = { id: m.id, sources: [l.from], targets: [l.to], labels: label(l.label) };
    root.edges!.push(e);
  }

  const out = await elk.layout(root);

  // ── Collect ──────────────────────────────────────────────────────────────
  const nodes = new Map<string, LayoutNode>();
  const walk = (n: ElkNode) => {
    for (const c of n.children ?? []) {
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

  return { nodes, edges, width: out.width ?? 0, height: out.height ?? 0, overlay };
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
