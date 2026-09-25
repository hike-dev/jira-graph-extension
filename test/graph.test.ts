import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DemoSource } from '../src/jira/demoSource';
import { GraphSession } from '../src/jira/graphSession';
import { toMermaid } from '../src/mermaid';
import { layout } from '../webview/layout';
import { TypeStyles } from '../webview/typeStyles';

const opts = { depth: 2, maxIssues: 300, includeChildren: true, sprintField: 'customfield_10020' };

async function demoModel(depth = 2) {
  const s = new GraphSession(new DemoSource(), { kind: 'demo' }, { ...opts, depth });
  await s.load(() => {});
  return { s, model: s.toModel() };
}

test('demo session expands hierarchy and links, keeps unreached issues as stubs', async () => {
  const { model } = await demoModel();
  const byKey = new Map(model.issues.map((i) => [i.key, i]));
  assert.deepEqual(model.roots.sort(), ['SHOP-10', 'SHOP-20', 'SHOP-30']);
  assert.equal(byKey.get('SHOP-1')?.loaded, true, 'parent initiative fetched');
  assert.equal(byKey.get('SHOP-111')?.parentKey, 'SHOP-11', 'sub-task parent');
  assert.equal(byKey.get('PLAT-7')?.loaded, true, 'linked cross-project issue fetched at depth 2');
  assert.equal(byKey.get('PLAT-2')?.loaded, false, 'beyond depth -> stub');
  // Each Jira link appears on both issues but must be one edge, directed outward.
  const blocks = model.links.filter((l) => l.from === 'PLAT-7' && l.to === 'SHOP-21');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].category, 'blocks');
  assert.equal(model.links.find((l) => l.label === 'duplicates')?.from, 'SHOP-25');
});

test('expanding a stub loads it', async () => {
  const { s } = await demoModel();
  await s.expand(['PLAT-2'], () => {});
  const m = s.toModel();
  assert.equal(m.issues.find((i) => i.key === 'PLAT-2')?.loaded, true);
  assert.equal(m.issues.find((i) => i.key === 'PLAT-12')?.loaded, true, 'children of expanded epic');
});

test('truncation is reported only when something was really left out', async () => {
  // Exact fit: a limit equal to what the graph needs is not truncation (the old false positive).
  const full = new GraphSession(new DemoSource(), { kind: 'demo' }, opts);
  await full.load(() => {});
  const needed = full.toModel().issues.filter((i) => i.loaded).length;
  const exact = new GraphSession(new DemoSource(), { kind: 'demo' }, { ...opts, maxIssues: needed });
  await exact.load(() => {});
  assert.equal(exact.toModel().truncated, false, `exact fit at ${needed} is not truncated`);
  assert.equal(exact.toModel().truncation, undefined);

  // The query itself has more results than the limit: Jira's "more" signal plus the real total.
  const q = new GraphSession(new DemoSource(), { kind: 'jql', jql: 'project = SHOP' }, { ...opts, depth: 0, maxIssues: 5 });
  await q.load(() => {});
  const t = q.toModel().truncation!;
  assert.equal(t.queryMore, true);
  assert.equal(t.queryLoaded, 5);
  assert.ok(t.queryTotal! > 5, `total ${t.queryTotal}`);

  // All query results fit, but expansion stopped at the limit: related tickets skipped, query not cut.
  const e = new GraphSession(new DemoSource(), { kind: 'demo' }, { ...opts, maxIssues: 8 });
  await e.load(() => {});
  const te = e.toModel().truncation!;
  assert.equal(te.queryMore, false);
  assert.ok(te.skipped > 0 || te.childrenCut, 'expansion cut is reported');
  assert.ok(e.toModel().issues.filter((i) => i.loaded).length <= 8);

  // Raising the limit and reloading clears it.
  e.setLimit(500);
  await e.load(() => {});
  assert.equal(e.toModel().truncation, undefined);
});

test('ELK layout: edges and nested modes produce positioned nodes and routed edges', async () => {
  const { model } = await demoModel();
  const styles = new TypeStyles();
  for (const mode of ['edges', 'nested'] as const) {
    for (const routing of ['ORTHOGONAL', 'SPLINES'] as const) {
      const r = await layout({
        issues: model.issues, links: model.links, styleOf: (i) => styles.of(i), measure: (t) => t.length * 6,
        direction: 'DOWN', mode, routing, showHierarchy: true, showLabels: true, linksAffectLayout: true,
      });
      assert.equal(r.nodes.size, model.issues.length, `${mode}: all nodes placed`);
      for (const n of r.nodes.values()) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && n.w > 0 && n.h > 0);
      assert.ok(r.edges.length > 0 && r.edges.every((e) => e.points.length >= 2 && e.points.every((p) => Number.isFinite(p.x))));
      if (mode === 'nested') {
        const epic = r.nodes.get('SHOP-20')!;
        const story = r.nodes.get('SHOP-21')!;
        assert.ok(epic.group, 'epic is a container');
        assert.ok(story.x >= epic.x && story.y >= epic.y && story.x + story.w <= epic.x + epic.w + 0.5 && story.y + story.h <= epic.y + epic.h + 0.5, 'story inside epic (root coords)');
        assert.ok(!r.edges.some((e) => e.kind === 'hierarchy'), 'no hierarchy edges in nested mode');
      } else {
        assert.ok(r.edges.some((e) => e.kind === 'hierarchy'));
      }
    }
  }
});

