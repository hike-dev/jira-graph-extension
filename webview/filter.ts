import type { GraphIssue, GraphLink } from '../src/shared/model';
import type { Stage } from '../src/shared/stages';

// Ticket filter: free text + facets. Within a facet values are OR-ed, across facets AND-ed.

export type FlagId = 'blocked' | 'blocking' | 'critical' | 'overdue' | 'stub' | 'hasChildren' | 'changed';

/** "Related to ticket": what can be reached from the anchor ticket(s) within `depth` hops. */
export interface AnchorFilter {
  keys: string[];
  /** Hops; 0 = unlimited. */
  depth: number;
  /** For directed links (blocks, duplicates, clones, other) and hierarchy: up = prerequisites / parents, down = subsequent / children. */
  direction: 'both' | 'up' | 'down';
  /** Relation kinds to follow: 'hierarchy' and link categories. */
  via: string[];
  /** Also include every descendant (sub-tasks, children) of each reached ticket. */
  subtree: boolean;
}

export const ANCHOR_VIA = ['hierarchy', 'blocks', 'relates', 'duplicates', 'clones', 'other'] as const;
export const DEFAULT_ANCHOR: Omit<AnchorFilter, 'keys'> = { depth: 2, direction: 'both', via: [...ANCHOR_VIA], subtree: false };

export interface FilterState {
  text: string;
  anchor?: AnchorFilter;
  stages: Stage[];
  types: string[];
  statuses: string[];
  assignees: string[];
  priorities: string[];
  sprints: string[];
  labels: string[];
  flags: FlagId[];
  /** dim: highlight matches, keep the rest faded · hide: show only matches (+ their parents as context). */
  mode: 'dim' | 'hide';
}

export type FacetKey = 'stages' | 'types' | 'statuses' | 'assignees' | 'priorities' | 'sprints' | 'labels' | 'flags';

export const EMPTY_FILTER: FilterState = {
  text: '', stages: [], types: [], statuses: [], assignees: [], priorities: [], sprints: [], labels: [], flags: [], mode: 'dim',
};

/** Value used for "no assignee" / "no sprint". */
export const NONE = '∅';

export const FLAG_LABELS: Record<FlagId, [string, string]> = {
  blocked: ['Blocked', 'An open ticket blocks it'],
  blocking: ['Blocking', 'It blocks an open ticket'],
  critical: ['Critical block', 'Work started while a blocker has not'],
  overdue: ['Overdue', 'Due date passed and not done'],
  stub: ['Not loaded', 'Found through a relation, not fetched yet'],
  hasChildren: ['Has children', 'Epics, stories with sub-tasks, …'],
  changed: ['Changed recently', 'Updated in the last 24 hours'],
};

export interface FilterContext {
  typeKey: (i: GraphIssue) => string;
  stage: (i: GraphIssue) => Stage;
  blocked: (key: string) => boolean;
  blocking: (key: string) => boolean;
  critical: (key: string) => boolean;
  hasChildren: (key: string) => boolean;
  /** Reach of the anchor filter: key → hops from the nearest anchor (see `reachable`). */
  reach?: Map<string, number>;
  now?: number;
}

export function activeCount(f: FilterState): number {
  return (f.text.trim() ? 1 : 0) + (f.anchor?.keys.length ? 1 : 0) + f.stages.length + f.types.length + f.statuses.length + f.assignees.length + f.priorities.length + f.sprints.length + f.labels.length + f.flags.length;
}

export function facetCount(f: FilterState): number {
  return activeCount(f) - (f.text.trim() ? 1 : 0);
}

export const isActive = (f: FilterState) => activeCount(f) > 0;

const DAY = 86_400_000;

function flagOn(i: GraphIssue, flag: FlagId, c: FilterContext): boolean {
  const now = c.now ?? Date.now();
  switch (flag) {
    case 'blocked': return c.blocked(i.key);
    case 'blocking': return c.blocking(i.key);
    case 'critical': return c.critical(i.key);
    case 'overdue': return !!i.dueDate && i.statusCategory !== 'done' && Date.parse(i.dueDate) < now;
    case 'stub': return !i.loaded;
    case 'hasChildren': return c.hasChildren(i.key);
    case 'changed': return !!i.updated && now - Date.parse(i.updated) < DAY;
  }
}

