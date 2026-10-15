# REA RE-tool backends (`docker/`)

Dockerized backends for the classical RE toolchain (Capability C1,
`docs/ARCHITECTURE.md` §C1). Each tool lives in `docker/<tool>/`, is built
into a tagged image, and is discovered at runtime by the registry/runner in
`src/server/retools/` — nothing here is invoked directly by the platform.

## Image matrix

| Image tag | Provides | Registry tool ids | Build command | Resource profile (from `registry.ts`) |
|---|---|---|---|---|
| `rea/ghidra:11` | NSA Ghidra headless (`analyzeHeadless`) + REA postscripts (`decompile`, `disassemble`, `functions`, `info`) | `ghidra` | `docker build -t rea/ghidra:11 docker/ghidra` | 2 GB, 2 CPUs, 480 s |
| `rea/rizin:latest` | rizin + `rz-bin` (source build); `pdg` decompiler via best-effort r2ghidra plugin build | `rizin` | `docker build -t rea/rizin:latest docker/rizin` | 1 GB, 1 CPU, 180 s |
| `rea/pycdc:latest` | `pycdc` (bytecode → Python) + `pycdas` (bytecode disassembler) | `pycdc`, `pycdas` | `docker build -t rea/pycdc:latest docker/pycdc` | 512 MB, 1 CPU, 60 s |
| `rea/angr:latest` | angr + `rea_angr.py` (`symbolic`, bounded; `info` via CFGFast) | `angr` | `docker build -t rea/angr:latest docker/angr` | 2 GB, 2 CPUs, 420 s |
| `rea/ida:latest` | **operator-supplied licensed IDA** (`idat`) — build refuses without `docker/ida/installer/` | `ida` | `docker build -t rea/ida:latest docker/ida` | 2 GB, 2 CPUs, 480 s |
| `rea/hopper:latest` | **operator-supplied licensed Hopper** — build refuses without `docker/hopper/installer/` | `hopper` | `docker build -t rea/hopper:latest docker/hopper` | 2 GB, 1 CPU, 300 s |

Build everything buildable in one shot:

```sh
docker compose -f docker/docker-compose.yml --profile retools build
```

`ida`/`hopper` are deliberately excluded from the compose profile: their
Dockerfiles refuse to build without the operator's licensed installer
(see `docker/ida/README.md`, `docker/hopper/README.md`). **REA never
distributes licensed software.**

## How the runner discovers images

`src/server/retools/runner.ts` resolves availability in this order:

1. **docker** — probes `docker` then `podman` (`<runtime> version --format
   {{.Server.Version}}`), then checks the exact tag with
   `docker image inspect <tag> --format ok` (i.e. *any* image under that tag
   counts, including the operator-built `rea/ida:latest`).
2. **local** — if the image is absent, the tool's `localBinaries` are probed
   on PATH (`which`).
3. **unavailable** — otherwise an honest error containing the exact
   `docker build …` command from the table above.

## Runtime contract (enforced by the runner)

Every container run is spawned argv-only (no shell, either side):

```
<runtime> run --rm --network none --read-only --tmpfs /tmp \
  --memory <profile.memory> --cpus <profile.cpus> \
  -v <workDir>:/rea:rw -w /rea \
  <image> <registry entrypoint…> <operation argv…>
```

- **Inputs arrive at `/rea/input`** (the runner materializes the input inside
  the work dir that is bind-mounted at `/rea`).
- **Outputs must be written under the mounted work dir `/rea`** (bound rw) —
  the runner pre-creates `/rea/out` and collects the tool's `outputPaths`
  (`out/decompiled.c`, `out/disasm.txt`, `out/functions.txt`, `out/info.txt`,
  `out/symbolic.txt`, `out/decompiled.py`) relative to `/rea`.
- **Network is disabled** (`--network none`) — no RE tool profile declares
  network access (platform invariant 3).
- **Rootfs is read-only** (`--read-only`); only `/tmp` (tmpfs), `/rea` (bind
  rw) are writable. That is why the images set `HOME=/tmp` (Ghidra user
  settings, angr/pip state) and why the ghidra/angr images keep their
  baked-in scripts at `/opt/rea/scripts`.
- **`/tmp` is tmpfs** — scratch space only, never collected as artifacts.
- Memory/CPU/timeout come from the per-tool profile in `registry.ts` (the
  analysis postures are deliberately *not* the 512 MB workspace-sandbox
  posture — these are analysis workloads).

### Why the ghidra/angr images have an `entry.sh`

The runner bind-mounts the work dir over `/rea`, which **shadows** any image
content at `/rea/scripts` — but the registry argv passes `-scriptPath
/rea/scripts` (Ghidra) and `python3 /rea/scripts/rea_angr.py` (angr). The
images therefore bake their scripts at `/opt/rea/scripts/` and a tiny
argv-transparent `entry.sh` materializes them into `/rea/scripts/` before
`exec "$@"` runs the registry command. Both shims are removable once the
runner ships scripts into the work dir itself.

## Known contract gaps found while authoring W1b (honest report)

These were verified against `runner.ts`/`registry.ts` and the upstream tool
sources; **no docker image can bridge them** — they need a runner/registry
fix (tracked in `worklog.md`, task W1b):

1. **The runner never copies the input into the work dir.** The comment in
   `runner.ts` says "input copied in", but no copy exists — so docker-mode
   runs see no `/rea/input` at all, and every tool's `-import`/positional
   input path dangles. One-line fix on the runner side (copy the input to
   `<workDir>/input` next to the existing `mkdir out`).
2. **`pycdc` decompile argv passes a directory to `-o`.** Verified against
   pycdc's `pycdc.cpp`: `-o` is an output **file** (default stdout), so
   `pycdc /rea/input -o /rea/out` fails with "Error opening file for
   writing". The registry should pass `-o <outPath>/out/decompiled.py`
   (which then also matches `outputPaths`).
3. **`rizin` operations open no binary and misuse `pdg`.** All four rizin
   operations build `-q -c "<cmds>"` with **no positional file argument**, so
   `aaa`/`afl`/`iI`/`pD` run against an empty session; and
   `pdg <inputPath>` passes a file path where `pdg` expects an address.
   Correct shape: `["-q", "-c", "aaa; pdg > <out>/out/decompiled.c",
   <inputPath>]` (input last; `iI` needs no `aaa`).
4. Verified-correct parts: `pycdas -o <file> <input>` matches pycdas
   semantics exactly, and Ghidra's postscript contract (args[0] = output dir;
   write into `args[0]/out/`) is implemented by the `Rea*.java` scripts.

## Reproducibility notes

- Ghidra is pinned: `ghidra_11.3.2_PUBLIC_20250415.zip`,
  sha256 `99d45035bdcc3d6627e7b1232b7b379905a9fad76c772c920602e2b5d8b2dac2`
  (verified at authoring time). Ghidra 11.3.x requires JDK 21, which is why
  the base image is `eclipse-temurin:21-jdk-jammy` (a JRE cannot compile the
  `.java` postscripts at runtime). The stock `analyzeHeadless` hard-codes
  `MAXMEM=2G`; the image patches it to `1536M` so the JVM fits inside the
  registry's 2 GB container profile.
- rizin/pycdc build from depth-1 clones of upstream default branches per the
  W1b spec; pass `--build-arg RIZIN_REF=` / `--build-arg PYCDC_REF=` (tag or
  SHA) for pinned rebuilds. angr accepts `--build-arg ANGR_SPEC=angr==9.2.x`.
- For production, pin base images by digest and record the resulting image
  digests in the operations runbook — image *presence* under the tag is the
  only thing the runner checks (`docker image inspect`).
