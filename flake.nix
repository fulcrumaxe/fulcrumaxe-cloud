{
  description = "fulcrumaxe-cloud dev environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      # python312 with one check-time-only override (D#40, Team Lead decision,
      # comment 18493829): at the pinned nixpkgs rev, python3.12-inline-snapshot-0.34.2's
      # own checkPhase fails 3 of its tests, which fails every package that
      # depends on it at build time — including anthropic and claude-agent-sdk,
      # both of which pull it in only as a check-time (test) dependency, never
      # at runtime. `doCheck = false` skips inline-snapshot's own upstream test
      # suite; nothing in this repo imports inline-snapshot. This does not touch
      # flake.lock — same nixpkgs rev, same source, just a different build
      # attribute for one derivation.
      python312Override = pkgs.python312.override {
        packageOverrides = self: super: {
          inline-snapshot = super.inline-snapshot.overridePythonAttrs (_: {
            doCheck = false;
          });
        };
      };

      # D#37 WS-B: pkgs.playwright-driver.browsers-chromium, NOT the
      # default .browsers (chromium+firefox+webkit joined).
      #
      # At this repo's pinned nixpkgs rev, .browsers fails to build:
      # its autoPatchelf pass over the bundled WPE/WebKit minibrowser
      # errors with "could not satisfy dependency libmanette-0.2.so.0
      # wanted by .../libWPEWebKit-2.0.so.1.12.0" -- nixpkgs'
      # playwright-driver expression doesn't list libmanette as a
      # buildInput for that sub-derivation even though upstream's WPE
      # WebKit build now links against it. Verified via `nix develop`
      # (2026-09-18); confirmed CI hits the same failure on PR #100
      # (the "check" job in CI). `.browsers`
      # is a single joined derivation, so ANY one of its three browsers
      # failing to build fails the whole devShell for every gate, not
      # just e2e -- this is not something this PR can leave in place.
      #
      # pkgs.playwright-driver.passthru.selectBrowsers (found via `nix
      # repl`, loading the flake's own pinned nixpkgs input -- `nix eval`
      # itself is sandbox-blocked in this worktree, `nix repl` isn't)
      # builds only the browsers named true below, sidestepping the
      # broken WebKit sub-derivation entirely. withChromiumHeadlessShell
      # is required, not optional: Playwright's default headless launch
      # path looks for the separate chromium-headless-shell binary, not
      # the full chromium build (`pkgs.playwright-driver.browsers-
      # chromium`, tried first, omits it and fails at test time with
      # "Executable doesn't exist at .../chromium_headless_shell-*").
      # Both Playwright projects apps/workspace/e2e actually uses
      # (playwright.config.ts: Desktop Chrome, Pixel 7) are
      # Chromium-based, so withFirefox/withWebkit = false lose nothing
      # this PR needs. If a future task adds a WebKit-based project, it
      # will need either a nixpkgs bump past the libmanette gap or a
      # correctly-targeted override of the playwright-webkit
      # sub-derivation specifically (overriding pkgs.playwright-driver.
      # browsers' own buildInputs does not reach it -- tried, reverted,
      # see PR #100).
      playwrightBrowsers = pkgs.playwright-driver.passthru.selectBrowsers {
        withChromium = true;
        withChromiumHeadlessShell = true;
        withFfmpeg = true;
        withFirefox = false;
        withWebkit = false;
      };

      # Read-only interpreter built from the pinned nixpkgs rev in
      # flake.lock — NOT a .venv. It mirrors requirements.txt exactly;
      # scripts/tests/test_dev_shell_python_deps.py enforces the parity
      # mechanically (D#40). Pinned on python312 to match the engine's own
      # flake, so both repos build the same wheels against the same
      # interpreter. `pythonEnv` still provides the `python3` binary
      # parity.sh (and everything else that shells out to `python3`) calls.
      pythonEnv = python312Override.withPackages (ps: with ps; [
        duckdb
        pytz          # duckdb's Python client needs this to convert TIMESTAMPTZ
                       # columns (stats.duckdb) -- without it, fetchone()/fetchall()
                       # on any query touching a tz-aware column raises
                       # `_duckdb.InvalidInputException: Required module 'pytz'
                       # failed to import` (see backend/tests/test_agent_run_tracker.py)
        pyyaml
        anthropic
        claude-agent-sdk
        requests
        pyjwt
        cryptography  # PyJWT's RS256 backend (backend/github_app_auth.py)
        fastapi       # backend/asgi_app.py, backend/routers/*, backend/deps/*
        uvicorn       # live ASGI server used by backend/tests/* (SSE/perf tests)
        pytest
        pytest-timeout
      ]);

      # Everything the merge-gating CI path needs, shared by BOTH shells so
      # `default` and `ci` cannot drift (D#507). scripts/check.sh, the
      # workflow steps and the e2e job call only node, pnpm, git, jq, the
      # throwaway-Postgres tools and the Playwright browsers; none of them
      # touches Python, sqlite or duckdb.
      sharedPackages = with pkgs; [
        nodejs_24
        pnpm        # workspace package manager
        postgresql  # initdb/pg_ctl for throwaway test databases (packages/db)
        git
        jq
        # D#37 WS-B: browsers for apps/workspace/e2e and sitekit-checks,
        # from the binary cache (see playwrightBrowsers above).
        playwrightBrowsers
      ];

      # Runtime libs for compiled wheels/native addons. NixOS has no global
      # library path, so without this such imports fail at runtime.
      sharedLdLibraryPath = pkgs.lib.makeLibraryPath [
        pkgs.stdenv.cc.cc.lib   # libstdc++ / libgcc
        pkgs.zlib
      ];

      # Pure env-var exports, no network, no mutation: points
      # @playwright/test at the nix-provided browsers.
      sharedShellHook = ''
        export PLAYWRIGHT_BROWSERS_PATH=${playwrightBrowsers}
        export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
      '';
    in {
      # `ci`: lean shell for the workflow (D#507). No pythonEnv, sqlite or
      # duckdb: those serve the autonomous-team tooling, which public CI does
      # not have. Only python3 plus pyyaml, which the CI tests need. A fresh hosted runner should fetch it all from the public
      # cache instead of building Python packages from source.
      devShells.${system} = {
      ci = pkgs.mkShell {
        # Minimal Python, from the UNMODIFIED pkgs.python312 so it substitutes
        # from the public cache: ci-workflow.test.mjs parses ci.yml with
        # PyYAML, and the staging-reset tests drive a pty with python3.
        # pkgs.actionlint: ci-workflow.test.mjs validates every workflow file with it.
        packages = sharedPackages ++ [ (pkgs.python312.withPackages (ps: [ ps.pyyaml ])) pkgs.actionlint ];
        LD_LIBRARY_PATH = sharedLdLibraryPath;
        shellHook = sharedShellHook;
      };

      # `default`: local and team use; adds the Python/sqlite/duckdb tooling.
      default = pkgs.mkShell {
        packages = sharedPackages ++ (with pkgs; [
          pythonEnv   # parity runs (K02, packages/sitekit-checks) AND the
                       # autonomous-team backend/: fastapi-style modules,
                       # pydantic, duckdb, claude-agent-sdk (requirements.txt).
                       # See the `pythonEnv` binding above for why it's
                       # a packages closure and not a bare interpreter.
          sqlite      # .autonomous-team/state.db and friends
          duckdb      # stats.duckdb metrics store (backend/stats_writer.py)

          # (git, jq, node, pnpm, postgresql and the Playwright browsers
          # come from sharedPackages, which the ci shell uses too.)

          # Not added: ruff. The team's ruff-ratchet tooling exists
          # (scripts/ci/ruff-ratchet.py) but nothing in this repo invokes it
          # yet — it's not wired into scripts/check.sh or scripts/preflight-*.sh,
          # and there is no ruff.toml for it to read. Add ruff here if/when
          # something actually lints Python with it.

          # Not added: bun, rustc, cargo. The engine's flake carries these for
          # its own ts-backend/ and an archived Rust perf component — neither
          # exists in this repo, so they'd be speculative.
        ]);

        # `gh` is deliberately NOT listed here — it isn't in the engine's
        # flake either. It comes from the system (/run/current-system/sw/bin/gh).
        # Recorded here so the next person doesn't wonder why it's missing.

        # Runtime libs for compiled Python wheels (duckdb, pydantic-core, ...)
        # and the Playwright env exports, shared with the ci shell.
        LD_LIBRARY_PATH = sharedLdLibraryPath;
        shellHook = sharedShellHook;

        # No venv shellHook here, unlike the engine's flake. The engine's
        # hook builds .venv from requirements.txt on first `nix develop`
        # entry — fine for a long-lived checkout, but CI here runs
        # `nix develop --command bash scripts/check.sh` on a self-hosted
        # runner with an ephemeral work directory, so "first entry" would
        # mean "every job": a network pip install added to a gate that's
        # pnpm-only and currently takes ~10s. scripts/check.sh never touches
        # Python at all, so that cost would be pure waste on the path that
        # actually gates merges.
        # scripts/setup-deps.sh already owns venv creation on demand
        # (`--venv`) for whoever runs the Python-side team tooling — that's
        # the one place responsible for it, so the flake doesn't duplicate it.
        #
        # `pythonEnv` above replaces the bare `python312` interpreter with a
        # packages closure covering requirements.txt (D#40). It comes
        # straight from the binary cache at the rev flake.lock already pins
        # — no shellHook, no network pip install, no per-worktree disk copy,
        # and nothing mutable: every `nix develop` (operator session, every
        # agent worktree, every hook the harness runs) resolves the same
        # immutable /nix/store path for `python3`. requirements.txt stays
        # the declared source of truth; scripts/tests/test_dev_shell_python_deps.py
        # fails the moment this list and requirements.txt drift apart.
      };
      };
    };
}
