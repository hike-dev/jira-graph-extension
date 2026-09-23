import { IssueSource, RawIssue } from './types';

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
    return (await res.json()) as T;
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
    return this.conn.deployment === 'cloud'
      ? this.searchCloud(jql, fields, max, signal)
      : this.searchServer(jql, fields, max, signal);
  }

  /** Jira Cloud enhanced search (token-based pagination). */
  private async searchCloud(jql: string, fields: string[], max: number, signal?: AbortSignal): Promise<RawIssue[]> {
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
    return out;
  }

  /** Jira Server / Data Center offset-based search. */
  private async searchServer(jql: string, fields: string[], max: number, signal?: AbortSignal): Promise<RawIssue[]> {
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
    return out;
  }
}
