import { GraphIssue, GraphLink, GraphModel, GraphSource, IssueScope, ScopeConfig, ScopeInfo, SprintRef, StatusCategory, Truncation, linkCategory } from '../shared/model';
import { classify, select, Selection } from './scope';
import { JiraError } from './client';
import { IssueSource, RawIssue, RawIssueRef, SearchPage } from './types';

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
  /** Scoped graphs: most tickets indexed from the query's universe. */
  indexLimit?: number;
}

/** Everything needed to rebuild a session without Jira (see GraphCache). Raw issues are kept as fetched. */
export interface SessionSnapshot {
  raw: RawIssue[];
  roots: string[];
  childrenQueried: string[];
  query: { loaded: number; more: boolean; total?: number };
  skipped: string[];
  childrenCut: boolean;
  cursorMs: number;
  tombstones: [string, number][];
  index: RawIssue[];
  indexMeta: { capped: boolean; total?: number };
  inclusion: [string, IssueScope][];
  requested: string[];
  outside: RawIssue[];
  scope?: ScopeConfig;
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
const INDEX_LIMIT = 2000;
/** Upper bound for a keys-only children probe per batch of parents. */
const CHILD_PROBE = 1000;

/**
 * Holds the raw issues fetched for one graph and knows how to grow it
 * (initial query, depth expansion, on-demand expansion of single nodes).
 */
export class GraphSession {
  private raw = new Map<string, RawIssue>();
  private childrenQueried = new Set<string>();
  private roots: string[] = [];
  /** What the limit really cut — only these make the graph "truncated". */
  private query: { loaded: number; more: boolean; total?: number } = { loaded: 0, more: false };
  private skipped = new Set<string>();
  private childrenCut = false;

  // ── Load scope (see scope.ts) ──
  /** The query's universe with full fields; the scope picks from it locally. */
  private index = new Map<string, RawIssue>();
  private indexMeta: { capped: boolean; total?: number } = { capped: false };
  private selection: Selection | undefined;
  /** Why each loaded ticket is in the graph. */
  private inclusion = new Map<string, IssueScope>();
  /** Loaded on request ("Load more" / expand), kept across scope changes. */
  private requested = new Set<string>();
  /** Context tickets outside the universe (e.g. an epic in another project), kept so re-scoping needs no request. */
  private outside = new Map<string, RawIssue>();
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

  /** Identity + options that decide what a snapshot contains; a different value means it cannot be reused. */
  cacheKey(): { key: string; fingerprint: unknown } | undefined {
    const s = this.source;
    if (s.kind === 'demo' || (s.kind === 'keys' && s.demo)) return undefined;
    const ident = s.kind === 'jql' ? { jql: s.jql, scoped: !!s.scope?.enabled } : { keys: [...s.keys].sort() };
    const o = this.opts;
    return {
      key: JSON.stringify({ base: this.issues.baseUrl, kind: s.kind, ...ident }),
      fingerprint: {
        fields: this.fields,
        depth: o.depth, maxIssues: o.maxIssues, includeChildren: o.includeChildren,
        epicLinkField: o.epicLinkField, storyPointsField: o.storyPointsField, sprintField: o.sprintField, indexLimit: o.indexLimit,
      },
    };
  }

  snapshot(): SessionSnapshot {
    return {
      raw: [...this.raw.values()],
      roots: this.roots,
      childrenQueried: [...this.childrenQueried],
      query: this.query,
      skipped: [...this.skipped],
      childrenCut: this.childrenCut,
      cursorMs: this.cursorMs,
      tombstones: [...this.tombstones],
      index: [...this.index.values()],
      indexMeta: this.indexMeta,
      inclusion: [...this.inclusion],
      requested: [...this.requested],
      outside: [...this.outside.values()],
      scope: this.scoped,
    };
  }

