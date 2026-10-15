# area/hopper:latest — operator-supplied licensed image

**AREA never distributes Hopper Disassembler.** Hopper is proprietary software
(Cryptic Apps SARL); redistributing it from this repository or its images
would violate its license. The `hopper` entry in
`src/server/retools/registry.ts` is therefore a **license-required
placeholder**: every operation refuses verbatim ("hopper session scripting is
not configured — provide docker/hopper") until *you*, the operator, build an
image from *your own* licensed copy **and wire the session scripting**.

## What this directory is

`docker/hopper/Dockerfile` is a deliberately minimal assembler:

- It contains **no Hopper code, no download, no mirror** — only a `COPY` of a
  directory that must be provided at build time.
- If `docker/hopper/installer/` is absent, the build **fails on purpose** at
  the `COPY installer/` step (`"/installer": not found`). That failure is the
  honest signal; there is no fallback image.
- `installer/` must never be committed.

## Required installer layout

```
docker/hopper/installer/
└── hopper    ← the licensed Linux Hopper binary (registry entrypoint
                /opt/hopper/hopper resolves to /opt/hopper/ + installer root)
```

Build:

```sh
docker build -t area/hopper:latest docker/hopper
```

## Scripting requirement (why this is a placeholder in the registry)

The registry's `hopper` profile throws for every operation because Hopper has
no stable headless CLI equivalent to Ghidra's `analyzeHeadless`. To activate
the tool you must ship a scriptable driver inside this image (e.g. a wrapper
that drives Hopper's Python/SDK API or `hopper --execute-script`) and adjust
the registry operations to match — that change lives in
`src/server/retools/registry.ts` and belongs to whoever owns the license.
Until then the profile stays an honest placeholder, and `toolsForFile()`
never routes anything to hopper.
