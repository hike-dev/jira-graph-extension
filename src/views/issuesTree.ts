import * as vscode from 'vscode';
import { GraphIssue, GraphModel } from '../shared/model';

const TYPE_ICONS: [RegExp, string, string][] = [
  [/initiative|theme/i, 'layers', 'charts.orange'],
  [/epic/i, 'zap', 'charts.purple'],
  [/sub-?task/i, 'list-tree', 'charts.blue'],
  [/story/i, 'bookmark', 'charts.green'],
  [/bug|defect/i, 'bug', 'charts.red'],
  [/incident/i, 'flame', 'charts.red'],
  [/spike|research/i, 'beaker', 'charts.blue'],
  [/improvement|enhancement/i, 'arrow-up', 'charts.green'],
  [/feature/i, 'star-empty', 'charts.yellow'],
  [/task/i, 'pass', 'charts.blue'],
];

export function typeIcon(i: GraphIssue): vscode.ThemeIcon {
  const hit = TYPE_ICONS.find(([re]) => re.test(i.isSubtask ? 'sub-task' : i.type));
  return hit ? new vscode.ThemeIcon(hit[1], new vscode.ThemeColor(hit[2])) : new vscode.ThemeIcon('circle-outline');
}

const TYPE_RANK = ['initiative', 'epic', 'feature', 'story', 'task', 'bug', 'spike', 'improvement'];
function rank(i: GraphIssue): number {
  const r = TYPE_RANK.findIndex((t) => i.type.toLowerCase().includes(t));
  return r < 0 ? TYPE_RANK.length : r;
}

export function blockedKeys(model: GraphModel): Set<string> {
  const byKey = new Map(model.issues.map((i) => [i.key, i]));
  const out = new Set<string>();
  for (const l of model.links) {
    if (l.category !== 'blocks') continue;
    const from = byKey.get(l.from);
    const to = byKey.get(l.to);
    if (from && to && from.statusCategory !== 'done' && to.statusCategory !== 'done') out.add(l.to);
  }
  return out;
}

/** Side-panel tree mirroring the hierarchy of the active graph panel. */
export class IssuesTreeProvider implements vscode.TreeDataProvider<string> {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private model: GraphModel | undefined;
  private byKey = new Map<string, GraphIssue>();
  private children = new Map<string | undefined, string[]>();
  private blocked = new Set<string>();

  setModel(model: GraphModel | undefined) {
    this.model = model;
    this.byKey = new Map(model?.issues.map((i) => [i.key, i]) ?? []);
    this.blocked = model ? blockedKeys(model) : new Set();
    this.children.clear();
    for (const i of model?.issues ?? []) {
      const parent = i.parentKey && this.byKey.has(i.parentKey) ? i.parentKey : undefined;
      if (!this.children.has(parent)) this.children.set(parent, []);
      this.children.get(parent)!.push(i.key);
    }
    for (const list of this.children.values()) {
      list.sort((a, b) => {
        const ia = this.byKey.get(a)!;
        const ib = this.byKey.get(b)!;
        return rank(ia) - rank(ib) || a.localeCompare(b, undefined, { numeric: true });
      });
    }
    this.emitter.fire(undefined);
  }

  get current(): GraphModel | undefined {
    return this.model;
  }

  issue(key: string): GraphIssue | undefined {
    return this.byKey.get(key);
  }

  getChildren(key?: string): string[] {
    return this.children.get(key) ?? [];
  }

  getParent(key: string): string | undefined {
    const p = this.byKey.get(key)?.parentKey;
    return p && this.byKey.has(p) ? p : undefined;
  }

  getTreeItem(key: string): vscode.TreeItem {
    const i = this.byKey.get(key)!;
    const hasChildren = (this.children.get(key)?.length ?? 0) > 0;
    const item = new vscode.TreeItem(
      { label: `${i.key}  ${i.summary}`, highlights: [[0, i.key.length]] },
      hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.id = key;
    item.iconPath = typeIcon(i);
    item.description = [i.status, this.blocked.has(key) ? '⛔ blocked' : '', i.loaded ? '' : '(not loaded)'].filter(Boolean).join(' · ');
    item.contextValue = i.loaded ? 'issue' : 'issueStub';
    item.command = { command: 'jiraGraph.revealInGraph', title: 'Reveal in Graph', arguments: [key] };

    const links = this.model!.links.filter((l) => l.from === key || l.to === key);
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**[${i.key}](${i.url})** · ${i.type} · _${i.status}_\n\n${escapeMd(i.summary)}\n\n`);
    if (i.assignee) md.appendMarkdown(`$(account) ${escapeMd(i.assignee)}  `);
    if (i.priority) md.appendMarkdown(`$(flame) ${i.priority}`);
    if (links.length) {
      md.appendMarkdown('\n\n---\n');
      for (const l of links) {
        md.appendMarkdown(`\n- ${l.from === key ? `${l.label} **${l.to}**` : `**${l.from}** ${l.label} this`}`);
      }
    }
    item.tooltip = md;
    return item;
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}
