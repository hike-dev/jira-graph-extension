import { IssueSource, IssueTransition, RawIssue, SearchPage, SprintOption } from './types';

export type Deployment = 'cloud' | 'server';

export interface JiraConnection {
  baseUrl: string;
  deployment: Deployment;
  /** Required for Cloud (basic auth with API token). Ignored for Server/DC (PAT bearer auth). */
  email?: string;
  token: string;
}

export interface JiraProject {
  key: string;
  name: string;
}

export class JiraError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class JiraClient implements IssueSource {
  readonly baseUrl: string;

  constructor(private readonly conn: JiraConnection) {
    this.baseUrl = conn.baseUrl.replace(/\/+$/, '');
  }

  private get apiVersion(): string {
    return this.conn.deployment === 'cloud' ? '3' : '2';
  }

  private headers(): Record<string, string> {
    const auth =
      this.conn.deployment === 'cloud'
        ? `Basic ${Buffer.from(`${this.conn.email ?? ''}:${this.conn.token}`).toString('base64')}`
        : `Bearer ${this.conn.token}`;
    return { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, retried = false): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (res.status === 429 && !retried) {
      const wait = Math.min(Number(res.headers.get('Retry-After') ?? '2'), 30) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      return this.request(method, path, body, signal, true);
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const err = (await res.json()) as { errorMessages?: string[]; errors?: Record<string, string> };
        detail = [...(err.errorMessages ?? []), ...Object.values(err.errors ?? {})].join('; ') || detail;
      } catch {
        // non-JSON error body
      }
      throw new JiraError(`Jira ${res.status}: ${detail}`, res.status);
    }
    // Writes (transitions, sprint moves) answer 204 No Content.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async myself(): Promise<{ displayName: string }> {
    return this.request('GET', `/rest/api/${this.apiVersion}/myself`);
  }

  async projects(): Promise<JiraProject[]> {
    if (this.conn.deployment !== 'cloud') return this.request('GET', '/rest/api/2/project');
    const out: JiraProject[] = [];
    for (let startAt = 0; ; startAt += 50) {
      const page = await this.request<{ values: JiraProject[]; isLast: boolean }>('GET', `/rest/api/3/project/search?maxResults=50&startAt=${startAt}&orderBy=name`);
      out.push(...page.values);
      if (page.isLast || page.values.length === 0) return out;
    }
  }

  /** One issue's description as Jira renders it (works for Cloud ADF and Server/DC wiki markup alike). */
  async describe(key: string, signal?: AbortSignal): Promise<{ html: string; updated?: string }> {
    const res = await this.request<{ fields: { updated?: string }; renderedFields?: { description?: string | null } }>(
      'GET',
      `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(key)}?fields=description,updated&expand=renderedFields`,
      undefined,
      signal,
    );
    return { html: res.renderedFields?.description ?? '', updated: res.fields.updated };
  }

  async issue(key: string, fields: string[], signal?: AbortSignal): Promise<RawIssue> {
    return this.request('GET', `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(key)}?fields=${fields.map(encodeURIComponent).join(',')}`, undefined, signal);
  }

  async transitions(key: string): Promise<IssueTransition[]> {
    const res = await this.request<{ transitions: { id: string; name: string; to: { name: string; statusCategory?: { key: string } } }[] }>(
      'GET',
      `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(key)}/transitions`,
    );
    return res.transitions.map((t) => ({ id: t.id, name: t.name, to: { name: t.to.name, category: t.to.statusCategory?.key ?? 'new' } }));
  }

  async transition(key: string, transitionId: string): Promise<void> {
    await this.request('POST', `/rest/api/${this.apiVersion}/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: transitionId } });
  }

  /** Scrum boards per project, cached: listing them is slow and they rarely change. */
  private readonly boards = new Map<string, Promise<{ id: number; name: string }[]>>();

  private projectBoards(project: string): Promise<{ id: number; name: string }[]> {
    let p = this.boards.get(project);
    if (!p) {
      p = (async () => {
        const out: { id: number; name: string }[] = [];
        for (let startAt = 0; ; startAt += 50) {
          const page = await this.request<{ values: { id: number; name: string }[]; isLast?: boolean }>(
            'GET',
            `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(project)}&type=scrum&maxResults=50&startAt=${startAt}`,
          );
          out.push(...page.values);
          if (page.isLast !== false || page.values.length === 0) return out;
        }
      })();
      p.catch(() => this.boards.delete(project));
      this.boards.set(project, p);
    }
    return p;
  }

  async sprints(key: string): Promise<SprintOption[]> {
    const boards = await this.projectBoards(key.replace(/-\d+$/, ''));
    const byId = new Map<number, SprintOption>();
    for (const b of boards) {
      let res: { values: { id: number; name: string; state: string }[] };
      try {
        res = await this.request('GET', `/rest/agile/1.0/board/${b.id}/sprint?state=active,future&maxResults=50`);
      } catch (e) {
        if (e instanceof JiraError && e.status === 400) continue; // board without sprints enabled
        throw e;
      }
      for (const s of res.values) {
        const state = s.state.toLowerCase();
        if ((state === 'active' || state === 'future') && !byId.has(s.id)) byId.set(s.id, { id: s.id, name: s.name, state, board: b.name });
      }
    }
    return [...byId.values()];
  }

  async moveToSprint(key: string, sprintId: number | undefined): Promise<void> {
    const path = sprintId === undefined ? '/rest/agile/1.0/backlog/issue' : `/rest/agile/1.0/sprint/${sprintId}/issue`;
    await this.request('POST', path, { issues: [key] });
  }

  /** Cloud bulk fetch reports existing issues only; anything missing is deleted or no longer visible. */
  async presence(ids: string[], signal?: AbortSignal): Promise<Map<string, string>> {
    if (this.conn.deployment !== 'cloud') throw new JiraError('bulkfetch is Cloud only', 501);
    const out = new Map<string, string>();
    for (let i = 0; i < ids.length; i += 100) {
      const res = await this.request<{ issues: { id: string; key: string }[] }>(
        'POST',
        '/rest/api/3/issue/bulkfetch',
        { issueIdsOrKeys: ids.slice(i, i + 100), fields: ['updated'] },
        signal,
      );
      for (const x of res.issues) out.set(x.id, x.key);
    }
    return out;
  }

  async search(jql: string, fields: string[], max: number, signal?: AbortSignal): Promise<RawIssue[]> {
    return (await this.searchPage(jql, fields, max, signal)).issues;
  }

  async searchPage(jql: string, fields: string[], max: number, signal?: AbortSignal): Promise<SearchPage> {
    return this.conn.deployment === 'cloud'
      ? this.searchCloud(jql, fields, max, signal)
      : this.searchServer(jql, fields, max, signal);
  }

  async count(jql: string, signal?: AbortSignal): Promise<number> {
    const where = jql.replace(/\border\s+by\b[\s\S]*$/i, '').trim();
    if (this.conn.deployment === 'cloud') {
      const r = await this.request<{ count: number }>('POST', '/rest/api/3/search/approximate-count', { jql: where }, signal);
      return r.count;
    }
    const r = await this.request<{ total: number }>('POST', '/rest/api/2/search', { jql: where, maxResults: 0 }, signal);
    return r.total;
  }

  /** Jira Cloud enhanced search (token-based pagination). */
  private async searchCloud(jql: string, fields: string[], max: number, signal?: AbortSignal): Promise<SearchPage> {
    const out: RawIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{ issues: RawIssue[]; nextPageToken?: string; isLast?: boolean }>(
        'POST',
        '/rest/api/3/search/jql',
        { jql, fields, maxResults: Math.min(100, max - out.length), nextPageToken },
        signal,
      );
      out.push(...page.issues);
      nextPageToken = page.isLast === false || page.nextPageToken ? page.nextPageToken : undefined;
    } while (nextPageToken && out.length < max);
    // A next-page token left over means Jira has more than we asked for.
    return { issues: out, hasMore: !!nextPageToken };
  }

  /** Jira Server / Data Center offset-based search. */
  private async searchServer(jql: string, fields: string[], max: number, signal?: AbortSignal): Promise<SearchPage> {
    const out: RawIssue[] = [];
    let total = Infinity;
    while (out.length < max && out.length < total) {
      const page = await this.request<{ issues: RawIssue[]; total: number }>(
        'POST',
        '/rest/api/2/search',
        { jql, fields, startAt: out.length, maxResults: Math.min(100, max - out.length) },
        signal,
      );
      total = page.total;
      out.push(...page.issues);
      if (page.issues.length === 0) break;
    }
    return { issues: out, hasMore: total !== Infinity && total > out.length };
  }
}
