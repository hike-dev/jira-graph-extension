import * as vscode from 'vscode';
import { chooseProject, configure, currentProject, getConnection, refreshConfiguredContext, scopeJql, SavedQuery, savedQueries, setSavedQueries, signOut } from './config';
import { JiraClient } from './jira/client';
import { DemoSource } from './jira/demoSource';
import { IssueSource } from './jira/types';
import { GraphSource } from './shared/model';
import { GraphPanel, PanelContext } from './views/graphPanel';
import { blockedKeys, IssuesTreeProvider } from './views/issuesTree';
import { QueryNode, QueriesTreeProvider } from './views/queriesTree';

const KEY_RE = /\b[A-Z][A-Z0-9_]+-\d+\b/;

export function activate(context: vscode.ExtensionContext) {
  const { secrets } = context;
  const demo = new DemoSource();
  void refreshConfiguredContext(secrets);

  const ctx: PanelContext = {
    extensionUri: context.extensionUri,
    async resolveSource(source: GraphSource): Promise<IssueSource | undefined> {
      if (source.kind === 'demo' || (source.kind === 'keys' && source.demo)) return demo;
      let conn = await getConnection(secrets);
      if (!conn) {
        const pick = await vscode.window.showInformationMessage('Jira Graph is not connected to Jira yet.', 'Connect', 'Open Demo');
        if (pick === 'Open Demo') {
          void GraphPanel.open(ctx, { kind: 'demo' });
          return undefined;
        }
        if (pick !== 'Connect' || !(await configure(secrets))) return undefined;
        conn = await getConnection(secrets);
      }
      return conn && new JiraClient(conn);
    },
  };

  // ── Side panel ─────────────────────────────────────────────────────────────
  const queries = new QueriesTreeProvider(context.globalState);
  const issues = new IssuesTreeProvider();
  const issuesView = vscode.window.createTreeView('jiraGraph.issues', { treeDataProvider: issues, showCollapseAll: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'jiraGraph.focusGraph';

  const syncActive = () => {
    const panel = GraphPanel.active;
    issues.setModel(panel?.model);
    const m = panel?.model;
    issuesView.message = m ? `${m.title}${m.truncated ? ' (truncated)' : ''}` : undefined;
    issuesView.description = m ? `${m.issues.length} issues` : undefined;
    if (m) {
      const blocked = blockedKeys(m).size;
      status.text = `$(type-hierarchy) ${m.issues.length}${blocked ? `  $(circle-slash) ${blocked}` : ''}`;
      status.tooltip = `Jira Graph: ${m.title}\n${m.issues.length} issues, ${m.links.length} links, ${blocked} blocked`;
      status.show();
    } else {
      status.hide();
    }
    void vscode.commands.executeCommand('setContext', 'jiraGraph.hasGraph', !!m);
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('jiraGraph.queries', queries),
    issuesView,
    status,
    GraphPanel.onDidChangeActive(syncActive),
    GraphPanel.onDidChangeModel((p) => p === GraphPanel.active && syncActive()),
    GraphPanel.onDidSelect(({ panel, key }) => {
      if (key && panel === GraphPanel.active && issuesView.visible && issues.issue(key)) {
        void issuesView.reveal(key, { select: true, focus: false, expand: true });
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('jiraGraph.queries') || e.affectsConfiguration('jiraGraph.project')) queries.refresh();
      if (e.affectsConfiguration('jiraGraph.project')) void refreshConfiguredContext(secrets);
      if (e.affectsConfiguration('jiraGraph.baseUrl')) void refreshConfiguredContext(secrets);
    }),
    vscode.window.registerWebviewPanelSerializer(GraphPanel.viewType, {
      deserializeWebviewPanel: (panel, state) => GraphPanel.revive(panel, ctx, state as { source?: GraphSource } | undefined),
    }),
  );

  // ── Commands ───────────────────────────────────────────────────────────────
  const openJql = async (jql: string, title?: string) => {
    await queries.pushRecent(jql);
    await GraphPanel.open(ctx, { kind: 'jql', jql, title });
  };

  const keyArg = (arg: unknown): string | undefined =>
    typeof arg === 'string' ? arg : issuesView.selection[0];

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register('jiraGraph.configure', async () => {
    if ((await configure(secrets)) && currentProject()) {
      queries.refresh();
      await vscode.commands.executeCommand('jiraGraph.openProjectGraph');
    }
  });
  register('jiraGraph.signOut', () => signOut(secrets));
  register('jiraGraph.openDemo', () => GraphPanel.open(ctx, { kind: 'demo' }));

  register('jiraGraph.openGraph', async () => {
    const project = await ensureProject();
    if (!project) return;
    const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { jql?: string; switchProject?: boolean }>();
    qp.title = `Jira Graph: ${project.name} (${project.key})`;
    qp.placeholder = `Pick a preset or type JQL — it is limited to project ${project.key} unless it names a project`;
    const base: (vscode.QuickPickItem & { jql?: string; switchProject?: boolean })[] = [
      ...projectPresets(project.key).map((p) => ({ ...p, description: p.description ?? '' })),
      { label: '$(arrow-swap) Switch project…', switchProject: true },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      ...savedQueries().map((q) => ({ label: `$(star-full) ${q.name}`, description: q.jql, jql: q.jql })),
      ...queries.recent().map((q) => ({ label: `$(history) ${q.jql}`, jql: q.jql })),
    ];
    qp.items = base;
    qp.onDidChangeValue((v) => {
      qp.items = v.trim() ? [{ label: `$(play) Run: ${scopeJql(v, project)}`, jql: scopeJql(v, project), alwaysShow: true }, ...base] : base;
    });
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0];
      qp.hide();
      if (item?.switchProject) return void vscode.commands.executeCommand('jiraGraph.selectProject');
      const jql = item?.jql ?? scopeJql(qp.value.trim(), project);
      if (jql) void openJql(jql, item?.jql && !item.label.startsWith('$(history)') ? `${project.name} · ${item.label.replace(/^\$\([^)]*\)\s*/, '')}` : undefined);
    });
    qp.show();
  });

  /** Ensures a connection and a bound project, asking for whatever is missing. */
  const ensureProject = async () => {
    let conn = await getConnection(secrets);
    if (!conn) {
      if (!(await configure(secrets))) return undefined;
      conn = await getConnection(secrets);
    }
    return currentProject() ?? (conn ? await chooseProject(conn) : undefined);
  };

  const projectPresets = (key: string) => [
    { label: '$(issues) Unresolved tickets', jql: `project = ${key} AND resolution = Unresolved ORDER BY created DESC` },
    { label: '$(list-flat) All tickets', description: 'capped at jiraGraph.maxIssues', jql: `project = ${key} ORDER BY created DESC` },
    { label: '$(zap) Epics and their children', jql: `project = ${key} AND issuetype = Epic ORDER BY created DESC` },
    { label: '$(rocket) Open sprints', jql: `project = ${key} AND sprint in openSprints() ORDER BY rank` },
    { label: '$(account) Assigned to me', jql: `project = ${key} AND assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC` },
    { label: '$(clock) Updated in the last 14 days', jql: `project = ${key} AND updated >= -14d ORDER BY updated DESC` },
  ];

  register('jiraGraph.openProjectGraph', async () => {
    const project = await ensureProject();
    if (project) await openJql(projectPresets(project.key)[0].jql, `${project.name} · Unresolved`);
  });

  register('jiraGraph.selectProject', async () => {
    const conn = await getConnection(secrets);
    if (!conn) return configure(secrets);
    const project = await chooseProject(conn);
    queries.refresh();
    if (project) await openJql(projectPresets(project.key)[0].jql, `${project.name} · Unresolved`);
  });

  register('jiraGraph.openIssueGraph', async (arg?: unknown) => {
    const guess = keyArg(arg) ?? keyFromEditor() ?? (await keyFromBranch());
    const key = await vscode.window.showInputBox({
      title: 'Jira Graph: graph around issue(s)',
      prompt: 'One or more issue keys, separated by commas',
      value: guess ?? '',
      validateInput: (v) => (v.split(',').every((k) => KEY_RE.test(k.trim().toUpperCase())) ? undefined : 'e.g. ABC-123, ABC-124'),
    });
    if (!key) return;
    const keys = key.split(',').map((k) => k.trim().toUpperCase());
    await GraphPanel.open(ctx, { kind: 'keys', keys });
  });

  register('jiraGraph.openForBranch', async () => {
    const key = await keyFromBranch();
    if (!key) {
      vscode.window.showWarningMessage('Jira Graph: no issue key found in the current git branch name.');
      return;
    }
    await GraphPanel.open(ctx, { kind: 'keys', keys: [key] });
  });

  register('jiraGraph.refresh', () => GraphPanel.active?.reload());
  register('jiraGraph.focusGraph', () => GraphPanel.active?.reveal());
  register('jiraGraph.copyMermaid', () => GraphPanel.active?.copyMermaid());

  register('jiraGraph.revealInGraph', (arg?: unknown) => {
    const key = keyArg(arg);
    if (key) GraphPanel.active?.focus(key);
  });

  register('jiraGraph.openInBrowser', (arg?: unknown) => {
    const key = keyArg(arg);
    const model = GraphPanel.active?.model;
    const issue = model?.issues.find((i) => i.key === key);
    if (!issue) return;
    if (model!.source.kind === 'demo' || (model!.source.kind === 'keys' && model!.source.demo)) {
      vscode.window.showInformationMessage(`${issue.key} is a demo issue — connect to Jira to open real tickets.`);
      return;
    }
    void vscode.env.openExternal(vscode.Uri.parse(issue.url));
  });

  register('jiraGraph.expandIssue', (arg?: unknown) => {
    const key = keyArg(arg);
    if (key) void GraphPanel.active?.expand([key]);
  });

  register('jiraGraph.graphFromIssue', async (arg?: unknown) => {
    const key = keyArg(arg);
    const src = GraphPanel.active?.source;
    if (key) await GraphPanel.open(ctx, { kind: 'keys', keys: [key], demo: src?.kind === 'demo' || (src?.kind === 'keys' && src.demo) });
  });

  register('jiraGraph.copyKey', (arg?: unknown) => {
    const key = keyArg(arg);
    if (key) void vscode.env.clipboard.writeText(key);
  });

  // Query management
  register('jiraGraph.runQuery', (node: QueryNode) => node.kind === 'query' && openJql(node.query.jql, node.saved ? node.query.name : undefined));

  register('jiraGraph.addQuery', async (node?: QueryNode) => {
    const jql = await vscode.window.showInputBox({
      title: 'Save JQL query (1/2)',
      prompt: 'JQL',
      value: node?.kind === 'query' ? node.query.jql : '',
      placeHolder: 'project = ABC AND fixVersion = "1.4"',
    });
    if (!jql) return;
    const name = await vscode.window.showInputBox({ title: 'Save JQL query (2/2)', prompt: 'Name', value: jql.slice(0, 40) });
    if (!name) return;
    await setSavedQueries([...savedQueries(), { name, jql }]);
  });

  register('jiraGraph.editQuery', async (node: QueryNode) => {
    if (node.kind !== 'query') return;
    const list = savedQueries();
    const idx = list.findIndex((q) => q.name === node.query.name && q.jql === node.query.jql);
    const jql = await vscode.window.showInputBox({ title: 'Edit query', prompt: 'JQL', value: node.query.jql });
    if (!jql) return;
    const name = await vscode.window.showInputBox({ title: 'Edit query', prompt: 'Name', value: node.query.name });
    if (!name || idx < 0) return;
    list[idx] = { name, jql } satisfies SavedQuery;
    await setSavedQueries(list);
  });

  register('jiraGraph.deleteQuery', async (node: QueryNode) => {
    if (node.kind !== 'query') return;
    await setSavedQueries(savedQueries().filter((q) => !(q.name === node.query.name && q.jql === node.query.jql)));
  });

  register('jiraGraph.clearRecent', () => queries.clearRecent());
}

function keyFromEditor(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  const text = ed.selection.isEmpty
    ? ed.document.getText(ed.document.getWordRangeAtPosition(ed.selection.active, /[A-Za-z][A-Za-z0-9_]+-\d+/))
    : ed.document.getText(ed.selection);
  return KEY_RE.exec(text.toUpperCase())?.[0];
}

async function keyFromBranch(): Promise<string | undefined> {
  const ext = vscode.extensions.getExtension<{ getAPI(v: 1): { repositories: { state: { HEAD?: { name?: string } } }[] } }>('vscode.git');
  if (!ext) return undefined;
  const git = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
  for (const repo of git.repositories) {
    const m = KEY_RE.exec((repo.state.HEAD?.name ?? '').toUpperCase());
    if (m) return m[0];
  }
  return undefined;
}

export function deactivate() {}
