import { builtinModules } from "node:module";
import ts from "typescript";

/**
 * The one definition of "reads the process environment as a whole, or could". Every guard test and every fixture for it
 * calls `envAccessViolations`, so the rules cannot be retyped somewhere else and drift.
 *
 * The text is parsed with the TypeScript compiler, so regex literals, strings, templates and comments are tokenised by
 * the real lexer, and identifier and string values are read from `.text`, which is already unescaped. In `src`:
 *  - every `process` identifier is a violation, unless the file is `src/job/cleanEnv.ts` and the identifier is the
 *    object of a non-optional `.env` access that is itself read as `.NAME` or `[identifier]`, also non-optional;
 *  - the identifiers `globalThis` and `global` are violations;
 *  - any string or template text naming the `process` module, or containing the path `/proc/`, is a violation;
 *  - any `constructor` identifier or string is a violation (the Function constructor is reachable through it), as are
 *    the `Function` identifier and any `eval` that is not a direct call;
 *  - node built-in modules are an allowlist, per file (`ALLOWED_BUILTINS`): a built-in named by an import, a
 *    re-export, `import()` or an import type, with or without the `node:` prefix, must be listed for that file. `require`
 *    and an `import()` with a non-literal argument are violations;
 *  - `spawn` may be called only in the files that may import `node:child_process`, and there every call must pass an
 *    object with an `env` property and without `shell: true`; the `exec`, `execSync`, `execFile`, `execFileSync`,
 *    `fork` and `spawnSync` names are refused;
 *  - the same bans run once more on the raw text for `globalThis`/`global`, the process module and `/proc/`.
 */
export const ENV_READER_FILE = "src/job/cleanEnv.ts";

/**
 * The one other file that may name `process`: it signals the agent's process group, which only `process.kill` can do.
 * There `process` is allowed as the object of a non-optional `.kill` or `.platform` access and nowhere else, so it
 * still cannot read the environment.
 */
export const PROCESS_GROUP_FILE = "src/engines/claude/processGroup.ts";

function isGroupSignalUse(node: ts.Identifier): boolean {
  const access = node.parent;
  return ts.isPropertyAccessExpression(access) && access.expression === node && !access.questionDotToken && (access.name.text === "kill" || access.name.text === "platform");
}

const ENGINE_FILES = ["src/engines/claude/capture.ts", "src/engines/claude/engine.ts"];

/**
 * Built-in modules each file may name, keyed by path relative to the package, without the `node:` prefix. Everything
 * not listed is refused, including `vm`, `module`, `worker_threads` and `process`. Add a line only with a reviewed
 * reason; each entry below is read off the engine slice's imports.
 */
