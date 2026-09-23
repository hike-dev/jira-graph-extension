import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DemoSource } from '../src/jira/demoSource';
import { GraphSession } from '../src/jira/graphSession';
import { toMermaid } from '../src/mermaid';
import { layout } from '../webview/layout';
import { TypeStyles } from '../webview/typeStyles';

const opts = { depth: 2, maxIssues: 300, includeChildren: true };

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
