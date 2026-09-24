// Toolbar icons (16×16, stroke = currentColor).
const svg = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const UI_ICONS = {
  down: svg('<rect x="5" y="1.5" width="6" height="3.5" rx="1"/><rect x="5" y="11" width="6" height="3.5" rx="1"/><path d="M8 5v5.5M6 8.6l2 1.9 2-1.9"/>'),
  right: svg('<rect x="1.5" y="5" width="3.5" height="6" rx="1"/><rect x="11" y="5" width="3.5" height="6" rx="1"/><path d="M5 8h5.5M8.6 6l1.9 2-1.9 2"/>'),
  tree: svg('<rect x="5.5" y="1.5" width="5" height="3" rx=".8"/><rect x="1.5" y="11.5" width="5" height="3" rx=".8"/><rect x="9.5" y="11.5" width="5" height="3" rx=".8"/><path d="M8 4.5v3.5M4 11.5V8h8v3.5"/>'),
  nested: svg('<rect x="1.5" y="1.5" width="13" height="13" rx="2"/><path d="M1.5 5h13"/><rect x="4" y="7.5" width="3.5" height="4.5" rx=".8"/><rect x="9" y="7.5" width="3.5" height="4.5" rx=".8"/>'),
  fit: svg('<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/><rect x="5" y="5" width="6" height="6" rx="1"/>'),
  zoomIn: svg('<circle cx="7" cy="7" r="4.8"/><path d="m10.5 10.5 3.5 3.5M5 7h4M7 5v4"/>'),
  zoomOut: svg('<circle cx="7" cy="7" r="4.8"/><path d="m10.5 10.5 3.5 3.5M5 7h4"/>'),
  refresh: svg('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3.2h-3.2"/>'),
  export: svg('<path d="M8 2v8M5 5l3-3 3 3M2.5 10v3.5h11V10"/>'),
  labels: svg('<path d="M2 3.5h6.5L13.5 8l-5 4.5H2z"/><circle cx="5" cy="8" r="1"/>'),
  done: svg('<circle cx="8" cy="8" r="6"/><path d="m5.3 8.2 1.9 1.9 3.6-4"/><path d="M2 14 14 2"/>'),
  magnet: svg('<path d="M3.5 2v6a4.5 4.5 0 0 0 9 0V2h-3v6a1.5 1.5 0 0 1-3 0V2z"/><path d="M3.5 4.5h3M9.5 4.5h3"/>'),
  collapse: svg('<path d="m4 10 4-4 4 4"/><path d="M2.5 13.5h11"/>'),
  expand: svg('<path d="m4 6 4 4 4-4"/><path d="M2.5 2.5h11"/>'),
  minimap: svg('<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><rect x="7.5" y="7" width="5" height="4" rx=".6"/>'),
  close: svg('<path d="m4 4 8 8M12 4l-8 8"/>'),
  open: svg('<path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4"/>'),
  focus: svg('<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5"/><circle cx="8" cy="8" r="5"/>'),
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  graph: svg('<circle cx="3.5" cy="8" r="2"/><circle cx="12.5" cy="3.5" r="2"/><circle cx="12.5" cy="12.5" r="2"/><path d="M5.3 7.1 10.7 4.4M5.3 8.9l5.4 2.7"/>'),
  copy: svg('<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>'),
  hide: svg('<path d="M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8z"/><circle cx="8" cy="8" r="1.8"/><path d="m2.5 13.5 11-11"/>'),
  info: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4"/><circle cx="8" cy="4.9" r=".6" fill="currentColor"/>'),
  more: svg('<circle cx="3.5" cy="8" r="1.1" fill="currentColor"/><circle cx="8" cy="8" r="1.1" fill="currentColor"/><circle cx="12.5" cy="8" r="1.1" fill="currentColor"/>'),
  check: svg('<path d="m3.5 8.5 3 3 6-7"/>'),
  warn: svg('<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3M8 11.6v.1"/>'),
};
