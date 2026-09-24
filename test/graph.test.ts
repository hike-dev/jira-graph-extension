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

test('maxIssues truncates', async () => {
  const s = new GraphSession(new DemoSource(), { kind: 'demo' }, { ...opts, maxIssues: 8 });
  await s.load(() => {});
  const m = s.toModel();
  assert.equal(m.truncated, true);
  assert.ok(m.issues.filter((i) => i.loaded).length <= 8);
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
