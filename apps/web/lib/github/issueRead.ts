import { resolveChecked } from "@fx/net-guard";
import { platformOpsPool } from "@fx/api/src/sse/pools.js";
import { createIssueReader, createRepoInstallationResolver, InstallationTokenCache, loadAppCredentials, type IssueReader } from "@fx/github";
import { buildAccessTokenRequester, nodeHttpsPinnedRequester } from "../../app/api/gh-proxy/[...path]/handler";

/**
 * D#483 P1: the production issue reader the stage driver's triage uses (title, body, author and labels, with who
 * applied each label and their real repository permission). Read-only installation token, same shape as the retry
 * author check in ./authorCheck.ts: built once per process, never throws on build (a missing platform_ops URL
 * answers null for that call, and the caller treats null as "cannot read the issue", never as trusted). Missing GitHub
 * App credentials fail later, at token mint, which the reader throws and the driver reads as "fetch failed".
 */
const cache = new InstallationTokenCache();
let reader: IssueReader | undefined;

export function getIssueReader(): IssueReader | null {
  try {
    reader ??= createIssueReader({
      resolveInstallation: createRepoInstallationResolver(platformOpsPool()),
      appCredentials: loadAppCredentials(process.env),
      requester: buildAccessTokenRequester({
        resolveUpstream: (host, lookupFn) => resolveChecked(host, lookupFn),
        forwardPinned: nodeHttpsPinnedRequester,
      }),
      cache,
    });
    return reader;
  } catch {
    // fx-swallow-ok: a fixed line is logged and the caller treats null as "cannot read the issue", never as trusted; the build error can name the platform_ops URL
    console.warn(JSON.stringify({ event: "github.issue_reader_unavailable" }));
    return null;
  }
}

/** Test seam: swap the reader; call with no argument to restore the production one. */
export function setIssueReaderForTests(next?: IssueReader): void {
  reader = next;
}
