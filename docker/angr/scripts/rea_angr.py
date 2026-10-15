#!/usr/bin/env python3
"""REA angr backend script (Capability C1 — docs/ARCHITECTURE.md §C1).

Contract (src/server/retools/registry.ts, tool id "angr", image rea/angr:latest):

    symbolic:  python3 rea_angr.py <binary> --out <out>/out/symbolic.txt
    info:      python3 rea_angr.py <binary> --out <out>/out/info.txt --info-only

The runner invokes the container as
    python3 /rea/scripts/rea_angr.py /rea/input --out /rea/out/<report> [--info-only]
(read-only rootfs, network disabled, 2 GB / 2 CPUs, 420 s wall clock; the
profile timeout in the runner is the hard outer bound).

``--out`` accepts either a FILE path (what the registry passes) or a DIRECTORY
(the default report name is then appended). Exit code 0 on success, 1 on
failure; errors go to stderr and are never fabricated away — an analysis that
could not run says so.

Everything is argv-parsed; there is no shell execution and no network use.
Execution is bounded: CFGFast for control-flow recovery plus a hard step cap
(STEP_CAP) and a state-explosion guard (MAX_ACTIVE_STATES) on symbolic
exploration. Reports are deterministic: no timestamps, no randomness in
output formatting.
"""

from __future__ import annotations

import argparse
import os
import re
import sys

STEP_CAP = 512  # symbolic steps (basic-block level) — bounded exploration
MAX_ACTIVE_STATES = 64  # state-explosion guard; excess states are parked, counted
MAX_FOUND_REPORTED = 5  # concrete-input dumps written for the first N found states
MAX_STDIN_DUMP_BYTES = 256  # per-state stdin dump cap in the report

# Name heuristics for the find/avoid policy (applied to function/symbol names
# only; matches are reported verbatim in the output so the evidence is
# inspectable). No match means the policy degrades to avoid-only — stated.
SUCCESS_NAME_RE = re.compile(r"win|success|correct|good|granted|unlock|authoriz", re.IGNORECASE)
ABORT_NAME_RE = re.compile(r"abort|fail|denied|forbid|invalid|wrong|error", re.IGNORECASE)


def resolve_out_path(value: str, default_name: str) -> str:
    """Registry mode passes a file path; a directory gets the default name."""
    if os.path.isdir(value) or value.endswith(("/", os.sep)):
        return os.path.join(value, default_name)
    return value


def ensure_parent_dir(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="rea_angr.py",
        description="REA angr backend: bounded symbolic exploration and binary info.",
    )
    parser.add_argument("binary", help="path of the binary to analyze")
    parser.add_argument(
        "--out",
        required=True,
        help="report destination: a file path, or a directory (default report name appended)",
    )
    parser.add_argument(
        "--info-only",
        action="store_true",
        help="write project info only (arch, entry, CFGFast function count); skip exploration",
    )
    return parser.parse_args(argv)


def load_project(angr, binary_path: str):
    return angr.Project(binary_path, auto_load_libs=False)


def collect_policy(cfg) -> tuple[list[int], list[int], list[str]]:
    """Build find/avoid address sets from recovered function names (honest
    name heuristics only). Returns (find_addrs, avoid_addrs, notes)."""
    find_addrs: list[int] = []
    avoid_addrs: list[int] = []
    notes: list[str] = []
    seen: set[int] = set()

    funcs: list = []
    try:
        funcs = list(cfg.kb.functions.values())
    except Exception:
        try:
            funcs = list(cfg.functions.values())  # older angr fallback
        except Exception:
            funcs = []

    for func in funcs:
        addr = getattr(func, "addr", None)
        name = getattr(func, "name", "") or ""
        if addr is None or addr in seen:
            continue
        seen.add(addr)
        if func.is_simproc:  # SimProcedures are angr models, not binary code
            continue
        if SUCCESS_NAME_RE.search(name):
            find_addrs.append(addr)
        elif ABORT_NAME_RE.search(name):
            avoid_addrs.append(addr)

    if find_addrs:
        notes.append(
            "find policy: %d success-named function(s) (heuristic: %s)" % (len(find_addrs), SUCCESS_NAME_RE.pattern)
        )
    else:
        notes.append(
            "find policy: no success-named symbols identified — exploration is avoid-only; "
            "stash counts are the result (nothing was assumed)"
        )
    if avoid_addrs:
        notes.append(
            "avoid policy: %d abort/fail-named function(s) (heuristic: %s)" % (len(avoid_addrs), ABORT_NAME_RE.pattern)
        )
    else:
        notes.append("avoid policy: no abort/fail-named symbols identified — nothing avoided")
    return find_addrs, avoid_addrs, notes


def cfg_summary(cfg, limit: int = 20) -> tuple[int, list[str]]:
    try:
        funcs = list(cfg.kb.functions.values())
    except Exception:
        try:
            funcs = list(cfg.functions.values())
        except Exception:
            funcs = []
    named = sorted({f.name for f in funcs if getattr(f, "name", "") and not f.name.startswith("sub_")})
    return len(funcs), named[:limit]


