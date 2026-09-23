import { IssueSource, RawIssue, RawIssueLink, RawIssueRef } from './types';

// Offline demo dataset: lets people explore the graph without Jira credentials.

type Cat = 'new' | 'indeterminate' | 'done';
const TODO: [string, Cat] = ['To Do', 'new'];
const PROG: [string, Cat] = ['In Progress', 'indeterminate'];
const REVIEW: [string, Cat] = ['In Review', 'indeterminate'];
const DONE: [string, Cat] = ['Done', 'done'];

interface Def {
  key: string;
  type: string;
  summary: string;
  status: [string, Cat];
  parent?: string;
  assignee?: string;
  priority?: string;
  labels?: string[];
}

const DEFS: Def[] = [
  { key: 'SHOP-1', type: 'Initiative', summary: 'Mobile commerce launch', status: PROG, assignee: 'Olena Koval' },
  { key: 'SHOP-10', type: 'Epic', summary: 'Checkout redesign', status: PROG, parent: 'SHOP-1', assignee: 'Anna Kim' },
  { key: 'SHOP-20', type: 'Epic', summary: 'Payments v2', status: PROG, parent: 'SHOP-1', assignee: 'Marco Rossi' },
  { key: 'SHOP-30', type: 'Epic', summary: 'Product search', status: TODO, parent: 'SHOP-1', assignee: 'Ivan Petrenko' },

  { key: 'SHOP-11', type: 'Story', summary: 'One-page checkout form', status: PROG, parent: 'SHOP-10', assignee: 'Anna Kim', priority: 'High' },
  { key: 'SHOP-111', type: 'Sub-task', summary: 'Address autocomplete', status: DONE, parent: 'SHOP-11', assignee: 'Anna Kim' },
  { key: 'SHOP-112', type: 'Sub-task', summary: 'Inline form validation', status: PROG, parent: 'SHOP-11', assignee: 'Lee Chen' },
  { key: 'SHOP-113', type: 'Sub-task', summary: 'Checkout analytics events', status: TODO, parent: 'SHOP-11' },
  { key: 'SHOP-12', type: 'Story', summary: 'Guest checkout without registration', status: TODO, parent: 'SHOP-10', priority: 'Medium' },
  { key: 'SHOP-13', type: 'Bug', summary: 'Cart total rounding error when two discounts apply', status: PROG, parent: 'SHOP-10', assignee: 'Lee Chen', priority: 'High', labels: ['regression'] },
  { key: 'SHOP-14', type: 'Task', summary: 'A/B test setup for the new checkout', status: TODO, parent: 'SHOP-10', priority: 'Low' },

  { key: 'SHOP-21', type: 'Story', summary: 'Apple Pay & Google Pay support', status: PROG, parent: 'SHOP-20', assignee: 'Marco Rossi', priority: 'High' },
  { key: 'SHOP-211', type: 'Sub-task', summary: 'Merchant certificates', status: DONE, parent: 'SHOP-21', assignee: 'Marco Rossi' },
  { key: 'SHOP-212', type: 'Sub-task', summary: 'Wallet button component', status: REVIEW, parent: 'SHOP-21', assignee: 'Sara Novak' },
  { key: 'SHOP-22', type: 'Story', summary: 'Saved cards for returning customers', status: TODO, parent: 'SHOP-20' },
  { key: 'SHOP-23', type: 'Spike', summary: 'Evaluate 3DS2 providers', status: DONE, parent: 'SHOP-20', assignee: 'Sara Novak' },
  { key: 'SHOP-24', type: 'Bug', summary: 'Customer charged twice when payment is retried', status: TODO, parent: 'SHOP-20', priority: 'Highest', labels: ['incident'] },
  { key: 'SHOP-25', type: 'Bug', summary: 'Double charge after gateway timeout', status: DONE, parent: 'SHOP-20', priority: 'High' },

  { key: 'SHOP-31', type: 'Story', summary: 'Search autocomplete', status: TODO, parent: 'SHOP-30', assignee: 'Ivan Petrenko' },
  { key: 'SHOP-32', type: 'Improvement', summary: 'Typo tolerance in product search', status: TODO, parent: 'SHOP-30' },
  { key: 'SHOP-33', type: 'Task', summary: 'Index product catalog in OpenSearch', status: PROG, parent: 'SHOP-30', assignee: 'Ivan Petrenko' },
  { key: 'SHOP-34', type: 'Story', summary: 'Price range filters', status: TODO, parent: 'SHOP-30' },
  { key: 'SHOP-35', type: 'Story', summary: 'Brand filters', status: TODO, parent: 'SHOP-30' },

  { key: 'PLAT-2', type: 'Epic', summary: 'API platform hardening', status: PROG, assignee: 'Platform Team' },
  { key: 'PLAT-7', type: 'Task', summary: 'Upgrade payment gateway SDK to v5', status: PROG, parent: 'PLAT-2', assignee: 'Tom Berg', priority: 'High' },
  { key: 'PLAT-12', type: 'Story', summary: 'Public API rate limiting', status: TODO, parent: 'PLAT-2' },
  { key: 'PLAT-40', type: 'Task', summary: 'Provision OpenSearch cluster', status: DONE, assignee: 'Tom Berg' },
];