test('type styles detect common types and honour overrides', () => {
  const s = new TypeStyles({ 'Tech Debt': { base: 'task', color: '#123456', border: 'dotted' } });
  assert.equal(s.of({ type: 'Epic', isSubtask: false }).key, 'epic');
  assert.equal(s.of({ type: 'Sub-task', isSubtask: true }).key, 'subtask');
  assert.equal(s.of({ type: 'Defect', isSubtask: false }).key, 'bug');
  const td = s.of({ type: 'Tech Debt', isSubtask: false });
  assert.equal(td.color, '#123456');
  assert.equal(td.border, 'dotted');
  assert.equal(td.label, 'Tech Debt');
});

test('mermaid export', async () => {
  const { model } = await demoModel(1);
  const mm = toMermaid(model);
  assert.match(mm, /^flowchart TD/);
  assert.match(mm, /SHOP_10 --> SHOP_11/);
});

test('free-form JQL is scoped to the bound project', async () => {
  const { scopeJql } = await import('../src/shared/jql');
  const p = { key: 'KBIT', name: 'Kidney' };
  assert.equal(scopeJql('status = "In Progress" ORDER BY updated DESC', p), 'project = KBIT AND (status = "In Progress") ORDER BY updated DESC');
  assert.equal(scopeJql('ORDER BY created', p), 'project = KBIT ORDER BY created');
  assert.equal(scopeJql('project = KS AND type = Bug', p), 'project = KS AND type = Bug');
  assert.equal(scopeJql('assignee = currentUser()', undefined), 'assignee = currentUser()');
});

test('wide real-world shapes stay roughly proportional (fan-ins, loose tickets, big epics)', async () => {
  const issue = (key: string, type: string, parentKey?: string) => ({
    key, summary: key, type, isSubtask: false, status: 'To Do', statusCategory: 'new' as const, labels: [], parentKey, url: '', loaded: true,
  });
  const issues = [issue('E-1', 'Epic'), issue('HUB-1', 'Task'), issue('HUB-2', 'Task')];
  const links: import('../src/shared/model').GraphLink[] = [];
  for (let i = 0; i < 30; i++) issues.push(issue(`C-${i}`, 'Story', 'E-1'));
  for (let i = 0; i < 40; i++) {
    issues.push(issue(`R-${i}`, 'Task'));
    links.push({ id: `r${i}`, from: `R-${i}`, to: 'HUB-1', name: 'Relates', label: 'relates to', category: 'relates' });
  }
  for (let i = 0; i < 10; i++) {
    issues.push(issue(`B-${i}`, 'Bug'));
    links.push({ id: `b${i}`, from: `B-${i}`, to: 'HUB-2', name: 'Blocks', label: 'blocks', category: 'blocks' });
  }
  for (let i = 0; i < 40; i++) issues.push(issue(`L-${i}`, 'Task'));
  const styles = new TypeStyles();
  for (const mode of ['edges', 'nested'] as const) {
    const r = await layout({
      issues, links, styleOf: (i) => styles.of(i), measure: (t) => t.length * 6,
      direction: 'DOWN', mode, routing: 'ORTHOGONAL', showHierarchy: true, showLabels: true, linksAffectLayout: true, strategy: 'compact',
    });
    assert.equal(r.nodes.size, issues.length);
    const ratio = r.width / r.height;
    assert.ok(ratio < 3.2, `${mode}: aspect ratio ${ratio.toFixed(2)} (${Math.round(r.width)}×${Math.round(r.height)})`);
    // Every link is still drawn, either routed by ELK or as an overlay.
    assert.equal(r.edges.filter((e) => e.kind !== 'hierarchy').length, links.length);
  }
});

