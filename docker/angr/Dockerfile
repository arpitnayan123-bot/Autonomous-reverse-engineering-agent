# syntax=docker/dockerfile:1
###############################################################################
# AREA backend: angr — image tag area/angr:latest
#
# Contract (src/server/retools/registry.ts, tool id "angr"):
#   the runner invokes the container as
#     <image> python3 /area/scripts/area_angr.py <input> --out <out>/out/symbolic.txt
#     <image> python3 /area/scripts/area_angr.py <input> --out <out>/out/info.txt --info-only
#   with posture: --rm --network none --read-only --tmpfs /tmp \
#     --memory 2g --cpus 2 -v <workDir>:/area:rw -w /area
#
# /area/scripts/area_angr.py MUST exist at that exact path at runtime, but the
# runner's rw bind mount over /area would shadow a baked-in copy — so the
# script is baked at /opt/area/scripts/ and the entry shim (argv-transparent,
# `exec "$@"`) copies it into the mounted work dir before the real command
# runs. Removable once the runner ships the script itself.
#
# `pip install angr` tracks the latest release (per the W1b spec). For a
# reproducible image pass a pip spec via `--build-arg ANGR_SPEC=angr==9.2.136`.
###############################################################################
FROM python:3.11-slim

ARG ANGR_SPEC="angr"

RUN pip install --no-cache-dir ${ANGR_SPEC} \
 && python3 -c "import angr; print('angr', angr.__version__)"

COPY scripts/area_angr.py /opt/area/scripts/area_angr.py
COPY entry.sh /opt/area/entry.sh
RUN chmod +x /opt/area/entry.sh

# Read-only rootfs posture: keep all writable state on the tmpfs (/tmp).
# PYTHONDONTWRITEBYTECODE avoids __pycache__ writes into the read-only
# site-packages; PYTHONUNBUFFERED keeps stdout/stderr streaming for the runner.
ENV HOME=/tmp \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

ENTRYPOINT ["/opt/area/entry.sh"]
