/**
 * Shared component contracts: prop shapes and class-name constants.
 *
 * `src/html/**` and `src/react/**` both import from here rather than
 * spelling out class names themselves, so the two renderers cannot drift
 * apart (D#2 spec amendment pass/fail item 4). Neither renderer owns a
 * class name — this module does.
 *
 * Class names ported from packages/sitekit-template's own theme
 * (site-header/site-name/cta/evidence) for the Header, Footer and Button
 * components — that vocabulary predates H24 and is already the site-kit
 * product's public API, so H24 keeps it rather than renaming it. Card,
 * CodeBlock and StateMessage are new; their class names come straight from
 * formal-support/assets/css/style.css (.card, .code-block, .state-msg
 * families), since there is no prior template usage to stay compatible
 * with.
 */

export interface NavLink {
  label: string;
  href: string;
  current?: boolean;
}

export interface HeaderProps {
  siteName: string;
  homeHref?: string;
  links: readonly NavLink[];
}

export interface FooterProps {
  creditText: string;
  links?: readonly NavLink[];
}

export type ButtonVariant = "default" | "primary";

export interface ButtonProps {
  label: string;
  href?: string;
  variant?: ButtonVariant;
  disabled?: boolean;
}

export interface EvidenceLinkProps {
  label: string;
  href: string;
}

export interface CardProps {
  label?: string;
  title: string;
  body: string;
  href?: string;
}

export interface CodeBlockProps {
  label?: string;
  code: string;
}

export type StateVariant = "loading" | "empty" | "error";

export interface StateMessageProps {
  variant: StateVariant;
  message: string;
}

export const CLASSES = {
  header: { root: "site-header", name: "site-name" },
  footer: { root: "site-footer" },
  button: { root: "cta", primary: "cta-primary" },
  evidence: { root: "evidence" },
  card: { grid: "card-grid", root: "card", label: "card-label", title: "card-title", body: "card-body", link: "card-link" },
  codeBlock: { root: "code-block", head: "code-head" },
  stateMessage: { root: "state-msg", error: "error" },
} as const;