test('lenses classify the demo tickets', async () => {
  const { computeLens } = await import('../webview/lens');
  const { model } = await demoModel();
  const byKey = new Map(model.issues.map((i) => [i.key, i]));
  const kids = new Map<string, string[]>();
  for (const i of model.issues) if (i.parentKey && byKey.has(i.parentKey)) kids.set(i.parentKey, [...(kids.get(i.parentKey) ?? []), i.key]);
  const rollups = new Map<string, { new: number; indeterminate: number; done: number }>();
  const roll = (k: string): { new: number; indeterminate: number; done: number } => {
    const r = { new: 0, indeterminate: 0, done: 0 };
    for (const c of kids.get(k) ?? []) {
      r[byKey.get(c)!.statusCategory]++;
      const sub = roll(c);
      r.new += sub.new; r.indeterminate += sub.indeterminate; r.done += sub.done;
    }
    rollups.set(k, r);
    return r;
  };
  for (const k of kids.keys()) roll(k);
  const ctx = { issues: model.issues, links: model.links, byKey, rollups };

  const p = computeLens('progress', ctx);
  assert.equal(p.get('SHOP-21')!.level, 'primary');
  assert.ok(p.get('SHOP-21')!.badges.some((b) => b.text === 'moved'), 'moved <48h');
  assert.equal(p.get('SHOP-112')!.badges[0].tone, 'bad', '16 days in progress');
  assert.equal(p.get('PLAT-40')!.level, 'muted', 'done');
  assert.equal(p.get('SHOP-30')!.level, 'context', 'to-do epic with work in progress');

  const c = computeLens('completion', ctx);
  assert.equal(c.get('SHOP-25')!.level, 'primary', 'done 1.5d ago');
  assert.equal(c.get('SHOP-33')!.badges[0]?.text, 'unblocked', 'PLAT-40 (its only blocker) is done');
  assert.equal(c.get('SHOP-12')!.level, 'muted');

  const pl = computeLens('planning', ctx);
  assert.equal(pl.get('SHOP-13')!.level, 'primary');
  assert.ok(pl.get('SHOP-13')!.badges.some((b) => b.text === '↻1'), 'carried over');
  assert.equal(pl.get('SHOP-22')!.outline, 'dashed', 'future sprint');
  assert.equal(pl.get('SHOP-32')!.outline, 'hollow', 'backlog');
  assert.ok(pl.get('SHOP-32')!.badges.some((b) => b.text.endsWith('idle')));
  assert.ok(pl.get('SHOP-24')!.badges.some((b) => b.text === 'unassigned'));
});

test('sprint field parsing (Cloud objects and Server strings)', async () => {
  const { parseSprints } = await import('../src/jira/graphSession');
  assert.deepEqual(parseSprints([{ id: 1, name: 'S1', state: 'closed' }, { name: 'S2', state: 'active' }]), [
    { name: 'S1', state: 'closed' }, { name: 'S2', state: 'active' },
  ]);
  assert.deepEqual(parseSprints(['com.atlassian.greenhopper.service.sprint.Sprint@1f[id=3,rapidViewId=2,state=FUTURE,name=Team Sprint 9,startDate=<null>]']), [
    { name: 'Team Sprint 9', state: 'future' },
  ]);
  assert.equal(parseSprints(null), undefined);
});