export const ALLOWED_BUILTINS: Readonly<Record<string, readonly string[]>> = {
  "src/cloud.ts": ["crypto"],
  // D#845 ON-8c: the engine archive: an https GET per redirect hop (no agent, no redirect followed), a sha256 of the body as it streams, and gunzip with an output cap. It reads no file and no environment.
  "src/setup/engineArchive.ts": ["crypto", "https", "zlib"],
  "src/setup/planCheck.ts": ["crypto"], // the sha256 of the plan route's reply bytes, compared with the job's plan_ref before the reply is parsed
  // D#845 ON-8d: the project setup. The local log (a 0600 no-follow open judged by fstat, at most 1 MiB, never sent), the guest's engine archive (a gzip of the verified tar and its sha256, sent as a file), the host copy's random name; no process is started and no environment is read.
  "src/setup/projectSetup.ts": ["fs", "path"],
  "src/setup/guestScripts.ts": ["crypto", "zlib"],
  "src/setup/setupRepos.ts": ["crypto", "fs", "path"],
  // D#845 ON-8e: the standard tier's guest: a fresh 0700 job root (lstat, no-follow opens judged by the handle, removal), a name hash, a utf8 decoder for the command's output; every program starts through the injected process-group capture
  "src/setup/hostGuest.ts": ["crypto", "fs", "path", "string_decoder"],
  // D#845 ON-8e: the forwarder inside the sandbox: one loopback listener relaying to one Unix socket, and the wait probe of that port; no file, no process, no environment
  "src/setup/egressServe.ts": ["net", "path"],
  "src/config.ts": ["crypto", "fs", "path"],
  "src/keys.ts": ["crypto"],
  // The engine bridge (EB-3): the runner's user id is given by the caller, never read from `process` here.
  "src/engineBridge/cursor.ts": ["crypto", "fs", "path"], // the cursor: a no-follow open judged by the open handle, a random temp-file name, an exclusive 0600 create, one rename
  "src/engineBridge/detailSpool.ts": ["crypto", "fs", "path"], // the detail spool (D#845 watch mode): a random instance id, no-follow opens judged by the open handle (cursor.ts's), an append-only 0600 create, an unlink on disconnect
  "src/engineBridge/tail.ts": ["fs"], // positioned reads of the events file through the no-follow handle cursor.ts opened
  "src/engineBridge/loop.ts": ["crypto"], // a random id for the bridge's own session
  "src/engineBridge/ceiling.ts": ["crypto", "fs", "path"], // the dial ceiling file: a random temp-file name, a no-follow exclusive 0600 create judged by lstat of the directory and name, one rename
  "src/engineBridge/inbox.ts": ["crypto", "fs", "path"], // the engine inbox: lstat on the directories, no-follow opens judged by the handle, a random temp-file name, an exclusive 0600 create, one rename
  "src/engineBridge/decideSocket.ts": ["fs", "http", "path"], // the decide socket: lstat on its 0700 directory, an http server on that Unix socket only, chmod 0600
  "src/engineBridge/discover.ts": ["fs", "path"], // ON-BR-1: finds the engine checkout: realpath and lstat of directories, a directory listing that reports a link as a link, a no-follow open of two files through cursor.ts, and path joins; the home, the current directory, the clock and the lister arrive from the caller
  "src/engineBridge/engineVersion.ts": ["fs", "path"], // EB-3c: the engine's manifest version: lstat on its directory, a no-follow open judged by the handle, one positioned read
  "src/engineBridge/settings.ts": ["fs", "path"], // EB-3c: the bridged repos' file, through config.ts's private-file helpers; realpath and stat of the state directories, to tell one directory from another by identity
  "src/engineBridge/daemon.ts": ["path"], // EB-3c: the cursor's and the events file's names below the state directories
  "src/commands/engineBridge.ts": ["path"], // EB-3c: the default engine state directory's name below the home directory
  "src/credentials.ts": ["crypto", "fs", "path"], // D#6 R5b-3: the API key file: lstat checks, a no-follow open judged by the open handle, a random temp-file name, an exclusive 0600 create and one rename
  // D#587 B-6-VMTOKEN: the microVM Claude token file. secretFile.ts is the file rules (lstat checks, a no-follow open judged by the open handle, a random temp-file name, an exclusive 0600 create, one rename); vmToken.ts takes the environment as an argument and starts no process.
  "src/credentials/secretFile.ts": ["crypto", "fs", "path"],
  "src/credentials/vmToken.ts": ["fs", "path"], // only an lstat of the file for its age, and path joins
  // D#597 CC-7a-1, the assistant link and its local tool proxy.
  "src/assistant/tokenFile.ts": ["crypto", "fs", "path"], // the token file: lstat checks, a no-follow open judged by the open handle, a random temp-file name, an exclusive 0600 create and one rename
  "src/engineSession/operateMark.ts": ["fs", "path"], // D#845 ON-13a1: an lstat of the mark file (a link or a non-file is refused), then the bridge's no-follow read and atomic write; path joins
  "src/engineSession/standardTier.ts": ["fs", "path"], // D#845 ON-13a3: an lstat of the session's kept root (a link or a file is not a root); path joins below the sessions' directory
  "src/engineSession/repoLookup.ts": ["fs"], // D#845 ON-13a1: an lstat of the repository's own mirror directory (a link is refused) before git reads its recorded origin
  "src/engineBridge/stateFiles.ts": ["crypto", "fs", "path"], // EB-11b: the engine bridge's local files (halt file, host handle): lstat checks, a no-follow open judged by the open handle, a random temp-file name, an exclusive 0600 create and one rename
  "src/daemon/claudeLogin.ts": ["fs", "path"], // D#845 MC-8b: the sign-in log under the state directory: a 0700 directory (lstat checked) and one 0600 file per request made with an exclusive, no-follow open; the process start arrives through the host argument
  "src/daemon/ghLogin.ts": ["path"], // D#845 ON-19c: the GitHub sign-in's working directory and the directory of the located `gh` on the child's search path; no file is opened here and the process start arrives through the host argument
  "src/daemon/machineCommands.ts": ["crypto", "fs"], // D#845 MC-8b: the signed-command id history file (private state, not a secret), built like sandboxCommands.ts's nonce file: lstat check, a no-follow non-blocking open judged by the open handle, a random temp-file name for the exclusive 0600 create, fsync and one rename
  "src/daemon/managedServer.ts": ["fs"], // D#845 MC-8b: lstat of the install's own marker file and its two directories (a link is never followed, nothing is opened or written)
  "src/daemon/sandboxCommands.ts": ["crypto", "fs"], // D#587 B-7b-i: the signed-command nonce history file (private state, not a secret): lstat check, a no-follow non-blocking open judged by the open handle (plain file, bounded size, one read), a random temp-file name for the exclusive 0600 create, fsync and one rename; crypto only names that temp file
  "src/engineHost/hostConfig.ts": ["fs", "path"], // EB-12c: the host's settings read: lstat, a no-follow open judged by the open handle, one bounded read
  "src/engineHost/hostFeeds.ts": ["crypto", "fs", "path"], // EB-12c: the feeds the host reads: lstat, no-follow opens judged by the handle, bounded reads, a random id
  "src/engineHost/hostInbox.ts": ["crypto", "fs", "path"], // EB-12c: the host's inbox writes: lstat, no-follow opens, a random temp-file name, an exclusive create, one rename
  "src/engineHost/guestSession.ts": ["fs", "net", "path"], // ON-13b1: the engine session's channel (a private unix socket, no-follow reads of its own spool); it starts no program, the runtime hands in `launch`
  "src/engineHost/channelClient.ts": ["stream"], // ON-13b2: the runner's client of the session's channel: it is handed a connected duplex (a type), starts no program and reads no file
  "src/engineHost/hostFiles.ts": ["fs", "path", "crypto"], // EB-12a: the host stream log (O_NOFOLLOW append at 0600, rotated at 20 MB) and the read of the bridge state file; no process is started
  "src/assistant/cloudCall.ts": [], // the one cloud call: the injected fetch, a fixed User-Agent, no redirect
  "src/assistant/fence.ts": [], // pure text work: the untrusted-content fence over a reply
  "src/assistant/readTools.ts": [], // pure: the read tools' argument checks and route paths
  "src/assistant/link.ts": [], // the device-flow loop over the injected fetch, clock and sleep
  "src/assistant/proxy.ts": ["crypto", "fs", "http", "path"], // the proxy: a per-session secret (crypto), one 0700 mkdtemp directory holding a Unix socket (fs, path), an http server on that socket only
  "src/assistant/unlink.ts": [], // the undo: one DELETE over the injected fetch, then the token file removal
  "src/commands/assistant.ts": [], // `fx-runner assistant link`
  "src/protectionBypass.ts": ["fs", "path"], // the Vercel protection bypass secret file: one no-follow open judged by the open handle, a bounded read, and a real-path check that it lies under the home directory
  "src/codeSource.ts": ["fs"], // D#605 FL-7: the registration code file: one no-follow open judged by the open handle (regular file, mode 0600, owner), a bounded read
  "src/memoryOffer.ts": ["crypto"], // D#601 MEM-6: the SHA-256 of a memory proposal body, shown to the person and compared again before anything is sent
  "src/keyring.ts": ["crypto"], // SHA-256 of a cloud address: the pinned-key table is keyed by hash, so no private host name is committed
  "src/hostFacts.ts": ["os"], // D#605 FL-2: the facts a hello reports (platform, architecture, total memory rounded to a bucket, core count) and the host name as the default runner name; read-only calls, no file and no process
  "src/daemon/resources.ts": ["fs", "os", "path"], // D#6 C43-4: what the machine has free: os.freemem (MemAvailable), load average and core count, and statfs of the workspace and cache volumes; no process is started and no process-table file is read
  "src/daemon/footprints.ts": ["fs", "path"], // D#6 C43-4: the learned per-repo, per-role memory estimates: lstat and a bounded read of one small file in the state directory, written through the private-file writer
  "src/sandbox/jobLimits.ts": ["path"], // D#6 C43-5: path joins and an absolute-path check; every program (systemd-run, systemctl, env) runs through the injected capture or the engine's own start
  "src/daemon/nestedGitfiles.ts": ["fs"], // D#6 RUNNER-HOSTREAD-FOLLOWUPS-527: readdir of the worktree looking for nested .git names; nothing is opened or written
  "src/daemon/workspacePin.ts": ["crypto", "fs", "path"], // D#6 RUNNER-HOSTREAD-GITDIR-SHAPE: lstat of the workspace git folder and its config, a SHA-256 of the config bytes, a realpath key; nothing is written
  "src/daemon/signInState.ts": ["fs", "path"], // D#749 VERIFY-SIGNIN-EXPIRY: one lstat of the saved verify sign-in file (a link is never followed) and path joins to its sidecar; the sidecar is read through the private-file reader, and nothing is written
  "src/daemon/deployOrder.ts": ["fs", "path"], // D#749 V2b: lstat of each part of the deploy script's path below the owner's checkout (a link is refused, nothing is opened or written); the command runs through the injected process-group capture
  "src/daemon/resumeClean.ts": ["fs", "path"], // D#6 RUNNER-RESUME-CLEAN: realpath of the workspace root before the purge
  "src/daemon/resumePurge.ts": ["fs", "path"], // D#6 RUNNER-RESUME-CLEAN: lstat, unlink and rmdir of ignored build output in a resumed workspace without following a link; realpath of each entry's parent
  "src/daemon/resumePurgeSandbox.ts": ["fs", "path"], // D#6 RESUME-CLEAN-MAC: a 0600 list file in a fresh directory under the state directory for the sandboxed purge child, removed afterwards; the child runs through the injected capture
  "src/commands/purgeChild.ts": ["fs", "path"], // D#6 RESUME-CLEAN-MAC: the purge child reads the list file (lstat, bounded read) and checks the root is its own real path
  "src/runnerSettings.ts": ["fs", "path"], // D#6 C43-4: the concurrency settings file and the claiming-pause marker in the state directory: lstat, a bounded read, the private-file writer and one removal
  "src/instructionCanaryState.ts": ["fs", "path"], // D#601 MEM-7: lstat and a read of one small result file in the state directory, written through the private-file writer
  "src/daemon/ledger.ts": ["crypto", "fs", "path"], // the job-id ledger file: random temp-file names, one 0600 file, its directory
  "src/daemon/pushLog.ts": ["crypto", "fs", "path"], // the local push log (D#519 MQ4-RUNNER-PUSH-LOG): a 0600 file built like the ledger's, never sent anywhere
  "src/job/depsRegistry.ts": ["fs", "path"], // D#6 C44-4: one lstat of the workspace's lockfile names, never followed, to tell whether the repo has a lockfile
  "src/daemon/planePush.ts": ["fs", "path"], // D#598 P1f-3: the run-end hook's throwaway repository directory: lstat of the work root and of each work directory (a link is never followed or deleted through), a 0700 root, one mkdtemp per run, removal of exactly that directory, the start-up sweep of leftovers; every program (the version-control tool) runs through the protocol package's pinned runner
  "src/daemon/lockfileSync.ts": ["fs", "path"], // D#6 BUILD-LOCKFILE-ON-DEP-ADD: the offline lockfile update after the agent: no-follow looks at manifests and the lockfile, the put-back of the original lockfile (O_EXCL|O_NOFOLLOW temp file, rename) and the 0700 scratch directory; pnpm runs through the injected install capture
  "src/daemon/depsInstall.ts": ["fs", "path"], // D#6 C44-4: the host-side install: lstat and a no-follow read of the lockfile and two settings files, removal of node_modules trees (no link followed), the 0700 scratch directories; the package manager runs through the injected install capture
  "src/daemon/checkStep.ts": ["crypto", "fs", "path"], // D#6 R-CHK-2: puts the files the check vector names back to the start commit for the run (lstat, no-follow unlink, exclusive create) and gives the branch's version back; the check itself runs through the injected capture
  "src/sandbox/checkProtected.ts": ["fs", "path"], // D#6 R-CHK-2: lists the workspace root for `.env*` names (a read of one directory) to know which protected files exist
  "src/sandbox/checkHome.ts": ["fs", "path"], // D#6 chknested: makes the check's own home (a fresh mkdtemp directory with two exclusively created files) inside the job's temp directory; nothing is read
  "src/sandbox/checkSeccomp.ts": ["os"], // D#6 R-CHK-2: os.arch() picks the system call numbers of the seccomp filter the check runs under; nothing else
  "src/job/lockfileCheck.ts": ["path"], // D#6 C44-4: normalising a repo-relative link target
  "src/daemon/conflictAttest.ts": ["fs", "path"], // D#519 MQ4-e2-c1: the same throwaway object store as the conflict facts, in a directory the caller supplies; every program runs through the shared reader
  "src/daemon/conflictFacts.ts": ["fs", "path"], // D#519 MQ4-e2-a: the throwaway object store of a conflict check gets an alternates file (mkdir, write) and its path is joined; every program runs through the shared reader
  "src/daemon/planeMerge.ts": ["fs", "path"], // D#6 PUBLIC-MERGE PR3: the merge order's throwaway repository directory under the state directory: lstat of the work root and of each work directory (a link is never followed or deleted), a 0700 create, and a sweep of leftovers; every program runs through the shared git reader
  "src/vm/workspace/tar.ts": ["path"], // D#587 B-5b: lexical path work on names read from an archive (normalise and join, never a file system call)
  "src/vm/workspace/tree.ts": ["crypto"], // D#587 B-5b: the SHA-1 git gives a blob or a commit, to hold an archive to the tree it claims
  "src/vm/workspace/packScan.ts": ["zlib"], // D#587 B-5b: inflates each object of a guest's pack, bounded by the size its own header declared, to read its declared sizes before git sees the pack (no file or process access, nothing written)
  "src/daemon/vmArchive.ts": ["crypto", "fs", "path", "zlib"], // D#587 B-5b: the archive of one commit for a microVM guest: git writes a tar into a 0700 scratch directory the caller owns, from a scratch git directory there that holds only an alternates file and an attributes file (a random name, an O_NOFOLLOW open judged by the handle, a size check, one read, removal), and it is gzipped; every program runs through the daemon's guarded git
  "src/daemon/vmJobDeps.ts": ["fs", "path"], // D#587 B-5b-3c-iii: the one 0700 scratch directory under the runner's state directory that archives and throwaway repositories are made in (mkdir, lstat, chmod); nothing else, no program
  "src/daemon/vmBundle.ts": ["crypto", "fs", "path"], // D#587 B-5b: the throwaway repository a guest's bundle is checked in: a 0700 directory made by the daemon with a random name, the bundle written to it exclusively without following a link, one append to the host workspace's own `.git/info/attributes` (no-follow), removal; every program runs through the daemon's guarded git
  "src/daemon/mirror.ts": ["fs", "path"], // the persistent mirrors: a 0700 directory of bare repositories, one per repo id
  "src/daemon/nixShell.ts": ["crypto", "fs", "path"], // D#6 R7c: the dev shell step's own 0700 data directory and its cache files, a SHA-256 of the lock file, and the search for the nix binary; nix itself runs through the injected capture
  "src/daemon/gitPathA.ts": ["fs", "os", "path"], // cloud-verified path: realpath and statfs of the mirrors directory (must not be a temp directory or memory-backed), and the temp directory's location
  "src/daemon/gitPath.ts": ["path"], // the snapshots directory under the runner's state directory
  "src/daemon/snapshot.ts": ["fs", "fs/promises", "path"], // the daemon-owned copy of the workspace's git files: no-follow reads, one 0700 directory per push
  "src/job/pinFiles.ts": ["fs", "fs/promises", "path"], // D#600 CX-5c2: a job's pinned files read from the checkout: lstat of every path component, an O_NOFOLLOW open, and realpath containment
  "src/daemon/staleTemp.ts": ["fs", "path"], // `fx-runner run` at start: lstat and unlink of exact-name regular files next to the ledger, nothing else
  "src/commands/logs.ts": ["fs", "path"], // `fx-runner logs`: a size check, then the log file <state dir>/logs/<run id>.jsonl through the private-file reader
  "src/commands/service.ts": ["crypto", "fs", "path"], // `fx-runner service`: lstat, an atomic write (random temp name) and an unlink of the one per-user unit file
  "src/watch/layout.ts": ["fs", "path"], // the watch's own files under the state directory: the tmux socket directory, one record per running job, the take-over request
  "src/watch/tmux.ts": ["fs", "path"], // finds the tmux binary on the search path; tmux itself is run through the injected capture
  "src/engines/claude/takeover.ts": ["fs", "path"], // reads a taken-over run's transcript, session index and job files to resume its session
  "src/commands/attach.ts": [],
  "src/daemon/browserProbe.ts": ["fs", "path"], // D#749 V2b: lstat and a directory listing of the Chrome bridge directory (a name built from the user name); the process list arrives through an injected port
  "src/commands/watchPane.ts": ["path"], // the transcript's path under the state directory
  "src/commands/run.ts": ["path"], // the composition root: the runner's own directory layout; the process start and the pid check arrive through its host argument
  "src/engines/claude/kit.ts": ["path"], // the engine's file layout under the state directory
  "src/setup/twinSeed.ts": ["crypto", "fs", "path"], // D#845 ON-27b: the per-job scratch repository is named from random bytes under the runner's own workspace root, and removed after the job
  "src/setup/twinPublish.ts": ["fs", "path"], // D#845 ON-27c2: the per-job throwaway repository is made under the runner's own state directory (a real 0700 directory, never a link) and removed after the job
  "src/setup/twinSync.ts": ["crypto", "fs", "path"], // D#845 ON-27d2: the per-job scratch repository is made 0700 under the runner's own state directory (a real directory, never a link), holds the mirror's object path and is removed after the job
  "src/setup/setupPush.ts": ["path"], // D#845 ON-8f1: the snapshot of the setup workspace is made under the runner's own snapshots directory, resolved from absolute paths
  "src/daemon/push.ts": ["path"], // the workspace's git directory is `<workspace>/.git`, resolved from an absolute path
  "src/daemon/workspaceExclude.ts": ["fs", "path"], // D#6 C44-3: no-follow append to the workspace's own `.git/info/exclude`
  "src/daemon/workspaceGit.ts": ["fs", "path"], // lstat of the agent-written `.git`: nothing in it is followed
  "src/engines/claude/capture.ts": ["child_process"],
  "src/launchDir.ts": ["fs", "path"], // D#6 RUNNER-CWD-1: the 0700 launch root, one fresh mkdtemp directory per program start (lstat, realpath and an empty-listing check before the start), and its removal afterwards
  "src/daemon/cliStubs.ts": ["fs", "path"], // D#6 RUNNER-CWD-1: doctor's look for the CLI's empty placeholder files: lstat, a directory listing and a no-follow read of `.git/info/exclude`; nothing is written
  "src/daemon/workspaceStubs.ts": ["fs", "path"], // D#6 RUNNER-CWD-1: lstat of a job workspace's placeholder names before the run, then unlink/rmdir of the empty ones made since and a no-follow truncate of `.git/info/exclude` back to its bytes from before
  "src/engines/claude/engine.ts": ["child_process", "path"],
  "src/engines/claude/instructionCanary.ts": ["crypto", "fs", "os", "path"], // D#601 MEM-7: a random canary token, a 0700 scratch directory holding a canary CLAUDE.md and two empty settings files (removed after the check), and the temp directory location; the CLI is started only through runCaptureWithInput in capture.ts
  "src/engines/claude/filePermissions.ts": ["path"],
  "src/engines/claude/pin.ts": ["crypto", "fs", "path"], // crypto: a random name for the flags-cache temp file, made with an exclusive create
  "src/engines/claude/session.ts": ["crypto", "fs", "path"], // crypto: random temp-file names for the index write
  "src/engines/claude/processGroup.ts": [],
  "src/engines/claude/settingsFile.ts": ["fs", "path"],
  "src/engines/claude/bashSandboxProbe.ts": ["fs", "path"], // the throwaway workspace the start-up probe builds and removes
  "src/engines/claude/stream.ts": ["fs", "path"],
  // The host sandbox tier and the job runner: directories and paths on this machine, and the OS name for platform detection. No child processes.
  "src/job/workspace.ts": ["fs", "path"],
  "src/sandbox/hostSandbox.ts": ["fs", "path"],
  "src/sandbox/platform.ts": ["os"],
  "src/sandbox/select.ts": ["fs", "path"],
  "src/sandbox/probe.ts": ["path"], // the sandbox probe (`doctor`): paths for the probe's rules; the machine itself is reached only through its host argument
  "src/sandbox/wslGate.ts": ["path"], // D#587 B-9b: path joins for the probe's settings; every process start goes through the injected SandboxHost
  "src/sandbox/wslChecks.ts": ["path"], // D#587 B-9: path normalisation for the WSL2 doctor checks (mount points, deny entries, runner directories); the machine is reached only through the injected reader and WslMachine
  "src/sandbox/jobShellProbe.ts": ["path"], // D#6 C44-2: paths for the login-shell probe's rules and the start-up files it re-binds; the machine itself is reached only through its host argument
  "src/sandbox/probeHost.ts": ["fs"], // the real machine behind the probe: stat and a bounded read of a few small files; the process start is the engine kit's
  "src/sandbox/allowances.ts": ["fs", "path"], // D#6 R7b: realpath of an allowed path, and the target of a dangling link (lstat, readlink), before the floor is checked on where it really lands
  "src/sandbox/jobEnvFile.ts": ["fs", "path"], // D#6 C44-1: the per-job env file: lstat of the temp dir, an exclusive no-follow create (0600)
  "src/sandbox/writeScratch.ts": ["fs", "path"], // D#6 R7b: the job-scoped write directories: lstat, a fresh 0700 mkdir, and a removal that follows no link
  "src/sandbox/sandboxSettings.ts": ["fs", "path"],
  "src/daemon/derivedStep.ts": ["fs", "path"], // #751: a generated file's bytes before and after its generators: realpath, a no-follow open, a bounded read, and a put-back into a file that existed; no process is started here
  "src/sandbox/toolchain.ts": ["fs", "path"], // the toolchain found at setup (D#6 R4d-3): stat, executable check and realpath of the tools; no process is started

  "src/job/plainSegment.ts": ["path"],
  "src/job/workspaceHolds.ts": ["fs", "os", "path"], // D#587 FU-318: the hold files other runner processes read: a 0600 file made O_EXCL|O_NOFOLLOW, lstat of the directory and the owner check, readdir and unlink of dead holds
  "src/commands/prune.ts": ["fs", "path"], // `fx-runner prune`: the state directory it takes the single-instance lock in
  "src/job/workspacePrune.ts": ["crypto", "fs", "fs/promises", "os", "path"], // D#587 FU-318: the prune of finished runs' workspaces: lstat-only walks, no-follow removal (a link is unlinked, never entered), the owner check, statfs of the volume, and the 0600 list of held directories (random temp name, renamed whole)
  "src/job/spillFiles.ts": ["crypto", "fs", "os", "path"], // D#600 CX-4b: the no-follow writer of a run's spill files (lstat, O_EXCL|O_NOFOLLOW) and the owner check of its root
  // D#6 R6-2a, the update client. The fetcher is the only code that opens a connection for an update: https (the request, with each redirect hop checked by hand and no plain-http hop ever opened), stream (the response body handed to the TUF client), and http for the response's type only.
  "src/update/pinnedFetcher.ts": ["http", "https", "stream"],
  // The client's own files under <state dir>/tuf: SHA-256 of a downloaded release file, a random temp-file name for the root, a 0700 directory, and the saved metadata and verified download.
  "src/update/tuf.ts": ["crypto", "fs", "path"],
  "src/update/trustedRoot.ts": ["crypto"],
  // D#6 R6-2b, applying updates. The installed layout under the state directory: a random name for a staging directory and a link, lstat/readlink/symlink/rename for the atomic switch of the stable link, a copy of the verified file with exclusive create, and SHA-256 of the staged file. No process is started here: the entry point hands in the one function that runs a program for the start check.
  "src/update/versions.ts": ["crypto", "fs", "path"],
  "src/update/updater.ts": ["crypto", "fs", "path"],
  // D#587 B-1, the microVM image build (`fx-runner vm build-image`). It reads no environment and starts no process itself: crane, tar and mke2fs run through the injected host (scripts/vm-main.mjs).
  "src/vm/buildImage.ts": ["crypto", "fs", "path"], // SHA-256 of the root disk and the guest files, a work directory per architecture, a sparse disk file of the computed size, and the staged guest files
  "src/vm/bundle.ts": ["crypto", "fs", "os", "path"], // the verified install bundle: SHA-256 of each download, no-follow reads, exclusive 0600 writes into a fresh temp directory
  "src/vm/egress/address.ts": ["net", "os"], // B-4a: `net.BlockList` and `net.isIP` classify a resolved address (pure, opens no socket); `os.networkInterfaces()` reads this host's own addresses. No process is started and no environment is read
  "src/vm/egress/proxy.ts": ["dns", "fs", "http", "net", "path"], // B-4a: an http server on one Unix socket inside the VM's vsock directory (lstat checks, chmod); `dns.promises.lookup` resolves a policy host; `net.connect` opens the upstream leg to an address already judged public. No process is started and no environment is read
  "src/vm/egress/reverse.ts": ["dns", "http", "https", "net", "path"], // B-4a-ii: an http server on one Unix socket in the VM's vsock directory; `https.request` makes the upstream TLS request to an address already judged public; `dns.promises.lookup` resolves the policy host. No process is started and no environment is read
  "src/vm/install.ts": ["crypto"], // `vm install`: SHA-256 of the unit, config and manifest text carried in the root request; no process is started here
  "src/vm/rootActions.ts": ["path"], // the root steps as data, and the root side's check that every path is clean, absolute and inside the install's own places
  "src/vm/rootApply.ts": ["crypto", "fs", "path"], // the root side: lstat of every path and its parents, no-follow opens judged by the handle, a random temp-file name, an exclusive create, fsync, one rename, owner/mode/content checked afterwards
  "src/vm/uninstallApply.ts": ["fs", "path"], // the root side of `vm uninstall`: no-follow lstat of each path and its parents (via rootApply), a directory listing and unlink or rmdir of what install made; no process is started here
  "src/vm/helperSandboxes.ts": ["net"], // `vm uninstall`: one connection per request to the helper's Unix socket for `list` and `destroy` (the socket path is passed in); nothing else is read
  "src/vm/helperProbe.ts": ["net"], // one connect to the helper's Unix socket to see whether it answers; nothing else is read
  "src/vm/command.ts": ["fs"], // reads the image lock file named on the command line
  "src/vm/sandboxd/command.ts": ["crypto"], // D#587 B-2b-iii: a random command id and pid-file name; no process is started here, the command runs in the guest through the agent
  "src/vm/sandboxd/guestAgent.ts": ["net", "stream"], // D#587 B-2b-iii: the guest agent client: a Unix-socket connection to the sandbox's vsock proxy and the Duplex type it is handed; no process is started
  "src/vm/sandboxd/streamCommand.ts": ["stream"], // D#587 B-5a-RT-1: the Duplex type of the connection it is handed; frames are read off that socket on demand, no process is started
  "src/vm/sandboxd/helperClient.ts": ["stream"], // D#587 B-2b-iii: the helper client takes an injected Duplex and speaks framed JSON over it; only the stream type is named
  "src/vm/sandboxd/files.ts": ["path"], // D#587 B-2b-iii-b: the guest path rules of file transfer (joins and normalises names); no file on this host is opened here
  "src/vm/sandboxd/production.ts": ["net", "stream"], // D#587 B-2b-iii-b: the Unix-socket connection to the helper and the Duplex type; the euid and platform arrive from the caller
  "src/vm/sandboxd/teardown.ts": [], // D#587 B-2b-iii-b: the teardown logic only; the process counter is an injected port, built outside src
  "src/vm/sandboxd/vsockFd.ts": ["fs", "net"], // D#587 B-2b-iii-b: O_PATH|O_NOFOLLOW opens judged by fstat, and the connect through the checked socket fd; the euid and platform arrive from the caller
  "src/vm/sandboxd/snapshots.ts": ["crypto"], // D#587 B-3b: a random snapshot id; the state file is read and written through the engine bridge's file helpers, and no process is started
  "src/vm/sandboxd/sandboxd.ts": ["path"], // D#587 B-2b-iii: joins the per-sandbox directory and socket names below the state directory
  "src/vm/sandboxd/sdkAdapter.ts": ["crypto"], // D#587 B-5: names are hashed into daemon ids; no process, file or environment is touched
  "src/vm/sandboxd/sdkSlice.ts": [], // D#587 B-5: types only
  "src/vm/sandboxd/management.ts": [], // D#587 B-5b: the runner's inventory and lifecycle over the adapter; no built-in
  "src/vm/sandboxd/policyPort.ts": [], // D#587 B-5b: starts and closes the egress listeners; the egress code is injected
  "src/vm/engineGate.ts": [], // D#587 B-5b: the engine choice and the job gate; pure
  // D#749 V2c-2a, the verify browser server. No environment read (the host environment, streams and job directory arrive as arguments) and no process of its own: Chromium is started by playwright-core.
  "src/verifyBrowser/server.ts": ["fs", "path", "stream"], // the one answer.json in the job directory (exclusive create, 0600); stream is only the types of the injected input and output
  "src/commands/verifyBrowserServer.ts": ["path"], // D#749 V2c-2b: the server entry checks its path flags are plain absolute paths; nothing is read or written here
  "src/commands/verifyLogin.ts": ["fs", "path"], // D#749 V2c-2b: the folder and name of the storage-state file (written by the private-file writer); `--forget` looks at it with lstat and removes exactly that one name (a link is removed, never followed)
  "src/daemon/answerFile.ts": ["fs", "path"], // D#749 V2c-2b: one answer.json in a job directory, opened without following a link and judged by the open handle (fstat), a bounded read, then its removal
  "src/daemon/playwrightProbe.ts": ["fs", "path"], // D#749 V2c-2b: stat of the browser program, lstat and a bounded read of the storage-state file for its cookie names, hosts and expiry (content never returned or logged)
  "src/verifyBrowser/stateScope.ts": ["fs"], // D#749 V2c-2b: the server reads the storage-state file once: opened without following a link, judged by the open handle (plain file, mode, size), parsed and checked for foreign origins
  "src/verifyBrowser/loadPlaywright.ts": ["path"], // D#749 V2c-2b: the sidecar folder's path; the loader that opens it is built in bin/fx-runner.mjs
  "src/verifyBrowser/proxy.ts": ["http", "net"], // the origin proxy on 127.0.0.1: an http server for forwarded requests and CONNECT tunnels to the one base host and port; the upstream address is the base's own
  "src/verifyBrowser/driver.ts": ["fs", "path"], // the job directory's HOME and TMPDIR (lstat of the job directory, non-recursive mkdir so nothing existing is reused, removal of exactly those two) and the lookup of an installed Chromium (directory listing, existence)
};

