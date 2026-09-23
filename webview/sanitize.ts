// Allowlist sanitiser for Jira-rendered description HTML (untrusted).
// DOMParser builds an inert document (no scripts run, nothing loads); we then rebuild only the
// elements and attributes we allow. Everything else is unwrapped to its text.

const BLOCK = new Set(['p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr']);
const INLINE = new Set(['strong', 'b', 'em', 'i', 'u', 's', 'del', 'code', 'sub', 'sup', 'br', 'span']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'form', 'input', 'button', 'select', 'textarea']);

export function sanitizeDescription(html: string): string {
  if (!html.trim()) return '';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = document.createElement('div');
  for (const n of [...doc.body.childNodes]) append(out, n);
  return out.innerHTML;
}

function append(parent: Element, n: Node) {
  if (n.nodeType === Node.TEXT_NODE) {
    parent.appendChild(document.createTextNode(n.textContent ?? ''));
    return;
  }
  if (n.nodeType !== Node.ELEMENT_NODE) return;
  const el = n as Element;
  const tag = el.tagName.toLowerCase();
  if (DROP.has(tag)) return;

  if (tag === 'img') {
    // Attachments need Jira auth and the webview CSP blocks remote images: show a placeholder.
    const chip = document.createElement('span');
    chip.className = 'desc-media';
    chip.textContent = `🖼 ${el.getAttribute('alt') || 'image'}`;
    parent.appendChild(chip);
    return;
  }
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    const a = document.createElement('a');
    if (/^https?:\/\//i.test(href)) {
      a.setAttribute('data-url', href);
      a.setAttribute('href', '#');
      a.setAttribute('title', href);
    }
    for (const c of [...el.childNodes]) append(a, c);
    parent.appendChild(a);
    return;
  }

  let target: Element = parent;
  if (BLOCK.has(tag) || INLINE.has(tag)) {
    target = document.createElement(tag);
    if ((tag === 'td' || tag === 'th') && el.getAttribute('colspan')) target.setAttribute('colspan', String(parseInt(el.getAttribute('colspan')!, 10) || 1));
    parent.appendChild(target);
  } else if (HEADINGS.has(tag)) {
    // Headings keep their meaning but not their size: a card is not a page.
    target = document.createElement('h5');
    parent.appendChild(target);
  } else if (tag === 'div' && el.parentElement?.tagName.toLowerCase() === 'body') {
    target = document.createElement('p');
    parent.appendChild(target);
  }
  for (const c of [...el.childNodes]) append(target, c);
}