test('layout strategies: explicit routes every relation, hybrid packs only relation-less tickets', async () => {
  const issue = (key: string, type: string, parentKey?: string) => ({
    key, summary: key, type, isSubtask: false, status: 'To Do', statusCategory: 'new' as const, labels: [], parentKey, url: '', loaded: true,
  });
  const issues = [issue('E-1', 'Epic'), issue('HUB', 'Task')];
  const links: import('../src/shared/model').GraphLink[] = [];
  for (let i = 0; i < 8; i++) issues.push(issue(`C-${i}`, 'Story', 'E-1')); // childless, no relations -> packable
  for (let i = 0; i < 8; i++) {
    issues.push(issue(`R-${i}`, 'Task'));
    links.push({ id: `r${i}`, from: `R-${i}`, to: 'HUB', name: 'Relates', label: 'relates to', category: 'relates' });
  }
  for (let i = 0; i < 8; i++) issues.push(issue(`L-${i}`, 'Task')); // no parent, no relations -> packable
  const styles = new TypeStyles();
  const run = (strategy: 'explicit' | 'hybrid' | 'compact', mode: 'edges' | 'nested') =>
    layout({
      issues, links, styleOf: (i) => styles.of(i), measure: (t) => t.length * 6,
      direction: 'DOWN', mode, routing: 'ORTHOGONAL', showHierarchy: true, showLabels: true, linksAffectLayout: true, strategy,
    });
  for (const mode of ['edges', 'nested'] as const) {
    const explicit = await run('explicit', mode);
    assert.equal(explicit.frames.length, 0, `${mode}: explicit packs nothing`);
    // Routed by ELK => orthogonal polyline (overlays are 4-point cubic curves with spline=true).
    assert.ok(explicit.edges.filter((e) => e.kind === 'relates').every((e) => !e.spline), `${mode}: explicit routes relations`);

    const hybrid = await run('hybrid', mode);
    assert.ok(hybrid.edges.filter((e) => e.kind === 'relates').every((e) => !e.spline), `${mode}: hybrid routes relations`);
    assert.equal(explicit.edges.filter((e) => e.kind === 'relates').length, 8, `${mode}: explicit keeps every edge`);
    assert.ok(hybrid.frames.some((f) => f.label?.startsWith('No relations')), `${mode}: relation-less tickets grouped`);
    const lx = new Set([...hybrid.nodes.values()].filter((n) => n.key.startsWith('L-')).map((n) => Math.round(n.y)));
    assert.ok(lx.size > 1, `${mode}: loose tickets wrap into a grid, not one row`);
    // A fan of single-link tickets becomes one framed cluster joined to the hub by one bundled edge.
    const fan = hybrid.frames.find((f) => f.id?.startsWith('__fan:'));
    assert.ok(fan && fan.members?.length === 8 && fan.members.every((m) => m.startsWith('R-')), `${mode}: fan cluster`);
    const bundle = hybrid.edges.filter((e) => e.kind === 'relates');
    assert.equal(bundle.length, 1, `${mode}: one bundled edge`);
    assert.equal(bundle[0].label, 'relates to ×8');
    assert.equal(bundle[0].to, 'HUB');

    const compact = await run('compact', mode);
    assert.ok(compact.edges.filter((e) => e.kind === 'relates').every((e) => e.spline), `${mode}: compact draws relations on top`);
  }
});

test('sync scheduler: paused / idle / debounce / cooldown timing', async () => {
  const { SyncScheduler } = await import('../src/sync/scheduler');
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 0;
  const runs: number[] = [];
  const s = new SyncScheduler(
    { idleIntervalMs: 60_000, debounceMs: 2_000, cooldownMs: 180_000, cooldownIntervalMs: 10_000 },
    {
      now: () => t,
      setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
      clearTimer: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
      run: async () => { runs.push(t); },
    },
  );
  const advance = async (to: number) => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > to) break;
      timers.shift();
      t = next.at;
      next.fn();
      await new Promise((r) => setImmediate(r));
    }
    t = to;
  };

  await advance(125_000);
  assert.deepEqual(runs, [60_000, 120_000], 'idle: once a minute');

  runs.length = 0;
  s.activity(); // t = 125s
  await advance(126_000);
  s.activity(); // debounce restarts
  await advance(130_000);
  assert.deepEqual(runs, [128_000], 'debounced 2s after the last action');
  await advance(150_000);
  assert.deepEqual(runs, [128_000, 138_000, 148_000], 'cooldown: every 10s');

  runs.length = 0;
  await advance(126_000 + 180_000 + 70_000);
  const gaps = runs.slice(1).map((r, i) => r - runs[i]);
  assert.ok(gaps.slice(-1)[0] === 60_000, `back to idle after cooldown (gaps ${gaps})`);

  runs.length = 0;
  s.setFocused(false);
  await advance(t + 600_000);
  assert.deepEqual(runs, [], 'paused while unfocused');
  const back = t;
  s.setFocused(true);
  await advance(back + 2_500);
  assert.deepEqual(runs, [back + 2_000], 'focus regained counts as an action');

  runs.length = 0;
  s.setVisible(false);
  await advance(t + 300_000);
  assert.deepEqual(runs, [], 'paused while the graph is hidden');

  // Continuous interaction must not starve syncing.
  s.setVisible(true);
  runs.length = 0;
  const start = t;
  for (let i = 0; i < 30; i++) {
    s.activity();
    await advance(t + 1_000);
  }
  assert.ok(runs.length >= 2 && runs[0] - start <= 10_000, `syncs during continuous activity (${runs.map((r) => r - start)})`);
  s.dispose();
});

