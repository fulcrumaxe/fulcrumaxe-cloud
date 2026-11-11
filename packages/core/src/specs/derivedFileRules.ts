import { parseDerivedFileRules, type DerivedFileRule } from '@fulcrumaxe/runner-protocol';

/**
 * #751: this repository's table of derived files, for the cloud's two readers (the Spec writer, and the `done` check). The local runner reads the same table from the repository itself,
 * `.fulcrumaxe/derived-files.json` on the default branch; `test/specs/derivedFileRules.test.ts` holds the two byte for byte equal, so there is one table to edit in two places that cannot differ.
 * A table the parser refuses is an empty one: no file is added to a Spec and none is lifted, which is how things were before the table existed.
 */
const SOURCE: unknown = {
  version: 1,
  rules: [
    {
      id: 'api-routes',
      kind: 'generated',
      inputs: ['packages/api/src/routes/**'],
      outputs: ['packages/api/openapi.json', 'packages/api-client/src/generated.ts'],
      generators: [
        ['pnpm', '--filter', '@fx/api', 'gen-openapi'],
        ['pnpm', '--filter', '@fx/api-client', 'gen'],
      ],
    },
    { id: 'error-codes', kind: 'companion', inputs: ['packages/*/src/errors.ts', 'packages/core/src/*/errors.ts'], outputs: ['packages/telemetry/src/errorCodes.ts'] },
  ],
};

export const DERIVED_FILE_TABLE: unknown = SOURCE;
export const DERIVED_FILE_RULES: readonly DerivedFileRule[] = Object.freeze(parseDerivedFileRules(SOURCE) ?? []);