/**
 * Files that may hold the exact string token `/proc` and nothing longer: the sandbox probe hands it to bubblewrap as the mount point of a
 * fresh process table, as the installed agent CLI does, so the probe fails where a job would on a host that masks it; the Nix client view (D#6 R7c) does the
 * same for the same reason. A path below it
 * (`/proc/`), the process table's environment files and a `proc` segment anywhere else stay banned in every file.
 */
export const EXACT_PROC_TOKEN_FILES: readonly string[] = ["src/sandbox/probe.ts", "src/sandbox/nixView.ts"];

/**
 * The checkout search's list of places it never enters (ON-BR-1): the exact token `/proc` as an element of the array `SKIPPED_PATHS` in this one file, and
 * nowhere else. It is never joined onto, listed or opened: it is only compared against a path to refuse it.
 */
export const SKIP_LIST_FILE = "src/engineBridge/discover.ts";

/**
 * D#6 RUNNER-CWD-1: the one file that may name this process's descriptor table, and only as the whole name `/proc/self/fd` (not `fdinfo`, not
 * anything after it but what the code builds at run time): the workspace cleanup reaches each entry through the descriptor of the directory it
 * checked, so a parent swapped for a link cannot redirect a removal. Every other `/proc` path, the environment files included, stays banned there.
 */
