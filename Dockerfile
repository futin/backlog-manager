# Dev image shared by both Node processes (Nest API and Vite). It carries only
# the dependency install: the source arrives at run time through a bind mount so
# --watch stays useful, and there is nothing to rebuild for a code change.
#
# node_modules lives in the image rather than in the bind mount because the
# host's copy is built for macOS — mounting it over /app would hand the
# container the wrong binaries for esbuild and friends. Compose masks
# /app/node_modules with a named volume, which Docker seeds from this layer.
# node:24 rather than the 20 this image used to carry: pnpm 11 declares
# `engines.node >= 22.13` and genuinely means it — on 20 it dies during its own
# module init with ERR_UNKNOWN_BUILTIN_MODULE, before it ever reads the
# lockfile. Node 20 is also out of support.
FROM node:24-slim

WORKDIR /app

# procps, for `ps`. The Nest CLI's watch mode restarts the app by walking the
# process tree with `ps -A -o pid,ppid` and killing what it finds — and the
# helper swallows a missing `ps`, returning an empty child list rather than
# failing. On this image without it, a restart killed only the CLI's direct
# child; the real server survived as an orphan holding :4321, every rebuild
# after that died with EADDRINUSE, and the container went on serving the stale
# build in silence until someone restarted it by hand.
#
# The dev script also passes --no-shell, which makes the server the CLI's direct
# child and is what actually fixes that. This is the second layer: it keeps the
# failure from coming back silently if the spawn ever grows a wrapper again.
# Installed before the dependency layers so a package.json edit does not redo it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

# pnpm, via corepack, so the version the image installs with is the one
# package.json's `packageManager` field names rather than whatever npm happens
# to ship. The prompt has to be disabled explicitly: corepack asks for
# confirmation before fetching a version it has not seen, and a build has no
# one to answer it.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Copied on their own so editing source does not invalidate the install layer.
# pnpm-workspace.yaml belongs here too, not just alongside the source: it holds
# the allowBuilds list, and without it esbuild installs with its postinstall
# script skipped — which shows up much later as Vite failing to start rather
# than as an install error. esbuild is the only entry: this repo has no
# database, so nothing else here has an install script worth running.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
