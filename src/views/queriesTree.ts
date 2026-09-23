import * as vscode from 'vscode';
import { currentProject, SavedQuery, savedQueries } from '../config';

const RECENT_KEY = 'jiraGraph.recentQueries';
const RECENT_MAX = 10;

export type QueryNode =
  | { kind: 'group'; group: 'saved' | 'recent' }
  | { kind: 'query'; query: SavedQuery; saved: boolean }
  | { kind: 'demo' }
  | { kind: 'project' };

export class QueriesTreeProvider implements vscode.TreeDataProvider<QueryNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  refresh() {
    this.emitter.fire();
  }

  recent(): SavedQuery[] {
    return this.state.get<SavedQuery[]>(RECENT_KEY, []);
  }

  async pushRecent(jql: string) {
    const list = [{ name: jql, jql }, ...this.recent().filter((q) => q.jql !== jql)].slice(0, RECENT_MAX);
    await this.state.update(RECENT_KEY, list);
    this.refresh();
  }

  async clearRecent() {
    await this.state.update(RECENT_KEY, []);
    this.refresh();
  }

  getChildren(node?: QueryNode): QueryNode[] {
    if (!node) {
      const out: QueryNode[] = currentProject() ? [{ kind: 'project' }, { kind: 'group', group: 'saved' }] : [{ kind: 'group', group: 'saved' }];
      if (this.recent().length) out.push({ kind: 'group', group: 'recent' });
      out.push({ kind: 'demo' });
      return out;
    }
    if (node.kind !== 'group') return [];
    return node.group === 'saved'
      ? savedQueries().map((query) => ({ kind: 'query', query, saved: true }))
      : this.recent().map((query) => ({ kind: 'query', query, saved: false }));
  }

  getTreeItem(node: QueryNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.group === 'saved' ? 'Saved Queries' : 'Recent', vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = `group-${node.group}`;
      item.iconPath = new vscode.ThemeIcon(node.group === 'saved' ? 'star-full' : 'history');
      if (node.group === 'saved' && savedQueries().length === 0) item.description = 'use + to add';
      return item;
    }
    if (node.kind === 'project') {
      const p = currentProject()!;
      const item = new vscode.TreeItem(p.name);
      item.description = `${p.key} · open graph`;
      item.tooltip = `Tickets of project ${p.key}. Use the switch button to bind another project.`;
      item.iconPath = new vscode.ThemeIcon('project');
      item.contextValue = 'project';
      item.command = { command: 'jiraGraph.openProjectGraph', title: 'Open Project Graph' };
      return item;
    }
    if (node.kind === 'demo') {
      const item = new vscode.TreeItem('Demo graph (offline)');
      item.iconPath = new vscode.ThemeIcon('beaker');
      item.command = { command: 'jiraGraph.openDemo', title: 'Open Demo' };
      return item;
    }
    const item = new vscode.TreeItem(node.query.name);
    item.description = node.query.name !== node.query.jql ? node.query.jql : undefined;
    item.tooltip = node.query.jql;
    item.iconPath = new vscode.ThemeIcon('type-hierarchy');
    item.contextValue = node.saved ? 'savedQuery' : 'recentQuery';
    item.command = { command: 'jiraGraph.runQuery', title: 'Run', arguments: [node] };
    return item;
  }
}
