import * as vscode from 'vscode';
import { sessionOptions, syncTiming, viewOptions } from '../config';
import { JiraError } from '../jira/client';
import { GraphSession, SyncResult } from '../jira/graphSession';
import { SyncScheduler } from '../sync/scheduler';
import { IssueSource } from '../jira/types';
import { toMermaid } from '../mermaid';
import { GraphModel, GraphSource, HostMessage, WebviewMessage } from '../shared/model';

export interface PanelContext {
  extensionUri: vscode.Uri;
  /** Resolves the issue source for a graph; undefined when Jira is not configured. */
  resolveSource(source: GraphSource): Promise<IssueSource | undefined>;
}

interface PersistedState {
  source?: GraphSource;
}

/** One graph = one editor-area webview panel. */
export class GraphPanel {
  static readonly viewType = 'jiraGraph.graph';

  private static readonly panels = new Set<GraphPanel>();
  private static _active: GraphPanel | undefined;
  private static readonly activeEmitter = new vscode.EventEmitter<GraphPanel | undefined>();
  private static readonly modelEmitter = new vscode.EventEmitter<GraphPanel>();
  private static readonly selectEmitter = new vscode.EventEmitter<{ panel: GraphPanel; key: string | undefined }>();

  static readonly onDidChangeActive = GraphPanel.activeEmitter.event;
  static readonly onDidChangeModel = GraphPanel.modelEmitter.event;
  static readonly onDidSelect = GraphPanel.selectEmitter.event;

  static get active(): GraphPanel | undefined {
    return GraphPanel._active;
  }

  model: GraphModel | undefined;
  private session: GraphSession | undefined;
  private abort: AbortController | undefined;
  private ready = false;
  private pending: HostMessage[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private scheduler: SyncScheduler | undefined;
  private busy = false;
  private lastSyncAt: number | undefined;
  private syncErrors = 0;
  private syncBlockedUntil = 0;
  private syncError: string | undefined;

  static async open(ctx: PanelContext, source: GraphSource): Promise<GraphPanel | undefined> {
    const issues = await ctx.resolveSource(source);
    if (!issues) return undefined;
    const panel = vscode.window.createWebviewPanel(GraphPanel.viewType, 'Jira Graph', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    });
    const p = new GraphPanel(panel, ctx, source, issues);
    void p.reload();
    return p;
  }

  static async revive(webview: vscode.WebviewPanel, ctx: PanelContext, state: PersistedState | undefined): Promise<void> {
    const source = state?.source ?? { kind: 'demo' };
    const issues = await ctx.resolveSource(source);
    if (!issues) {
      webview.dispose();
      return;
    }
    const p = new GraphPanel(webview, ctx, source, issues);
    void p.reload();
  }

