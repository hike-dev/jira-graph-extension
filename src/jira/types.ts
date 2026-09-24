// Subset of the Jira REST issue shape that the extension relies on.

export interface RawIssueFieldsRef {
  summary?: string;
  status?: { name: string; statusCategory?: { key: string } };
  issuetype?: { name: string; subtask?: boolean };
  priority?: { name: string };
}

export interface RawIssueRef {
  id?: string;
  key: string;
  fields?: RawIssueFieldsRef;
}

export interface RawIssueLink {
  id: string;
  type: { name: string; inward: string; outward: string };
  inwardIssue?: RawIssueRef;
  outwardIssue?: RawIssueRef;
}

export interface RawIssue {
  id: string;
  key: string;
  fields: RawIssueFieldsRef & {
    assignee?: { displayName: string } | null;
    parent?: RawIssueRef;
    subtasks?: RawIssueRef[];
    issuelinks?: RawIssueLink[];
    labels?: string[];
    updated?: string;
    [custom: string]: unknown;
  };
}

export interface SearchPage {
  issues: RawIssue[];
  /** Jira reported more matching issues beyond `max` (not a guess from hitting the limit). */
  hasMore: boolean;
}

/** Minimal search contract implemented by the real client and the demo client. */
export interface IssueSource {
  readonly baseUrl: string;
  search(jql: string, fields: string[], max: number, signal?: AbortSignal): Promise<RawIssue[]>;
  /** Like `search`, but also says whether Jira has more results than were returned. */
  searchPage?(jql: string, fields: string[], max: number, signal?: AbortSignal): Promise<SearchPage>;
  /** Number of issues matching the JQL (approximate on Cloud). */
  count?(jql: string, signal?: AbortSignal): Promise<number>;
  /**
   * Which of the given numeric issue ids still exist and are visible to the user.
   * Returns id → current key (a different key means the issue was moved to another project).
   * Optional: without it the session falls back to `id in (...)` searches.
   */
  presence?(ids: string[], signal?: AbortSignal): Promise<Map<string, string>>;
  /** Description rendered to HTML by Jira (untrusted — sanitised by the webview), fetched on demand. */
  describe?(key: string, signal?: AbortSignal): Promise<{ html: string; updated?: string }>;
}
