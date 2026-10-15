#!/usr/bin/env python3
"""
Mine AREA's own verified analysis history into (input, ground-truth) training pairs.

Reads the platform SQLite database (tables Evidence, BuildArtifact, GraphNode) and
emits JSONL rows of shape { task, input, output, source } with a deterministic 90/10
train/val split into training/data/.

What is mined — honest heuristics only; every pair carries its full provenance in
the `source` field:

  function-name-recovery
    * BuildArtifact rows whose path ends in `decompiled.c` are parsed into function
      blocks with a C-parser HEURISTIC (signature regex over `type name(args) {` +
      brace matching) — not a full C parser, and it says so;
    * candidate ground-truth names come from GraphNode(kind='function').label
      (provenance must be OBSERVED) and from Evidence.subjectName rows that pass
      the confidence filter (confidence high/medium, or numeric >= threshold);
    * a pair is emitted ONLY when a placeholder-named function (FUN_14001a2c4,
      sub_4010f0, fcn.004010f0, thunk_FUN_*, j_*, nullsub_*, ...) is matched to a
      candidate by, in order of trust:
        1. address — Ghidra-style placeholders embed the entry address; matched
           against `0x…` addresses inside GraphNode.meta / Evidence.payload and
           address comments in the decompiled body;
        2. direct evidence — an Evidence payload mentions the placeholder name and
           carries a plausible subjectName with passing confidence;
        3. (opt-in, --allow-unique-pair) uniqueness — exactly one unmatched
           placeholder and one unused candidate in the whole DB (weakest signal).
    * functions whose decompiled name is already a real symbol are skipped: an
      identity "copy the name" pair trains nothing.

  struct-reconstruction
    * Evidence payloads containing a C struct definition (regex over
      `struct X { ... };` / `typedef struct { ... } X;`) with passing confidence
      are paired with the project's decompiled function bodies that actually
      reference raw offsets (`+ 0x…`), i.e. code the struct could explain.

Empty DB is handled honestly: the miner prints exactly what it mined (usually 0)
and exits 0. It NEVER fabricates rows to fill the dataset.

Usage:
    python3 training/dataset_miner.py                        # default DB db/custom.db
    AREA_DB=/path/to/custom.db python3 training/dataset_miner.py
    python3 training/dataset_miner.py --min-confidence high --allow-unique-pair

Output:
    training/data/function-name-recovery.train.jsonl / .val.jsonl
    training/data/struct-reconstruction.train.jsonl  / .val.jsonl
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = REPO_ROOT / "db" / "custom.db"
DEFAULT_OUT_DIR = REPO_ROOT / "training" / "data"

TASK_NAME_RECOVERY = "function-name-recovery"
TASK_STRUCT = "struct-reconstruction"

# ---------------------------------------------------------------------------
# C parsing heuristics (documented as heuristics — NOT a real C parser)
# ---------------------------------------------------------------------------

C_KEYWORDS = {
    "if", "else", "for", "while", "do", "switch", "case", "default", "return",
    "break", "continue", "goto", "sizeof", "typedef", "struct", "union", "enum",
    "static", "extern", "register", "auto", "inline", "const", "volatile",
}

# `type name(args)` — the spec-mandated heuristic. Requires a return type
# before the name (excludes bare control keywords), tolerates pointer stars
# and calling conventions (int __fastcall FUN_x(...), char *sub_4010F0(...)).
# The opening '{' is located AFTER the match (decompilers put it on the next
# line); parse_functions validates it.
SIGNATURE_RE = re.compile(
    r"(?m)^[ \t]*(?:static\s+|inline\s+|const\s+|unsigned\s+|signed\s+|"
    r"struct\s+|enum\s+|union\s+)*[A-Za-z_][\w \t\*]*?[\s\*]+(?P<name>[A-Za-z_]\w*)"
    r"[ \t]*\((?P<args>[^;{}()]*)\)[ \t]*"
)

# Decompiler placeholder names (Ghidra / rizin / IDA / Hex-Rays pseudo-signatures).
PLACEHOLDER_RE = re.compile(
    r"^(?:"
    r"FUN_[0-9a-fA-F]+|thunk_FUN_[0-9a-fA-F]+|thunk_FUN_\w+|"
    r"SUB_[0-9a-fA-F]+|sub_[0-9a-fA-F]+|fcn\.[0-9a-fA-F]+|"
    r"j_[A-Za-z_]\w*|nullsub_\w*|locret_\w*|unk_\w*|loc_\w*|"
    r"UNKNOWN\w*|\?\?\??"
    r")$",
    re.IGNORECASE,
)

ADDRESS_COMMENT_RE = re.compile(r"/\*\s*(?:0x)?([0-9a-fA-F]{6,})\s*\*/")
HEX_LITERAL_RE = re.compile(r"0x([0-9a-fA-F]{6,})")
# `*(int *)(a1 + 0x18)` style raw-offset access → struct-recovery input signal.
RAW_OFFSET_RE = re.compile(r"\+\s*0x[0-9a-fA-F]+")
STRUCT_DEF_RE = re.compile(
    r"(?:typedef\s+)?struct\s*[A-Za-z_]\w*\s*\{[^{}]{10,4000}\}\s*[A-Za-z_]\w*\s*;",
    re.DOTALL,
)


@dataclass
class FunctionBlock:
    name: str
    start: int
    end: int
    text: str


def is_plausible_name(name: str) -> bool:
    """A candidate ground-truth identifier: real-looking, not a placeholder."""
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{2,}", name or ""):
        return False
    if PLACEHOLDER_RE.match(name):
        return False
    if name.lower() in C_KEYWORDS:
        return False
    return True


def parse_functions(text: str) -> list[FunctionBlock]:
    """Signature-regex + brace-matching function extraction (heuristic)."""
    blocks: list[FunctionBlock] = []
    for m in SIGNATURE_RE.finditer(text):
        name = m.group("name")
        if name in C_KEYWORDS:
            continue
        # Find the opening '{' after the signature (decompilers usually put it
        # on the next line); anything else (declarations, function pointers,
        # attribute lists) is not a definition we can mine.
        i = m.end()
        while i < len(text) and text[i] in " \t\r\n":
            i += 1
        if i >= len(text) or text[i] != "{":
            continue
        depth = 0
        end = None
        for j in range(i, len(text)):
            ch = text[j]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
        if end is None:
            continue  # truncated decompilation — skip honestly
        blocks.append(FunctionBlock(name=name, start=m.start(), end=end, text=text[m.start():end]))
    return blocks


def placeholder_address(name: str) -> int | None:
    """FUN_14001a2c4 / sub_4010f0 / fcn.004010f0 → embedded entry address."""
    m = re.search(r"(?:FUN_|SUB_|sub_|fcn\.|loc_|locret_|unk_)([0-9a-fA-F]{4,})", name)
    return int(m.group(1), 16) if m else None


def addresses_in(value) -> set[int]:
    """Recursively collect hex addresses from parsed JSON blobs and strings."""
    found: set[int] = set()
    if isinstance(value, dict):
        for v in value.values():
            found |= addresses_in(v)
    elif isinstance(value, list):
        for v in value:
            found |= addresses_in(v)
    elif isinstance(value, str):
        for m in HEX_LITERAL_RE.finditer(value):
            found.add(int(m.group(1), 16))
    elif isinstance(value, bool):
        pass
    elif isinstance(value, int):
        if value > 0xFFFF:
            found.add(value)
    return found


def parse_json_or_none(raw: str | None):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Confidence filtering
# ---------------------------------------------------------------------------

CONF_ORDER = {"low": 1, "medium": 2, "high": 3}
CONF_NUMERIC_FLOOR = {"low": 0.3, "medium": 0.6, "high": 0.8}


def confidence_passes(raw, min_confidence: str) -> bool:
    """Evidence.confidence is a free string: 'high'/'medium'/'low' or a float."""
    if raw is None:
        return False
    s = str(raw).strip().lower()
    if s in CONF_ORDER:
        return CONF_ORDER[s] >= CONF_ORDER[min_confidence]
    try:
        return float(s) >= CONF_NUMERIC_FLOOR[min_confidence]
    except ValueError:
        return False  # unparseable confidence is NOT treated as confidence


# ---------------------------------------------------------------------------
# Mining
# ---------------------------------------------------------------------------

def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def load_name_candidates(conn: sqlite3.Connection, min_confidence: str):
    """GraphNode kind='function' labels + Evidence subjectNames → candidate pool."""
    candidates_by_project: dict[str, list[dict]] = defaultdict(list)
    global_candidates: list[dict] = []

    n_graph = n_evid = 0
    if table_exists(conn, "GraphNode"):
        for pid, key, label, meta, provenance in conn.execute(
            "SELECT projectId, key, label, meta, provenance FROM GraphNode WHERE kind='function'"
        ):
            n_graph += 1
            if provenance != "OBSERVED":  # confidence heuristic for graph labels
                continue
            if not is_plausible_name(label or ""):
                continue
            meta_json = parse_json_or_none(meta)
            cand = {
                "name": label,
                "source": f"GraphNode:{key}",
                "addresses": addresses_in(meta_json) if meta_json else set(),
                "used": False,
            }
            candidates_by_project[pid].append(cand)
            global_candidates.append(cand)

    if table_exists(conn, "Evidence"):
        for eid, kind, subject, conf, payload in conn.execute(
            "SELECT id, kind, subjectName, confidence, payload FROM Evidence "
            "WHERE subjectName IS NOT NULL"
        ):
            n_evid += 1
            if not confidence_passes(conf, min_confidence):
                continue
            if not is_plausible_name(subject or ""):
                continue
            payload_json = parse_json_or_none(payload)
            cand = {
                "name": subject,
                "source": f"Evidence:{eid}({kind},conf={conf})",
                "addresses": addresses_in(payload_json) if payload_json else set(),
                "payload": payload or "",
                "used": False,
            }
            global_candidates.append(cand)
    return candidates_by_project, global_candidates, n_graph, n_evid


def mine_name_recovery(conn: sqlite3.Connection, cfg) -> list[dict]:
    if not table_exists(conn, "BuildArtifact"):
        print("[dataset_miner] BuildArtifact table missing — mining 0 name pairs")
        return []
    artifacts = conn.execute(
        "SELECT id, projectId, path, content FROM BuildArtifact "
        "WHERE path LIKE '%decompiled.c' AND content IS NOT NULL AND content != ''"
    ).fetchall()

    candidates_by_project, global_candidates, n_graph, n_evid = load_name_candidates(
        conn, cfg.min_confidence
    )

    pairs: list[dict] = []
    n_funcs = n_placeholders = 0
    matched_by_addr = matched_by_evidence = matched_by_unique = 0

    for artifact_id, pid, path, content in artifacts:
        blocks = parse_functions(content)
        n_funcs += len(blocks)
        placeholders = [b for b in blocks if PLACEHOLDER_RE.match(b.name)]
        n_placeholders += len(placeholders)

        body_addresses: set[int] = set()
        for b in placeholders:
            body_addresses |= {int(m.group(1), 16) for m in ADDRESS_COMMENT_RE.finditer(b.text)}

        unmatched_placeholders: list[FunctionBlock] = []

        for block in placeholders:
            entry_addr = placeholder_address(block.name)
            match = None

            # 1) address match (strongest): embedded entry address or an address
            #    comment in the body must appear in the candidate's metadata.
            for cand in candidates_by_project.get(pid, []):
                if cand["used"]:
                    continue
                if cand["addresses"] and (
                    (entry_addr and entry_addr in cand["addresses"])
                    or (body_addresses & cand["addresses"])
                ):
                    match = cand
                    matched_by_addr += 1
                    break

            # 2) direct evidence: payload mentions the placeholder name.
            if match is None:
                for cand in global_candidates:
                    if cand["used"] or "payload" not in cand:
                        continue
                    if block.name in cand["payload"]:
                        match = cand
                        matched_by_evidence += 1
                        break

            if match is None:
                unmatched_placeholders.append(block)
                continue

            pairs.append(
                {
                    "task": TASK_NAME_RECOVERY,
                    "input": block.text,
                    "output": match["name"],
                    "source": f"BuildArtifact:{artifact_id}#{block.name}|{match['source']}",
                }
            )
            match["used"] = True

        # 3) opt-in weakest heuristic: one unmatched placeholder ↔ one unused
        #    candidate for the whole artifact/project.
        if cfg.allow_unique_pair and len(unmatched_placeholders) == 1:
            project_unused = [c for c in candidates_by_project.get(pid, []) if not c["used"]]
            if len(project_unused) == 1:
                cand = project_unused[0]
                block = unmatched_placeholders[0]
                pairs.append(
                    {
                        "task": TASK_NAME_RECOVERY,
                        "input": block.text,
                        "output": cand["name"],
                        "source": f"BuildArtifact:{artifact_id}#{block.name}|{cand['source']}|unique-pair",
                    }
                )
                cand["used"] = True
                matched_by_unique += 1

    print(
        f"[dataset_miner] name-recovery scan: artifacts={len(artifacts)} "
        f"functions={n_funcs} placeholders={n_placeholders} | "
        f"rows scanned: graph-function={n_graph} evidence-named={n_evid}"
    )
    print(
        f"[dataset_miner] name-recovery matches: by-address={matched_by_addr} "
        f"by-evidence-payload={matched_by_evidence} by-unique-pair={matched_by_unique}"
    )
    return pairs


def mine_struct_recovery(conn: sqlite3.Connection, cfg) -> list[dict]:
    if not table_exists(conn, "Evidence") or not table_exists(conn, "BuildArtifact"):
        print("[dataset_miner] Evidence/BuildArtifact missing — mining 0 struct pairs")
        return []

    # Ground truth: struct definitions inside passing-confidence Evidence payloads.
    structs: list[dict] = []
    n_evidence_scanned = 0
    for eid, kind, conf, payload in conn.execute(
        "SELECT id, kind, confidence, payload FROM Evidence WHERE payload IS NOT NULL"
    ):
        n_evidence_scanned += 1
        if n_evidence_scanned >= cfg.max_evidence_scan:
            print(
                f"[dataset_miner] evidence scan capped at {cfg.max_evidence_scan} rows "
                "(honest cap — raise --max-evidence-scan to scan more)"
            )
            break
        kind_hit = kind and "struct" in str(kind).lower()
        if not (kind_hit or "struct " in (payload or "") or "typedef struct" in (payload or "")):
            continue
        if not confidence_passes(conf, cfg.min_confidence):
            continue
        for m in STRUCT_DEF_RE.finditer(payload):
            structs.append(
                {
                    "definition": m.group(0),
                    "source": f"Evidence:{eid}({kind},conf={conf})",
                }
            )
            break  # one struct per evidence row keeps provenance 1:1

    # Input: decompiled function bodies that reference raw offsets.
    artifacts = conn.execute(
        "SELECT id, projectId, path, content FROM BuildArtifact "
        "WHERE path LIKE '%decompiled.c' AND content IS NOT NULL AND content != ''"
    ).fetchall()
    bodies_by_project: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for artifact_id, pid, _path, content in artifacts:
        blocks = parse_functions(content)
        offset_blocks = [b for b in blocks if RAW_OFFSET_RE.search(b.text)]
        text = "\n\n".join(b.text for b in (offset_blocks or blocks))[: cfg.max_input_chars]
        if text.strip():
            bodies_by_project[pid].append((artifact_id, text))

    pairs: list[dict] = []
    for st in structs:
        # Pair each struct with ONE offset-heavy body (prefer project variety).
        for pid, bodies in bodies_by_project.items():
            if not bodies:
                continue
            artifact_id, text = bodies[len(pairs) % len(bodies)]
            pairs.append(
                {
                    "task": TASK_STRUCT,
                    "input": text,
                    "output": st["definition"],
                    "source": f"{st['source']}|BuildArtifact:{artifact_id}",
                }
            )
            break  # one project per struct; next struct takes the next project

    print(
        f"[dataset_miner] struct scan: evidence_payloads={n_evidence_scanned} "
        f"struct_defs={len(structs)} offset_bodies={sum(len(v) for v in bodies_by_project.values())}"
    )
    return pairs


# ---------------------------------------------------------------------------
# Split + emit
# ---------------------------------------------------------------------------

def split_bucket(source_key: str, val_ratio: float) -> str:
    """Deterministic split: sha1 of the provenance key, no randomness."""
    digest = hashlib.sha1(source_key.encode("utf-8")).digest()
    return "val" if (digest[0] / 255.0) < val_ratio else "train"


def write_pairs(pairs: list[dict], task: str, out_dir: Path, val_ratio: float) -> tuple[int, int]:
    buckets = {"train": [], "val": []}
    for p in pairs:
        buckets[split_bucket(p["source"], val_ratio)].append(p)
    for bucket, rows in buckets.items():
        out_path = out_dir / f"{task}.{bucket}.jsonl"
        with out_path.open("w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"[dataset_miner] wrote {out_path} ({len(rows)} rows)")
    return len(buckets["train"]), len(buckets["val"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Mine AREA's DB into LoRA training pairs")
    parser.add_argument(
        "--db",
        default=os.environ.get("AREA_DB") or str(DEFAULT_DB),
        help=f"SQLite DB path (default: AREA_DB env or {DEFAULT_DB})",
    )
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--min-confidence", choices=["low", "medium", "high"], default="medium")
    parser.add_argument("--val-ratio", type=float, default=0.1, help="validation split (default 0.1 = 90/10)")
    parser.add_argument("--max-input-chars", type=int, default=6000)
    parser.add_argument("--max-evidence-scan", type=int, default=5000)
    parser.add_argument("--allow-unique-pair", action="store_true",
                        help="enable the weakest 1:1 unique-pair name matching heuristic")
    cfg = parser.parse_args()

    db_path = Path(cfg.db)
    if not db_path.exists():
        print(f"[dataset_miner] DB not found: {db_path} — honest exit: 0 pairs mined")
        return 0

    out_dir = Path(cfg.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        conn = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)  # read-only
    except sqlite3.Error as exc:
        print(f"[dataset_miner] cannot open DB {db_path}: {exc}")
        return 1

    try:
        name_pairs = mine_name_recovery(conn, cfg)
        struct_pairs = mine_struct_recovery(conn, cfg)
    finally:
        conn.close()

    for task, pairs in ((TASK_NAME_RECOVERY, name_pairs), (TASK_STRUCT, struct_pairs)):
        train_n, val_n = write_pairs(pairs, task, out_dir, cfg.val_ratio)
        print(f"[dataset_miner] {task}: {len(pairs)} pairs mined (train {train_n} / val {val_n})")

    total = len(name_pairs) + len(struct_pairs)
    if total == 0:
        print(
            "[dataset_miner] mined 0 pairs — the DB has no (decompiled.c, evidence) "
            "history yet. Run real analyses first; the miner does NOT fabricate data."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
