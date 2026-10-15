# syntax=docker/dockerfile:1
###############################################################################
# REA backend: rizin — image tag rea/rizin:latest
#
# Contract (src/server/retools/registry.ts, tool ids "rizin"):
#   the runner invokes the container as
#     <image> rizin -q -c "<commands>"          (no ENTRYPOINT needed — the
#   runner passes the full registry argv after the image name, so this image
#   must NOT define ENTRYPOINT/CMD)
#   with posture: --rm --network none --read-only --tmpfs /tmp \
#     --memory 1g --cpus 1 -v <workDir>:/rea:rw -w /rea
#   Outputs land in /rea/out/ (pre-created by the runner; rw mount).
#
# Built from source per the W1b spec (git clone --depth 1 of the default
# branch). NOTE: a depth-1 clone of a moving default branch is NOT pinned —
# for reproducible images pass `--build-arg RIZIN_REF=<tag-or-sha>`.
#
# The `pdg` decompiler requires the r2ghidra plugin (rizinorg/r2ghidra). The
# build below ATTEMPTS it best-effort (it vendors the Ghidra decompiler as a
# git submodule and is a long C++ build). If it fails, the image is still
# valid for disassemble/functions/info and the outcome is recorded in
# /opt/rea/r2ghidra.status — decompile runs then produce empty artifacts,
# which the runner reports honestly.
###############################################################################
FROM debian:12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential git meson ninja-build pkg-config cmake ca-certificates \
      zlib1g-dev liblzma-dev libzip-dev libcapstone-dev libtree-sitter-dev \
 && rm -rf /var/lib/apt/lists/*

ARG RIZIN_REF=""

# --- rizin (provides rizin + rz-bin + the rest of binrz) ----------------------
RUN git clone --depth 1 https://github.com/rizinorg/rizin /tmp/rizin \
 && cd /tmp/rizin \
 && if [ -n "$RIZIN_REF" ]; then \
      git fetch --depth 1 origin "$RIZIN_REF" && git checkout FETCH_HEAD; \
    fi \
 && meson setup build --buildtype=release -Dprefix=/usr/local \
 && ninja -C build \
 && ninja -C build install \
 && cd / && rm -rf /tmp/rizin \
 && ldconfig \
 && rizin -v \
 && rz-bin -v

# --- r2ghidra plugin (pdg) — best effort, status recorded --------------------
# r2ghidra builds against the installed rizin (CMAKE_PREFIX_PATH=/usr/local)
# and installs its plugin + Sleigh files into the same prefix.
RUN mkdir -p /opt/rea \
 && { git clone --depth 1 --recurse-submodules --shallow-submodules \
        https://github.com/rizinorg/r2ghidra /tmp/r2ghidra \
   && cmake -S /tmp/r2ghidra -B /tmp/r2ghidra/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
        -DCMAKE_PREFIX_PATH=/usr/local \
   && cmake --build /tmp/r2ghidra/build --parallel \
   && cmake --install /tmp/r2ghidra/build \
   && rm -rf /tmp/r2ghidra \
   && ldconfig \
   && printf 'installed\n' > /opt/rea/r2ghidra.status; \
    } \
 || { printf 'build-failed — pdg unavailable; disassemble/functions/info remain usable\n' \
        > /opt/rea/r2ghidra.status; }

ENV HOME=/tmp

WORKDIR /rea
