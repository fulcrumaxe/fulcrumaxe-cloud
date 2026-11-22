# fx-agent microVM template (D#587 B-1): the userland of the Firecracker guest. `fx-runner vm build-image` exports this image
# by digest and turns it into a read-only ext4 root disk; the guest init and agent are added there, not here.
# Every download comes from lock.json (URL and sha256 per architecture) and is checked, so the lock is the one record of it.
# Build only through .github/workflows/microvm-image.yml, which puts lock.json next to this file as the build context.
# Same base as infra/sandbox-image (index digest resolved on Docker Hub). The apt packages are not pinned; the image DIGEST is,
# once built, and the root disk is a pure function of that digest.

# Stage 1: download and verify. Its tools (curl, xz, jq) never reach the final image. It runs on the build machine's own
# architecture (no emulation) and fetches the files for the target architecture, which are only copied, never run.
ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM docker.io/library/ubuntu@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78 AS fetch
ARG TARGETARCH
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils jq \
    && rm -rf /var/lib/apt/lists/*
COPY lock.json /lock.json
RUN set -eu; \
    fetch() { \
      url="$(jq -er ".artifacts.$1.$TARGETARCH.url" /lock.json)"; sha="$(jq -er ".artifacts.$1.$TARGETARCH.sha256" /lock.json)"; \
      curl -fsSL --retry 3 -o "$2" "$url"; echo "$sha  $2" | sha256sum -c -; \
    }; \
    install -d -m 0755 /opt/fx/bin /opt/fx/pnpm /tmp/dl; \
    fetch node /tmp/dl/node.tar.xz; \
    tar -xJf /tmp/dl/node.tar.xz --wildcards --strip-components=2 -C /opt/fx/bin '*/bin/node'; \
    tar -xJf /tmp/dl/node.tar.xz --wildcards --strip-components=1 -C /opt/fx '*/lib/node_modules/npm'; \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/fx/bin/npm; \
    ln -s ../lib/node_modules/npm/bin/npx-cli.js /opt/fx/bin/npx; \
    fetch claude /opt/fx/bin/claude; \
    fetch pnpm /tmp/dl/pnpm.tar.gz; \
    tar -xzf /tmp/dl/pnpm.tar.gz -C /opt/fx/pnpm pnpm dist; \
    ln -s ../pnpm/pnpm /opt/fx/bin/pnpm; \
    chmod 0755 /opt/fx/bin/node /opt/fx/bin/claude; \
    chown -R root:root /opt/fx

# Stage 2: the image. It matches infra/sandbox-image where check.sh can see a difference: the same user, sudo and home, the
# same pinned node, pnpm and claude (packages/fx-runner/test/vm/sandboxImageParity.test.ts fails when they drift), Postgres 18
# and Chromium at the Playwright version pnpm-lock.yaml resolves. On top of that comes what only the guest needs: bubblewrap
# and socat for the agent's Bash sandbox (the CLI refuses to start under failIfUnavailable without both), iproute2 for loopback, python3 for the guest agent, jq. libatomic1 is pnpm's one
# shared-library dependency.
# postgresql-18: initdb, pg_ctl and postgres for the throwaway clusters the pg-backed tests start. create_main_cluster=false
# stops the package creating a cluster (the disk is read-only; tests make theirs under /tmp). Debian keeps the binaries in
# /usr/lib/postgresql/18/bin, so the ones tests call by name are linked into /usr/local/bin (on PATH, behind /opt/fx/bin).
FROM docker.io/library/ubuntu@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78
ENV LANG=C.UTF-8
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get upgrade -y \
    && install -d /etc/postgresql-common \
    && printf '%s\n' 'create_main_cluster = false' > /etc/postgresql-common/createcluster.conf \
    && apt-get install -y --no-install-recommends ca-certificates sudo git bubblewrap socat iproute2 jq libatomic1 python3 postgresql-18 \
    && for b in initdb pg_ctl postgres psql createdb pg_isready; do ln -s "/usr/lib/postgresql/18/bin/$b" "/usr/local/bin/$b"; done \
    && rm -rf /var/lib/apt/lists/* /var/log/apt /var/log/dpkg.log /var/log/alternatives.log /var/cache/ldconfig/aux-cache
RUN printf '%s\n' \
      'Defaults always_set_home' \
      'Defaults !env_reset' \
      'Defaults !fqdn' \
      'ubuntu ALL=(ALL) NOPASSWD:ALL' \
      > /etc/sudoers.d/sandbox \
    && chmod 0440 /etc/sudoers.d/sandbox \
    && install -d -o ubuntu -g ubuntu /vercel /vercel/sandbox \
    && usermod --home /vercel ubuntu \
    && chown -R ubuntu:ubuntu /vercel
COPY --from=fetch --chown=root:root /opt/fx /opt/fx
# Chromium for the repo's Playwright specs, baked in because the guest has no network. PLAYWRIGHT_VERSION is the value in
# infra/sandbox-image/Dockerfile and the @playwright/test version in pnpm-lock.yaml (a test checks both): each Playwright
# release expects one exact Chromium build. Nothing here turns Chromium's own sandbox off. The guest kernel has user namespaces,
# which that sandbox uses. The browsers sit under /opt/ms-playwright, root-owned and world-readable.
ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \
    && PATH=/opt/fx/bin:$PATH npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium \
    && chmod -R a+rX /opt/ms-playwright \
    && rm -rf /var/lib/apt/lists/* /root/.npm /var/log/apt /var/log/dpkg.log /var/log/alternatives.log /var/cache/ldconfig/aux-cache
ENV PATH=/opt/fx/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV DISABLE_AUTOUPDATER=1
ENV HOME=/vercel
ENV SHELL=/bin/bash
USER ubuntu
WORKDIR /vercel