const LINK_TYPES = {
  blocks: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
  relates: { name: 'Relates', outward: 'relates to', inward: 'relates to' },
  duplicates: { name: 'Duplicate', outward: 'duplicates', inward: 'is duplicated by' },
  clones: { name: 'Cloners', outward: 'clones', inward: 'is cloned by' },
  causes: { name: 'Problem/Incident', outward: 'causes', inward: 'is caused by' },
};

const LINKS: [string, keyof typeof LINK_TYPES, string][] = [
  ['PLAT-7', 'blocks', 'SHOP-21'],
  ['SHOP-21', 'blocks', 'SHOP-22'],
  ['SHOP-23', 'blocks', 'SHOP-21'],
  ['SHOP-11', 'blocks', 'SHOP-12'],
  ['SHOP-12', 'blocks', 'SHOP-22'],
  ['SHOP-22', 'blocks', 'SHOP-12'],
  ['SHOP-13', 'relates', 'SHOP-11'],
  ['SHOP-25', 'duplicates', 'SHOP-24'],
  ['SHOP-33', 'blocks', 'SHOP-31'],
  ['PLAT-40', 'blocks', 'SHOP-33'],
  ['SHOP-31', 'relates', 'SHOP-32'],
  ['SHOP-35', 'clones', 'SHOP-34'],
  ['PLAT-7', 'causes', 'SHOP-24'],
  ['PLAT-12', 'relates', 'PLAT-7'],
  ['SHOP-14', 'relates', 'SHOP-11'],
];

const DAY = 86_400_000;
const SPRINT_OLD = { name: 'SHOP Sprint 13', state: 'closed' };
const SPRINT_NOW = { name: 'SHOP Sprint 14', state: 'active' };
const SPRINT_NEXT = { name: 'SHOP Sprint 15', state: 'future' };

