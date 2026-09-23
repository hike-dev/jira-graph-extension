import type { GraphIssue, GraphLink } from '../src/shared/model';

// Lenses decide which tickets matter for a question ("what is moving?", "what got done?",
// "where does the rest live in the plan?") and express it as emphasis + a couple of badges.

export type LensId = 'none' | 'progress' | 'completion' | 'planning';
export type Level = 'primary' | 'context' | 'muted';
export type Tone = 'info' | 'ok' | 'warn' | 'bad' | 'neutral';

export interface Badge {
  text: string;
  tone: Tone;
  title: string;
}

export interface LensMark {
  level: Level;
  badges: Badge[];
  /** Planning: future sprint = dashed card, backlog = hollow card. */
  outline?: 'dashed' | 'hollow';
}

export interface LensContext {
  issues: GraphIssue[];
  links: GraphLink[];
  byKey: Map<string, GraphIssue>;
  rollups: Map<string, { new: number; indeterminate: number; done: number }>;
  now?: number;
}

export interface LensLegendRow {
  badge?: Badge;
  level?: Level;
  outline?: 'dashed' | 'hollow';
  text: string;
}

export const LENSES: Record<LensId, { label: string; hint: string; legend: LensLegendRow[] }> = {
  none: { label: 'No lens', hint: '', legend: [] },
  progress: {
    label: 'Progress',
    hint: 'What is moving: work in progress, how long it has been there, and what blocks it.',
    legend: [
      { level: 'primary', text: 'In progress' },
      { badge: { text: '2d', tone: 'ok', title: '' }, text: 'Time in status (amber ≥ 3d, red ≥ 14d)' },
      { badge: { text: 'moved', tone: 'info', title: '' }, text: 'Changed status in the last 48h' },
      { badge: { text: 'blocks WIP', tone: 'bad', title: '' }, text: 'Open issue blocking work in progress' },
      { level: 'context', text: 'Parents of active work' },
      { level: 'muted', text: 'To do and done' },
    ],
  },
  completion: {
    label: 'Completion',
    hint: 'What got done recently, what it unlocked, and containers ready to close.',
    legend: [
      { level: 'primary', text: 'Done in the last 14 days' },
      { badge: { text: 'unblocked', tone: 'ok', title: '' }, text: 'All blockers done — ready to start' },
      { badge: { text: 'ready to close', tone: 'ok', title: '' }, text: 'Open parent with every child done' },
      { badge: { text: 'open children', tone: 'bad', title: '' }, text: 'Done parent with unfinished children' },
      { badge: { text: '60%', tone: 'neutral', title: '' }, text: 'Share of descendants done' },
      { level: 'muted', text: 'Open work' },
    ],
  },
  planning: {
    label: 'Planning',
    hint: 'Where open work lives: current sprint, next sprints, backlog, carried over or idle.',
    legend: [
      { level: 'primary', text: 'In the active sprint' },
      { outline: 'dashed', text: 'Planned for a future sprint' },
      { outline: 'hollow', text: 'Backlog (no open sprint)' },
      { badge: { text: '↻2', tone: 'warn', title: '' }, text: 'Carried over from earlier sprints' },
      { badge: { text: '45d idle', tone: 'warn', title: '' }, text: 'Not updated for 30+ days' },
      { badge: { text: 'unassigned', tone: 'warn', title: '' }, text: 'In the active sprint without an assignee' },
      { level: 'muted', text: 'Done' },
    ],
  },
};

const DAY = 86_400_000;
const RECENT_MOVE_DAYS = 2;
const RECENT_DONE_DAYS = 14;
const IDLE_DAYS = 30;

function days(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / DAY) : undefined;
}

export function fmtAge(d: number): string {
  if (d < 1) return `${Math.max(1, Math.round(d * 24))}h`;
  if (d < 60) return `${Math.round(d)}d`;
  return `${Math.round(d / 30)}mo`;
}

