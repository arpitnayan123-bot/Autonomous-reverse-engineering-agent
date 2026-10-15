# syntax=docker/dockerfile:1
###############################################################################
# area/ida:latest — REFUSES TO BUILD WITHOUT THE OPERATOR'S LICENSED INSTALLER
#
# AREA NEVER DISTRIBUTES IDA PRO OR THE HEX-RAYS DECOMPILER (proprietary
# software). This Dockerfile only ASSEMBLES an image from files that the
# operator places here — they are never committed to this repository:
#
#   docker/ida/installer/
#     ├── idat                      ← headless IDA binary (registry entrypoint)
#     ├── ...                       ← the rest of your licensed install
#     └── (license must be pre-activated or included here — see README.md)
#
# Build:
#   docker build -t area/ida:latest docker/ida
#
# If docker/ida/installer/ is absent, the build fails ON PURPOSE at the COPY
# below with:
#     failed to compute cache key: ... "/installer": not found
# That error means "no licensed installer was provided" — nothing is missing
# in AREA itself, and no fallback image exists by design. Until then the
# registry reports ida as unavailable with its verbatim license note.
#
# Runtime contract after a successful operator build (registry.ts, id "ida"):
#   entrypoint: /opt/ida/idat   → installer root must contain `idat`
#   argv: -A -S"/area/scripts/area_ida_decomp.py <out>" /area/input  (see registry)
#   posture: --rm --network none --read-only --tmpfs /tmp -v <work>:/area:rw -w /area
# NOTE the registry's -S scripts under /area/scripts must exist inside the
# mounted work dir or be added to installer/ (this is an operator concern;
# see the W1b worklog: the runner currently provides neither the input copy
# nor those scripts).
###############################################################################
FROM scratch

COPY installer/ /opt/ida/

LABEL org.opencontainers.image.title="area/ida (operator-supplied licensed build)" \
      org.opencontainers.image.description="Assembled only when the operator supplies a licensed IDA installer under docker/ida/installer/. AREA never distributes IDA." \
      org.opencontainers.image.source="https://github.com/arpitnayan123/reverse-engineering-agent"
