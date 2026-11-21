import { PROVISIONING_TOKEN_PREFIX } from "./provisioningTokens.js";

/**
 * D#845 MC-5: the cloud-init `user_data` of a rented Hetzner Cloud server. It is a pure function of three inputs (the cloud's origin, the credential mode and one
 * issued provisioning token) and writes nothing anywhere. The one secret in it is the token, in a root-only 0600 file that the bootstrap script deletes as it
 * finishes. The runner itself is not fetched or verified here: the install stage is ONE fixed command that runs the cloud's own install script, which pins the
 * TUF root and checks the target hash (ON-4). A second hash or verifier in `user_data` would be a second thing to keep in step with it.
 *
 * The output is `#cloud-config` followed by JSON, which is YAML (every string is quoted and escaped, so no value can break the structure) and keeps the
 * structural test free of a YAML library.
 */

/** Hetzner takes at most 32 KiB of user_data. */
export const USER_DATA_MAX_BYTES = 32 * 1024;
/** S-2: a server's token lives half an hour and carries no repositories. Both are enforced where the token is made (`mintServerProvisioningToken`) and again here. */
export const SERVER_TOKEN_TTL_SECONDS = 30 * 60;
export const SERVER_TOKEN_REPO_COUNT = 0;
/** The directory the stage markers are written to, one empty file per finished stage, and `failed` naming the stage that stopped the run. */
export const STAGE_DIR = "/var/lib/fx/stage";
export const TOKEN_FILE = "/root/.fx-provisioning-token";
export const BOOTSTRAP_SCRIPT = "/usr/local/sbin/fx-bootstrap";
export const METADATA_ADDRESS = "169.254.169.254";
/**
 * The primary-key fingerprint of NodeSource's apt signing key: the key at deb.nodesource.com/gpgkey/nodesource-repo.gpg.key, which NodeSource's own setup_22.x
 * script installs. Read from that key with `gpg --show-keys --with-colons` on 2026-11-21 (pub 2F59B5F99B1BE0B4, created 2016-05-23). NodeSource's repository does
 * not state the fingerprint anywhere I could find, so this pins what the host serves today (it stops a later swap of the key there); it is not a second source.
 */
export const NODESOURCE_KEY_FINGERPRINT = "6F71F525282841EEDAF851B42F59B5F99B1BE0B4";
/** Packages the stage installs from the distribution (node 22 comes from its own apt repository, below). */
export const SERVER_PACKAGES = ["git", "python3", "bubblewrap", "build-essential"] as const;
/** The stages in order; each is a marker file `<STAGE_DIR>/<name>`, and `done` is written last. */
export const STAGE_NAMES = ["01-metadata-drop", "02-user", "03-upgrades", "04-packages", "05-claude", "06-runner", "07-register", "08-service", "09-ssh", "10-verify", "done"] as const;

/** What the render's caller hands over: the secret and the two facts about how it was issued, which the render checks. */
export interface IssuedServerToken {
  secret: string;
  ttlSeconds: number;
  repoCount: number;
}

export interface UserDataInput {
  /** The cloud's origin, `https://host[:port]` and nothing else. */
  origin: string;
  credentialMode: "subscription" | "api_key";
  token: IssuedServerToken;
}

const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?$/;
const TOKEN = new RegExp(`^${PROVISIONING_TOKEN_PREFIX}[A-Za-z0-9]{40}$`);

const sh = (lines: string[]): string => lines.join("\n") + "\n";

/** The metadata drop: a unit that runs before the network is up on EVERY boot, so a reboot does not lose it. Root keeps the address (cloud-init needs it). */
function metadataDropUnit(): string {
  const rule = `OUTPUT -d ${METADATA_ADDRESS} -m owner ! --uid-owner 0 -j DROP`;
  return sh([
    "[Unit]",
    "Description=Keep every user but root away from the cloud metadata address",
    "DefaultDependencies=no",
    "After=local-fs.target",
    "Before=network-pre.target",
    "Wants=network-pre.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=/bin/sh -c 'iptables -C ${rule} 2>/dev/null || iptables -I ${rule}'`,
    "",
    "[Install]",
    "WantedBy=multi-user.target",
  ]);
}