export function computeLens(id: LensId, ctx: LensContext): Map<string, LensMark> {
  const out = new Map<string, LensMark>();
  if (id === 'none') return out;
  const now = ctx.now ?? Date.now();
  const blockersOf = new Map<string, GraphIssue[]>();
  const blocksOf = new Map<string, GraphIssue[]>();
  for (const l of ctx.links) {
    if (l.category !== 'blocks') continue;
    const a = ctx.byKey.get(l.from);
    const b = ctx.byKey.get(l.to);
    if (!a || !b) continue;
    blockersOf.set(b.key, [...(blockersOf.get(b.key) ?? []), a]);
    blocksOf.set(a.key, [...(blocksOf.get(a.key) ?? []), b]);
  }
  const mark = id === 'progress' ? progress : id === 'completion' ? completion : planning;
  for (const i of ctx.issues) {
    const m = mark(i);
    m.badges = m.badges.slice(0, 2);
    out.set(i.key, m);
  }
  return out;

  function progress(i: GraphIssue): LensMark {
    const moved = days(i.statusChangedAt, now);
    const badges: Badge[] = [];
    if (i.statusCategory === 'indeterminate') {
      if (moved !== undefined) {
        const tone: Tone = moved >= 14 ? 'bad' : moved >= 3 ? 'warn' : 'ok';
        badges.push({ text: fmtAge(moved), tone, title: `${fmtAge(moved)} in ${i.status}` });
      }
      if (moved !== undefined && moved <= RECENT_MOVE_DAYS) badges.push({ text: 'moved', tone: 'info', title: `Moved to ${i.status} ${fmtAge(moved)} ago` });
      return { level: 'primary', badges };
    }
    const wip = (blocksOf.get(i.key) ?? []).filter((x) => x.statusCategory === 'indeterminate');
    if (i.statusCategory !== 'done' && wip.length) {
      return { level: 'primary', badges: [{ text: 'blocks WIP', tone: 'bad', title: `Blocks ${wip.map((x) => x.key).join(', ')} (in progress)` }] };
    }
    const r = ctx.rollups.get(i.key);
    if (r?.indeterminate) return { level: 'context', badges: [{ text: `${r.indeterminate} active`, tone: 'info', title: `${r.indeterminate} descendants in progress` }] };
    return { level: 'muted', badges };
  }

  function completion(i: GraphIssue): LensMark {
    const badges: Badge[] = [];
    const r = ctx.rollups.get(i.key);
    const total = r ? r.new + r.indeterminate + r.done : 0;
    if (i.statusCategory === 'done') {
      if (total && r!.done < total) {
        badges.push({ text: 'open children', tone: 'bad', title: `${total - r!.done} of ${total} descendants are not done` });
        return { level: 'primary', badges };
      }
      const d = days(i.resolvedAt ?? i.statusChangedAt, now);
      if (d !== undefined && d <= RECENT_DONE_DAYS) {
        badges.push({ text: `✓ ${fmtAge(d)}`, tone: 'ok', title: `Done ${fmtAge(d)} ago` });
        return { level: 'primary', badges };
      }
      return { level: 'context', badges };
    }
    if (total && r!.done === total) {
      return { level: 'primary', badges: [{ text: 'ready to close', tone: 'ok', title: `All ${total} descendants are done` }] };
    }
    const blockers = blockersOf.get(i.key) ?? [];
    if (blockers.length && blockers.every((b) => b.statusCategory === 'done')) {
      return { level: 'primary', badges: [{ text: 'unblocked', tone: 'ok', title: `Blockers done: ${blockers.map((b) => b.key).join(', ')}` }] };
    }
    if (total) {
      const pct = Math.round((r!.done / total) * 100);
      return { level: 'context', badges: [{ text: `${pct}%`, tone: pct >= 80 ? 'ok' : 'neutral', title: `${r!.done}/${total} descendants done` }] };
    }
    return { level: 'muted', badges };
  }

  function planning(i: GraphIssue): LensMark {
    if (i.statusCategory === 'done') return { level: 'muted', badges: [] };
    const badges: Badge[] = [];
    const sprints = i.sprints ?? [];
    const active = sprints.find((s) => s.state === 'active');
    const future = sprints.find((s) => s.state === 'future');
    const carried = sprints.filter((s) => s.state === 'closed').length;
    if (carried) badges.push({ text: `↻${carried}`, tone: 'warn', title: `Carried over from ${carried} closed sprint${carried > 1 ? 's' : ''}: ${sprints.filter((s) => s.state === 'closed').map((s) => s.name).join(', ')}` });
    const idle = days(i.updated, now);
    if (idle !== undefined && idle >= IDLE_DAYS) badges.push({ text: `${fmtAge(idle)} idle`, tone: 'warn', title: `Not updated for ${fmtAge(idle)}` });
    if (active) {
      if (!i.assignee) badges.push({ text: 'unassigned', tone: 'warn', title: `In ${active.name} without an assignee` });
      badges.push({ text: active.name, tone: 'info', title: `Active sprint: ${active.name}` });
      return { level: 'primary', badges };
    }
    // Containers (epics, initiatives) rarely sit in sprints: show them as context for their children.
    const r = ctx.rollups.get(i.key);
    if (r && r.new + r.indeterminate + r.done > 0) return { level: 'context', badges };
    if (future) {
      badges.push({ text: `▸ ${future.name}`, tone: 'neutral', title: `Planned for ${future.name}` });
      return { level: 'context', badges, outline: 'dashed' };
    }
    badges.push({ text: 'backlog', tone: 'neutral', title: 'Not in an open sprint' });
    return { level: 'context', badges, outline: 'hollow' };
  }
}

/** True when no loaded issue carries sprint data (field missing or not configured). */
export function hasSprintData(issues: GraphIssue[]): boolean {
  return issues.some((i) => i.sprints !== undefined && i.sprints.length > 0);
}
