# syntax=docker/dockerfile:1
###############################################################################
# AREA backend: pycdc (Decompyle++) — image tag area/pycdc:latest
#
# Contract (src/server/retools/registry.ts, tool ids "pycdc" and "pycdas"):
#   the runner invokes the container as
#     <image> pycdc <input> -o <out>/out/decompiled.py     (decompile)
#     <image> pycdas -o <out>/out/disasm.txt <input>       (disassemble)
#   so this image must NOT define ENTRYPOINT/CMD — the runner passes the full
#   registry argv after the image name — and both binaries must be on PATH.
#   Posture: --rm --network none --read-only --tmpfs /tmp --memory 512m
#   --cpus 1 -v <workDir>:/area:rw -w /area.
#
# Verified against the pycdc source at W1b authoring time: BOTH pycdc and
# pycdas take `-o <filename>` as an OUTPUT FILE (default stdout) — see the
# W1b worklog for the pycdc registry-argv mismatch this exposed.
#
# Built from source per the W1b spec (git clone --depth 1). A depth-1 clone
# of a moving default branch is NOT pinned — for reproducible images pass
# `--build-arg PYCDC_REF=<tag-or-sha>`.
###############################################################################
FROM debian:12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ARG PYCDC_REF=""

RUN git clone --depth 1 https://github.com/zrax/pycdc /tmp/pycdc \
 && cd /tmp/pycdc \
 && if [ -n "$PYCDC_REF" ]; then \
      git fetch --depth 1 origin "$PYCDC_REF" && git checkout FETCH_HEAD; \
    fi \
 && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build --parallel \
 && cmake --install build \
 && cd / && rm -rf /tmp/pycdc \
 && pycdc --help 2>&1 | head -n 1 \
 && pycdas --help 2>&1 | head -n 1

ENV HOME=/tmp

WORKDIR /area
