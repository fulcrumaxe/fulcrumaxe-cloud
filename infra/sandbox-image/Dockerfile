# fx-agent sandbox image: the Vercel sandbox ubuntu setup plus a pinned agent bundle under /opt/fx.
# Build only through scripts/ops/publish-sandbox-image.sh: it feeds the URL and sha256 build args
# from versions.lock.json, so the lockfile is the single record of what is downloaded.
# Base: ubuntu:26.04, index digest resolved on Docker Hub (same digest as packages/env-presets).

# Stage 1: download and verify. Its tools (curl, xz) never reach the final image.
FROM docker.io/library/ubuntu@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78 AS fetch
ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_URL
ARG NODE_SHA256
ARG CLAUDE_URL
ARG CLAUDE_SHA256
ARG CODEX_URL
ARG CODEX_SHA256
ARG OPENCODE_URL
ARG OPENCODE_SHA256
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    : "${NODE_URL:?}" "${NODE_SHA256:?}" "${CLAUDE_URL:?}" "${CLAUDE_SHA256:?}" "${CODEX_URL:?}" "${CODEX_SHA256:?}" "${OPENCODE_URL:?}" "${OPENCODE_SHA256:?}"; \
    install -d -m 0755 /opt/fx /opt/fx/bin /tmp/dl; \
    curl -fsSL --retry 3 -o /tmp/dl/node.tar.xz "$NODE_URL"; \
    echo "$NODE_SHA256  /tmp/dl/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/dl/node.tar.xz --wildcards --strip-components=2 -C /opt/fx/bin '*/bin/node'; \
    curl -fsSL --retry 3 -o /opt/fx/bin/claude "$CLAUDE_URL"; \
    echo "$CLAUDE_SHA256  /opt/fx/bin/claude" | sha256sum -c -; \
    curl -fsSL --retry 3 -o /tmp/dl/codex.tar.gz "$CODEX_URL"; \
    echo "$CODEX_SHA256  /tmp/dl/codex.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/dl/codex.tar.gz -C /opt/fx/bin; \
    mv /opt/fx/bin/codex-x86_64-unknown-linux-musl /opt/fx/bin/codex; \
    curl -fsSL --retry 3 -o /tmp/dl/opencode.tar.gz "$OPENCODE_URL"; \
    echo "$OPENCODE_SHA256  /tmp/dl/opencode.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/dl/opencode.tar.gz -C /opt/fx/bin opencode; \
    chmod 0755 /opt/fx/bin/node /opt/fx/bin/claude /opt/fx/bin/codex /opt/fx/bin/opencode; \
    chown -R root:root /opt/fx

# Stage 2: the image the sandbox runs. Same user, sudo and home as Vercel's ubuntu image.
FROM docker.io/library/ubuntu@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78
ENV LANG=C.UTF-8
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates sudo git \
    && rm -rf /var/lib/apt/lists/*
RUN printf '%s\n' \
      'Defaults always_set_home' \
      'Defaults !env_reset' \
      'Defaults !fqdn' \
      'ubuntu ALL=(ALL) NOPASSWD:ALL' \
      > /etc/sudoers.d/sandbox \
    && chmod 0440 /etc/sudoers.d/sandbox \
    && install -d -o ubuntu -g ubuntu /vercel /vercel/sandbox /fx \
    && usermod --home /vercel ubuntu \
    && chown -R ubuntu:ubuntu /vercel
COPY --from=fetch --chown=root:root /opt/fx /opt/fx
# The runner starts the agent as plain `claude`, and the agent's own child processes expect `node`: both are found on
# PATH. /opt/fx/bin comes FIRST, so these are the pinned binaries and nothing in a customer's repository or image can
# shadow them. The rest is Ubuntu's standard PATH. packages/runner/test/sandboxImagePin.test.ts keeps this in step
# with what the runner runs.
ENV PATH=/opt/fx/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV DISABLE_AUTOUPDATER=1
ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV HOME=/vercel
ENV SHELL=/bin/bash
USER ubuntu
WORKDIR /vercel
