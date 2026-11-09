/**
 * The post-merge deploy verifier's names, shared by the cloud and a local runner (the verify stage after a merge: the cloud says "deploy this sha",
 * a runner on a machine with a signed-in Chrome deploys it with a command only that machine holds, and a browser job checks the result).
 *
 *  - `DEPLOY_VERIFIER_ROLE` is a platform role, like the claim verifier: it is not in the role manifest and the cloud's own sandbox never runs it.
 *  - `BROWSER_CHROME_CAPABILITY` gates that role: the cloud offers the job only to a runner whose latest hello listed it.
 *  - `DEPLOY_ORDER_CAPABILITY` gates no role: it tells the cloud the runner can read the `deploy_order` hint on its claim replies and claim and report a
 *    deploy order (deployOrder.ts). A cloud that predates it refuses the capability on the hello (400), the runner drops it and offers nothing.
 *
 * Neither capability widens a permission: each only narrows what the claim offers. The protocol version does not move.
 */

/** The role the platform runs to check a deployed change in a real browser. Not in the role manifest. */
export const DEPLOY_VERIFIER_ROLE = "deploy-verifier";

/** The capability that gates the deploy verifier's job: the machine has Chrome connected and signed in as the configured test account (checked by the daemon, never by the model). */
export const BROWSER_CHROME_CAPABILITY = "browser_chrome_v1";

/** The capability to claim and report a deploy order. Gates no role. */
export const DEPLOY_ORDER_CAPABILITY = "deploy_order_v1";

/**
 * The roles whose job needs the machine's browser. A runner holds at most `BROWSER_JOB_SLOTS_PER_RUNNER` of them at a time, whatever its light and heavy
 * capacity says: the cloud's claim offers one only to a runner that holds none, and the runner's own admission may refuse a second as well.
 * In the light and heavy accounting such a job counts as heavy (`JOB_CLASS_BY_ROLE`): the scarcer slot, so a machine that is short of room is never over-committed.
 */
export const BROWSER_JOB_ROLES: readonly string[] = Object.freeze([DEPLOY_VERIFIER_ROLE]);
export const BROWSER_JOB_SLOTS_PER_RUNNER = 1;
export const isBrowserJobRole = (role: string): boolean => BROWSER_JOB_ROLES.includes(role);

/**
 * The Claude in Chrome tools the deploy verifier may use. The names are the extension's own (`<prefix><tool>`); the CLI reaches the extension through its `--chrome`
 * flag, not through an MCP file (the runner's MCP file stays empty for every role). Which tools are in and which are out:
 *  - in: tab management (own tab group), navigation, `computer` (click, type, scroll, screenshot), `find`, the page tree and page text, the console reader;
 *  - out: `javascript_tool` (it would run the model's code inside the signed-in session and defeat every card rule), `read_network_requests` (it shows the signed-in session's request headers), `file_upload` and `upload_image` (they send local files to a page), and `form_input` (journeys act through the page's own controls with `computer`; no journey needs a second way to type).
 * Page text is an outsider's text. These tools bring it into the prompt, which is why the role is a confined read role (verifierGuard.ts).
 */
export const CHROME_TOOL_PREFIX = "mcp__claude-in-chrome__";
const CHROME_TOOL_NAMES = ["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "navigate", "computer", "find", "read_page", "get_page_text", "read_console_messages"] as const;
const CHROME_TOOLS_NEVER = ["javascript_tool", "form_input", "file_upload", "upload_image", "read_network_requests"] as const;
export const DEPLOY_VERIFIER_BROWSER_TOOLS: readonly string[] = Object.freeze(CHROME_TOOL_NAMES.map((name) => `${CHROME_TOOL_PREFIX}${name}`));
/** The two extension tools the role never holds. They are denied in its settings as well as left out of the list, so a wrong allow rule could not grant them. */
export const DEPLOY_VERIFIER_DENIED_BROWSER_TOOLS: readonly string[] = Object.freeze(CHROME_TOOLS_NEVER.map((name) => `${CHROME_TOOL_PREFIX}${name}`));

/** Whether a tool entry names an MCP tool (not one of the CLI's built-in tools). A runner passes the built-in names to `--tools` and grants an MCP tool by its allow rule only. */
export const isMcpToolName = (entry: string): boolean => entry.startsWith("mcp__");

/**
 * The deploy verifier's tools as a runner holds them and as the cloud signs them (`role_tools_sha256`): the bare names. The three read tools, so the job can read the
 * checkout at the merge commit, then the browser tools above. No Bash, no Edit, no Write, no web tool. The runner pins the same table, so a change here is a change there
 * and moves the digest.
 */
export const DEPLOY_VERIFIER_RUNNER_TOOLS: readonly string[] = Object.freeze(["Read", "Glob", "Grep", ...DEPLOY_VERIFIER_BROWSER_TOOLS]);