  /**
   * Rebuild from a snapshot without any request. If the scope settings changed since it was taken,
   * re-scope locally from the cached index. The caller then syncs from the cursor to catch up.
   */
  async restore(snap: SessionSnapshot, progress: Progress = () => {}, signal?: AbortSignal) {
    this.raw = new Map(snap.raw.map((i) => [i.key, i]));
    this.roots = snap.roots;
    this.childrenQueried = new Set(snap.childrenQueried);
    this.query = snap.query;
    this.skipped = new Set(snap.skipped);
    this.childrenCut = snap.childrenCut;
    this.cursorMs = snap.cursorMs;
    this.tombstones = new Map(snap.tombstones);
    this.index = new Map(snap.index.map((i) => [i.key, i]));
    this.indexMeta = snap.indexMeta;
    this.inclusion = new Map(snap.inclusion);
    this.requested = new Set(snap.requested);
    this.outside = new Map(snap.outside.map((i) => [i.key, i]));
    // Force the deletion / move check on the first sync after a restore.
    this.lastPresenceAt = 0;
    const cfg = this.scoped;
    if (cfg && this.index.size) {
      if (JSON.stringify(cfg) !== JSON.stringify(snap.scope)) await this.applyScope(progress, signal);
      else this.selection = select([...this.index.values()], cfg, { sprintField: this.opts.sprintField, epicLinkField: this.opts.epicLinkField });
    }
  }

  private get scoped(): ScopeConfig | undefined {
    return this.source.kind === 'jql' && this.source.scope?.enabled ? this.source.scope : undefined;
  }

  /** Scoped graph: index the whole universe once, then choose locally (no refetch on scope changes). */
  private async loadScoped(jql: string, progress: Progress, signal?: AbortSignal) {
    progress('Indexing the query…');
    const idx = await this.page(jql, this.opts.indexLimit ?? INDEX_LIMIT, signal);
    this.index = new Map(idx.issues.map((i) => [i.key, i]));
    this.indexMeta = { capped: idx.hasMore };
    if (idx.hasMore && this.issues.count) {
      try {
        this.indexMeta.total = await this.issues.count(jql, signal);
      } catch {
        // Only for the message.
      }
    }
    // Leaving tickets out is the scope's intent, not truncation.
    this.query = { loaded: idx.issues.length, more: false };
    await this.applyScope(progress, signal);
    let m = 0;
    for (const i of this.index.values()) m = Math.max(m, ms(i.fields.updated));
    this.cursorMs = m;
  }

  /** Change the scope. With an index in hand this is local and fast; turning it off reloads the query as-is. */
  async setScope(cfg: ScopeConfig, progress: Progress, signal?: AbortSignal) {
    if (this.source.kind !== 'jql') return;
    (this.source as { scope?: ScopeConfig }).scope = cfg;
    if (cfg.enabled && this.index.size) await this.applyScope(progress, signal);
    else await this.load(progress, signal);
  }

  /** Load every left-out child of a parent (the "+N more" chip). */
  async loadMore(parent: string, progress: Progress, signal?: AbortSignal) {
    const kids = [...this.index.values()].filter((i) => this.parentKeyOf(i) === parent && !this.raw.has(i.key));
    progress(`Loading ${kids.length} more under ${parent}…`);
    kids.forEach((i) => this.requested.add(i.key));
    const added = this.add(kids);
    for (const k of added) this.inclusion.set(k, { tier: 'requested', reasons: [`Loaded on request under ${parent}`] });
    if (this.scoped?.context) await this.addContext(added, signal);
  }

  private async applyScope(progress: Progress, signal?: AbortSignal) {
    const cfg = this.scoped!;
    progress('Choosing tickets for the scope…');
    const sel = select([...this.index.values()], cfg, { sprintField: this.opts.sprintField, epicLinkField: this.opts.epicLinkField });
    this.selection = sel;
    this.raw.clear();
    this.inclusion.clear();
    this.skipped.clear();
    this.childrenCut = false;
    const want = [...sel.keys, ...[...this.requested].filter((k) => this.index.has(k) && !sel.keys.includes(k))];
    // In priority order, so a hard limit drops backlog before done before sprint work.
    this.add(want.map((k) => this.index.get(k)!));
    for (const k of this.raw.keys()) {
      const c = sel.classified.get(k)!;
      const tier = this.requested.has(k) && c.tier !== 'sprint' ? 'requested' : c.tier === 'oldDone' ? 'done' : c.tier;
      this.inclusion.set(k, {
        tier,
        rank: sel.rank.get(k),
        score: Number.isFinite(c.score) && c.tier === 'backlog' ? Math.round(c.score) : undefined,
        reasons: tier === 'requested' ? ['Loaded on request'] : c.reasons.map((r) => (r.points ? `${r.label} (+${Math.round(r.points)})` : r.label)),
      });
    }
    this.roots = [...this.raw.keys()].filter((k) => sel.classified.get(k)?.tier === 'sprint');
    if (cfg.context) await this.addContext([...this.raw.keys()], signal);
  }

