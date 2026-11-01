type Child = Node | string | null | undefined | false;

/**
 * Tiny element builder. Strings become text nodes (textContent semantics), so scraped
 * content can never be parsed as HTML.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; id?: string; attrs?: Record<string, string>; on?: { click?: (e: Event) => void } } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.id) node.id = props.id;
  for (const [k, v] of Object.entries(props.attrs ?? {})) node.setAttribute(k, v);
  if (props.on?.click) node.addEventListener('click', props.on.click);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function button(label: string, onClick?: () => void, cls?: string): HTMLButtonElement {
  return el('button', { class: cls, attrs: { type: 'button' }, on: { click: () => onClick?.() } }, label);
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return plural(Math.floor(s / 60), 'minute');
  if (s < 86400) return plural(Math.floor(s / 3600), 'hour');
  return plural(Math.floor(s / 86400), 'day');
}
