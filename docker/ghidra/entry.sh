#!/bin/sh
# REA Ghidra runtime shim (image-internal; the runner still spawns argv-only).
#
# The runner bind-mounts the run work dir at /rea (rw), which SHADOWS any
# image content under /rea/scripts — but the registry argv passes
# `-scriptPath /rea/scripts`. So the postscripts baked at /opt/rea/scripts
# are materialized into the mounted work dir before exec'ing the real
# command. This shim is removable once the runner ships scripts itself.
#
# Safety: fixed source paths baked at build time, fixed destination inside
# the rw mount; `exec "$@"` hands control to the registry argv with no
# interpretation.
set -eu

mkdir -p /rea/scripts
cp /opt/rea/scripts/*.java /rea/scripts/

exec "$@"