export const PROC_FD_FILES: readonly string[] = ["src/daemon/workspaceStubs.ts"];
const PROC_FD_NAME = /\/proc\/self\/fd(?![\w/.-])/g;

/**
 * D#587 B-2b-iii-b: the one file that may name `/proc/self/fd/` as the start of a template literal, as in `/proc/self/fd/${fd}`. The sandbox daemon
 * connects to a VM's vsock socket, and inspects its directory, through descriptors it opened with O_PATH|O_NOFOLLOW and checked, never through a path
 * a sandbox could re-point (the reviewed security property of Corrections 8 and 9). Only whole template shapes are exempt, matched on the syntax tree (see vsockFdTemplateHeads);
 * `/proc/self/fdx/`, `/proc/1/fd/`, `/proc/self/`, a plain string, a tagged or nested template and every other `/proc` path stay banned, here and everywhere else.
 */
export const VSOCK_FD_TEMPLATE_FILES: readonly string[] = ["src/vm/sandboxd/vsockFd.ts"];
const VSOCK_FD_PREFIX = "/proc/self/fd/";

/**
 * The template heads the vsock-file exemption covers, by AST shape. A template qualifies only when it is untagged, starts with exactly
 * `/proc/self/fd/`, and is one of the two shapes the file uses: `` `/proc/self/fd/${a}` `` or `` `/proc/self/fd/${a}/${b}` ``, where each substitution is a
 * bare identifier and no other literal text appears (the middle is exactly `/`, the tail is empty). Anything else, and every other `/proc` text,
 * stays banned.
 */