  /**
   * Context for loaded tickets: their parent chain and directly linked tickets. Taken from the index
   * when possible (no request), fetched otherwise (e.g. an epic in another project).
   */
  private async addContext(keys: string[], signal?: AbortSignal) {
    const why = new Map<string, string>();
    const linkNeed: string[] = [];
    for (const k of keys) {
      for (const l of this.raw.get(k)?.fields.issuelinks ?? []) {
        const o = (l.outwardIssue ?? l.inwardIssue)!.key;
        if (!this.raw.has(o) && !why.has(o)) {
          why.set(o, `${l.outwardIssue ? l.type.inward : l.type.outward} ${k}`.replace(/^./, (c) => c.toUpperCase()));
          linkNeed.push(o);
        }
      }
    }
    let frontier = keys;
    const need = new Set(linkNeed);
    for (let level = 0; level < 4; level++) {
      for (const k of frontier) {
        const p = this.raw.get(k) ? this.parentKeyOf(this.raw.get(k)!) : undefined;
        if (p && !this.raw.has(p)) {
          need.add(p);
          if (!why.has(p)) why.set(p, `Parent of ${k}`);
        }
      }
      if (!need.size) break;
      const known = (k: string) => this.index.get(k) ?? this.outside.get(k);
      const added = this.add([...need].filter((k) => known(k)).map((k) => known(k)!));
      const fetched = await this.fetchKeys([...need].filter((k) => !known(k)), signal);
      for (const k of fetched) this.outside.set(k, this.raw.get(k)!);
      for (const k of [...added, ...fetched]) this.inclusion.set(k, { tier: 'context', reasons: [why.get(k) ?? 'Context'] });
      frontier = [...added, ...fetched];
      need.clear();
    }
  }

