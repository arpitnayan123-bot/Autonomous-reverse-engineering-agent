#!/bin/sh
# AREA Ghidra runtime shim (image-internal; the runner still spawns argv-only).
#
# The runner bind-mounts the run work dir at /area (rw), which SHADOWS any
# image content under /area/scripts — but the registry argv passes
# `-scriptPath /area/scripts`. So the postscripts baked at /opt/area/scripts
# are materialized into the mounted work dir before exec'ing the real
# command. This shim is removable once the runner ships scripts itself.
#
# Safety: fixed source paths baked at build time, fixed destination inside
# the rw mount; `exec "$@"` hands control to the registry argv with no
# interpretation.
set -eu

mkdir -p /area/scripts
cp /opt/area/scripts/*.java /area/scripts/

exec "$@"