function vsockFdTemplateHeads(source: ts.SourceFile): Set<ts.Node> {
  const heads = new Set<ts.Node>();
  const walk = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent) && node.head.text === VSOCK_FD_PREFIX) {
      const spans = node.templateSpans;
      const bare = spans.every((span) => ts.isIdentifier(span.expression));
      const [one, two] = spans;
      const shapeOne = spans.length === 1 && one !== undefined && one.literal.text === "";
      const shapeTwo = spans.length === 2 && one !== undefined && two !== undefined && one.literal.text === "/" && two.literal.text === "";
      if (bare && (shapeOne || shapeTwo)) heads.add(node.head);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return heads;
}

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]));
const BANNED_EXEC_NAMES = new Set(["exec", "execSync", "execFile", "execFileSync", "fork", "spawnSync"]);

function isNamedLookup(node: ts.Identifier): boolean {
  const env = node.parent;
  if (!ts.isPropertyAccessExpression(env) || env.expression !== node || env.questionDotToken || env.name.text !== "env") return false;
  const read = env.parent;
  if (ts.isPropertyAccessExpression(read)) return read.expression === env && !read.questionDotToken;
  if (ts.isElementAccessExpression(read)) {
    return read.expression === env && !read.questionDotToken && ts.isIdentifier(read.argumentExpression);
  }
  return false;
}

