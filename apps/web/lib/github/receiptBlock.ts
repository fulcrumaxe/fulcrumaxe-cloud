import type { OpenReceiptBlockHttp } from "@fx/worker";
import { openInstallationHttp } from "./installationHttp";

/**
 * D#7 DP6a-WIRING: the client the receipt block is written with. It is the installation client of the `receipt_block` purpose, pinned to the one pull request:
 * `pull_requests: write` and `checks: read` on one repository, a PATCH whose only key is `body`, and a head's check-run list. Nothing else is allowed (packages/github
 * `installationHttp.ts`), and the runner's fence is not involved: this is a platform-side call, like the merge gate's.
 */
export const openReceiptBlockHttp: OpenReceiptBlockHttp = (target) => openInstallationHttp("receipt_block", target);
