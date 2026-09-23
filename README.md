# Jira Graph for VS Code

Interactive dependency graph of Jira tickets inside VS Code, laid out with [ELK](https://eclipse.dev/elk/) (`elkjs`).

- **Hierarchy**: Initiative → Epic → Story/Task/Bug → Sub-task.
- **Cross links**: blocks, relates to, duplicates, clones, and any custom link type.

![Tree mode](docs/tree-mode.png)
![Nested mode](docs/nested-mode.png)

## Features

### Main-screen graph (webview panel)
- **Node = ticket.** Each node shows the key, title, status pill, priority chevrons and assignee avatar.
- **Type = border + icon.** Each issue type has its own border style and a Jira-like icon:

  | Type | Border | Icon |
  |---|---|---|
  | Initiative | orange, **double** | stacked layers |
  | Epic | purple, **thick** | lightning bolt |
  | Feature | teal, thick | flag |
  | Story | green, solid | bookmark |
  | Task | blue, solid | check |
  | Bug | red, **dashed** | dot |
  | Spike | indigo, **dotted** | magnifier |
  | Improvement | green, dashed | up arrow |
  | Incident | red, heavy | warning |
  | Sub-task | light blue, thin, **smaller card** | two squares |

  Custom types can be mapped with `jiraGraph.issueTypeStyles`.
- **Two hierarchy modes:**
  - **Tree**: parent → child edges in a layered layout.
  - **Nested**: children drawn inside their parent's container. With *"links shape layout"* off, containers are rect-packed into a compact roadmap board.
- **Link styling.** Each relation type has its own colour, dash pattern and arrowhead, plus optional labels.
- **Dependency analysis:**
  - A ⛔ badge marks issues blocked by unresolved issues.
  - **Blocks cycles** are detected (Tarjan SCC), animated, and reported in a banner.
- **Collapse and expand subtrees.** Links to hidden descendants are re-attached to the collapsed ancestor, for example `blocks ×3`. This gives an epic-level dependency view with one click (*Collapse all*).
- **Stub nodes.** Issues reached through a relation but not yet fetched appear hatched. Click **+** or double-click to load them.
- **Focus mode**: shows only the N-hop neighbourhood of an issue (1–3 hops).
- **Filters.** Click legend entries to hide issue types or link types. You can also hide done issues, or hide single nodes.
- **Search.** Matches key, title, assignee, status and labels, with Enter cycling through matches.
- **Minimap**, animated relayout, pan and zoom, and fit to screen.
- **Details drawer**: status, priority, assignee, labels, parent, children and relations grouped by type, with action buttons.
- **Context menu**: open in Jira, load relations, focus, new graph from here, collapse, copy key or link, hide.
- **Keyboard:**
  - `/` search · `F` fit · `+`/`-`/`0` zoom
  - arrows move the selection spatially
  - `Enter` opens · `E` expands · `Space` collapses · `H` hides · `Esc` clears
- **Export:**
  - standalone themed **SVG**
  - **Mermaid** (paste into PRs, Confluence or Markdown)
  - visible keys, or a `key in (…)` JQL
- **Themes.** Follows the VS Code theme (dark, light, high contrast). The layout and view options are remembered per panel, and panels are restored after a restart.

### Side panel (activity-bar icon)
- **Queries**: saved JQL (stored in `jiraGraph.queries`, so it can be shared via workspace settings), recent queries, and the demo graph.
- **Graph Issues**: the hierarchy of the active graph as a tree.
  - The tree and the graph stay in sync both ways.
  - Tooltips show the relations.
  - Inline actions: open in Jira, load a stub.

### Other entry points
- `Jira Graph: Open Graph from JQL…`, with a quick pick of saved and recent queries.
- `Jira Graph: Open Graph around Issue…` pre-fills the key from the editor selection, the word under the cursor, or the git branch.
- `Jira Graph: Open Graph for Current Git Branch`, e.g. `feature/SHOP-123-guest-checkout`.
- A status bar item shows the issue count and blocked count of the active graph.

## Getting started

```bash
npm install
npm run build        # or: npm run watch
npm test             # session / layout / style unit tests
```

Press **F5** in VS Code to start an Extension Development Host. Run **Jira Graph: Open Demo Graph**, which works offline, or **Connect to Jira**:

- **Jira Cloud**: base URL, account email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens).
- **Server / Data Center**: base URL and a personal access token.