/** Days since the last status-category change, and sprint history, per demo issue. */
const PLAN: Record<string, { days: number; sprints?: object[] }> = {
  'SHOP-11': { days: 4, sprints: [SPRINT_NOW] },
  'SHOP-111': { days: 1, sprints: [SPRINT_NOW] },
  'SHOP-112': { days: 16, sprints: [SPRINT_OLD, SPRINT_NOW] },
  'SHOP-113': { days: 20, sprints: [SPRINT_NOW] },
  'SHOP-12': { days: 30, sprints: [SPRINT_NEXT] },
  'SHOP-13': { days: 9, sprints: [SPRINT_OLD, SPRINT_NOW] },
  'SHOP-14': { days: 45 },
  'SHOP-21': { days: 0.3, sprints: [SPRINT_NOW] },
  'SHOP-211': { days: 6, sprints: [SPRINT_OLD] },
  'SHOP-212': { days: 2, sprints: [SPRINT_NOW] },
  'SHOP-22': { days: 25, sprints: [SPRINT_NEXT] },
  'SHOP-23': { days: 12, sprints: [SPRINT_OLD] },
  'SHOP-24': { days: 3, sprints: [SPRINT_NOW] },
  'SHOP-25': { days: 1.5, sprints: [SPRINT_NOW] },
  'SHOP-31': { days: 40, sprints: [SPRINT_NEXT] },
  'SHOP-32': { days: 60 },
  'SHOP-33': { days: 1, sprints: [SPRINT_OLD, SPRINT_NOW] },
  'SHOP-34': { days: 33 },
  'SHOP-35': { days: 33 },
  'PLAT-7': { days: 11 },
  'PLAT-12': { days: 50 },
  'PLAT-40': { days: 20 },
};

function buildIssues(): Map<string, RawIssue> {
  const byKey = new Map(DEFS.map((d) => [d.key, d]));
  const ref = (key: string): RawIssueRef => {
    const d = byKey.get(key)!;
    return {
      key,
      fields: {
        summary: d.summary,
        status: { name: d.status[0], statusCategory: { key: d.status[1] } },
        issuetype: { name: d.type, subtask: d.type === 'Sub-task' },
        priority: d.priority ? { name: d.priority } : undefined,
      },
    };
  };
  const out = new Map<string, RawIssue>();
  DEFS.forEach((d, idx) => {
    const r = ref(d.key);
    out.set(d.key, {
      id: String(10000 + idx),
      key: d.key,
      fields: {
        ...r.fields,
        assignee: d.assignee ? { displayName: d.assignee } : null,
        parent: d.parent ? ref(d.parent) : undefined,
        subtasks: [],
        issuelinks: [],
        labels: d.labels ?? [],
        // Long-untouched items stay untouched (the Planning lens flags them as idle).
        updated: new Date(Date.now() - ((PLAN[d.key]?.days ?? 0) >= 30 ? PLAN[d.key].days * DAY : idx * 3600_000)).toISOString(),
        created: new Date(Date.now() - 70 * DAY).toISOString(),
        statuscategorychangedate: new Date(Date.now() - (PLAN[d.key]?.days ?? 5) * DAY).toISOString(),
        resolutiondate: d.status[1] === 'done' ? new Date(Date.now() - (PLAN[d.key]?.days ?? 5) * DAY).toISOString() : null,
        customfield_10020: PLAN[d.key]?.sprints ?? null,
      },
    });
  });
  for (const d of DEFS) {
    if (d.parent && d.type === 'Sub-task') out.get(d.parent)!.fields.subtasks!.push(ref(d.key));
  }
  LINKS.forEach(([from, t, to], idx) => {
    const type = LINK_TYPES[t];
    const id = String(20000 + idx);
    const l1: RawIssueLink = { id, type, outwardIssue: ref(to) };
    const l2: RawIssueLink = { id, type, inwardIssue: ref(from) };
    out.get(from)!.fields.issuelinks!.push(l1);
    out.get(to)!.fields.issuelinks!.push(l2);
  });
  return out;
}

/** Tiny JQL "interpreter" supporting only what GraphSession generates. */
export class DemoSource implements IssueSource {
  readonly baseUrl = 'https://demo.atlassian.net';
  private readonly issues = buildIssues();
  private seq = 0;

