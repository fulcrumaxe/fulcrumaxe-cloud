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
    fetch claude /opt/fx/bin/claude; \
    fetch pnpm /tmp/dl/pnpm.tar.gz; \
    tar -xzf /tmp/dl/pnpm.tar.gz -C /opt/fx/pnpm pnpm dist; \
    ln -s ../pnpm/pnpm /opt/fx/bin/pnpm; \
    chmod 0755 /opt/fx/bin/node /opt/fx/bin/claude; \
    chown -R root:root /opt/fx

# Stage 2: the image. Same user, sudo and home as infra/sandbox-image, plus what scripts/check.sh needs (pnpm, Postgres,
# Python, jq) and what the guest needs (bubblewrap for the agent's Bash sandbox, iproute2 for loopback). libatomic1 is
# pnpm's one shared-library dependency.
FROM docker.io/library/ubuntu@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78
ENV LANG=C.UTF-8
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates sudo git bubblewrap iproute2 jq libatomic1 python3 postgresql \
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
ENV PATH=/opt/fx/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV DISABLE_AUTOUPDATER=1
ENV HOME=/vercel
ENV SHELL=/bin/bash
USER ubuntu
WORKDIR /vercel
