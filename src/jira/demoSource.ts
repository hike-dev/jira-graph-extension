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
        updated: new Date(Date.now() - idx * 3600_000).toISOString(),
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

  async search(jql: string): Promise<RawIssue[]> {
    await new Promise((r) => setTimeout(r, 120));
    const list = (re: RegExp) => (re.exec(jql)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const all = [...this.issues.values()];
    if (/key in \(/.test(jql)) {
      const keys = new Set(list(/key in \(([^)]*)\)/));
      return all.filter((i) => keys.has(i.key));
    }
    if (/parent in \(/.test(jql)) {
      const parents = new Set(list(/parent in \(([^)]*)\)/));
      return all.filter((i) => i.fields.parent && parents.has(i.fields.parent.key));
    }
    if (/issuetype\s*=\s*Epic/i.test(jql)) {
      return all.filter((i) => i.key.startsWith('SHOP-') && i.fields.issuetype?.name === 'Epic');
    }
    return all.filter((i) => i.key.startsWith('SHOP-'));
  }
}
