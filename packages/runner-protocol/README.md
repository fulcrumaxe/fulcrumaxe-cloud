# @fulcrumaxe/runner-protocol

The wire protocol between the fulcrumaxe cloud and a local runner, the program that runs an agent on a customer's own
machine. Everything the runner can say to the cloud, and everything the cloud can ask of it, is defined here, so you
can read this package to check what leaves your machine.

- `src/messages.ts`: the runner-to-cloud message schemas (`hello`, `claim`, `heartbeat`, `events`, `done`, `register`,
  `rotate`, `revoke`) and the metadata-only `LocalOnlyEvent`. Every schema is strict: an unknown key is rejected, and a
  test fails if a schema grows a field whose name looks like a credential.
- `src/job.ts` and `src/jobSignature.ts`: the job the cloud hands a runner, and its Ed25519 signature over canonical
  JSON. A job has no field that can carry a command, a URL, an image, an environment map or a settings object.
- `src/httpSignature.ts`: RFC 9421 request signatures (`ed25519`), with RFC 9530 `content-digest` and RFC 7638 key
  thumbprints.
- `src/redact.ts`: credential redaction, applied on the runner before anything is uploaded and again when the cloud
  ingests it.
- `src/agentRuntime.ts` and `src/envelope.ts`: the agent-runtime types and the `AGENT_OUTPUT` envelope reader.

## Boundaries

This package imports no other workspace package and nothing outside its own directory. It holds no credential-shaped
string and names no host apart from the documented defaults. `test/publicBoundary.test.ts` checks both, over the source
and over the built output.

## Node

The supported minimum is Node 22.22.2 (`engines.node`). The repository itself builds and tests on Node 24, and CI also
runs this package's tests under Node 22.

## Third-party components

Nothing from Anthropic ships in this package. The Claude Agent SDK and the Claude Code binary are installed from
Anthropic at install time by the runner and remain under Anthropic's terms.

## Licence

Source-visible and proprietary, the same licence as the rest of this repository: copyright Formal Hosting LLC, all
rights reserved, with no grant beyond what GitHub's Terms of Service give for viewing and forking on github.com. The
`LICENSE` file in this directory is identical to the one at the repository root. The package is published here so you
can read it, not so you can reuse it.
