/**
 * H04 pass/fail 4: no file under `apps/web` may statically import the
 * local-dev runner. Exported here for the root eslint config (H01/I1) to
 * spread into its `files: ['apps/web/**']` block, e.g.:
 *
 *   import fxRuntimeNoLocalImport from './packages/runtime/eslint-rules.cjs';
 *   export default [
 *     { files: ['apps/web/**'], rules: fxRuntimeNoLocalImport.rules },
 *   ];
 *
 * `test/no-local-import-from-web.test.ts` in this package enforces the same
 * rule directly (a grep over `apps/web`, tolerant of it not existing yet),
 * so the check exists even before the root config wires this in.
 */
module.exports = {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: [
              "**/packages/runtime/src/local",
              "**/packages/runtime/src/local/*",
              "@fx/runtime/local",
            ],
            message:
              "apps/web must never import the local-dev runner — owner-subscription only, never bundled (Spec H04 pass/fail 4).",
          },
        ],
      },
    ],
  },
};
