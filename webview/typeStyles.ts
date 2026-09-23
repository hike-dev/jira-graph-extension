import type { GraphIssue, LinkCategory, TypeStyleOverride } from '../src/shared/model';

export type BorderStyle = 'solid' | 'dashed' | 'dotted' | 'double';

export interface TypeStyle {
  key: string;
  label: string;
  color: string;
  border: BorderStyle;
  width: number;
  radius: number;
  icon: string;
  /** Visual weight in the layout (size of the card). */
  size: 'large' | 'normal' | 'small';
}

const BASE: Record<string, TypeStyle> = {
  initiative: { key: 'initiative', label: 'Initiative', color: '#F18A2C', border: 'double', width: 1.5, radius: 14, icon: 'initiative', size: 'large' },
  epic: { key: 'epic', label: 'Epic', color: '#904EE2', border: 'solid', width: 3, radius: 12, icon: 'epic', size: 'large' },
  feature: { key: 'feature', label: 'Feature', color: '#00A3BF', border: 'solid', width: 2.5, radius: 12, icon: 'feature', size: 'large' },
  story: { key: 'story', label: 'Story', color: '#63BA3C', border: 'solid', width: 2, radius: 8, icon: 'story', size: 'normal' },
  task: { key: 'task', label: 'Task', color: '#4BADE8', border: 'solid', width: 2, radius: 6, icon: 'task', size: 'normal' },
  bug: { key: 'bug', label: 'Bug', color: '#E5493A', border: 'dashed', width: 2, radius: 6, icon: 'bug', size: 'normal' },
  incident: { key: 'incident', label: 'Incident', color: '#DE350B', border: 'solid', width: 3, radius: 4, icon: 'incident', size: 'normal' },
  spike: { key: 'spike', label: 'Spike', color: '#6554C0', border: 'dotted', width: 2.2, radius: 8, icon: 'spike', size: 'normal' },
  improvement: { key: 'improvement', label: 'Improvement', color: '#36B37E', border: 'dashed', width: 2, radius: 8, icon: 'improvement', size: 'normal' },
  subtask: { key: 'subtask', label: 'Sub-task', color: '#6B9BD1', border: 'solid', width: 1.25, radius: 4, icon: 'subtask', size: 'small' },
  other: { key: 'other', label: 'Other', color: '#8993A4', border: 'solid', width: 1.5, radius: 6, icon: 'other', size: 'normal' },
};

const DETECT: [RegExp, string][] = [
  [/initiative|theme|portfolio/i, 'initiative'],
  [/epic/i, 'epic'],
  [/feature/i, 'feature'],
  [/sub-?task/i, 'subtask'],
  [/story/i, 'story'],
  [/incident|outage/i, 'incident'],
  [/bug|defect/i, 'bug'],
  [/spike|research|investigation/i, 'spike'],
  [/improvement|enhancement|tech.?debt/i, 'improvement'],
  [/task|chore/i, 'task'],
];

export class TypeStyles {
  private cache = new Map<string, TypeStyle>();
  private overrides: Record<string, TypeStyleOverride>;

  constructor(overrides: Record<string, TypeStyleOverride> = {}) {
    this.overrides = Object.fromEntries(Object.entries(overrides).map(([k, v]) => [k.toLowerCase(), v]));
  }

  of(issue: Pick<GraphIssue, 'type' | 'isSubtask'>): TypeStyle {
    const cacheKey = `${issue.type}|${issue.isSubtask}`;
    let s = this.cache.get(cacheKey);
    if (s) return s;
    const o = this.overrides[issue.type.toLowerCase()];
    const detected = issue.isSubtask ? 'subtask' : DETECT.find(([re]) => re.test(issue.type))?.[1] ?? 'other';
    const base = BASE[o?.base ?? ''] ?? BASE[detected];
    s = {
      ...base,
      key: o ? `custom:${issue.type}` : base.key,
      label: o || base.key === 'other' ? issue.type : base.label,
      color: o?.color ?? base.color,
      border: o?.border ?? base.border,
      icon: o?.icon && ICONS[o.icon] ? o.icon : base.icon,
    };
    this.cache.set(cacheKey, s);
    return s;
  }
}

