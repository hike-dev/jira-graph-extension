import type { ScopeConfig } from '../shared/model';
import type { RawIssue } from './types';

export type { ScopeConfig };

// Load scope: which tickets of a query's "universe" are loaded into the graph.
//
//   sprint   — active and (optionally) future sprints: always, including their done tickets
//   context  — parents and directly linked tickets of what is loaded: always (explains it)
//   backlog  — open tickets outside open sprints: graded by a relevance score, top N
//   done     — resolved within `doneDays` (older ones only as context)

export const DEFAULT_SCOPE: ScopeConfig = { enabled: true, backlog: 50, doneDays: 14, future: true, context: true };

export type Tier = 'sprint' | 'backlog' | 'done' | 'oldDone';

export interface ScoreReason {
  label: string;
  points: number;
}

export interface Classified {
  tier: Tier;
  score: number;
  reasons: ScoreReason[];
}

export interface ScopeCtx {
  sprintField?: string;
  epicLinkField?: string;
  now?: number;
}

const DAY = 86_400_000;

interface SprintValue {
  state?: string;
}

function sprints(i: RawIssue, field?: string): SprintValue[] {
  if (!field) return [];
  const v = i.fields[field];
  if (!Array.isArray(v)) return [];
  return v.map((s) => (typeof s === 'string' ? { state: /state=([A-Z]+)/.exec(s)?.[1] } : (s as SprintValue)));
}

function isDone(i: RawIssue): boolean {
  return i.fields.status?.statusCategory?.key === 'done';
}

function parentKey(i: RawIssue, ctx: ScopeCtx): string | undefined {
  if (i.fields.parent?.key) return i.fields.parent.key;
  const e = ctx.epicLinkField ? i.fields[ctx.epicLinkField] : undefined;
  return typeof e === 'string' && e ? e : undefined;
}

const PRIORITY_POINTS: Record<string, number> = {
  highest: 30, blocker: 30, critical: 30, high: 20, major: 20, medium: 10, low: 3, minor: 3, lowest: 0, trivial: 0,
};

/**
 * Tier of every ticket, and a relevance score for backlog tickets:
 *   linked to sprint work +50 · same epic as sprint work +20 · priority 0–30 ·
 *   recency 20·e^(−days/14) · carried over +15 · due within 14 days +25
 */
export function classify(issues: RawIssue[], cfg: ScopeConfig, ctx: ScopeCtx = {}): Map<string, Classified> {
  const now = ctx.now ?? Date.now();
  const inSprint = (i: RawIssue) => sprints(i, ctx.sprintField).some((s) => {
    const st = (s.state ?? '').toLowerCase();
    return st === 'active' || (cfg.future && st === 'future');
  });
  const sprintKeys = new Set(issues.filter(inSprint).map((i) => i.key));
  const sprintParents = new Set(issues.filter(inSprint).map((i) => parentKey(i, ctx)).filter((k): k is string => !!k));
  const out = new Map<string, Classified>();
  for (const i of issues) {
    if (sprintKeys.has(i.key)) {
      out.set(i.key, { tier: 'sprint', score: Infinity, reasons: [{ label: 'In an open sprint', points: 0 }] });
      continue;
    }
    if (isDone(i)) {
      const resolved = Date.parse(String(i.fields.resolutiondate ?? i.fields.statuscategorychangedate ?? ''));
      const days = Number.isFinite(resolved) ? (now - resolved) / DAY : Infinity;
      const recent = cfg.doneDays < 0 || (cfg.doneDays > 0 && days <= cfg.doneDays);
      out.set(i.key, {
        tier: recent ? 'done' : 'oldDone',
        score: -days,
        reasons: [{ label: Number.isFinite(days) ? `Done ${Math.round(days)}d ago` : 'Done', points: 0 }],
      });
      continue;
    }
    const reasons: ScoreReason[] = [];
    const linked = (i.fields.issuelinks ?? []).map((l) => (l.outwardIssue ?? l.inwardIssue)!.key).filter((k) => sprintKeys.has(k));
    if (linked.length) reasons.push({ label: `Linked to sprint work (${linked.slice(0, 2).join(', ')}${linked.length > 2 ? '…' : ''})`, points: 50 });
    const p = parentKey(i, ctx);
    if (p && sprintParents.has(p)) reasons.push({ label: `Same epic as sprint work (${p})`, points: 20 });
    const pr = PRIORITY_POINTS[(i.fields.priority?.name ?? '').toLowerCase()] ?? 0;
    if (pr) reasons.push({ label: `Priority ${i.fields.priority!.name}`, points: pr });
    const upd = Date.parse(i.fields.updated ?? '');
    if (Number.isFinite(upd)) {
      const d = Math.max(0, (now - upd) / DAY);
      const pts = Math.round(20 * Math.exp(-d / 14) * 10) / 10;
      if (pts >= 1) reasons.push({ label: `Updated ${Math.round(d)}d ago`, points: pts });
    }
    if (sprints(i, ctx.sprintField).some((s) => (s.state ?? '').toLowerCase() === 'closed')) reasons.push({ label: 'Carried over from a sprint', points: 15 });
    const due = Date.parse(String(i.fields.duedate ?? ''));
    if (Number.isFinite(due) && due - now <= 14 * DAY) reasons.push({ label: due < now ? 'Overdue' : 'Due within 14 days', points: 25 });
    out.set(i.key, { tier: 'backlog', score: reasons.reduce((a, r) => a + r.points, 0), reasons });
  }
  return out;
}

export interface Selection {
  /** Keys to load, in priority order (sprint, done, backlog by rank) — used when a hard limit applies. */
  keys: string[];
  /** Backlog rank (1-based) of every backlog ticket, selected or not. */
  rank: Map<string, number>;
  classified: Map<string, Classified>;
}

export function select(issues: RawIssue[], cfg: ScopeConfig, ctx: ScopeCtx = {}): Selection {
  const classified = classify(issues, cfg, ctx);
  const byTier = (t: Tier) => issues.filter((i) => classified.get(i.key)!.tier === t);
  const backlog = byTier('backlog').sort(
    (a, b) => classified.get(b.key)!.score - classified.get(a.key)!.score || Date.parse(b.fields.updated ?? '') - Date.parse(a.fields.updated ?? '') || a.key.localeCompare(b.key),
  );
  const rank = new Map(backlog.map((i, n) => [i.key, n + 1]));
  const keys = [
    ...byTier('sprint').map((i) => i.key),
    ...byTier('done').sort((a, b) => classified.get(b.key)!.score - classified.get(a.key)!.score).map((i) => i.key),
    ...backlog.slice(0, Math.max(0, cfg.backlog)).map((i) => i.key),
  ];
  return { keys, rank, classified };
}