  /** Supports the predicates GraphSession generates, combined with AND. */
  async search(jql: string): Promise<RawIssue[]> {
    await new Promise((r) => setTimeout(r, 120));
    const list = (re: RegExp) => (re.exec(jql)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    let out = [...this.issues.values()];
    let narrowed = false;
    if (/\bkey in \(/.test(jql)) {
      const keys = new Set(list(/\bkey in \(([^)]*)\)/));
      out = out.filter((i) => keys.has(i.key));
      narrowed = true;
    }
    if (/\bid in \(/.test(jql)) {
      const ids = new Set(list(/\bid in \(([^)]*)\)/));
      out = out.filter((i) => ids.has(i.id));
      narrowed = true;
    }
    if (/\bparent in \(/.test(jql)) {
      const parents = new Set(list(/\bparent in \(([^)]*)\)/));
      out = out.filter((i) => i.fields.parent && parents.has(i.fields.parent.key));
      narrowed = true;
    }
    const since = /\bupdated >= (\d+)/.exec(jql);
    if (since) {
      out = out.filter((i) => Date.parse(i.fields.updated ?? '') >= Number(since[1]));
      out.sort((a, b) => Date.parse(a.fields.updated!) - Date.parse(b.fields.updated!) || a.key.localeCompare(b.key));
      narrowed = true;
    }
    if (/issuetype\s*=\s*Epic/i.test(jql)) out = out.filter((i) => i.key.startsWith('SHOP-') && i.fields.issuetype?.name === 'Epic');
    else if (!narrowed) out = out.filter((i) => i.key.startsWith('SHOP-'));
    // Copies, like a real API response: simulated edits must not leak into what callers hold.
    return structuredClone(out);
  }

  async presence(ids: string[]): Promise<Map<string, string>> {
    const wanted = new Set(ids);
    return new Map([...this.issues.values()].filter((i) => wanted.has(i.id)).map((i) => [i.id, i.key]));
  }

  // ── Simulation, so live sync can be tried without Jira ─────────────────────

  /** Moves a random open issue one status forward; returns its key. */
  simulateChange(): string {
    const order: [string, string][] = [['To Do', 'new'], ['In Progress', 'indeterminate'], ['In Review', 'indeterminate'], ['Done', 'done']];
    const open = [...this.issues.values()].filter((i) => i.fields.status?.statusCategory?.key !== 'done');
    const i = open[(this.seq++ * 7) % open.length];
    const idx = order.findIndex(([n]) => n === i.fields.status?.name);
    const [name, key] = order[Math.min(order.length - 1, idx + 1)];
    i.fields.status = { name, statusCategory: { key } };
    i.fields.statuscategorychangedate = new Date().toISOString();
    if (key === 'done') i.fields.resolutiondate = new Date().toISOString();
    this.touch(i);
    return i.key;
  }

  /** Adds a new story under the given parent; returns its key. */
  simulateCreate(parentKey = 'SHOP-30'): string {
    const parent = this.issues.get(parentKey)!;
    const key = `SHOP-${900 + this.seq++}`;
    this.issues.set(key, {
      id: String(30000 + this.seq),
      key,
      fields: {
        summary: 'New story created while the graph was open',
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        issuetype: { name: 'Story', subtask: false },
        parent: { key: parentKey, fields: { summary: parent.fields.summary, status: parent.fields.status, issuetype: parent.fields.issuetype } },
        subtasks: [],
        issuelinks: [],
        labels: [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      },
    });
    return key;
  }

  /** Deletes an issue (and its links on other issues, like Jira does); returns its key. */
  simulateDelete(key: string): string {
    this.issues.delete(key);
    for (const i of this.issues.values()) {
      const before = i.fields.issuelinks?.length ?? 0;
      i.fields.issuelinks = (i.fields.issuelinks ?? []).filter((l) => (l.outwardIssue ?? l.inwardIssue)!.key !== key);
      if (i.fields.subtasks) i.fields.subtasks = i.fields.subtasks.filter((st) => st.key !== key);
      if (i.fields.parent?.key === key) i.fields.parent = undefined;
      if ((i.fields.issuelinks?.length ?? 0) !== before) this.touch(i);
    }
    return key;
  }

  private touch(i: RawIssue) {
    i.fields.updated = new Date(Math.max(Date.now(), Date.parse(i.fields.updated ?? '') + 1)).toISOString();
  }
}
