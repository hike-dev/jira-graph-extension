import * as vscode from 'vscode';
import { Deployment, JiraClient, JiraConnection } from './jira/client';
import { SessionOptions } from './jira/graphSession';
import type { ProjectRef } from './shared/jql';
import { TypeStyleOverride, ViewOptions } from './shared/model';
import type { SyncTiming } from './sync/scheduler';

const TOKEN_KEY = 'jiraGraph.token';

export interface SavedQuery {
  name: string;
  jql: string;
}

function cfg() {
  return vscode.workspace.getConfiguration('jiraGraph');
}

export function sessionOptions(): SessionOptions {
  const c = cfg();
  return {
    depth: c.get<number>('expandDepth', 2),
    maxIssues: c.get<number>('maxIssues', 300),
    includeChildren: c.get<boolean>('includeChildren', true),
    epicLinkField: c.get<string>('epicLinkField') || undefined,
    storyPointsField: c.get<string>('storyPointsField') || undefined,
    sprintField: c.get<string>('sprintField', 'customfield_10020') || undefined,
    overlapMs: c.get<number>('sync.overlapSeconds', 300) * 1000,
    presenceIntervalMs: c.get<number>('sync.presenceCheckMinutes', 10) * 60_000,
  };
}

export function syncTiming(): SyncTiming & { enabled: boolean } {
  const c = cfg();
  const s = (k: string, d: number) => Math.max(0, c.get<number>(`sync.${k}`, d)) * 1000;
  return {
    enabled: c.get<boolean>('sync.enabled', true),
    idleIntervalMs: s('idleIntervalSeconds', 60),
    debounceMs: s('activityDebounceSeconds', 2),
    cooldownMs: s('cooldownSeconds', 180),
    cooldownIntervalMs: s('cooldownIntervalSeconds', 10),
  };
}

export function viewOptions(): ViewOptions {
  const c = cfg();
  return {
    direction: c.get<'DOWN' | 'RIGHT'>('layout.direction', 'DOWN'),
    hierarchyMode: c.get<'edges' | 'nested'>('layout.hierarchyMode', 'edges'),
    edgeRouting: c.get<ViewOptions['edgeRouting']>('layout.edgeRouting', 'ORTHOGONAL'),
    typeStyles: c.get<Record<string, TypeStyleOverride>>('issueTypeStyles', {}),
    hover: {
      enabled: c.get<boolean>('hoverCard.enabled', true),
      delayMs: Math.max(0, c.get<number>('hoverCard.delayMs', 1000)),
      descriptionLines: Math.max(1, c.get<number>('hoverCard.descriptionLines', 4)),
    },
    statusStages: c.get<Record<string, string>>('statusStages', {}),
  };
}

export function savedQueries(): SavedQuery[] {
  return cfg().get<SavedQuery[]>('queries', []);
}

export async function setSavedQueries(queries: SavedQuery[]): Promise<void> {
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg().update('queries', queries, target);
}

export async function getConnection(secrets: vscode.SecretStorage): Promise<JiraConnection | undefined> {
  const c = cfg();
  const baseUrl = c.get<string>('baseUrl');
  const token = await secrets.get(TOKEN_KEY);
  if (!baseUrl || !token) return undefined;
  return { baseUrl, deployment: c.get<Deployment>('deployment', 'cloud'), email: c.get<string>('email'), token };
}

export async function refreshConfiguredContext(secrets: vscode.SecretStorage): Promise<boolean> {
  const configured = !!(await getConnection(secrets));
  await vscode.commands.executeCommand('setContext', 'jiraGraph.configured', configured);
  await vscode.commands.executeCommand('setContext', 'jiraGraph.hasProject', !!currentProject());
  return configured;
}

export type { ProjectRef } from './shared/jql';
export { scopeJql } from './shared/jql';

/** The Jira project this workspace is bound to. */
export function currentProject(): ProjectRef | undefined {
  const key = cfg().get<string>('project');
  return key ? { key, name: cfg().get<string>('projectName') || key } : undefined;
}

