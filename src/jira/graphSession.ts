import { GraphIssue, GraphLink, GraphModel, GraphSource, StatusCategory, linkCategory } from '../shared/model';
import { JiraError } from './client';
import { IssueSource, RawIssue, RawIssueRef } from './types';

export interface SessionOptions {
  /** How many rounds of "follow links / parents / children" to run after the initial query. */
  depth: number;
  maxIssues: number;
  includeChildren: boolean;
  epicLinkField?: string;
  storyPointsField?: string;
}

type Progress = (message: string) => void;

const BATCH = 50;

/**
 * Holds the raw issues fetched for one graph and knows how to grow it
 * (initial query, depth expansion, on-demand expansion of single nodes).
 */
export class GraphSession {
  private raw = new Map<string, RawIssue>();
  private childrenQueried = new Set<string>();
  private roots: string[] = [];
  private truncated = false;

  constructor(
    readonly issues: IssueSource,
    readonly source: GraphSource,
    private readonly opts: SessionOptions,
  ) {}

  private get fields(): string[] {
    const f = ['summary', 'issuetype', 'status', 'priority', 'assignee', 'parent', 'subtasks', 'issuelinks', 'labels', 'updated'];
    if (this.opts.epicLinkField) f.push(this.opts.epicLinkField);
    if (this.opts.storyPointsField) f.push(this.opts.storyPointsField);
    return f;
  }

  get title(): string {
    const s = this.source;
    if (s.kind === 'demo') return 'Demo: Online Shop';
    if (s.kind === 'keys' && !s.title) return `Around ${s.keys.join(', ')}`;
    if (s.title) return s.title;
    return s.kind === 'jql' ? s.jql : s.keys.join(', ');
  }

  async load(progress: Progress, signal?: AbortSignal): Promise<void> {
    this.raw.clear();
    this.childrenQueried.clear();
    this.truncated = false;

    progress('Running query…');
    const s = this.source;
    const jql = s.kind === 'jql' ? s.jql : s.kind === 'keys' ? keyJql(s.keys) : 'project = SHOP AND issuetype = Epic';
    const first = await this.issues.search(jql, this.fields, this.opts.maxIssues, signal);
    this.add(first);
    this.roots = first.map((i) => i.key);

    let frontier = this.roots;
    for (let d = 0; d < this.opts.depth && frontier.length && !this.full; d++) {
      progress(`Expanding relations (level ${d + 1}/${this.opts.depth}, ${this.raw.size} issues)…`);
      const children = this.opts.includeChildren ? await this.fetchChildren(frontier, signal) : [];
      const refs = this.unloadedRefs(frontier);
      const fetched = await this.fetchKeys(refs, signal);
      frontier = [...children, ...fetched];
    }
  }

  /** Fetches the given keys if they are stubs, plus their children. */
  async expand(keys: string[], progress: Progress, signal?: AbortSignal): Promise<void> {
    progress(`Expanding ${keys.join(', ')}…`);
    await this.fetchKeys(keys.filter((k) => !this.raw.has(k)), signal);
    await this.fetchChildren(keys, signal);
    // Pull in the direct relations too, so the neighbourhood becomes fully loaded.
    await this.fetchKeys(this.unloadedRefs(keys), signal);
  }

  private get full(): boolean {
    if (this.raw.size >= this.opts.maxIssues) this.truncated = true;
    return this.truncated;
  }

  private add(issues: RawIssue[]): string[] {
    const added: string[] = [];
    for (const i of issues) {
      if (!this.raw.has(i.key)) {
        if (this.raw.size >= this.opts.maxIssues) {
          this.truncated = true;
          continue;
        }
        added.push(i.key);
      }
      this.raw.set(i.key, i);
    }
    return added;
  }

  private remaining(): number {
    return Math.max(0, this.opts.maxIssues - this.raw.size);
  }

  private async fetchKeys(keys: string[], signal?: AbortSignal): Promise<string[]> {
    const added: string[] = [];
    for (const batch of chunks(keys, BATCH)) {
      if (this.full) break;
      added.push(...this.add(await this.searchTolerant(batch, signal)));
    }
    return added;
  }

  /** `key in (...)` fails as a whole if one key is missing or hidden, so split and retry. */
  private async searchTolerant(keys: string[], signal?: AbortSignal): Promise<RawIssue[]> {
    try {
      return await this.issues.search(keyJql(keys), this.fields, Math.min(keys.length, this.remaining()), signal);
    } catch (e) {
      if (!(e instanceof JiraError) || e.status !== 400) throw e;
      if (keys.length === 1) return [];
      const mid = Math.ceil(keys.length / 2);
      return [
        ...(await this.searchTolerant(keys.slice(0, mid), signal)),
        ...(await this.searchTolerant(keys.slice(mid), signal)),
      ];
    }
  }