  async load(progress: Progress, signal?: AbortSignal): Promise<void> {
    this.raw.clear();
    this.childrenQueried.clear();
    this.query = { loaded: 0, more: false };
    this.skipped.clear();
    this.childrenCut = false;
    this.tombstones.clear();
    this.lastPresenceAt = Date.now();

    progress('Running query…');
    const s = this.source;
    const jql = s.kind === 'jql' ? s.jql : s.kind === 'keys' ? keyJql(s.keys) : 'project = SHOP AND issuetype = Epic';
    this.outside.clear();
    if (this.scoped) {
      await this.loadScoped(jql, progress, signal);
      return;
    }
    this.index.clear();
    this.selection = undefined;
    this.inclusion.clear();
    const first = await this.page(jql, this.opts.maxIssues, signal);
    this.add(first.issues);
    this.roots = first.issues.map((i) => i.key);
    this.query = { loaded: first.issues.length, more: first.hasMore };
    if (first.hasMore && this.issues.count) {
      try {
        this.query.total = await this.issues.count(jql, signal);
      } catch {
        // The count is a nicety for the message; the "more" signal alone is enough.
      }
    }

    // At the limit the loop still runs: children are probed by key and refs are known, so whatever
    // the limit refuses is recorded exactly (fetchKeys) instead of being assumed.
    let frontier = this.roots;
    for (let d = 0; d < this.opts.depth && frontier.length; d++) {
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
    const before = new Set(this.raw.keys());
    await this.expandInner(keys, progress, signal);
    if (this.scoped) {
      for (const k of this.raw.keys()) {
        if (before.has(k)) continue;
        this.requested.add(k);
        this.inclusion.set(k, { tier: 'requested', reasons: [`Loaded with ${keys.join(', ')}`] });
      }
    }
  }

  private async expandInner(keys: string[], progress: Progress, signal?: AbortSignal): Promise<void> {
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
    // Left-out tickets the index already has at the same version need no refetch.
    const unknown = feed
      .filter((f) => !this.raw.has(f.key) && !(this.index.has(f.key) && ms(this.index.get(f.key)!.fields.updated) === ms(f.fields.updated)))
      .map((f) => f.key);

    // 2. Refresh changed issues in full.
    if (changed.length) {
      for (const batch of chunks(changed, BATCH)) {
        const got = await this.searchTolerant(batch, signal);
        this.add(got);
        for (const i of got) {
          if (this.index.has(i.key)) this.index.set(i.key, i);
          if (this.outside.has(i.key)) this.outside.set(i.key, i);
        }
      }
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
      const linksLoaded = (i: RawIssue) => (i.fields.issuelinks ?? []).some((l) => this.raw.has((l.outwardIssue ?? l.inwardIssue)!.key));
      let joins: RawIssue[];
      if (this.scoped) {
        // Scoped: the universe (index) learns every change; only sprint work, recent done and
        // tickets linked to loaded ones join the graph. The rest updates the "+N more" counts.
        fresh.filter((i) => matchesQuery.has(i.key)).forEach((i) => this.index.set(i.key, i));
        const cls = classify([...this.index.values()], this.scoped, { sprintField: this.opts.sprintField, epicLinkField: this.opts.epicLinkField });
        joins = fresh.filter((i) => {
          const t = cls.get(i.key)?.tier;
          return t === 'sprint' || t === 'done' || linksLoaded(i);
        });
        for (const i of joins) {
          const c = cls.get(i.key);
          this.inclusion.set(i.key, c && (c.tier === 'sprint' || c.tier === 'done') ? { tier: c.tier, reasons: c.reasons.map((r) => r.label) } : { tier: 'context', reasons: ['Linked to a loaded ticket'] });
        }
      } else {
        joins = fresh.filter((i) => {
          const parent = this.parentKeyOf(i);
          return matchesQuery.has(i.key) || (this.opts.includeChildren && !!parent && this.raw.has(parent)) || linksLoaded(i);
        });
      }
      const revived = joins.filter((i) => this.tombstones.has(i.key));
      revived.forEach((i) => this.tombstones.delete(i.key));
      const added = this.add(joins);
      if (!this.scoped) matchesQuery.forEach((k) => !this.roots.includes(k) && this.roots.push(k));
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
        this.index.delete(key);
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
    return this.raw.size >= this.opts.maxIssues;
  }

  /** Raise (or lower) the issue limit for the next load / expansion. */
  setLimit(maxIssues: number) {
    this.opts = { ...this.opts, maxIssues };
  }

  private canHaveChildren(k: string): boolean {
    const i = this.raw.get(k);
    return !!i && !i.fields.issuetype?.subtask && !this.childrenQueried.has(k);
  }

  /** Search that knows whether Jira has more results (sources without `searchPage` fall back to a guess). */
  private async page(jql: string, max: number, signal?: AbortSignal, fields = this.fields): Promise<SearchPage> {
    if (this.issues.searchPage) return this.issues.searchPage(jql, fields, max, signal);
    const issues = await this.issues.search(jql, fields, max, signal);
    return { issues, hasMore: issues.length >= max };
  }

  private add(issues: RawIssue[]): string[] {
    const added: string[] = [];
    for (const i of issues) {
      if (!this.raw.has(i.key)) {
        if (this.raw.size >= this.opts.maxIssues) {
          this.skipped.add(i.key);
          continue;
        }
        added.push(i.key);
        this.skipped.delete(i.key);
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
      if (this.full) {
        batch.filter((k) => !this.raw.has(k)).forEach((k) => this.skipped.add(k));
        continue;
      }
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

  /**
   * Children in two steps: a keys-only query (cheap), then a full fetch of only the keys not loaded
   * yet. The limit is applied in fetchKeys, which records by key what it had to skip.
   */
  private async fetchChildren(keys: string[], signal?: AbortSignal): Promise<string[]> {
    const parents = keys.filter((k) => this.canHaveChildren(k));
    const added: string[] = [];
    for (const batch of chunks(parents, BATCH)) {
      const list = batch.join(',');
      let jql = `parent in (${list})`;
      if (this.opts.epicLinkField) jql += ` OR ${jqlField(this.opts.epicLinkField)} in (${list})`;
      let found: SearchPage;
      try {
        found = await this.page(jql, CHILD_PROBE, signal, ['parent']);
      } catch (e) {
        if (!(e instanceof JiraError) || e.status !== 400) throw e;
        batch.forEach((k) => this.childrenQueried.add(k));
        continue;
      }
      if (found.hasMore) this.childrenCut = true;
      const fresh = found.issues.map((i) => i.key).filter((k) => !this.raw.has(k));
      added.push(...(await this.fetchKeys(fresh, signal)));
      // Parents whose children were all loaded are done; the rest stay open for a later expansion.
      const missing = new Set(fresh.filter((k) => !this.raw.has(k)));
      const parentOfChild = new Map(found.issues.map((i) => [i.key, i.fields.parent?.key]));
      for (const p of batch) {
        const pending = [...missing].some((k) => parentOfChild.get(k) === p || !parentOfChild.get(k));
        if (!pending && !found.hasMore) this.childrenQueried.add(p);
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

  private scopeInfo(): ScopeInfo | undefined {
    const cfg = this.scoped;
    const sel = this.selection;
    if (!cfg || !sel) return undefined;
    const tierOf = (k: string) => sel.classified.get(k)?.tier;
    const loadedTier = (t: IssueScope['tier']) => [...this.raw.keys()].filter((k) => this.inclusion.get(k)?.tier === t).length;
    const count = (pred: (k: string) => boolean) => [...this.index.keys()].filter(pred).length;
    const omitted: ScopeInfo['omitted'] = {};
    for (const i of this.index.values()) {
      if (this.raw.has(i.key)) continue;
      const p = this.parentKeyOf(i);
      if (!p || !this.raw.has(p)) continue;
      const o = (omitted[p] ??= { backlog: 0, done: 0, new: 0, indeterminate: 0 });
      const cat = i.fields.status?.statusCategory?.key;
      if (cat === 'done') o.done++;
      else {
        o.backlog++;
        if (cat === 'indeterminate') o.indeterminate++;
        else o.new++;
      }
    }
    return {
      config: cfg,
      limit: this.opts.maxIssues,
      indexed: this.index.size,
      indexCapped: this.indexMeta.capped,
      universeTotal: this.indexMeta.total,
      sprint: { total: count((k) => tierOf(k) === 'sprint'), shown: loadedTier('sprint') },
      backlog: { total: count((k) => tierOf(k) === 'backlog'), shown: loadedTier('backlog') },
      done: { total: count((k) => tierOf(k) === 'done' || tierOf(k) === 'oldDone'), recent: count((k) => tierOf(k) === 'done'), shown: loadedTier('done') },
      context: loadedTier('context'),
      requested: loadedTier('requested'),
      omitted,
    };
  }

  /** Undefined unless the limit really left something out. */
  private truncationInfo(): Truncation | undefined {
    const skipped = [...this.skipped].filter((k) => !this.raw.has(k) && !this.tombstones.has(k)).length;
    if (!this.query.more && !skipped && !this.childrenCut) return undefined;
    return {
      limit: this.opts.maxIssues,
      queryLoaded: this.query.loaded,
      queryMore: this.query.more,
      queryTotal: this.query.total,
      skipped,
      childrenCut: this.childrenCut,
    };
  }

  toModel(): GraphModel {
    const base = this.issues.baseUrl;
    const truncation = this.truncationInfo();
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
        scope: this.scoped ? this.inclusion.get(i.key) ?? { tier: 'requested', reasons: ['Loaded on request'] } : undefined,
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
      truncated: !!truncation,
      truncation,
      scopeInfo: this.scopeInfo(),
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