test('session sync: changes, new children, deletions and moves', async () => {
  const src = new DemoSource();
  const s = new GraphSession(src, { kind: 'demo' }, { ...opts, overlapMs: 60_000, presenceIntervalMs: 0 });
  await s.load(() => {});
  const before = s.toModel();

  const changedKey = src.simulateChange();
  const newKey = src.simulateCreate('SHOP-30');
  src.simulateDelete('SHOP-14');
  await new Promise((r) => setTimeout(r, 5));
  const r = await s.sync();
  const after = s.toModel();

  assert.ok(r.changed.includes(changedKey), 'status change detected');
  assert.notEqual(after.issues.find((i) => i.key === changedKey)!.status, before.issues.find((i) => i.key === changedKey)!.status);
  assert.ok(r.added.includes(newKey), 'new child of a loaded epic joins');
  assert.equal(after.issues.find((i) => i.key === newKey)!.parentKey, 'SHOP-30');
  assert.deepEqual(r.removed, ['SHOP-14'], 'deleted issue detected by presence check');
  assert.ok(!after.issues.some((i) => i.key === 'SHOP-14'), 'removed from model (no stub resurrection)');
  assert.ok(!after.links.some((l) => l.from === 'SHOP-14' || l.to === 'SHOP-14'), 'its links are gone');

  // Nothing changed: an idle sync is a no-op.
  const again = await s.sync();
  assert.deepEqual([again.changed, again.added, again.removed], [[], [], []]);
});

test('workflow stages and blocking-link states (TMDXNC statuses)', async () => {
  const { stageOf, blockState, normalizeStageOverrides } = await import('../src/shared/stages');
  const s = (status: string, statusCategory: 'new' | 'indeterminate' | 'done') => stageOf({ status, statusCategory });
  assert.equal(s('To Do', 'new'), 'todo');
  assert.equal(s('Requirements Review', 'new'), 'todo');
  assert.equal(s('In Progress', 'indeterminate'), 'dev');
  assert.equal(s('In Review', 'indeterminate'), 'dev');
  assert.equal(s('Dev Testing Passed', 'indeterminate'), 'test');
  assert.equal(s('Ready for Testing', 'indeterminate'), 'test');
  assert.equal(s('QA Passed', 'indeterminate'), 'test');
  assert.equal(s('Done', 'done'), 'done');
  const o = normalizeStageOverrides({ 'In Review': 'test', Bogus: 'nope' });
  assert.equal(stageOf({ status: 'In Review', statusCategory: 'indeterminate' }, o), 'test', 'override wins');
  assert.deepEqual(Object.keys(o), ['in review'], 'invalid override ignored');
  assert.equal(blockState('todo', 'dev'), 'critical');
  assert.equal(blockState('todo', 'todo'), 'todo');
  assert.equal(blockState('dev', 'todo'), 'dev');
  assert.equal(blockState('test', 'dev'), 'test');
  assert.equal(blockState('dev', 'done'), 'stale');
  assert.equal(blockState('done', 'dev'), 'resolved');
});

test('filter: text + facets (OR within, AND across), flags, facet counts, sorting', async () => {
  const f = await import('../webview/filter');
  const { stageOf } = await import('../src/shared/stages');
  const { model } = await demoModel();
  const styles = new TypeStyles();
  const blockedSet = new Set(['SHOP-21', 'SHOP-13']);
  const ctx = {
    typeKey: (i: (typeof model.issues)[number]) => styles.of(i).key,
    stage: (i: (typeof model.issues)[number]) => stageOf(i),
    blocked: (k: string) => blockedSet.has(k),
    blocking: () => false,
    critical: (k: string) => k === 'SHOP-13',
    hasChildren: (k: string) => model.issues.some((i) => i.parentKey === k),
  };
  const run = (patch: Partial<import('../webview/filter').FilterState>) =>
    model.issues.filter((i) => f.matchesFilter(i, { ...f.EMPTY_FILTER, ...patch }, ctx)).map((i) => i.key).sort();

  assert.deepEqual(run({ text: 'pay' }), ['SHOP-20', 'SHOP-21', 'SHOP-24', 'PLAT-7'].sort(), 'text over summary');
  assert.deepEqual(run({ text: 'marco' }).sort(), run({ assignees: ['Marco Rossi'] }).sort(), 'text also searches assignee');
  const bugsOrSpikes = run({ types: ['bug', 'spike'] });
  assert.ok(bugsOrSpikes.includes('SHOP-13') && bugsOrSpikes.includes('SHOP-23'), 'OR within a facet');
  assert.deepEqual(run({ types: ['bug'], stages: ['done'] }), ['SHOP-25'], 'AND across facets');
  assert.deepEqual(run({ flags: ['blocked'] }), ['SHOP-13', 'SHOP-21']);
  assert.deepEqual(run({ flags: ['blocked', 'critical'] }), ['SHOP-13'], 'flags: all must hold');
  assert.ok(run({ assignees: [f.NONE] }).includes('SHOP-12'), 'unassigned');
  assert.ok(run({ sprints: [f.NONE] }).includes('SHOP-32'), 'backlog = no open sprint');
  assert.equal(f.activeCount({ ...f.EMPTY_FILTER, text: 'x', types: ['bug'] }), 2);

  // Facet counts ignore their own facet: choosing Bug must not zero the other types.
  const opts = f.facetOptions(model.issues, { ...f.EMPTY_FILTER, types: ['bug'] }, ctx);
  assert.ok(opts.types.find((o) => o.value === 'story')!.count > 0);
  assert.equal(opts.stages.reduce((a, o) => a + o.count, 0), run({ types: ['bug'] }).length, 'stage counts within bugs');

  const pos = new Map([['A-1', { x: 500, y: 0 }], ['A-2', { x: 0, y: 10 }], ['A-3', { x: 0, y: 300 }]]);
  const items = ['A-3', 'A-1', 'A-2', 'A-4'].map((key) => ({ ...model.issues[0], key }));
  const graphOrder = f.sortMatches(items, 'graph', { stage: (i) => stageOf(i), position: (k) => pos.get(k) }).map((i) => i.key);
  assert.deepEqual(graphOrder, ['A-2', 'A-1', 'A-3', 'A-4'], 'reading order (same row left→right), hidden last');
  assert.deepEqual(f.sortMatches(items, 'key', { stage: (i) => stageOf(i), position: () => undefined }).map((i) => i.key), ['A-1', 'A-2', 'A-3', 'A-4']);
});

