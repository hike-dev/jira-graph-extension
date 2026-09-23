import { GraphIssue, GraphLink, GraphModel, GraphSource, SprintRef, StatusCategory, linkCategory } from '../shared/model';
import { JiraError } from './client';
import { IssueSource, RawIssue, RawIssueRef } from './types';

export interface SessionOptions {
  /** How many rounds of "follow links / parents / children" to run after the initial query. */
  depth: number;
  maxIssues: number;
  includeChildren: boolean;
  epicLinkField?: string;
  storyPointsField?: string;
  /** Sprint custom field id; `customfield_10020` on most Jira Cloud sites. */
  sprintField?: string;
  /** Sync: re-read this much before the cursor, to catch issues the search index surfaced late. */
  overlapMs?: number;
  /** Sync: how often to check that loaded issues still exist (deleted / no access / moved). */
  presenceIntervalMs?: number;
}

export interface SyncResult {
  changed: string[];
  added: string[];
  /** Deleted, or no longer visible to the user — Jira does not distinguish the two. */
  removed: string[];
  /** Moved to another project: old key → new key. */
  renamed: [string, string][];
  checkedPresence: boolean;
}

const DEFAULT_OVERLAP_MS = 5 * 60_000;
const DEFAULT_PRESENCE_MS = 10 * 60_000;
/** Beyond this many recently-updated issues site-wide, check only the loaded keys instead. */
const FEED_CAP = 500;
/** Removed keys are remembered this long so a lagging search result cannot resurrect them. */
const TOMBSTONE_MS = 24 * 3600_000;

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
  /** Newest `updated` seen (epoch ms, server clock) — the sync cursor. */
  private cursorMs = 0;
  private lastPresenceAt = 0;
  private tombstones = new Map<string, number>();

  constructor(
    readonly issues: IssueSource,
    readonly source: GraphSource,
    private opts: SessionOptions,
  ) {}

  setSyncOptions(o: Pick<SessionOptions, 'overlapMs' | 'presenceIntervalMs'>) {
    this.opts = { ...this.opts, overlapMs: o.overlapMs, presenceIntervalMs: o.presenceIntervalMs };
  }

  private get fields(): string[] {
    const f = ['summary', 'issuetype', 'status', 'priority', 'assignee', 'parent', 'subtasks', 'issuelinks', 'labels', 'updated',
      'created', 'statuscategorychangedate', 'resolutiondate', 'duedate', 'fixVersions'];
    if (this.opts.sprintField) f.push(this.opts.sprintField);
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
    this.tombstones.clear();
    this.lastPresenceAt = Date.now();

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
    this.cursorMs = this.maxUpdated();
  }

  /** Fetches the given keys if they are stubs, plus their children. */
  async expand(keys: string[], progress: Progress, signal?: AbortSignal): Promise<void> {
    progress(`Expanding ${keys.join(', ')}…`);
    await this.fetchKeys(keys.filter((k) => !this.raw.has(k)), signal);
    await this.fetchChildren(keys, signal);
    // Pull in the direct relations too, so the neighbourhood becomes fully loaded.
    await this.fetchKeys(this.unloadedRefs(keys), signal);
  }

  /**
   * Incremental sync. One cheap query for everything updated since the cursor (minus an overlap),
   * then full fetches only for issues that really changed or newly belong to the graph.
   * Every `presenceIntervalMs` (or when forced) also checks that loaded issues still exist.
   */
  async sync(opts: { forcePresence?: boolean } = {}, signal?: AbortSignal): Promise<SyncResult> {
    const result: SyncResult = { changed: [], added: [], removed: [], renamed: [], checkedPresence: false };
    const now = Date.now();
    for (const [k, t] of this.tombstones) if (now - t > TOMBSTONE_MS) this.tombstones.delete(k);
    if (!this.cursorMs) this.cursorMs = this.maxUpdated();
    const since = Math.max(0, this.cursorMs - (this.opts.overlapMs ?? DEFAULT_OVERLAP_MS));

    // 1. Change feed: epoch milliseconds are UTC and exact (absolute date strings use the profile time zone).
    let feed = await this.issues.search(`updated >= ${since} ORDER BY updated ASC, key ASC`, ['updated'], FEED_CAP, signal);
    if (feed.length >= FEED_CAP) {
      // Very busy site: fall back to checking only what the graph holds.
      feed = [];
      for (const batch of chunks([...this.raw.keys()], BATCH)) {
        feed.push(...(await this.issues.search(`${keyJql(batch)} AND updated >= ${since}`, ['updated'], batch.length, signal)));
      }
    }
    for (const f of feed) this.cursorMs = Math.max(this.cursorMs, ms(f.fields.updated));

    const changed = feed.filter((f) => this.raw.has(f.key) && ms(this.raw.get(f.key)!.fields.updated) !== ms(f.fields.updated)).map((f) => f.key);
    const unknown = feed.filter((f) => !this.raw.has(f.key)).map((f) => f.key);

    // 2. Refresh changed issues in full.
    if (changed.length) {
      for (const batch of chunks(changed, BATCH)) this.add(await this.searchTolerant(batch, signal));
      result.changed.push(...changed);
    }

    // 3. Unknown issues join the graph when they match the query, are children of a loaded issue,
    //    or link to one. Tombstoned keys must prove they exist again first (presence below).
    if (unknown.length) {
      const fresh: RawIssue[] = [];
      for (const batch of chunks(unknown, BATCH)) fresh.push(...(await this.searchTolerant(batch, signal)));
      const matchesQuery = new Set<string>();
      const where = this.sourceWhere();
      if (where) {
        for (const batch of chunks(fresh.map((i) => i.key), BATCH)) {
          try {
            const hits = await this.issues.search(`(${where}) AND ${keyJql(batch)}`, ['updated'], batch.length, signal);
            hits.forEach((h) => matchesQuery.add(h.key));
          } catch (e) {
            if (!(e instanceof JiraError) || e.status !== 400) throw e;
          }
        }
      }
      const joins = fresh.filter((i) => {
        const parent = this.parentKeyOf(i);
        return (
          matchesQuery.has(i.key) ||
          (this.opts.includeChildren && !!parent && this.raw.has(parent)) ||
          (i.fields.issuelinks ?? []).some((l) => this.raw.has((l.outwardIssue ?? l.inwardIssue)!.key))
        );
      });
      const revived = joins.filter((i) => this.tombstones.has(i.key));
      revived.forEach((i) => this.tombstones.delete(i.key));
      const added = this.add(joins);
      matchesQuery.forEach((k) => !this.roots.includes(k) && this.roots.push(k));
      result.added.push(...added);
    }

    // 4. Deletions / lost access / moves: absent from any "updated" feed, so check presence explicitly.
    if (opts.forcePresence || now - this.lastPresenceAt >= (this.opts.presenceIntervalMs ?? DEFAULT_PRESENCE_MS)) {
      await this.checkPresence(result, signal);
    }
    return result;
  }

  private async checkPresence(result: SyncResult, signal?: AbortSignal) {
    this.lastPresenceAt = Date.now();
    result.checkedPresence = true;
    const byId = new Map([...this.raw.values()].map((i) => [i.id, i.key]));
    const ids = [...byId.keys()];
    if (!ids.length) return;
    let present: Map<string, string>;
    try {
      if (!this.issues.presence) throw new JiraError('no bulk presence', 501);
      present = await this.issues.presence(ids, signal);
    } catch (e) {
      if (!(e instanceof JiraError) || (e.status !== 501 && e.status !== 404)) throw e;
      present = new Map();
      for (const batch of chunks(ids, BATCH)) {
        const found = await this.searchTolerantJql(batch, (b) => `id in (${b.join(',')})`, signal);
        found.forEach((i) => present.set(i.id, i.key));
      }
    }
    const moved: string[] = [];
    for (const [id, key] of byId) {
      const now = present.get(id);
      if (now === undefined) {
        this.raw.delete(key);
        this.tombstones.set(key, Date.now());
        this.roots = this.roots.filter((k) => k !== key);
        result.removed.push(key);
      } else if (now !== key) {
        this.raw.delete(key);
        this.tombstones.set(key, Date.now());
        this.roots = this.roots.map((k) => (k === key ? now : k));
        result.renamed.push([key, now]);
        moved.push(now);
      }
    }
    if (moved.length) this.add(await this.searchTolerant(moved, signal));
    // Issues that linked to removed/moved ones: their links changed, so refresh them.
    const gone = new Set([...result.removed, ...result.renamed.map(([k]) => k)]);
    if (gone.size) {
      const affected = [...this.raw.values()]
        .filter((i) => this.parentKeyOf(i) && gone.has(this.parentKeyOf(i)!) || (i.fields.issuelinks ?? []).some((l) => gone.has((l.outwardIssue ?? l.inwardIssue)!.key)))
        .map((i) => i.key);
      for (const batch of chunks(affected, BATCH)) this.add(await this.searchTolerant(batch, signal));
    }
  }

  /** The source query's WHERE part (ORDER BY stripped), used to test whether new issues match it. */
  private sourceWhere(): string | undefined {
    const s = this.source;
    const jql = s.kind === 'jql' ? s.jql : s.kind === 'demo' ? 'project = SHOP AND issuetype = Epic' : undefined;
    return jql?.replace(/\border\s+by\b[\s\S]*$/i, '').trim() || undefined;
  }

  private maxUpdated(): number {
    let m = 0;
    for (const i of this.raw.values()) m = Math.max(m, ms(i.fields.updated));
    return m;
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
  private searchTolerant(keys: string[], signal?: AbortSignal): Promise<RawIssue[]> {
    return this.searchTolerantJql(keys, keyJql, signal);
  }

  private async searchTolerantJql(items: string[], jql: (batch: string[]) => string, signal?: AbortSignal): Promise<RawIssue[]> {
    if (!items.length) return [];
    try {
      return await this.issues.search(jql(items), this.fields, Math.max(items.length, 1), signal);
    } catch (e) {
      if (!(e instanceof JiraError) || e.status !== 400) throw e;
      if (items.length === 1) return [];
      const mid = Math.ceil(items.length / 2);
      return [
        ...(await this.searchTolerantJql(items.slice(0, mid), jql, signal)),
        ...(await this.searchTolerantJql(items.slice(mid), jql, signal)),
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

    const gone = (k?: string) => !!k && this.tombstones.has(k) && !this.raw.has(k);
    const stub = (ref: RawIssueRef, parentKey?: string) => {
      if (issues.has(ref.key) || this.raw.has(ref.key) || gone(ref.key)) return;
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
        parentKey: gone(this.parentKeyOf(i)) ? undefined : this.parentKeyOf(i),
        storyPoints: typeof sp === 'number' ? sp : undefined,
        updated: f.updated,
        created: str(f.created),
        statusChangedAt: str(f.statuscategorychangedate),
        resolvedAt: str(f.resolutiondate),
        dueDate: str(f.duedate),
        fixVersions: Array.isArray(f.fixVersions) ? (f.fixVersions as { name?: string }[]).map((v) => v.name ?? '').filter(Boolean) : undefined,
        sprints: this.opts.sprintField ? parseSprints(f[this.opts.sprintField]) : undefined,
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
        if (gone(other.key)) continue;
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

function ms(iso: unknown): number {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Sprint field values: Cloud returns objects `{ name, state }`; Server/DC returns strings like
 * `com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=1,state=ACTIVE,name=Sprint 7,...]`.
 */
export function parseSprints(v: unknown): SprintRef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SprintRef[] = [];
  for (const s of v) {
    let name: string | undefined;
    let state: string | undefined;
    if (s && typeof s === 'object') ({ name, state } = s as { name?: string; state?: string });
    else if (typeof s === 'string') {
      name = /[[,]name=([^,\]]*)/.exec(s)?.[1];
      state = /[[,]state=([^,\]]*)/.exec(s)?.[1];
    }
    const st = state?.toLowerCase();
    if (name && (st === 'active' || st === 'future' || st === 'closed')) out.push({ name, state: st });
  }
  return out;
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
