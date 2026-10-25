ARG BASE_IMAGE=optio-base:latest
FROM ${BASE_IMAGE}

USER root

# bun (pnpm and yarn are provided by Corepack in the base image)
RUN curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/ \
    && rm -rf /root/.bun

# Build tools for native modules
RUN apt-get update && apt-get install -y build-essential python3-dev \
    && rm -rf /var/lib/apt/lists/*

USER agent