test('load scope: sprint always, graded backlog, recent done, context, +N more, local re-scope', async () => {
  const src = new DemoSource();
  const scope = { enabled: true, backlog: 1, doneDays: 0, future: true, context: true };
  const s = new GraphSession(src, { kind: 'jql', jql: 'project = SHOP ORDER BY updated DESC', scope }, { ...opts });
  await s.load(() => {});
  const m = s.toModel();
  const tier = (k: string) => m.issues.find((i) => i.key === k)?.scope?.tier;
  // Sprint work (active + future), including done tickets that sit in the active sprint.
  for (const k of ['SHOP-21', 'SHOP-24', 'SHOP-12', 'SHOP-25', 'SHOP-111']) assert.equal(tier(k), 'sprint', k);
  // Parents and linked tickets come in as context, with a reason.
  assert.equal(tier('SHOP-10'), 'context');
  assert.match(m.issues.find((i) => i.key === 'SHOP-10')!.scope!.reasons[0], /Parent of/);
  assert.equal(tier('SHOP-23'), 'context', 'done blocker of sprint work is context even with doneDays 0');
  // Exactly one graded backlog ticket, the best-scored one, with its rank and reasons.
  const backlog = m.issues.filter((i) => i.scope?.tier === 'backlog');
  assert.equal(backlog.length, 1);
  assert.equal(backlog[0].scope!.rank, 1);
  assert.ok(backlog[0].scope!.reasons.some((r) => r.startsWith('Linked to sprint work')), backlog[0].scope!.reasons.join('; '));
  // Old done child of sprint work is left out but counted for its parent.
  assert.equal(tier('SHOP-211'), undefined);
  const info = m.scopeInfo!;
  assert.equal(info.omitted['SHOP-21']?.done, 1, 'SHOP-211 counted under SHOP-21');
  assert.equal(info.backlog.shown, 1);
  assert.ok(info.backlog.total > 1);
  assert.equal(m.truncated, false, 'leaving tickets out on purpose is not truncation');

  // Re-scoping is local: no new query, more backlog appears.
  let searches = 0;
  const orig = src.searchPage.bind(src);
  src.searchPage = async (...a) => ((searches += 1), orig(...a));
  await s.setScope({ ...scope, backlog: 10, doneDays: 14 }, () => {});
  const m2 = s.toModel();
  assert.equal(searches, 0, 'no request: index and out-of-project context are reused');
  assert.ok(m2.scopeInfo!.backlog.shown > 1);
  assert.equal(m2.issues.find((i) => i.key === 'SHOP-211')?.scope?.tier, 'done', 'recent done now included');

  // "+N more" loads a parent's left-out children.
  await s.setScope({ ...scope, backlog: 0 }, () => {});
  const before = s.toModel().scopeInfo!.omitted['SHOP-30'];
  assert.ok(before && before.backlog > 0, 'SHOP-30 has left-out backlog children');
  await s.loadMore('SHOP-30', () => {});
  const m3 = s.toModel();
  assert.equal(m3.scopeInfo!.omitted['SHOP-30'], undefined, 'nothing left out under SHOP-30');
  assert.equal(m3.issues.find((i) => i.key === 'SHOP-34')?.scope?.tier, 'requested');
});