  private constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly ctx: PanelContext,
    readonly source: GraphSource,
    issues: IssueSource,
  ) {
    this.session = new GraphSession(issues, source, sessionOptions());
    panel.title = this.session.title;
    panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'graph-tab.svg');
    panel.webview.options = { ...panel.webview.options, enableScripts: true };
    panel.webview.html = this.html(panel.webview);

    GraphPanel.panels.add(this);
    this.setActive();

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((e) => e.webviewPanel.active && this.setActive()),
      panel.webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('jiraGraph.issueTypeStyles') || e.affectsConfiguration('jiraGraph.layout') || e.affectsConfiguration('jiraGraph.hoverCard')) {
          if (this.model) this.post({ type: 'graph', model: this.model, options: viewOptions(), reason: 'update' });
        }
        if (e.affectsConfiguration('jiraGraph.sync')) this.applySyncSettings();
      }),
      vscode.window.onDidChangeWindowState((w) => this.scheduler?.setFocused(w.focused)),
      panel.onDidChangeViewState((e) => this.scheduler?.setVisible(e.webviewPanel.visible)),
    );
    this.startSync();
  }

  // ── Live sync ────────────────────────────────────────────────────────────────
  private startSync() {
    const t = syncTiming();
    this.scheduler = new SyncScheduler(t, {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
      run: () => this.syncOnce(),
      onPhase: (phase, nextRunAt) => this.postSyncState(phase, nextRunAt),
    });
    this.scheduler.setEnabled(t.enabled);
    this.scheduler.setFocused(vscode.window.state.focused);
    this.scheduler.setVisible(this.panel.visible);
  }

  private applySyncSettings() {
    const t = syncTiming();
    this.scheduler?.setTiming(t);
    this.scheduler?.setEnabled(t.enabled);
    this.session?.setSyncOptions(sessionOptions());
  }

  private postSyncState(phase: 'paused' | 'idle' | 'cooldown', nextRunAt?: number) {
    const enabled = syncTiming().enabled;
    this.post({
      type: 'syncState',
      phase: enabled ? phase : 'off',
      lastSyncAt: this.lastSyncAt,
      nextRunAt,
      syncing: this.busy,
      error: this.syncError,
    });
  }

  /** Force a sync soon (e.g. from the Sync Now command). Presence of every issue is re-checked too. */
  syncNow() {
    this.forcePresence = true;
    this.scheduler?.now();
  }
  private forcePresence = false;

  private async syncOnce() {
    if (!this.model || this.busy || Date.now() < this.syncBlockedUntil) return;
    this.busy = true;
    this.postSyncState(this.scheduler!.phase);
    const before = this.model;
    try {
      const r: SyncResult = await this.session!.sync({ forcePresence: this.forcePresence });
      this.forcePresence = false;
      this.syncErrors = 0;
      this.syncError = undefined;
      this.lastSyncAt = Date.now();
      if (r.changed.length || r.added.length || r.removed.length || r.renamed.length) {
        this.model = this.session!.toModel();
        const diff = { changed: r.changed, added: r.added, removed: r.removed, renamed: r.renamed };
        this.post({ type: 'graph', model: this.model, options: viewOptions(), reason: 'sync', diff });
        GraphPanel.modelEmitter.fire(this);
      } else if (before !== this.model) {
        // A full reload happened meanwhile; nothing to report.
      }
    } catch (e) {
      this.syncErrors++;
      this.syncError = (e as Error).message;
      if (e instanceof JiraError && e.status === 401) {
        this.scheduler?.setEnabled(false);
        this.syncError = 'Jira rejected the credentials — sync stopped. Reconnect to resume.';
      } else {
        // Exponential back-off: 10s, 20s, 40s … capped at 5 minutes.
        this.syncBlockedUntil = Date.now() + Math.min(300_000, 10_000 * 2 ** (this.syncErrors - 1));
      }
    } finally {
      this.busy = false;
      this.postSyncState(this.scheduler!.phase, this.scheduler!.nextRunAt());
    }
  }

  private setActive() {
    if (GraphPanel._active === this) return;
    GraphPanel._active = this;
    GraphPanel.activeEmitter.fire(this);
  }

  private dispose() {
    this.abort?.abort();
    this.scheduler?.dispose();
    GraphPanel.panels.delete(this);
    if (GraphPanel._active === this) {
      GraphPanel._active = [...GraphPanel.panels].pop();
      GraphPanel.activeEmitter.fire(GraphPanel._active);
    }
    this.disposables.forEach((d) => d.dispose());
  }

  private post(msg: HostMessage) {
    if (this.ready) void this.panel.webview.postMessage(msg);
    else this.pending.push(msg);
  }

  reveal() {
    this.panel.reveal();
  }

  focus(key: string) {
    this.panel.reveal(undefined, true);
    this.post({ type: 'focus', key });
  }

  reload(): Promise<void> {
    return this.run((progress, signal) => this.session!.load(progress, signal), 'init');
  }

  expand(keys: string[]): Promise<void> {
    return this.run((progress, signal) => this.session!.expand(keys, progress, signal), 'update');
  }

  private async run(job: (progress: (m: string) => void, signal: AbortSignal) => Promise<void>, reason: 'init' | 'update') {
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.busy = true;
    try {
      await job((message) => this.post({ type: 'loading', message }), abort.signal);
      if (abort.signal.aborted) return;
      this.model = this.session!.toModel();
      this.post({ type: 'graph', model: this.model, options: viewOptions(), reason });
      GraphPanel.modelEmitter.fire(this);
      this.lastSyncAt = Date.now();
    } catch (e) {
      if (abort.signal.aborted) return;
      const msg = (e as Error).message;
      this.post({ type: 'error', message: msg });
      if (e instanceof JiraError && e.status === 401) {
        const pick = await vscode.window.showErrorMessage('Jira rejected the credentials.', 'Reconnect');
        if (pick) void vscode.commands.executeCommand('jiraGraph.configure');
      }
    } finally {
      if (this.abort === abort) this.busy = false;
    }
  }

  private async onMessage(m: WebviewMessage) {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        this.pending.splice(0).forEach((p) => this.post(p));
        this.postSyncState(this.scheduler?.phase ?? 'paused', this.scheduler?.nextRunAt());
        break;
      case 'activity':
        this.scheduler?.activity();
        break;
      case 'syncNow':
        this.syncNow();
        break;
      case 'describe':
        await this.describe(m.key, m.reqId);
        break;
      case 'openUrl':
        // Only web links from rendered descriptions; never file:, command: or javascript: URIs.
        if (/^https?:\/\//i.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      case 'openIssue':
        void vscode.commands.executeCommand('jiraGraph.openInBrowser', m.key);
        break;
      case 'expand':
        await this.expand(m.keys);
        break;
      case 'graphFrom': {
        const demo = this.source.kind === 'demo' || (this.source.kind === 'keys' && !!this.source.demo);
        await GraphPanel.open(this.ctx, { kind: 'keys', keys: [m.key], demo });
        break;
      }
      case 'refresh':
        await this.reload();
        break;
      case 'select':
        GraphPanel.selectEmitter.fire({ panel: this, key: m.key });
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.setStatusBarMessage(`$(copy) Copied ${m.text}`, 2500);
        break;
      case 'copyMermaid':
        this.copyMermaid();
        break;
      case 'exportSvg': {
        const uri = await vscode.window.showSaveDialog({
          filters: { SVG: ['svg'] },
          defaultUri: vscode.Uri.file(`${this.panel.title.replace(/[^\w.-]+/g, '_').slice(0, 60)}.svg`),
        });
        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(m.svg, 'utf8'));
          vscode.window.showInformationMessage(`Graph exported to ${uri.fsPath}`);
        }
        break;
      }
    }
  }

  /** Descriptions are fetched on demand and cached until the issue's `updated` changes. */
  private readonly descriptions = new Map<string, { updated?: string; html: string }>();
  /** Latest request per key: a slower, older response must not overwrite a newer one. */
  private readonly describeSeq = new Map<string, number>();

  private async describe(key: string, reqId: number) {
    this.describeSeq.set(key, reqId);
    const issue = this.model?.issues.find((i) => i.key === key);
    const cached = this.descriptions.get(key);
    if (cached && (!issue?.updated || cached.updated === issue.updated)) {
      this.post({ type: 'description', key, reqId, html: cached.html, updated: cached.updated });
      return;
    }
    const src = this.session?.issues;
    if (!src?.describe) {
      this.post({ type: 'description', key, reqId, html: '' });
      return;
    }
    try {
      const d = await src.describe(key);
      if (this.describeSeq.get(key) !== reqId) return; // superseded while in flight
      const prev = this.descriptions.get(key);
      if (!prev || !prev.updated || !d.updated || Date.parse(d.updated) >= Date.parse(prev.updated)) this.descriptions.set(key, d);
      this.post({ type: 'description', key, reqId, html: d.html, updated: d.updated });
    } catch (e) {
      if (this.describeSeq.get(key) !== reqId) return;
      this.post({ type: 'description', key, reqId, error: (e as Error).message });
    }
  }

  copyMermaid() {
    if (!this.model) return;
    void vscode.env.clipboard.writeText(toMermaid(this.model));
    vscode.window.showInformationMessage('Mermaid diagram copied to clipboard.');
  }

  private html(webview: vscode.Webview): string {
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    const asset = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', f));
    const state: PersistedState = { source: this.source };
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Jira Graph</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">window.__JIRA_GRAPH_STATE__ = ${JSON.stringify(state)};</script>
  <script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
  }
}
