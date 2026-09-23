import { GraphModel } from './shared/model';

const ARROWS = { blocks: '==>', relates: '-.-', duplicates: '-.->', clones: '-.->', other: '-.->' } as const;

/** Mermaid flowchart for pasting the graph into PRs, Confluence or Markdown docs. */
export function toMermaid(model: GraphModel): string {
  const id = (k: string) => k.replace(/[^A-Za-z0-9_]/g, '_');
  const esc = (s: string) => s.replace(/"/g, '#quot;');
  const keys = new Set(model.issues.map((i) => i.key));
  const lines = ['flowchart TD'];
  for (const i of model.issues) {
    lines.push(`  ${id(i.key)}["${esc(`${i.key} · ${i.type}`)}<br/>${esc(i.summary)}"]:::${i.statusCategory}`);
  }
  for (const i of model.issues) {
    if (i.parentKey && keys.has(i.parentKey)) lines.push(`  ${id(i.parentKey)} --> ${id(i.key)}`);
  }
  for (const l of model.links) {
    lines.push(`  ${id(l.from)} ${ARROWS[l.category]}|${esc(l.label)}| ${id(l.to)}`);
  }
  lines.push(
    '  classDef new fill:#f4f5f7,stroke:#8993a4',
    '  classDef indeterminate fill:#deebff,stroke:#0052cc',
    '  classDef done fill:#e3fcef,stroke:#00875a',
  );
  return lines.join('\n');
}