test('filter by ticket: relation depth, direction, relation kinds, optional subtree', async () => {
  const { reachable, DEFAULT_ANCHOR } = await import('../webview/filter');
  const { model } = await demoModel();
  const r = (patch: Record<string, unknown>) => {
    const m = reachable(model.issues, model.links, { ...DEFAULT_ANCHOR, keys: ['SHOP-21'], depth: 1, ...patch } as never);
    return [...m.keys()].sort();
  };
  assert.deepEqual(r({}), ['PLAT-7', 'SHOP-20', 'SHOP-21', 'SHOP-211', 'SHOP-212', 'SHOP-22', 'SHOP-23'].sort(), 'both directions, all kinds, 1 hop');
  assert.deepEqual(r({ direction: 'up' }), ['PLAT-7', 'SHOP-20', 'SHOP-21', 'SHOP-23'], 'prerequisites: blockers + parent');
  assert.deepEqual(r({ direction: 'down' }), ['SHOP-21', 'SHOP-211', 'SHOP-212', 'SHOP-22'], 'subsequent: what it blocks + children');
  assert.deepEqual(r({ direction: 'down', via: ['blocks'], depth: 2 }), ['SHOP-12', 'SHOP-21', 'SHOP-22'], 'blocks chain, 2 hops');
  const dist = reachable(model.issues, model.links, { ...DEFAULT_ANCHOR, keys: ['SHOP-21'], depth: 2, direction: 'down', via: ['blocks'], subtree: false });
  assert.equal(dist.get('SHOP-12'), 2);
  // relates has no direction: followed even with "up".
  const rel = reachable(model.issues, model.links, { ...DEFAULT_ANCHOR, keys: ['SHOP-11'], depth: 1, direction: 'up', via: ['relates'], subtree: false });
  assert.ok(rel.has('SHOP-13') && rel.has('SHOP-14'));
  // Subtree: every descendant of each reached ticket, even when hierarchy is not followed.
  const sub = reachable(model.issues, model.links, { ...DEFAULT_ANCHOR, keys: ['SHOP-10'], depth: 1, direction: 'both', via: ['blocks'], subtree: true });
  for (const k of ['SHOP-11', 'SHOP-111', 'SHOP-112', 'SHOP-12', 'SHOP-13', 'SHOP-14']) assert.ok(sub.has(k), k);
  assert.equal(sub.get('SHOP-111'), 2, 'descendant distance = ancestor + 1 per level');
  // Unlimited depth follows the whole blocks chain.
  const all = reachable(model.issues, model.links, { ...DEFAULT_ANCHOR, keys: ['PLAT-40'], depth: 0, direction: 'down', via: ['blocks'], subtree: false });
  assert.deepEqual([...all.keys()].sort(), ['PLAT-40', 'SHOP-31', 'SHOP-33']);
});

test('disk cache: round trip, fingerprint/version/age checks, corrupt files, size cap', async () => {
  const { GraphCache, CACHE_VERSION } = await import('../src/jira/cache');
  const { mkdtemp, writeFile, readdir, utimes } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'jg-cache-'));
  const c = new GraphCache({ dir, maxAgeMs: 1000 * 60, maxBytes: 10_000 });
  await c.save('graph-a', 'fp1', { hello: 'world' }, 1_000);
  assert.deepEqual((await c.load('graph-a', 'fp1', 2_000))?.data, { hello: 'world' });
  assert.equal(await c.load('graph-a', 'fp2', 2_000), undefined, 'fingerprint mismatch');
  assert.equal(await c.load('graph-a', 'fp1', 1_000 + 61_000), undefined, 'too old');
  assert.equal(await c.load('graph-b', 'fp1', 2_000), undefined, 'missing');
  const [file] = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  await writeFile(join(dir, file), '{ not json');
  assert.equal(await c.load('graph-a', 'fp1', 2_000), undefined, 'corrupt file → cold load');
  await writeFile(join(dir, file), JSON.stringify({ version: CACHE_VERSION + 1, fingerprint: 'fp1', savedAt: 1_000, data: {} }));
  assert.equal(await c.load('graph-a', 'fp1', 2_000), undefined, 'other format version');
  // Size cap: the least recently written file goes first.
  const now = Date.now();
  const big = 'x'.repeat(4_000);
  await c.save('g1', 'f', big, now);
  await utimes(join(dir, (await readdir(dir)).find((n) => n.startsWith('graph-') && n.endsWith('.json'))!), new Date(now - 30_000), new Date(now - 30_000));
  await c.save('g2', 'f', big, now);
  await c.save('g3', 'f', big, now);
  assert.equal(await c.load('g1', 'f', now), undefined, 'least recently written dropped to stay under the cap');
  assert.ok(await c.load('g2', 'f', now) && (await c.load('g3', 'f', now)), 'newer ones kept');
  // Orphaned temp files from a crashed write are removed.
  await writeFile(join(dir, 'graph-x.json.1.1.tmp'), 'partial');
  await utimes(join(dir, 'graph-x.json.1.1.tmp'), new Date(now - 120_000), new Date(now - 120_000));
  await c.prune(now);
  assert.ok(!(await readdir(dir)).some((n) => n.endsWith('.tmp')));
  await c.clear();
  assert.equal(await c.load('g3', 'f', now), undefined, 'cleared');
});

