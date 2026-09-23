# TODO

Parked ideas and open questions, roughly by priority within each section.

## To verify on a real site
- [ ] Does adding/removing an issue link bump `updated` on both issues? If not, link-only changes wait for the presence check.
- [ ] Sprint field id on tmdxdev (`jiraGraph.sprintField`, default `customfield_10020`).
- [ ] `statuscategorychangedate` availability on Server/DC (time-in-status badges).
- [ ] Run the extension end to end in VS Code against the bound project (only the webview and unit tests were exercised headless).

## Live sync
- [ ] Persist the local store + cursor to disk: instant open from cache, then catch up.
- [ ] Early presence check when `approximate-count` of the source query drops.
- [ ] Change history view: last N changes (field old → new, who, when), "since I last looked".
- [ ] Old → new status chip on changed cards for a few seconds; "changed" dot until seen.
- [ ] Refresh linked issues from other projects during presence checks.
- [ ] Two-phase fetch: fetch detail fields only when an issue is opened.
- [ ] Proactively switch to key-scoped checks on very busy sites (today: fallback above 500 updates in the overlap window).
- [ ] Sleep/wake: sync once on wake and restart the cadence.
- [ ] Optional push channel: Forge app (issue + link events, web trigger) or admin webhook → relay; keep polling as the source of truth.
- [ ] Whole-project scope without the `maxIssues` cap: store vs. rendered scope (project / unresolved / sprint / epic).

## Layout and representation
- [ ] Tech-tree tiers: labelled layer bands ("ready now", "1 step", …).
- [ ] Dependencies lens: done / available / in progress / locked (🔒 N).
- [ ] Goal targeting: pick a ticket, show its prerequisite set in order with remaining count.
- [ ] Bus connectors (`elk.layered.mergeEdges`) for Explicit and Hybrid.
- [ ] Branch colours per epic; cross-branch edges stand out.
- [ ] Stable positions across refreshes (`elk.interactive`), pinning, manual drag.
- [ ] Ghost neighbours: faded nodes one hop outside the scope instead of hiding.
- [ ] Zoomed-out epic clusters with a progress ring.
- [ ] ELK in a Web Worker; collapse by default above a node threshold; canvas/WebGL renderer for very large graphs.
- [ ] Tree mode still gets wide when blocks links chain many epic trees together.
- [ ] Critical path along `blocks` chains; swimlanes by assignee / sprint / component (ELK partitioning).

## Product
- [ ] Edit from the graph: drag to create a link, transition status, reparent by drop.
- [ ] Hover / CodeLens for issue keys in code and commit messages.
- [ ] Health lint: done parent with open children, stale in-progress work, orphans, missing estimates.
- [ ] Saved views (filters, lens, strategy, collapsed state) next to saved queries.
