// Types shared between the extension host and the webview.

export type StatusCategory = 'new' | 'indeterminate' | 'done';

export type LinkCategory = 'blocks' | 'relates' | 'duplicates' | 'clones' | 'other';

export interface GraphIssue {
  key: string;
  summary: string;
  type: string;
  isSubtask: boolean;
  status: string;
  statusCategory: StatusCategory;
  priority?: string;
  assignee?: string;
  labels: string[];
  parentKey?: string;
  storyPoints?: number;
  updated?: string;
  url: string;
  /** false when the issue is only known as a reference (link / parent / subtask) and was not fetched. */
  loaded: boolean;
}

export interface GraphLink {
  id: string;
  from: string;
  to: string;
  /** Jira link type name, e.g. "Blocks". */
  name: string;
  /** Outward description, read as "from <label> to", e.g. "blocks". */
  label: string;
  category: LinkCategory;
}

export type GraphSource =
  | { kind: 'jql'; jql: string; title?: string }
  | { kind: 'keys'; keys: string[]; title?: string; demo?: boolean }
  | { kind: 'demo' };

export interface GraphModel {
  title: string;
  source: GraphSource;
  baseUrl: string;
  issues: GraphIssue[];
  links: GraphLink[];
  /** Keys returned directly by the query (as opposed to discovered by expansion). */
  roots: string[];
  truncated: boolean;
  fetchedAt: string;
}

export interface TypeStyleOverride {
  base?: string;
  color?: string;
  border?: 'solid' | 'dashed' | 'dotted' | 'double';
  icon?: string;
}

export interface ViewOptions {
  direction: 'DOWN' | 'RIGHT';
  hierarchyMode: 'edges' | 'nested';
  edgeRouting: 'ORTHOGONAL' | 'SPLINES' | 'POLYLINE';
  typeStyles: Record<string, TypeStyleOverride>;
}

export type HostMessage =
  | { type: 'graph'; model: GraphModel; options: ViewOptions; reason: 'init' | 'update' }
  | { type: 'loading'; message: string }
  | { type: 'error'; message: string }
  | { type: 'focus'; key: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'openIssue'; key: string }
  | { type: 'expand'; keys: string[] }
  | { type: 'graphFrom'; key: string }
  | { type: 'refresh' }
  | { type: 'select'; key: string | undefined }
  | { type: 'copy'; text: string }
  | { type: 'exportSvg'; svg: string }
  | { type: 'copyMermaid' };

export function linkCategory(name: string, label: string): LinkCategory {
  const s = `${name} ${label}`.toLowerCase();
  if (s.includes('block')) return 'blocks';
  if (s.includes('duplic')) return 'duplicates';
  if (s.includes('clon')) return 'clones';
  if (s.includes('relat')) return 'relates';
  return 'other';
}