test('session snapshot: restore without requests, re-scope locally, then catch up by sync', async () => {
  const src = new DemoSource();
  let searches = 0;
  const orig = src.searchPage.bind(src);
  src.searchPage = async (...a) => ((searches += 1), orig(...a));
  const scope = { enabled: true, backlog: 2, doneDays: 14, future: true, context: true };
  const source = { kind: 'jql' as const, jql: 'project = SHOP ORDER BY updated DESC', scope };
  const a = new GraphSession(src, source, { ...opts, overlapMs: 60_000 });
  await a.load(() => {});
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  // Compared as JSON: that is what reaches the webview (undefined-valued keys disappear either way).
  const strip = (m: ReturnType<typeof a.toModel>) => JSON.parse(JSON.stringify({ ...m, fetchedAt: '' }));

  searches = 0;
  const b = new GraphSession(src, { ...source, scope: { ...scope } }, { ...opts, overlapMs: 60_000 });
  await b.restore(snap);
  assert.equal(searches, 0, 'restore makes no request');
  assert.deepEqual(strip(b.toModel()), strip(a.toModel()), 'same graph as before');
  assert.equal(JSON.stringify(b.cacheKey()), JSON.stringify(a.cacheKey()), 'same cache identity');

  // Scope settings changed since the snapshot: re-scope from the cached index, still no request.
  const c = new GraphSession(src, { ...source, scope: { ...scope, backlog: 0 } }, { ...opts, overlapMs: 60_000 });
  await c.restore(snap);
  assert.equal(searches, 0);
  assert.equal(c.toModel().scopeInfo!.backlog.shown, 0);

  // Something changed in Jira after the snapshot: the first sync picks it up from the saved cursor.
  const changed = src.simulateChange();
  await new Promise((r) => setTimeout(r, 5));
  const r = await b.sync();
  assert.ok(r.changed.includes(changed) || r.added.includes(changed), `caught up on ${changed}`);
  assert.equal(r.checkedPresence, true, 'deletion check runs on the first sync after a restore');

  // Demo graphs are never cached.
  assert.equal(new GraphSession(src, { kind: 'demo' }, opts).cacheKey(), undefined);
});

test('edits: transition and sprint move write to the source, refresh redraws only what changed', async () => {
  const src = new DemoSource();
  const s = new GraphSession(src, { kind: 'demo' }, opts);
  await s.load(() => {});
  assert.deepEqual(s.toModel().editable, { status: true, sprint: true });
  assert.deepEqual(new GraphSession(src, { kind: 'demo' }, { ...opts, sprintField: undefined }).toModel().editable, { status: true, sprint: false });

  const t = await src.transitions('SHOP-12');
  const prog = t.find((x) => x.to.name === 'In Progress')!;
  await src.transition('SHOP-12', prog.id);
  assert.deepEqual(await s.refresh(['SHOP-12']), ['SHOP-12']);
  const i = s.toModel().issues.find((x) => x.key === 'SHOP-12')!;
  assert.equal(i.status, 'In Progress');
  assert.equal(i.statusCategory, 'indeterminate');
  assert.deepEqual(await s.refresh(['SHOP-12']), [], 'nothing new on a second read');

  // Sprint moves keep closed sprints as history; the backlog removes the open one.
  const sprints = await src.sprints();
  await src.moveToSprint('SHOP-13', sprints.find((x) => x.state === 'future')!.id);
  await s.refresh(['SHOP-13']);
  assert.deepEqual(s.toModel().issues.find((x) => x.key === 'SHOP-13')!.sprints, [{ name: 'SHOP Sprint 13', state: 'closed' }, { name: 'SHOP Sprint 15', state: 'future' }]);
  await src.moveToSprint('SHOP-13', undefined);
  await s.refresh(['SHOP-13']);
  assert.deepEqual(s.toModel().issues.find((x) => x.key === 'SHOP-13')!.sprints, [{ name: 'SHOP Sprint 13', state: 'closed' }]);
  await assert.rejects(src.moveToSprint('SHOP-111', sprints[0].id), /sub-task/i);

  // The next sync sees the refreshed version and does not report the edit again.
  const r = await s.sync();
  assert.ok(!r.changed.includes('SHOP-12') && !r.changed.includes('SHOP-13'), `sync changed: ${r.changed}`);
});
