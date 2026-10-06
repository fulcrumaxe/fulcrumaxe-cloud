import type { ReactElement } from "react";
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

/**
 * Thin React wrappers over the exact same markup/classes src/html/index.ts
 * emits as strings (D#2 spec amendment pass/fail item 4: the two must
 * normalize to the same markup — see
 * packages/design/test/html-react-parity.test.ts). Neither renderer is
 * "the real one" — both read their class names from
 * ../components/index.ts's CLASSES, and neither hardcodes a colour or
 * spacing value; every visual property comes from the CSS var() chain in
 * base.css, not from these components.
 */

export function Header({ siteName, homeHref = "/", links }: HeaderProps): ReactElement {
  return (
    <header className={CLASSES.header.root}>
      <a className={CLASSES.header.name} href={homeHref}>
        {siteName}
      </a>
      <nav>
        {links.map((l) => (
          <a key={l.href} href={l.href} aria-current={l.current ? "page" : undefined}>
            {l.label}
          </a>
        ))}
      </nav>
    </header>
  );
}

export function Footer({ creditText, links }: FooterProps): ReactElement {
  return (
    <footer className={CLASSES.footer.root}>
      <p>{creditText}</p>
      {links && links.length > 0 ? (
        <div>
          {links.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </div>
      ) : null}
    </footer>
  );
}

export function Button({ label, href, variant, disabled }: ButtonProps): ReactElement {
  const cls = variant === "primary" ? `${CLASSES.button.root} ${CLASSES.button.primary}` : CLASSES.button.root;
  if (href) {
    return (
      <a className={cls} href={href} aria-disabled={disabled ? "true" : undefined}>
        {label}
      </a>
    );
  }
  return (
    <button type="button" className={cls} disabled={disabled}>
      {label}
    </button>
  );
}

export function EvidenceLink({ label, href }: EvidenceLinkProps): ReactElement {
  return (
    <a className={CLASSES.evidence.root} href={href}>
      {label}
    </a>
  );
}

export function Card({ label, title, body, href }: CardProps): ReactElement {
  const inner = (
    <>
      {label ? <div className={CLASSES.card.label}>{label}</div> : null}
      <div className={CLASSES.card.title}>{title}</div>
      <div className={CLASSES.card.body}>{body}</div>
    </>
  );
  if (href) {
    return (
      <a className={CLASSES.card.root} href={href}>
        {inner}
      </a>
    );
  }
  return <div className={CLASSES.card.root}>{inner}</div>;
}

export function CodeBlock({ label, code }: CodeBlockProps): ReactElement {
  return (
    <div className={CLASSES.codeBlock.root}>
      {label ? <div className={CLASSES.codeBlock.head}>{label}</div> : null}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function StateMessage({ variant, message }: StateMessageProps): ReactElement {
  const cls = variant === "error" ? `${CLASSES.stateMessage.root} ${CLASSES.stateMessage.error}` : CLASSES.stateMessage.root;
  return <p className={cls}>{message}</p>;
}