export function dashArray(style: TypeStyle): string | undefined {
  if (style.border === 'dashed') return `${style.width * 3.5} ${style.width * 2}`;
  if (style.border === 'dotted') return `0.1 ${style.width * 2.4}`;
  return undefined;
}

/** Glyphs drawn in white on a 16×16 rounded square of the type colour (Jira-like). */
export const ICONS: Record<string, string> = {
  epic: '<path d="M9.2 2.5 4.3 9h3.4l-.9 4.5L11.7 7H8.3z" fill="#fff"/>',
  story: '<path d="M5 3.2h6v9.6L8 10.6l-3 2.2z" fill="#fff"/>',
  task: '<path d="M4.4 8.3 6.9 10.8 11.6 5.4" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  bug: '<circle cx="8" cy="8" r="3.4" fill="#fff"/>',
  subtask: '<rect x="3.6" y="3.6" width="5.4" height="5.4" rx="1" fill="none" stroke="#fff" stroke-width="1.4"/><rect x="7" y="7" width="5.4" height="5.4" rx="1" fill="#fff"/>',
  initiative: '<path d="M3 6.2 8 3.4l5 2.8L8 9z" fill="#fff"/><path d="M3 9.2 8 12l5-2.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>',
  feature: '<path d="M5.2 2.8v10.4M5.2 3.2h6.4l-1.6 2.6 1.6 2.6H5.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>',
  spike: '<circle cx="7" cy="7" r="3.1" fill="none" stroke="#fff" stroke-width="1.7"/><path d="m9.4 9.4 3 3" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>',
  improvement: '<path d="M8 3 12.4 7.6H9.6v5.2H6.4V7.6H3.6z" fill="#fff"/>',
  incident: '<path d="M8 2.8 13.3 12.4H2.7z" fill="#fff"/><path d="M8 6.4v3" stroke-width="1.5" stroke-linecap="round" stroke="currentColor"/><circle cx="8" cy="10.9" r=".8" fill="currentColor"/>',
  other: '<circle cx="8" cy="8" r="3.3" fill="none" stroke="#fff" stroke-width="1.7"/>',
};

export function iconMarkup(style: TypeStyle, size = 16): string {
  return `<svg class="type-icon" width="${size}" height="${size}" viewBox="0 0 16 16" style="color:${style.color}"><rect width="16" height="16" rx="3.5" fill="${style.color}"/>${ICONS[style.icon]}</svg>`;
}

export const LINK_LABELS: Record<LinkCategory | 'hierarchy', string> = {
  hierarchy: 'Parent → child',
  blocks: 'Blocks',
  relates: 'Relates to',
  duplicates: 'Duplicates',
  clones: 'Clones',
  other: 'Other links',
};

const P_HIGHEST = { path: 'M2 7 6 3l4 4M2 10.5l4-4 4 4', color: '#CD1317' };
const P_HIGH = { path: 'M2 8.5l4-4 4 4', color: '#E9494A' };
const P_MEDIUM = { path: 'M2 4.5h8M2 7.5h8', color: '#E97F33' };
const P_LOW = { path: 'M2 3.5l4 4 4-4', color: '#2684FF' };
const P_LOWEST = { path: 'M2 1.5l4 4 4-4M2 5l4 4 4-4', color: '#2684FF' };

/** 12×12 stroke glyphs, Jira-style priority chevrons. */
export const PRIORITY: Record<string, { path: string; color: string }> = {
  highest: P_HIGHEST,
  critical: P_HIGHEST,
  blocker: P_HIGHEST,
  high: P_HIGH,
  major: P_HIGH,
  medium: P_MEDIUM,
  low: P_LOW,
  minor: P_LOW,
  lowest: P_LOWEST,
  trivial: P_LOWEST,
};