function isTextToken(node: ts.Node): node is ts.StringLiteralLike | ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail {
  return ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
}

/** The module specifier a node loads, if the node is a loader form; `null` for the specifier of a non-literal one. */
function loadedSpecifier(node: ts.Node): { spec: ts.Expression | undefined } | undefined {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) return { spec: node.moduleSpecifier };
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) return { spec: node.moduleReference.expression };
  if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) return { spec: node.argument.literal as ts.Expression };
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return { spec: node.arguments[0] };
  return undefined;
}

const SPAWN_NAME = /^spawn/i;
const SPAWN_SEAM_FILE = "src/engines/claude/engine.ts";
const CHILD_PROCESS_NAMES = new Set(["spawn", "ChildProcess"]);
/**
 * The one reviewed exemption to the banned child-process names: the guest agent protocol's wire op name (B-1b) is the word "exec". It is
 * allowed only in that file, only as the exact string, and only as the value of an `op` property in an object literal (a frame field), so it
 * can never be called, indexed or passed as a function name. No other file, string or position is exempt.
 */
export const WIRE_OP_EXEMPTION: Readonly<Record<string, string>> = { "src/vm/sandboxd/guestAgent.ts": "exec" };

function isWireOpFrameField(node: ts.Node, file: string, text: string): boolean {
  if (WIRE_OP_EXEMPTION[file] !== text || !ts.isStringLiteral(node)) return false;
  const parent = node.parent;
  return ts.isPropertyAssignment(parent) && parent.initializer === node && ts.isIdentifier(parent.name) && parent.name.text === "op" && ts.isObjectLiteralExpression(parent.parent);
}