  private async fetchChildren(keys: string[], signal?: AbortSignal): Promise<string[]> {
    const parents = keys.filter((k) => {
      const i = this.raw.get(k);
      return i && !i.fields.issuetype?.subtask && !this.childrenQueried.has(k);
    });
    parents.forEach((k) => this.childrenQueried.add(k));
    const added: string[] = [];
    for (const batch of chunks(parents, BATCH)) {
      if (this.full) break;
      const list = batch.join(',');
      let jql = `parent in (${list})`;
      if (this.opts.epicLinkField) jql += ` OR ${jqlField(this.opts.epicLinkField)} in (${list})`;
      try {
        added.push(...this.add(await this.issues.search(jql, this.fields, this.remaining(), signal)));
      } catch (e) {
        if (!(e instanceof JiraError) || e.status !== 400) throw e;
      }
    }
    return added;
  }

  private unloadedRefs(keys: string[]): string[] {
    const refs = new Set<string>();
    for (const k of keys) {
      const f = this.raw.get(k)?.fields;
      if (!f) continue;
      const parent = this.parentKeyOf(this.raw.get(k)!);
      if (parent) refs.add(parent);
      f.subtasks?.forEach((s) => refs.add(s.key));
      f.issuelinks?.forEach((l) => refs.add((l.inwardIssue ?? l.outwardIssue)!.key));
    }
    return [...refs].filter((k) => !this.raw.has(k));
  }

  private parentKeyOf(i: RawIssue): string | undefined {
    if (i.fields.parent?.key) return i.fields.parent.key;
    const epic = this.opts.epicLinkField ? i.fields[this.opts.epicLinkField] : undefined;
    return typeof epic === 'string' && epic ? epic : undefined;
  }

  toModel(): GraphModel {
    const base = this.issues.baseUrl;
    const issues = new Map<string, GraphIssue>();
    const links = new Map<string, GraphLink>();

    const stub = (ref: RawIssueRef, parentKey?: string) => {
      if (issues.has(ref.key) || this.raw.has(ref.key)) return;
      issues.set(ref.key, {
        key: ref.key,
        summary: ref.fields?.summary ?? '',
        type: ref.fields?.issuetype?.name ?? 'Unknown',
        isSubtask: !!ref.fields?.issuetype?.subtask,
        status: ref.fields?.status?.name ?? '',
        statusCategory: category(ref.fields?.status?.statusCategory?.key),
        priority: ref.fields?.priority?.name,
        labels: [],
        parentKey,
        url: `${base}/browse/${ref.key}`,
        loaded: false,
      });
    };

    for (const i of this.raw.values()) {
      const f = i.fields;
      const sp = this.opts.storyPointsField ? f[this.opts.storyPointsField] : undefined;
      issues.set(i.key, {
        key: i.key,
        summary: f.summary ?? '',
        type: f.issuetype?.name ?? 'Unknown',
        isSubtask: !!f.issuetype?.subtask,
        status: f.status?.name ?? '',
        statusCategory: category(f.status?.statusCategory?.key),
        priority: f.priority?.name,
        assignee: f.assignee?.displayName,
        labels: f.labels ?? [],
        parentKey: this.parentKeyOf(i),
        storyPoints: typeof sp === 'number' ? sp : undefined,
        updated: f.updated,
        url: `${base}/browse/${i.key}`,
        loaded: true,
      });
    }

    for (const i of this.raw.values()) {
      const f = i.fields;
      if (f.parent) stub(f.parent);
      f.subtasks?.forEach((s) => stub(s, i.key));
      for (const l of f.issuelinks ?? []) {
        const other = l.outwardIssue ?? l.inwardIssue!;
        stub(other);
        const [from, to] = l.outwardIssue ? [i.key, other.key] : [other.key, i.key];
        if (!links.has(l.id)) {
          links.set(l.id, {
            id: l.id,
            from,
            to,
            name: l.type.name,
            label: l.type.outward,
            category: linkCategory(l.type.name, l.type.outward),
          });
        }
      }
    }

    return {
      title: this.title,
      source: this.source,
      baseUrl: base,
      issues: [...issues.values()],
      links: [...links.values()],
      roots: this.roots,
      truncated: this.truncated,
      fetchedAt: new Date().toISOString(),
    };
  }
}

function category(key?: string): StatusCategory {
  return key === 'done' || key === 'indeterminate' ? key : 'new';
}

function keyJql(keys: string[]): string {
  return `key in (${keys.join(',')})`;
}

/** customfield_10014 -> cf[10014]; everything else is quoted as a field name. */
function jqlField(field: string): string {
  const m = /^customfield_(\d+)$/.exec(field);
  return m ? `cf[${m[1]}]` : `"${field}"`;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
