# syntax=docker/dockerfile:1
###############################################################################
# AREA backend: NSA Ghidra headless — image tag area/ghidra:11
#
# Contract (src/server/retools/registry.ts, tool id "ghidra"):
#   the runner invokes the container as
#     <image> /opt/ghidra/support/analyzeHeadless <outDir> AreaProject \
#       -import /area/input -scriptPath /area/scripts \
#       -postScript <Area*.java> <outDir> -deleteProject
#   with posture: --rm --network none --read-only --tmpfs /tmp \
#     --memory 2g --cpus 2 -v <workDir>:/area:rw -w /area
#   <outDir> is /area (the mounted work dir); postscripts receive it as
#   args[0] and must write <args[0]>/out/{decompiled.c,disasm.txt,
#   functions.txt,info.txt} (the runner pre-creates <workDir>/out and
#   collects those paths as artifacts).
#
# NOTES
#  * Base is 21-JDK (not the 21-JRE first suggested): Ghidra compiles .java
#    postscripts at runtime with the JDK's JavaCompiler, which a JRE lacks.
#    Ghidra 11.3.x officially requires JDK 21.
#  * The stock analyzeHeadless hard-codes MAXMEM=2G; with the registry's
#    --memory 2g profile the JVM heap alone would fill the cgroup and get
#    OOM-killed, so the launcher is patched to 1536M in-image.
#  * Overriding eclipse-temurin's /__cacert_entrypoint.sh is intentional and
#    safe: CA certificates are provisioned at build time; our entry shim
#    execs the runner-provided argv unchanged (argv-transparent, no shell
#    interpretation of user input anywhere).
###############################################################################
FROM eclipse-temurin:21-jdk-jammy

ARG GHIDRA_VERSION=11.3.2
ARG GHIDRA_BUILD_ID=20250415
# sha256 of ghidra_11.3.2_PUBLIC_20250415.zip (verified at W1b authoring time)
ARG GHIDRA_SHA256=99d45035bdcc3d6627e7b1232b7b379905a9fad76c772c920602e2b5d8b2dac2

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip wget ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && wget -q -O /tmp/ghidra.zip \
      "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_BUILD_ID}.zip" \
 && echo "${GHIDRA_SHA256}  /tmp/ghidra.zip" | sha256sum -c - \
 && unzip -q /tmp/ghidra.zip -d /opt \
 && mv "/opt/ghidra_${GHIDRA_VERSION}_PUBLIC" /opt/ghidra \
 && rm -f /tmp/ghidra.zip \
 && sed -i 's/^MAXMEM=2G$/MAXMEM=1536M/' /opt/ghidra/support/analyzeHeadless

# The runner gives containers a READ-ONLY rootfs; only /tmp (tmpfs) and /area
# (bind, rw) are writable. Ghidra resolves and persists its JDK path and user
# settings under $HOME on first run, so HOME must live on the tmpfs.
ENV HOME=/tmp

# Postscripts are baked at /opt/area/scripts — deliberately NOT at /area/scripts,
# because the runner bind-mounts the work dir over /area and would shadow them.
# The entry shim materializes them into /area/scripts (the -scriptPath the
# registry argv passes) before exec'ing the registry command.
COPY scripts/ /opt/area/scripts/
COPY entry.sh /opt/area/entry.sh
RUN chmod +x /opt/area/entry.sh /opt/ghidra/support/analyzeHeadless

ENTRYPOINT ["/opt/area/entry.sh"]