const BANNED_STRINGS = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);

function isChildProcessSpec(spec: string): boolean {
  return spec.replace(/^node:/, "") === "child_process";
}

/** `const spawnFn = <expr> ?? spawn;` in the engine file: the one place the real `spawn` may be named as a value. */
function isSeamDefault(node: ts.Node, file: string): node is ts.BinaryExpression {
  return (
    file === SPAWN_SEAM_FILE &&
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    ts.isIdentifier(node.right) &&
    node.right.text === "spawn" &&
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node &&
    ts.isIdentifier(node.parent.name) &&
    node.parent.name.text === "spawnFn"
  );
}

/** `SpawnFn` or `typeof spawn`: a value of this type must be named spawn..., or the name checks below cannot see its calls. */
function isSpawnType(type: ts.TypeNode): boolean {
  return (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "SpawnFn") || (ts.isTypeQueryNode(type) && ts.isIdentifier(type.exprName) && type.exprName.text === "spawn");
}

/** True when a spawn-like name is used in a way the narrow allowances do not cover (alias, value, .call, Reflect.apply, ...). */
function spawnValueProblem(node: ts.Identifier, file: string): boolean {
  const parent = node.parent;
  if (ts.isImportSpecifier(parent) || ts.isTypeQueryNode(parent) || ts.isTypeReferenceNode(parent)) return false;
  if ((ts.isPropertySignature(parent) || ts.isParameter(parent) || ts.isTypeAliasDeclaration(parent)) && parent.name === node) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  if (ts.isPropertyAssignment(parent)) {
    if (parent.name === node) return false;
    return !(ts.isIdentifier(parent.name) && parent.name.text === "spawn" && node.text === "spawnFn");
  }
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return !(node.text === "spawnFn" && parent.initializer !== undefined && isSeamDefault(parent.initializer, file));
  }
  if (ts.isBinaryExpression(parent) && parent.right === node && isSeamDefault(parent, file)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return false;
    const seamLeft = ts.isBinaryExpression(parent.parent) && parent.parent.left === parent && isSeamDefault(parent.parent, file);
    const runCaptureArg =
      ts.isCallExpression(parent.parent) &&
      parent.parent.arguments[0] === parent &&
      ts.isIdentifier(parent.parent.expression) &&
      (parent.parent.expression.text === "runCapture" || parent.parent.expression.text === "runForeground" || parent.parent.expression.text === "runInstall" || parent.parent.expression.text === "runCaptureWithInput" || parent.parent.expression.text === "runForegroundLaunched");
    return !(seamLeft || runCaptureArg);
  }
  return true;
}