function sprintValues(i: GraphIssue): string[] {
  const open = (i.sprints ?? []).filter((s) => s.state !== 'closed');
  return open.length ? open.map((s) => s.name) : [NONE];
}

export function matchesFilter(i: GraphIssue, f: FilterState, c: FilterContext, skip?: FacetKey): boolean {
  if (f.anchor?.keys.length && c.reach && !c.reach.has(i.key)) return false;
  const any = <T>(facet: FacetKey, sel: T[], has: (v: T) => boolean) => facet === skip || !sel.length || sel.some(has);
  if (!any('stages', f.stages, (s) => c.stage(i) === s)) return false;
  if (!any('types', f.types, (t) => c.typeKey(i) === t)) return false;
  if (!any('statuses', f.statuses, (s) => i.status === s)) return false;
  if (!any('assignees', f.assignees, (a) => (i.assignee ?? NONE) === a)) return false;
  if (!any('priorities', f.priorities, (p) => (i.priority ?? NONE) === p)) return false;
  if (!any('sprints', f.sprints, (s) => sprintValues(i).includes(s))) return false;
  if (!any('labels', f.labels, (l) => i.labels.includes(l))) return false;
  // Flags narrow further: every chosen flag must hold.
  if (skip !== 'flags' && !f.flags.every((fl) => flagOn(i, fl, c))) return false;
  const terms = f.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    const hay = `${i.key} ${i.summary} ${i.assignee ?? ''} ${i.status} ${i.type} ${i.labels.join(' ')} ${(i.sprints ?? []).map((s) => s.name).join(' ')}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) return false;
  }
  return true;
}

export interface FacetOption {
  value: string;
  label: string;
  /** Tickets that would match if this value were (also) selected, given the other facets. */
  count: number;
}

/** Options per facet with counts that respect every *other* active facet (standard faceted search). */
export function facetOptions(issues: GraphIssue[], f: FilterState, c: FilterContext): Record<FacetKey, FacetOption[]> {
  const tally = (facet: FacetKey, values: (i: GraphIssue) => string[], label: (v: string) => string = (v) => v): FacetOption[] => {
    const counts = new Map<string, number>();
    for (const i of issues) {
      if (!matchesFilter(i, f, c, facet)) continue;
      for (const v of new Set(values(i))) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    // Keep selected values visible even when their count dropped to zero.
    for (const v of f[facet] as string[]) if (!counts.has(v)) counts.set(v, 0);
    return [...counts].map(([value, count]) => ({ value, label: label(value), count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const stageOrder: Stage[] = ['todo', 'dev', 'test', 'done'];
  const flagCounts = (Object.keys(FLAG_LABELS) as FlagId[]).map((fl) => ({
    value: fl,
    label: FLAG_LABELS[fl][0],
    count: issues.filter((i) => matchesFilter(i, f, c, 'flags') && flagOn(i, fl, c)).length,
  })).filter((o) => o.count || f.flags.includes(o.value as FlagId));
  return {
    stages: tally('stages', (i) => [c.stage(i)]).sort((a, b) => stageOrder.indexOf(a.value as Stage) - stageOrder.indexOf(b.value as Stage)),
    types: tally('types', (i) => [c.typeKey(i)]),
    statuses: tally('statuses', (i) => [i.status]),
    assignees: tally('assignees', (i) => [i.assignee ?? NONE], (v) => (v === NONE ? 'Unassigned' : v)),
    priorities: tally('priorities', (i) => [i.priority ?? NONE], (v) => (v === NONE ? 'No priority' : v)),
    sprints: tally('sprints', sprintValues, (v) => (v === NONE ? 'Backlog (no open sprint)' : v)),
    labels: tally('labels', (i) => i.labels),
    flags: flagCounts,
  };
}

/**
 * Breadth-first reach from the anchor ticket(s) over the chosen relation kinds.
 * Directed kinds follow `direction`: up = towards what blocks / is the parent of it, down = what it
 * blocks / its children. "relates" has no direction and is always followed both ways.
 * With `subtree`, every descendant of each reached ticket is added (at its ancestor's distance + 1).
 */
export function reachable(issues: GraphIssue[], links: GraphLink[], a: AnchorFilter): Map<string, number> {
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const children = new Map<string, string[]>();
  for (const i of issues) if (i.parentKey && byKey.has(i.parentKey)) children.set(i.parentKey, [...(children.get(i.parentKey) ?? []), i.key]);
  const up = a.direction !== 'down';
  const down = a.direction !== 'up';
  const via = new Set(a.via);
  const next = (k: string): string[] => {
    const out: string[] = [];
    if (via.has('hierarchy')) {
      const p = byKey.get(k)?.parentKey;
      if (up && p && byKey.has(p)) out.push(p);
      if (down) out.push(...(children.get(k) ?? []));
    }
    for (const l of links) {
      if (!via.has(l.category)) continue;
      const undirected = l.category === 'relates';
      if (l.from === k && (down || undirected)) out.push(l.to);
      if (l.to === k && (up || undirected)) out.push(l.from);
    }
    return out;
  };
  const dist = new Map<string, number>();
  let frontier = a.keys.filter((k) => byKey.has(k));
  frontier.forEach((k) => dist.set(k, 0));
  const limit = a.depth > 0 ? a.depth : Infinity;
  for (let d = 1; d <= limit && frontier.length; d++) {
    const nxt: string[] = [];
    for (const k of frontier) for (const n of next(k)) if (!dist.has(n) && byKey.has(n)) dist.set(n, d), nxt.push(n);
    frontier = nxt;
  }
  if (a.subtree) {
    const stack = [...dist.keys()];
    while (stack.length) {
      const k = stack.pop()!;
      for (const c of children.get(k) ?? []) if (!dist.has(c)) dist.set(c, dist.get(k)! + 1), stack.push(c);
    }
  }
  return dist;
}

export type SortKey = 'graph' | 'distance' | 'key' | 'stage' | 'updated' | 'priority';

const PRIORITY_RANK = ['highest', 'blocker', 'critical', 'high', 'major', 'medium', 'low', 'minor', 'lowest', 'trivial'];

export function sortMatches(
  list: GraphIssue[],
  by: SortKey,
  c: { stage: (i: GraphIssue) => Stage; position: (key: string) => { x: number; y: number } | undefined; distance?: (key: string) => number | undefined },
): GraphIssue[] {
  const keyCmp = (a: GraphIssue, b: GraphIssue) => a.key.localeCompare(b.key, undefined, { numeric: true });
  const stageOrder: Stage[] = ['todo', 'dev', 'test', 'done'];
  const pr = (i: GraphIssue) => { const r = PRIORITY_RANK.indexOf((i.priority ?? '').toLowerCase()); return r < 0 ? PRIORITY_RANK.length : r; };
  const cmp: Record<SortKey, (a: GraphIssue, b: GraphIssue) => number> = {
    // Reading order on the canvas (rows of ~40px), so stepping follows the picture; hidden ones last.
    graph: (a, b) => {
      const pa = c.position(a.key);
      const pb = c.position(b.key);
      if (!pa || !pb) return (pa ? -1 : pb ? 1 : 0) || keyCmp(a, b);
      return Math.round(pa.y / 40) - Math.round(pb.y / 40) || pa.x - pb.x;
    },
    distance: (a, b) => (c.distance?.(a.key) ?? Infinity) - (c.distance?.(b.key) ?? Infinity) || keyCmp(a, b),
    key: keyCmp,
    stage: (a, b) => stageOrder.indexOf(c.stage(a)) - stageOrder.indexOf(c.stage(b)) || keyCmp(a, b),
    updated: (a, b) => (Date.parse(b.updated ?? '') || 0) - (Date.parse(a.updated ?? '') || 0) || keyCmp(a, b),
    priority: (a, b) => pr(a) - pr(b) || keyCmp(a, b),
  };
  return [...list].sort(cmp[by]);
}
