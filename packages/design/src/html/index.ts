import {
  CLASSES,
  type ButtonProps,
  type CardProps,
  type CodeBlockProps,
  type EvidenceLinkProps,
  type FooterProps,
  type HeaderProps,
  type StateMessageProps,
} from "../components/index.js";

/** Minimal HTML-attribute/text escaper — this package has no dependency on
 * any other workspace package, so it does not reuse sitekit-template's. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function header(props: HeaderProps): string {
  const home = props.homeHref ?? "/";
  const links = props.links
    .map(
      (l) =>
        `<a href="${escapeHtml(l.href)}"${l.current ? ' aria-current="page"' : ""}>${escapeHtml(l.label)}</a>`,
    )
    .join("\n");
  return `<header class="${CLASSES.header.root}">
<a class="${CLASSES.header.name}" href="${escapeHtml(home)}">${escapeHtml(props.siteName)}</a>
<nav>
${links}
</nav>
</header>`;
}

export function footer(props: FooterProps): string {
  const links = (props.links ?? [])
    .map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`)
    .join("\n");
  const linksHtml = links ? `\n<div>${links}</div>` : "";
  return `<footer class="${CLASSES.footer.root}"><p>${escapeHtml(props.creditText)}</p>${linksHtml}</footer>`;
}

export function button(props: ButtonProps): string {
  const cls = props.variant === "primary" ? `${CLASSES.button.root} ${CLASSES.button.primary}` : CLASSES.button.root;
  if (props.href) {
    const disabled = props.disabled ? ' aria-disabled="true"' : "";
    return `<a class="${cls}" href="${escapeHtml(props.href)}"${disabled}>${escapeHtml(props.label)}</a>`;
  }
  // `disabled=""` (not the bare-attribute form) so this string output and
  // React's renderToStaticMarkup output for the same boolean attribute
  // normalize to identical text — see html-react-parity.test.ts.
  const disabled = props.disabled ? ' disabled=""' : "";
  return `<button type="button" class="${cls}"${disabled}>${escapeHtml(props.label)}</button>`;
}

export function evidenceLink(props: EvidenceLinkProps): string {
  return `<a class="${CLASSES.evidence.root}" href="${escapeHtml(props.href)}">${escapeHtml(props.label)}</a>`;
}

export function card(props: CardProps): string {
  const label = props.label ? `<div class="${CLASSES.card.label}">${escapeHtml(props.label)}</div>` : "";
  const inner = `${label}<div class="${CLASSES.card.title}">${escapeHtml(props.title)}</div><div class="${CLASSES.card.body}">${escapeHtml(props.body)}</div>`;
  if (props.href) {
    return `<a class="${CLASSES.card.root}" href="${escapeHtml(props.href)}">${inner}</a>`;
  }
  return `<div class="${CLASSES.card.root}">${inner}</div>`;
}

export function codeBlock(props: CodeBlockProps): string {
  const head = props.label ? `<div class="${CLASSES.codeBlock.head}">${escapeHtml(props.label)}</div>` : "";
  return `<div class="${CLASSES.codeBlock.root}">${head}<pre><code>${escapeHtml(props.code)}</code></pre></div>`;
}

export function stateMessage(props: StateMessageProps): string {
  const cls = props.variant === "error" ? `${CLASSES.stateMessage.root} ${CLASSES.stateMessage.error}` : CLASSES.stateMessage.root;
  return `<p class="${cls}">${escapeHtml(props.message)}</p>`;
}