/** The loading forms of `node:child_process`: only an unaliased named import of `spawn` (and the `ChildProcess` type). */
function childProcessLoadProblem(node: ts.Node): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return true;
    return clause.namedBindings.elements.some((el) => el.propertyName !== undefined || !CHILD_PROCESS_NAMES.has(el.name.text));
  }
  return true;
}

function envValueOk(prop: ts.ObjectLiteralElementLike): boolean {
  if (ts.isShorthandPropertyAssignment(prop)) return prop.name.text !== "undefined" && !prop.objectAssignmentInitializer;
  if (!ts.isPropertyAssignment(prop)) return false;
  const value = prop.initializer;
  if (ts.isIdentifier(value)) return value.text !== "undefined";
  return ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === "cleanEnv";
}

/** True when a spawn call is not `spawn(command, argv, { env: <identifier or cleanEnv(...)>, shell: false, ... })`. */
function spawnCallProblem(call: ts.CallExpression): boolean {
  if (call.arguments.length !== 3) return true;
  const options = call.arguments[2]!;
  if (!ts.isObjectLiteralExpression(options)) return true;
  const seen = new Map<string, number>();
  for (const prop of options.properties) {
    if (ts.isSpreadAssignment(prop) || !prop.name || !(ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name))) return true;
    const name = prop.name.text;
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (name === "env" && !envValueOk(prop)) return true;
    if (name === "shell" && !(ts.isPropertyAssignment(prop) && prop.initializer.kind === ts.SyntaxKind.FalseKeyword)) return true;
  }
  return seen.get("env") !== 1 || (seen.get("shell") ?? 0) > 1;
}

/** Every rule the text breaks, by name. Empty means the text reads the environment only by name, and only where that is allowed. */
export function envAccessViolations(source0: string, file: string = ENV_READER_FILE): string[] {
  // The descriptor table's exact name, in the one file allowed it, is read as a neutral word; anything longer or different is still checked below.
  const named = PROC_FD_FILES.includes(file) ? source0.replace(PROC_FD_NAME, "fd-table") : source0;
  const text = named;
  const found = new Set<string>();
  const allowed = new Set(ALLOWED_BUILTINS[file] ?? []);
  const mayUseChildProcess = ENGINE_FILES.includes(file) && allowed.has("child_process");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exemptHeads = VSOCK_FD_TEMPLATE_FILES.includes(file) ? vsockFdTemplateHeads(source) : new Set<ts.Node>();
  // The exempt prefix is read as a neutral word of the same length in the raw-text checks at the end; everything else in the text is checked as written.
  let rawText = text;
  for (const head of exemptHeads) {
    const at = head.getStart(source) + 1;
    rawText = rawText.slice(0, at) + "x".repeat(VSOCK_FD_PREFIX.length) + rawText.slice(at + VSOCK_FD_PREFIX.length);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (name === "process") {
        if (file === PROCESS_GROUP_FILE) {
          if (!isGroupSignalUse(node)) found.add("process used other than as process.kill or process.platform");
        } else if (file !== ENV_READER_FILE) found.add("process outside the environment reader");
        else if (!isNamedLookup(node)) found.add("process used other than as process.env.NAME or process.env[name]");
      } else if (name === "globalThis" || name === "global") {
        found.add("globalThis or global");
      } else if (name === "constructor") {
        found.add("constructor member");
      } else if (name === "require") {
        found.add("require");
      } else if (name === "Function" && !ts.isTypeReferenceNode(node.parent)) {
        found.add("Function constructor");
      } else if (name === "eval") {
        if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) found.add("eval without a direct call");
      } else if (SPAWN_NAME.test(name) && name !== "spawnSync" && spawnValueProblem(node, file)) {
        found.add("spawn used other than as a direct, checked call");
      } else if (BANNED_EXEC_NAMES.has(name)) {
        const isMember = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
        if (mayUseChildProcess || !isMember) found.add("exec, fork or synchronous spawn");
      }
    }
    if ((ts.isParameter(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.type && isSpawnType(node.type)) {
      if (!SPAWN_NAME.test(node.name.getText(source))) found.add("a spawn-typed name that does not start with spawn");
    }
    if (isTextToken(node) && !exemptHeads.has(node)) {
      if (/^(?:node:)?process$/.test(node.text)) found.add("import of the process module");
      if (node.text.includes("/proc/")) found.add("/proc/ path");
      if (node.text === "constructor") found.add("constructor member");
      if (BANNED_STRINGS.has(node.text) && !isWireOpFrameField(node, file, node.text)) found.add("child process function named by a string");
      // Allowed only as the element right after "--proc" in an array literal: the mount-point argument, never a path being built.
      const parent = node.parent;
      const exactProc =
        node.text === "/proc" && EXACT_PROC_TOKEN_FILES.includes(file) && ts.isArrayLiteralExpression(parent) &&
        (() => {
          const before = parent.elements[parent.elements.indexOf(node as ts.Expression) - 1];
          return before !== undefined && ts.isStringLiteralLike(before) && before.text === "--proc";
        })();
      const inSkipList =
        node.text === "/proc" && file === SKIP_LIST_FILE && ts.isArrayLiteralExpression(parent) && ts.isVariableDeclaration(parent.parent) && parent.parent.name.getText(source) === "SKIPPED_PATHS";
      if (/environ(?!ment)/i.test(node.text) || (!exactProc && !inSkipList && node.text.split(/[\\/]/).includes("proc"))) found.add("proc path segment or environ file");
    }
    const load = loadedSpecifier(node);
    if (load) {
      const spec = load.spec;
      if (!spec || !(ts.isStringLiteralLike(spec))) {
        found.add("module load with a non-literal specifier");
      } else {
        const bare = spec.text.replace(/^node:/, "");
        if (isChildProcessSpec(spec.text) && childProcessLoadProblem(node)) found.add("child_process loaded other than as an unaliased named import");
        if ((spec.text.startsWith("node:") || BUILTINS.has(bare)) && !allowed.has(bare)) found.add("node built-in module not allowed here");
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "";
      if (/^spawn/i.test(callee) && callee !== "spawnSync") {
        if (!mayUseChildProcess) found.add("spawn outside the engine files");
        else if (spawnCallProblem(node)) found.add("spawn without an env option, or with a shell");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (/["'`](?:node:)?process["'`]/.test(rawText)) found.add("import of the process module");
  if (/\b(?:globalThis|global)\b/.test(rawText)) found.add("globalThis or global");
  if (/\/proc\//.test(rawText)) found.add("/proc/ path");
  return [...found];
}