def describe_project(proj) -> list[str]:
    obj = proj.loader.main_object
    lines = [
        "arch: %s (%d-bit, %s)" % (proj.arch.name, proj.arch.bits, proj.arch.memory_endness),
        "entry-point: 0x%x" % proj.entry,
        "binary-type: %s" % obj.binary,
        "position-independent: %s" % ("yes" if getattr(obj, "pic", False) else "no"),
        "libs-loaded: none (auto_load_libs=False)",
    ]
    return lines


def write_info_report(proj, out_path: str) -> None:
    lines: list[str] = ["# REA angr project info", ""]
    lines.extend(describe_project(proj))
    lines.append("")
    lines.append("# CFG recovery (CFGFast, bounded by the runner profile)")
    try:
        cfg = proj.analyses.CFGFast(show_progressbar=False)
        count, named = cfg_summary(cfg)
        lines.append("functions-recovered: %d" % count)
        lines.append("named-functions (first %d): %s" % (len(named), ", ".join(named) if named else "(none)"))
    except Exception as exc:  # CFGFast failure is reported, never fabricated
        lines.append("functions-recovered: CFGFast failed: %s" % exc)
    write_report(out_path, lines)


def write_symbolic_report(proj, out_path: str) -> None:
    import angr  # local import: arg/IO errors exit before the heavy import

    lines: list[str] = ["# REA angr symbolic exploration report", ""]
    lines.extend(describe_project(proj))
    lines.append("step-cap: %d (basic-block steps)" % STEP_CAP)
    lines.append("state-cap: %d active states (excess parked in 'overflow' stash, counted)" % MAX_ACTIVE_STATES)
    lines.append("")

    cfg = proj.analyses.CFGFast(show_progressbar=False)
    func_count, named = cfg_summary(cfg)
    find_addrs, avoid_addrs, notes = collect_policy(cfg)
    lines.append("functions-recovered: %d" % func_count)
    if named:
        lines.append("named-functions (first %d): %s" % (len(named), ", ".join(named)))
    lines.append("")
    lines.extend("- " + n for n in notes)
    lines.append("")

    state = proj.factory.entry_state()
    simgr = proj.factory.simgr(state)

    if find_addrs or avoid_addrs:
        explorer = angr.exploration_techniques.Explorer(
            find=find_addrs or None, avoid=avoid_addrs or None
        )
        simgr.use_technique(explorer)

    steps_executed = 0
    for _ in range(STEP_CAP):
        if not simgr.active:
            break
        if len(simgr.active) > MAX_ACTIVE_STATES:
            # State-explosion guard: park excess states, keep exploring the rest.
            simgr.stashes["overflow"] = simgr.stashes.get("overflow", []) + simgr.active[MAX_ACTIVE_STATES:]
            simgr.stashes["active"] = simgr.active[:MAX_ACTIVE_STATES]
        simgr.step()
        steps_executed += 1
        if simgr.found:
            break

    lines.append("# exploration result (bounded: %d of %d steps executed)" % (steps_executed, STEP_CAP))
    for stash in ("found", "avoided", "active", "deadended", "unconstrained", "overflow", "errored"):
        states = simgr.stashes.get(stash, [])
        if states:
            lines.append("stash %s: %d state(s)" % (stash, len(states)))
    lines.append("")

    found_states = simgr.stashes.get("found", [])
    if found_states:
        lines.append("# concrete inputs reaching 'found' states (first %d, stdin capped at %d bytes)" % (
            MAX_FOUND_REPORTED, MAX_STDIN_DUMP_BYTES))
        for idx, st in enumerate(found_states[:MAX_FOUND_REPORTED]):
            lines.append("found-state %d: address 0x%x" % (idx, st.addr))
            try:
                argv_bytes = [a for a in st.posix.argv if a is not None]
                lines.append("  argv: %s" % (repr(argv_bytes),))
            except Exception as exc:
                lines.append("  argv: unavailable (%s)" % exc)
            try:
                stdin = st.posix.dumps(0)[:MAX_STDIN_DUMP_BYTES]
                lines.append("  stdin: %s" % (stdin.hex() or "(empty)"))
            except Exception as exc:
                lines.append("  stdin: unavailable (%s)" % exc)
    else:
        lines.append("# no states reached the 'find' targets within the step cap")
        lines.append(
            "# (this is an observed outcome of the bounded policy — not a proof of unreachability)"
        )
    write_report(out_path, lines)


def write_report(out_path: str, lines: list[str]) -> None:
    ensure_parent_dir(out_path)
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines).rstrip() + "\n")


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    if not os.path.isfile(args.binary):
        print("Error: binary not found: %s" % args.binary, file=sys.stderr)
        return 1

    default_name = "info.txt" if args.info_only else "symbolic.txt"
    out_path = resolve_out_path(args.out, default_name)

    try:
        import angr
    except ImportError as exc:
        print("Error: angr is not importable in this environment: %s" % exc, file=sys.stderr)
        return 1

    try:
        proj = load_project(angr, args.binary)
    except Exception as exc:
        print("Error: angr could not load '%s': %s" % (args.binary, exc), file=sys.stderr)
        return 1

    try:
        if args.info_only:
            write_info_report(proj, out_path)
        else:
            write_symbolic_report(proj, out_path)
    except Exception as exc:
        print("Error: analysis of '%s' failed: %s" % (args.binary, exc), file=sys.stderr)
        return 1

    print("rea_angr: wrote %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
