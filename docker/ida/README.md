# area/ida:latest — operator-supplied licensed image

**AREA never distributes IDA Pro or the Hex-Rays decompiler.** IDA is
proprietary software (Hex-Rays); shipping it — or any part of it — from this
repository or its images would violate its license. The `ida` entry in
`src/server/retools/registry.ts` is therefore a **license-required** profile:
it stays honestly unavailable until *you*, the operator, build an image from
*your own* licensed copy.

## What this directory is

`docker/ida/Dockerfile` is a deliberately minimal assembler:

- It contains **no IDA code, no download, no mirror** — only a `COPY` of a
  directory that must be provided at build time.
- If `docker/ida/installer/` is absent, the build **fails on purpose** at the
  `COPY installer/` step (`"/installer": not found`). That failure is the
  honest signal; there is no fallback image.
- `installer/` must never be committed. Keep it out of git (it is not in
  `.gitignore` scope of this directory by default — do not `git add` it).

## Required installer layout

```
docker/ida/installer/
├── idat            ← the headless binary; the registry entrypoint is /opt/ida/idat
├── <full ida install tree>   ← plugins, python, cfg, etc.
└── license/activation        ← IDA must run headless without prompting:
                                 pre-activate the install, or place your
                                 ida.hexlic / license file here
```

Build and verify:

```sh
docker build -t area/ida:latest docker/ida
docker run --rm --network none --read-only --tmpfs /tmp area/ida:latest /opt/ida/idat -?
```

## Runtime contract (once built)

`src/server/retools/registry.ts` (tool id `ida`) will discover the image via
`docker image inspect area/ida:latest` and run:

```
/opt/ida/idat -A -S"<script> <out>" /area/input
```

inside the standard AREA container posture (network disabled, read-only
rootfs, tmpfs `/tmp`, work dir bind-mounted rw at `/area`). Two things are
**your** responsibility as the operator:

1. The IDA IDC/IDAPython scripts referenced by the registry
   (`area_ida_decomp.py`, `area_ida_disasm.py`) are not shipped here — add them
   to the installer image or have the runner provide them (see the W1b
   worklog notes on `/area/scripts` and the input-copy gap).
2. A headless-valid license (IDA must not open any interactive dialog; `-A`
   suppresses dialogs but a missing license still fails).
