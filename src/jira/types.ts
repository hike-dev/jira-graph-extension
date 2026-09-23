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

/** Minimal search contract implemented by the real client and the demo client. */
export interface IssueSource {
  readonly baseUrl: string;
  search(jql: string, fields: string[], max: number, signal?: AbortSignal): Promise<RawIssue[]>;
  /**
   * Which of the given numeric issue ids still exist and are visible to the user.
   * Returns id → current key (a different key means the issue was moved to another project).
   * Optional: without it the session falls back to `id in (...)` searches.
   */
  presence?(ids: string[], signal?: AbortSignal): Promise<Map<string, string>>;
}
