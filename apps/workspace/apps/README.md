# First-party apps

Each directory here is one first-party fulcrumaxe-os SDK app (not a framework,
not React): `apps/<id>/` holds a `manifest.json` plus `.js`, `.ts`, `.tsx` and
`.css` files. Nothing else is allowed here except this README.

```json
{ "id": "developer", "entry": "main.tsx", "styles": ["developer.css"] }
```

- `id` equals the directory name and matches `^[a-z][a-z0-9-]{0,31}$`. An id
  that an imported app already owns (`shell/apps/<id>/`, e.g. `themes`) fails
  the build.
- `entry` and `styles` are paths inside the app's own directory: no `..`, no
  absolute path, no URL, no query string. Every path segment is a letter or
  digit followed by letters, digits, `.`, `_` or `-` (no quotes, spaces,
  `<`, `>` or leading dots); the value goes into `index.html` attributes.
  The same charset applies to every directory and file name anywhere under
  `apps/<id>/` and under a `_` library, not just the manifest paths: a file
  that only an `import` reaches is still written into `index.html` (as a
  modulepreload hint), so a name outside it fails the build.
- A directory starting with `_` (e.g. `_lib`) is a shared library: no manifest,
  and its files ship only when an app's import graph reaches them.
- Add the app's id to `profiles/*.json` `app_modules` to ship it; an unlisted
  app gets no tags and none of its files are copied.

Imports are spelled in dist space and always end in `.js`: `../../sdk/fulc-sdk.js`
is `shell/sdk/fulc-sdk.js`, and `./view.js` is `view.js`, `view.ts` or `view.tsx`.
TS/TSX is compiled per file by `typescript`'s `transpileModule` (`jsx: "react-jsx"`,
importing the shell's `runtime/jsx-runtime.js`); no bundler, no source ships.
A LITERAL specifier that is not relative (a URL, a package name, a root-absolute
path) fails the build. Only literals are inspected: a computed `import(expr)`
or a template-literal specifier still builds, and it is the runtime CSP
(`script-src 'self'`, Trusted Types) that blocks it, not this check. An import of a module the profile dropped
(`drop_core`) or of an app `app_modules` does not list also fails the build. Use no `innerHTML` or
other Trusted Types sink and no `eval`/`Function(...)`: `checks.mjs --ship`
scans the compiled output's raw text, so a sink word inside a comment OR a
string literal (for example `"do not call eval(x)"`, or a quoted `https://`
import in a string) trips it too; reword it. The scan is a lint, not a proof:
the runtime CSP is the real barrier. Code: `build/first-party.mjs`; fixture: `test/fixtures/first-party/`.

## Keeping secrets out of window previews

The shell clones a window's DOM for the dock hover preview and the Alt+Tab
strip. Two markers control what a clone keeps; both are handled in
`shell/core/window-manager.js` (`sanitizePreviewClone`) for both clone sites.

- `data-secret-node`: put it on every element that shows a one-time secret
  (a token, a recovery code). In a clone the element is replaced by an empty
  placeholder: no text and none of its attributes are copied. The live window
  is unchanged. The app must still remove the secret from the page when the
  user is done with it.
- `data-no-preview`: put it on a subtree, or on the window element itself, to
  keep its content out of previews altogether. A marked subtree becomes a
  neutral placeholder in the clone; a marked window shows only the placeholder.

Render user-supplied names (which can contain right-to-left or bidi control
characters) in a `<bdi>` element, or wrap them in U+2068 ... U+2069 inside a
plain string, so they cannot reorder the text around them.