The token is stored in VS Code **SecretStorage**, never in settings.

After connecting you pick the **project** this workspace works with (`jiraGraph.project`, saved per workspace). From then on:
- the Queries panel shows the project at the top — click it to open its unresolved tickets;
- **Open Graph from JQL…** offers project presets (unresolved, all, epics, open sprints, mine, recently updated), and any typed JQL is limited to the project unless it names another one;
- **Switch Project…** rebinds the workspace.

Package: `npm run package` gives you a `.vsix`. Install it with *Extensions → … → Install from VSIX*.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `jiraGraph.expandDepth` | 2 | Rounds of parents / children / links followed from the query result |
| `jiraGraph.maxIssues` | 300 | Hard cap per graph |
| `jiraGraph.includeChildren` | true | Fetch children of epics / stories |
| `jiraGraph.epicLinkField` | – | Epic Link field id for Server/DC or legacy projects |
| `jiraGraph.storyPointsField` | – | Shown in the details drawer |
| `jiraGraph.layout.*` | DOWN / edges / ORTHOGONAL | Defaults for new graphs |
| `jiraGraph.issueTypeStyles` | {} | `{ "Tech Debt": { "base": "task", "color": "#8B5CF6", "border": "dashed", "icon": "improvement" } }` |

## Architecture

```
src/                       extension host (Node)
  extension.ts             commands, tree views, status bar, serializer
  config.ts                settings + SecretStorage auth flow
  jira/client.ts           REST client: Cloud /rest/api/3/search/jql (token paging) and Server /rest/api/2/search
  jira/graphSession.ts     BFS expansion (links, parents, children), stubs, batching, maxIssues
  jira/demoSource.ts       offline dataset with a tiny JQL interpreter
  views/graphPanel.ts      webview panel lifecycle and message protocol
  views/*Tree.ts           side panel trees
  shared/model.ts          types shared with the webview
webview/                   browser bundle (esbuild, iife)
  layout.ts                model → ELK graph (flat / INCLUDE_CHILDREN / rectpacking) → positioned nodes & routed edges
  main.ts                  SVG renderer, interactions, drawer, legend, minimap, export
  typeStyles.ts            type → border/icon/colour mapping
```

## Roadmap / ideas

1. **Critical path and schedule view**: longest `blocks` chain, with start/due dates or sprints as ELK layer constraints (a Gantt-like layered view).
2. **Swimlanes**: group by assignee, team, sprint, component or fix version, using ELK partitioning.
3. **Diff since last refresh**: highlight nodes whose status changed or that were added since the previous load, plus auto-refresh.
4. **Edit from the graph**: drag to create a `blocks` link, transition status from the context menu, reparent by dropping into a container.
5. **Code integration**:
   - hover and CodeLens for issue keys in code and commit messages
   - "issues touched by this branch/PR", via the Git extension and Bitbucket/GitHub
6. **Health lint**: done parents with open children, open issues blocked by done ones, cycles, orphans, missing estimates, stale in-progress work.
7. **Large graphs**: run ELK in a Web Worker, render with canvas/WebGL beyond about 1,500 nodes, collapse by default above a threshold.
8. **Saved views**: persist filters, collapsed state and focus as named views next to saved queries. Share them as a URL or a workspace setting.
9. **Rollups on containers**: progress bar of done children and summed story points on epics and initiatives.
10. **Pinned or manual positions**, with incremental ELK layout (`elk.interactive`) for stable positions across refreshes.