function bootstrapScript(origin: string, credentialMode: string): string {
  const fx = "/home/fx/.local/bin/fx-runner";
  return sh([
    "#!/bin/bash",
    "# Written by cloud-init. Each stage leaves a marker in the stage directory and is skipped when it is already there. The token file is removed on every exit.",
    "set -u -o pipefail",
    "umask 022",
    "exec >>/var/log/fx-bootstrap.log 2>&1",
    `STAGE=${STAGE_DIR}`,
    `TOKEN_FILE=${TOKEN_FILE}`,
    `ORIGIN=${origin}`,
    `NODESOURCE_FPR=${NODESOURCE_KEY_FINGERPRINT}`,
    'mkdir -p "$STAGE"',
    "trap 'rm -f \"$TOKEN_FILE\"' EXIT",
    'stage() { local name=$1; shift; [ -e "$STAGE/$name" ] && return 0; if "$@"; then : >"$STAGE/$name"; else echo "$name" >"$STAGE/failed"; echo "stage failed: $name"; exit 1; fi; }',
    "export DEBIAN_FRONTEND=noninteractive",
    "",
    `s_metadata_drop() { apt-get update -y && apt-get install -y iptables curl ca-certificates gnupg && systemctl daemon-reload && systemctl enable --now fx-metadata-drop.service; }`,
    "s_user() { id fx >/dev/null 2>&1 || useradd --create-home --shell /bin/bash fx; }",
    "s_upgrades() { apt-get install -y unattended-upgrades; }",
    // The NodeSource key is fetched to a file and checked BEFORE it is trusted: exactly one primary key, and its fingerprint is the pinned one. Only then does it become apt's keyring.
    's_packages() { k=$(mktemp) && curl --proto =https --tlsv1.2 -fsSL -o "$k" https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key && [ "$(gpg --show-keys --with-colons "$k" | grep -c \'^pub:\')" = 1 ] && [ "$(gpg --show-keys --with-colons "$k" | awk -F: \'$1=="fpr"{print $(NF-1); exit}\')" = "$NODESOURCE_FPR" ] && install -d -m u=rwx,go=rx /etc/apt/keyrings && gpg --batch --yes --dearmor -o /etc/apt/keyrings/nodesource.gpg "$k" && rm -f "$k" && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" >/etc/apt/sources.list.d/nodesource.list && apt-get update -y && apt-get install -y ' +
      [...SERVER_PACKAGES, "nodejs"].join(" ") +
      "; }",
    "s_claude() { runuser -l fx -c 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash'; }",
    // Download to a file, then run it: a refusing install script answers 200 and exits 1, and a pipe would hide that exit. Any non-zero exit fails the stage.
    `s_runner() { runuser -l fx -c 'f=$(mktemp) && curl --proto =https --tlsv1.2 -fsSL ${origin}/install.sh -o "$f" && sh "$f" --yes --non-interactive; rc=$?; rm -f "$f"; exit $rc'; }`,
    `s_register() { runuser -l fx -c '${fx} register --code-stdin --credential-mode ${credentialMode} --cloud-url ${origin}' <"$TOKEN_FILE" && rm -f "$TOKEN_FILE"; }`,
    `s_service() { loginctl enable-linger fx && systemctl start "user@$(id -u fx).service" && runuser -l fx -c "XDG_RUNTIME_DIR=/run/user/$(id -u fx) ${fx} service install"; }`,
    "s_ssh() { passwd -l root && systemctl try-reload-or-restart ssh.service && install -d -m u=rwx,go=rx /run/sshd && sshd -T | grep -qi '^passwordauthentication no'; }",
    `s_verify() { ! runuser -u fx -- curl -s -m 3 -o /dev/null http://${METADATA_ADDRESS}/ && passwd -S root | grep -q ' L '; }`,
    "",
    "stage 01-metadata-drop s_metadata_drop",
    "stage 02-user s_user",
    "stage 03-upgrades s_upgrades",
    "stage 04-packages s_packages",
    "stage 05-claude s_claude",
    "stage 06-runner s_runner",
    "stage 07-register s_register",
    "stage 08-service s_service",
    "stage 09-ssh s_ssh",
    "stage 10-verify s_verify",
    "stage done true",
  ]);
}

/** Builds the `#cloud-config`. Throws on anything the caller must not pass: a token issued for longer than half an hour or with repositories, a malformed token or origin, an output over the limit. */
export function renderUserData(input: UserDataInput): string {
  if (!ORIGIN.test(input.origin)) throw new Error("renderUserData: the origin must be https://host[:port]");
  if (!TOKEN.test(input.token.secret)) throw new Error("renderUserData: the token is not a provisioning token");
  if (input.token.ttlSeconds !== SERVER_TOKEN_TTL_SECONDS || input.token.repoCount !== SERVER_TOKEN_REPO_COUNT) throw new Error("renderUserData: a server's token lives 30 minutes and carries no repositories");
  if (input.credentialMode !== "subscription" && input.credentialMode !== "api_key") throw new Error("renderUserData: unknown credential mode");

  const config = {
    ssh_pwauth: false,
    write_files: [
      { path: TOKEN_FILE, owner: "root:root", permissions: "0600", content: input.token.secret },
      { path: "/etc/systemd/system/fx-metadata-drop.service", owner: "root:root", permissions: "0644", content: metadataDropUnit() },
      { path: "/etc/apt/apt.conf.d/20auto-upgrades", owner: "root:root", permissions: "0644", content: sh(['APT::Periodic::Update-Package-Lists "1";', 'APT::Periodic::Unattended-Upgrade "1";']) },
      { path: "/etc/ssh/sshd_config.d/00-fx.conf", owner: "root:root", permissions: "0644", content: sh(["PasswordAuthentication no", "KbdInteractiveAuthentication no", "PermitRootLogin prohibit-password"]) },
      { path: BOOTSTRAP_SCRIPT, owner: "root:root", permissions: "0700", content: bootstrapScript(input.origin, input.credentialMode) },
    ],
    runcmd: [[BOOTSTRAP_SCRIPT]],
  };
  const text = `#cloud-config\n${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > USER_DATA_MAX_BYTES) throw new Error("renderUserData: the output is over 32 KiB");
  return text;
}
