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

/** A workflow transition available on an issue right now. */
export interface IssueTransition {
  id: string;
  name: string;
  to: { name: string; category: string };
}

/** An open sprint an issue can be moved to. */
export interface SprintOption {
  id: number;
  name: string;
  state: 'active' | 'future';
  board?: string;
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
  /** One issue read directly (not through the search index, which can lag right after a write). */
  issue?(key: string, fields: string[], signal?: AbortSignal): Promise<RawIssue>;

  // ── Writes (optional: a source without them is read-only) ──
  transitions?(key: string): Promise<IssueTransition[]>;
  transition?(key: string, transitionId: string): Promise<void>;
  /** Active and future sprints of the boards of an issue's project. */
  sprints?(key: string): Promise<SprintOption[]>;
  /** Moves an issue to a sprint, or to the backlog with `undefined`. */
  moveToSprint?(key: string, sprintId: number | undefined): Promise<void>;
}
