// Invented, minimal parity fixture, not copied from any real site's nav.
// Deliberately no "const NAV" or label-shaped text in this comment block:
// os-site-v2/tools/check-i18n-chrome.py finds its NAV/FOOTER arrays by
// matching the first "const NAV = [" it sees, so an example of that same
// text in a comment above the real declaration gets matched instead.
const NAV = [
  { href: '/', text: 'Learn more' },
];

const FOOTER = [
  { href: '/signin', text: 'Sign in' },
];
