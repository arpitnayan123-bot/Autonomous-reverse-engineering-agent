#!/bin/sh
# AREA angr runtime shim (image-internal; the runner still spawns argv-only).
#
# The runner bind-mounts the run work dir at /area (rw), which SHADOWS any
# image content under /area/scripts — but the registry entrypoint is
# `python3 /area/scripts/area_angr.py`. So the script baked at
# /opt/area/scripts/area_angr.py is materialized into the mounted work dir
# before exec'ing the real command. Removable once the runner ships the
# script itself.
#
# Safety: fixed source path baked at build time, fixed destination inside
# the rw mount; `exec "$@"` hands control to the registry argv with no
# interpretation.
set -eu

mkdir -p /area/scripts
cp /opt/area/scripts/area_angr.py /area/scripts/area_angr.py

exec "$@"
