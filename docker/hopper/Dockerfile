# syntax=docker/dockerfile:1
###############################################################################
# rea/hopper:latest — REFUSES TO BUILD WITHOUT THE OPERATOR'S LICENSED INSTALLER
#
# REA NEVER DISTRIBUTES HOPPER DISASSEMBLER (proprietary software, Cryptic
# Apps SARL). This Dockerfile only ASSEMBLES an image from files the operator
# places here — they are never committed to this repository:
#
#   docker/hopper/installer/
#     └── hopper                    ← the licensed Linux Hopper binary (the
#                                      registry entrypoint is /opt/hopper/hopper)
#
# Build:
#   docker build -t rea/hopper:latest docker/hopper
#
# If docker/hopper/installer/ is absent, the build fails ON PURPOSE at the
# COPY below with:
#     failed to compute cache key: ... "/installer": not found
# That error means "no licensed installer was provided" — nothing is missing
# in REA itself, and no fallback image exists by design. Until then the
# registry reports hopper as a placeholder profile with its verbatim license
# note ("hopper session scripting is not configured — provide docker/hopper").
#
# NOTE the registry also expects session scripting to be wired by whoever
# builds this image (see README.md) — a bare Hopper binary alone does not
# satisfy the decompile/disassemble operations.
###############################################################################
FROM scratch

COPY installer/ /opt/hopper/

LABEL org.opencontainers.image.title="rea/hopper (operator-supplied licensed build)" \
      org.opencontainers.image.description="Assembled only when the operator supplies a licensed Hopper installer under docker/hopper/installer/. REA never distributes Hopper." \
      org.opencontainers.image.source="https://github.com/arpitnayan123/reverse-engineering-agent"
