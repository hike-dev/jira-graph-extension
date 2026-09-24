import type { GraphIssue, GraphLink } from './model';

// Workflow stages refine Jira's three status categories. In many workflows most statuses sit in
// "In Progress" (development, review, several testing steps), which hides how close a blocker is.

export type Stage = 'todo' | 'dev' | 'test' | 'done';

export const STAGE_LABELS: Record<Stage, string> = {
  todo: 'Not started',
  dev: 'In development',
  test: 'In testing',
  done: 'Done',
};

const TESTING = /\b(test|testing|tested|qa|verif|uat|staging|acceptance)/i;

/** Per-status override (case-insensitive name → stage) wins; otherwise category + name heuristics. */
export function stageOf(i: Pick<GraphIssue, 'status' | 'statusCategory'>, overrides: Record<string, Stage> = {}): Stage {
  const o = overrides[i.status.toLowerCase()];
  if (o) return o;
  if (i.statusCategory === 'done') return 'done';
  if (i.statusCategory === 'new') return 'todo';
  return TESTING.test(i.status) ? 'test' : 'dev';
}

export function normalizeStageOverrides(raw: Record<string, string> | undefined): Record<string, Stage> {
  const out: Record<string, Stage> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const s = String(v).toLowerCase();
    if (s === 'todo' || s === 'dev' || s === 'test' || s === 'done') out[k.toLowerCase()] = s;
  }
  return out;
}

/**
 * State of a "blocks" link, from both ends:
 *   critical — blocker not started, but the blocked ticket is already being worked on
 *   todo / dev / test — blocker's stage while the blocked ticket waits
 *   stale — the blocked ticket is done although its blocker is not (inconsistent data)
 *   resolved — blocker done: no longer blocking
 */
export type BlockState = 'critical' | 'todo' | 'dev' | 'test' | 'stale' | 'resolved';

export const BLOCK_SEVERITY: BlockState[] = ['critical', 'todo', 'dev', 'test', 'stale', 'resolved'];

export const BLOCK_LABELS: Record<BlockState, string> = {
  critical: 'Blocker not started, blocked work already in progress',
  todo: 'Blocker not started',
  dev: 'Blocker in development',
  test: 'Blocker in testing',
  stale: 'Blocked ticket done while its blocker is open',
  resolved: 'Blocker done (no longer blocking)',
};

export function blockState(blocker: Stage, blocked: Stage): BlockState {
  if (blocker === 'done') return 'resolved';
  if (blocked === 'done') return 'stale';
  if (blocker === 'todo') return blocked === 'dev' || blocked === 'test' ? 'critical' : 'todo';
  return blocker;
}

/** The more severe of two states (lower index in BLOCK_SEVERITY). */
export function worse(a: BlockState | undefined, b: BlockState): BlockState {
  return a === undefined || BLOCK_SEVERITY.indexOf(b) < BLOCK_SEVERITY.indexOf(a) ? b : a;
}

/** States that still block (the ticket shows a blocked badge). */
export function isBlocking(s: BlockState): boolean {
  return s === 'critical' || s === 'todo' || s === 'dev' || s === 'test';
}

export function linkBlockState(
  l: GraphLink,
  byKey: Map<string, GraphIssue>,
  overrides: Record<string, Stage>,
): BlockState | undefined {
  if (l.category !== 'blocks') return undefined;
  const a = byKey.get(l.from);
  const b = byKey.get(l.to);
  if (!a || !b) return undefined;
  return blockState(stageOf(a, overrides), stageOf(b, overrides));
}
