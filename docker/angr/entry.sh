#!/bin/sh
# REA angr runtime shim (image-internal; the runner still spawns argv-only).
#
# The runner bind-mounts the run work dir at /rea (rw), which SHADOWS any
# image content under /rea/scripts — but the registry entrypoint is
# `python3 /rea/scripts/rea_angr.py`. So the script baked at
# /opt/rea/scripts/rea_angr.py is materialized into the mounted work dir
# before exec'ing the real command. Removable once the runner ships the
# script itself.
#
# Safety: fixed source path baked at build time, fixed destination inside
# the rw mount; `exec "$@"` hands control to the registry argv with no
# interpretation.
set -eu

mkdir -p /rea/scripts
cp /opt/rea/scripts/rea_angr.py /rea/scripts/rea_angr.py

exec "$@"