export async function chooseProject(conn: JiraConnection): Promise<ProjectRef | undefined> {
  let projects;
  try {
    projects = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Loading Jira projects…' },
      () => new JiraClient(conn).projects(),
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Jira Graph: could not load projects — ${(e as Error).message}`);
    return undefined;
  }
  if (!projects.length) {
    vscode.window.showWarningMessage('Jira Graph: your account cannot see any projects. Check the email/token with "Connect to Jira".');
    return undefined;
  }
  const current = currentProject()?.key;
  const pick = await vscode.window.showQuickPick(
    projects
      .map((p) => ({ label: p.name, description: p.key, detail: p.key === current ? 'current project' : undefined, key: p.key }))
      .sort((a, b) => (a.key === current ? -1 : b.key === current ? 1 : 0)),
    { title: 'Jira Graph: choose the project for this workspace', placeHolder: 'Project name or key', matchOnDescription: true, ignoreFocusOut: true },
  );
  if (!pick) return undefined;
  // Per workspace, so each repository can be bound to its own project.
  const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await cfg().update('project', pick.key, target);
  await cfg().update('projectName', pick.label, target);
  await vscode.commands.executeCommand('setContext', 'jiraGraph.hasProject', true);
  return { key: pick.key, name: pick.label };
}

export async function configure(secrets: vscode.SecretStorage): Promise<boolean> {
  const c = cfg();
  const baseUrl = await vscode.window.showInputBox({
    title: 'Jira Graph: Connect (1/3)',
    prompt: 'Jira base URL',
    placeHolder: 'https://your-company.atlassian.net',
    value: c.get<string>('baseUrl') ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : 'Enter a full http(s) URL'),
  });
  if (!baseUrl) return false;

  const guess: Deployment = /atlassian\.net/.test(baseUrl) ? 'cloud' : 'server';
  const pick = await vscode.window.showQuickPick(
    [
      { label: 'Jira Cloud', description: 'email + API token', value: 'cloud' as Deployment, picked: guess === 'cloud' },
      { label: 'Jira Server / Data Center', description: 'personal access token', value: 'server' as Deployment, picked: guess === 'server' },
    ].sort((a) => (a.picked ? -1 : 1)),
    { title: 'Jira Graph: Connect (2/3)', placeHolder: 'Deployment type', ignoreFocusOut: true },
  );
  if (!pick) return false;

  let email: string | undefined;
  if (pick.value === 'cloud') {
    email = await vscode.window.showInputBox({
      title: 'Jira Graph: Connect (2/3)',
      prompt: 'Atlassian account email',
      value: c.get<string>('email') ?? '',
      ignoreFocusOut: true,
    });
    if (!email) return false;
  }

  const token = await vscode.window.showInputBox({
    title: 'Jira Graph: Connect (3/3)',
    prompt: pick.value === 'cloud' ? 'API token (id.atlassian.com → Security → API tokens)' : 'Personal access token',
    password: true,
    ignoreFocusOut: true,
  });
  if (!token) return false;

  const conn: JiraConnection = { baseUrl: baseUrl.trim(), deployment: pick.value, email, token };
  try {
    const me = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking Jira connection…' },
      () => new JiraClient(conn).myself(),
    );
    await c.update('baseUrl', conn.baseUrl, vscode.ConfigurationTarget.Global);
    await c.update('deployment', conn.deployment, vscode.ConfigurationTarget.Global);
    if (email) await c.update('email', email, vscode.ConfigurationTarget.Global);
    await secrets.store(TOKEN_KEY, token);
    await refreshConfiguredContext(secrets);
    vscode.window.showInformationMessage(`Jira Graph: connected as ${me.displayName}.`);
    await chooseProject(conn);
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Jira Graph: connection failed — ${(e as Error).message}`);
    return false;
  }
}

export async function signOut(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(TOKEN_KEY);
  await refreshConfiguredContext(secrets);
  vscode.window.showInformationMessage('Jira Graph: signed out.');
}
