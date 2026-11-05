import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { createIssueLabelLookup, createLoginPermissionLookup, createRepoInstallationResolver, InstallationTokenCache, loadAppCredentials, type GithubWebhookDbDeps, type IssueLabelLookup, type LoginPermissionLookup } from "@fx/github";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/**
 * D#483: the real repository permission of whoever applied or removed the `fulcrumaxe:product` label (asked only for that label, used for that
 * one delivery), with the author check's read-only installation token. Any throw reaches the webhook, which then does not honour the label;
 * the whole lookup (the installation read, the token mint and the permission call) is under one deadline so a slow GitHub cannot hold a delivery open.
 */
export const SENDER_LOOKUP_DEADLINE_MS = 8_000;

const cache = new InstallationTokenCache();
let lookup: LoginPermissionLookup | undefined;
let labelLookup: IssueLabelLookup | undefined;

function deps(): Parameters<typeof createLoginPermissionLookup>[0] {
  return ({
    resolveInstallation: createRepoInstallationResolver(platformOpsPool()),
    appCredentials: loadAppCredentials(process.env),
    requester: buildAccessTokenRequester({
      resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn),
      forwardPinned: nodeHttpsPinnedRequester,
    }),
    cache,
  });
}

const build = (): LoginPermissionLookup => createLoginPermissionLookup(deps());

type SenderLookup = NonNullable<GithubWebhookDbDeps["senderPermission"]>;

/**
 * Runs `run` under one deadline: when it passes, the answer is a rejection (fail closed) whatever step is still pending. The signal given to `run`
 * stops the permission call; the token mint takes no signal, so the deadline is also enforced here, on the promise.
 */
export function underDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("senderPermission: deadline"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    run(signal).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export const senderPermission: SenderLookup = async (input) => {
  lookup ??= build();
  const look = lookup;
  return underDeadline((signal) => look({ ...input, signal }), SENDER_LOOKUP_DEADLINE_MS);
};

/** The live labels of the issue, under the same deadline: a slow or failing read throws and the webhook then does not honour the label. */
export const issueHasLabel: NonNullable<GithubWebhookDbDeps["issueHasLabel"]> = async (input) => {
  labelLookup ??= createIssueLabelLookup(deps());
  const look = labelLookup;
  return underDeadline((signal) => look({ ...input, signal }), SENDER_LOOKUP_DEADLINE_MS);
};
