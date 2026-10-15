#!/usr/bin/env python3
"""
DecompileBench-style eval harness for REA's specialized RE models.

Loads a DecompileBench-style JSONL ({ task, input, expected, [source] }), runs
inference against EITHER
  - an OpenAI-compatible endpoint (--endpoint http://gpu-host:8000/v1/chat/completions),
or
  - the REA platform LLM through the model registry chain (POST REA_URL/api/models
    with {"action":"suggest","task":...,"payload":...} — requires a session cookie,
    obtained by logging in via /api/auth/login with REA_EMAIL/REA_PASSWORD, exactly
    the convention of scripts/mcp-token.ts),
and scores FUNCTION NAME RECOVERY with exact-match + token-F1 (identifier-aware
tokenization: snake_case / camelCase splits). Other tasks are listed and checked
for non-empty output but are NOT numerically scored here.

If no dataset is configured, a tiny SYNTHETIC fixture is generated locally and
clearly announced — those numbers are smoke-test numbers, not benchmark results.

With --publish the aggregate is POSTed to REA_URL/api/leaderboard as provenance
OBSERVED with an explicit methodology string (what was measured, on what, with
which metric; synthetic fixtures are flagged in the methodology itself).

Usage:
    DECOMPILEBENCH_PATH=bench.jsonl python3 training/eval_decompilebench.py \
        --endpoint http://gpu-host:8000/v1/chat/completions
    REA_EMAIL=you@example.com REA_PASSWORD='…' python3 training/eval_decompilebench.py --publish
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_lora import PROMPTS, TASKS  # noqa: E402  (same-directory import)

REA_URL = os.environ.get("REA_URL", "http://127.0.0.1:3000").rstrip("/")
DEFAULT_FIXTURE = REPO_ROOT / "training" / "data" / "decompilebench-synthetic.jsonl"
DEFAULT_REPORT_DIR = REPO_ROOT / "training" / "out"

NAME_TASK = "function-name-recovery"

# ---------------------------------------------------------------------------
# Synthetic fixture (used ONLY when no dataset is configured — announced loudly)
# ---------------------------------------------------------------------------

SYNTHETIC_FIXTURE = [
    {
        "task": NAME_TASK,
        "input": (
            "int FUN_00401a20(unsigned char *a1, unsigned char *a2)\n{\n"
            "  int i;\n"
            "  for ( i = 0; a1[i] && a2[i]; ++i )\n"
            "    if ( a1[i] != a2[i] )\n"
            "      return 0;\n"
            "  return a1[i] == a2[i];\n}"
        ),
        "expected": "strings_equal",
        "source": "synthetic-fixture",
    },
    {
        "task": NAME_TASK,
        "input": (
            "unsigned int FUN_004023c0(unsigned char *in, int len, unsigned char *out)\n{\n"
            '  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";\n'
            "  int o = 0;\n"
            "  for ( int i = 0; i + 2 < len; i += 3 ) {\n"
            "    out[o++] = table[in[i] >> 2];\n"
            "    out[o++] = table[((in[i] & 3) << 4) | (in[i+1] >> 4)];\n"
            "    out[o++] = table[((in[i+1] & 15) << 2) | (in[i+2] >> 6)];\n"
            "    out[o++] = table[in[i+2] & 63];\n"
            "  }\n"
            "  return o;\n}"
        ),
        "expected": "base64_encode",
        "source": "synthetic-fixture",
    },
    {
        "task": NAME_TASK,
        "input": (
            "void FUN_00407710(unsigned char *buf, int len, unsigned char key)\n{\n"
            "  for ( int i = 0; i < len; ++i )\n"
            "    buf[i] ^= key;\n}"
        ),
        "expected": "xor_decode_buffer",
        "source": "synthetic-fixture",
    },
    {
        "task": NAME_TASK,
        "input": (
            "int FUN_0040b4e0(const char *path, unsigned char *data, unsigned int size)\n{\n"
            '  HANDLE h = CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL);\n'
            "  if ( h == INVALID_HANDLE_VALUE )\n"
            "    return 0;\n"
            "  DWORD written = 0;\n"
            "  WriteFile(h, data, size, &written, NULL);\n"
            "  CloseHandle(h);\n"
            "  return written == size;\n}"
        ),
        "expected": "write_file_buffer",
        "source": "synthetic-fixture",
    },
    {
        "task": "struct-reconstruction",
        "input": (
            "int FUN_00451230(void *hdr)\n{\n"
            "  if ( *(unsigned int *)hdr != 0x414D5345 )\n"
            "    return -1;\n"
            "  int size = *(int *)(hdr + 4);\n"
            "  void *body = *(void **)(hdr + 8);\n"
            "  return check((unsigned char *)body, size);\n}"
        ),
        "expected": "struct with magic/*0x00, size/*0x04, body pointer/*0x08",
        "source": "synthetic-fixture",
    },
]


def write_synthetic_fixture(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for row in SYNTHETIC_FIXTURE:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


# ---------------------------------------------------------------------------
# REA auth (scripts/mcp-token.ts convention) + inference transports
# ---------------------------------------------------------------------------

def rea_login(email: str, password: str) -> str:
    """POST /api/auth/login → the rea_session cookie value (mcp-token convention)."""
    req = urllib.request.Request(
        f"{REA_URL}/api/auth/login",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            if res.status != 200:
                raise SystemExit(f"[eval] login failed: HTTP {res.status}")
            cookies = res.headers.get_all("Set-Cookie") or []
    except urllib.error.URLError as exc:
        raise SystemExit(f"[eval] cannot reach REA at {REA_URL}: {exc}")
    session = next((c for c in cookies if c.startswith("rea_session=")), None)
    token = session.split(";", 1)[0].split("=", 1)[1] if session else None
    if not token:
        raise SystemExit("[eval] login succeeded but no rea_session cookie was returned")
    return token


def infer_via_platform(task: str, payload: str, cookie: str, timeout_s: float) -> str:
    """Use the registry chain exactly as the UI does: POST /api/models suggest."""
    req = urllib.request.Request(
        f"{REA_URL}/api/models",
        data=json.dumps({"action": "suggest", "task": task, "payload": payload}).encode(),
        headers={"content-type": "application/json", "cookie": f"rea_session={cookie}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as res:
        body = json.loads(res.read().decode())
    if not body.get("ok"):
        raise RuntimeError(f"REA suggest failed: {body.get('error')}")
    return body["result"]["suggestion"]


def infer_via_endpoint(endpoint: str, model: str, task: str, payload: str, timeout_s: float) -> str:
    url = endpoint if endpoint.rstrip("/").endswith("/chat/completions") else endpoint.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": PROMPTS[task]},
                    {"role": "user", "content": payload},
                ],
                "temperature": 0.2,
                "max_tokens": 512,
            }
        ).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as res:
        body = json.loads(res.read().decode())
    content = body.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError("endpoint returned no message content")
    return content


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def extract_predicted_name(text: str) -> str:
    """Pull the identifier out of a suggestion. Documented order:
    1. an explicit `NAME: <id>` line (the platform prompt's cousin of this format),
    2. a `PLACEHOLDER -> <id>` mapping line (the platform prompt's format),
    3. the first identifier-looking token anywhere."""
    m = re.search(r"\bNAME:\s*([A-Za-z_]\w*)", text)
    if m:
        return m.group(1)
    m = re.search(r"->\s*([A-Za-z_]\w*)", text)
    if m:
        return m.group(1)
    m = re.search(r"\b([A-Za-z_]\w{2,})\b", text)
    if m:
        return m.group(1)
    return text.strip().split(" ")[0] if text.strip() else ""


def name_tokens(name: str) -> list[str]:
    """Identifier-aware tokens: split snake_case and camelCase."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", name)
    return [p.lower() for p in re.split(r"[^A-Za-z0-9]+", spaced) if p]


def token_f1(predicted: str, expected: str) -> float:
    pred = [t for t in name_tokens(predicted) if t]
    gold = [t for t in name_tokens(expected) if t]
    if not pred or not gold:
        return 0.0
    from collections import Counter

    common = Counter(pred) & Counter(gold)
    overlap = sum(common.values())
    if overlap == 0:
        return 0.0
    precision = overlap / len(pred)
    recall = overlap / len(gold)
    return 2 * precision * recall / (precision + recall)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="DecompileBench-style eval for REA models")
    parser.add_argument("--dataset", default=os.environ.get("DECOMPILEBENCH_PATH"),
                        help="DecompileBench-style JSONL (env DECOMPILEBENCH_PATH)")
    parser.add_argument("--endpoint", default=None,
                        help="OpenAI-compatible chat-completions URL; omit to use the REA platform LLM")
    parser.add_argument("--model", default="Qwen/Qwen2.5-Coder-7B-Instruct",
                        help="model name sent to the OpenAI-compatible endpoint")
    parser.add_argument("--limit", type=int, default=0, help="cap items (0 = all)")
    parser.add_argument("--timeout-s", type=float, default=60.0)
    parser.add_argument("--report", default=None, help="markdown report path (default training/out/eval-<ts>.md)")
    parser.add_argument("--publish", action="store_true",
                        help="POST the aggregate to REA /api/leaderboard as provenance OBSERVED")
    args = parser.parse_args()

    # ---- dataset (honest fixture fallback) ----
    synthetic = False
    items: list[dict] = []
    if args.dataset and Path(args.dataset).exists():
        for line in Path(args.dataset).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("task") in TASKS and row.get("input") and row.get("expected"):
                items.append(row)
        if not items:
            print(f"[eval] dataset {args.dataset} yielded 0 usable items — falling back to the synthetic fixture")
    else:
        if args.dataset:
            print(f"[eval] dataset not found at {args.dataset} — generating a tiny SYNTHETIC fixture")
        else:
            print("[eval] no dataset configured (DECOMPILEBENCH_PATH/--dataset) — generating a tiny SYNTHETIC fixture")
    if not items:
        synthetic = True
        write_synthetic_fixture(DEFAULT_FIXTURE)
        items = list(SYNTHETIC_FIXTURE)
        print(
            "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n"
            "!! SYNTHETIC FIXTURE IN USE — RESULTS ARE SMOKE-TEST    !!\n"
            "!! NUMBERS ONLY, NOT DECOMPILEBENCH RESULTS.            !!\n"
            f"!! fixture written to {DEFAULT_FIXTURE}\n"
            "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
        )
    if args.limit and args.limit > 0:
        items = items[: args.limit]
    print(f"[eval] items: {len(items)} (synthetic={synthetic})")

    # ---- inference mode ----
    cookie: str | None = None
    if args.endpoint:
        mode = f"openai-compatible endpoint {args.endpoint} (model {args.model})"
        print("[eval] inference mode: openai-compatible endpoint")
    else:
        email = os.environ.get("REA_EMAIL")
        password = os.environ.get("REA_PASSWORD")
        if not email or not password:
            raise SystemExit(
                "[eval] platform-LLM mode needs REA_EMAIL and REA_PASSWORD (login via "
                f"{REA_URL}/api/auth/login, scripts/mcp-token.ts convention) — or pass --endpoint"
            )
        cookie = rea_login(email, password)
        mode = f"REA platform LLM via {REA_URL}/api/models (action suggest)"

    def infer(task: str, payload: str) -> str:
        if args.endpoint:
            return infer_via_endpoint(args.endpoint, args.model, task, payload, args.timeout_s)
        return infer_via_platform(task, payload, cookie or "", args.timeout_s)

    # ---- run ----
    name_rows = []
    other_rows = []
    for idx, item in enumerate(items):
        task = item["task"]
        t0 = time.time()
        try:
            output = infer(task, item["input"])
        except Exception as exc:  # honest per-item failure — no fabricated scores
            print(f"[eval] item {idx} ({task}) inference FAILED: {exc}")
            output = ""
        ms = int((time.time() - t0) * 1000)
        if task == NAME_TASK:
            pred = extract_predicted_name(output)
            em = int(pred.strip() == item["expected"].strip())
            f1 = token_f1(pred, item["expected"])
            name_rows.append({"idx": idx, "pred": pred, "expected": item["expected"],
                              "em": em, "f1": f1, "ms": ms, "raw": output})
        else:
            other_rows.append({"idx": idx, "task": task, "produced": bool(output.strip()), "ms": ms})

    # ---- aggregate + markdown report ----
    n = len(name_rows)
    em_mean = sum(r["em"] for r in name_rows) / n if n else 0.0
    f1_mean = sum(r["f1"] for r in name_rows) / n if n else 0.0
    avg_ms = int(sum(r["ms"] for r in name_rows) / n) if n else 0
    other_ok = sum(1 for r in other_rows if r["produced"])

    lines = [
        "# DecompileBench-style eval — REA specialized models",
        "",
        f"- inference: {mode}",
        f"- dataset: {'SYNTHETIC FIXTURE (not a real benchmark)' if synthetic else (args.dataset or 'unknown')}",
        f"- date: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "| task | items | exact_match | token_f1 | avg_ms |",
        "|---|---|---|---|---|",
    ]
    if n:
        lines.append(f"| {NAME_TASK} | {n} | {em_mean:.3f} | {f1_mean:.3f} | {avg_ms} |")
    for task in {r["task"] for r in other_rows}:
        rows = [r for r in other_rows if r["task"] == task]
        lines.append(
            f"| {task} | {len(rows)} | not scored (presence: {other_ok}/{len(rows)} non-empty) | — | — |"
        )
    lines += ["", "## Per-item (function-name-recovery)", "",
              "| # | predicted | expected | EM | F1 | ms |", "|---|---|---|---|---|---|"]
    for r in name_rows:
        lines.append(f"| {r['idx']} | {r['pred'] or '(empty)'} | {r['expected']} | {r['em']} | {r['f1']:.3f} | {r['ms']} |")
    if synthetic:
        lines += ["", "**NOTE:** synthetic fixture — these numbers are a plumbing smoke test, NOT benchmark results."]
    report = "\n".join(lines) + "\n"

    report_path = Path(args.report) if args.report else DEFAULT_REPORT_DIR / f"eval-{time.strftime('%Y%m%d-%H%M%S')}.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report, encoding="utf-8")
    print(report)
    print(f"[eval] report written to {report_path}")

    # ---- optional publish to the REA leaderboard ----
    if args.publish:
        if not n:
            print("[eval] publish skipped: no name-recovery items were scored")
            return 0
        score = round(em_mean * 100, 1)
        methodology = (
            f"eval_decompilebench.py: exact-match on function-identifier recovery over {n} items "
            f"(token-F1 {f1_mean:.3f}); inference={mode}; dataset="
            f"{'SYNTHETIC FIXTURE (smoke test only)' if synthetic else (args.dataset or 'unknown')}; "
            f"suggestions provenance INFERRED, aggregate published as OBSERVED (we ran the eval)."
        )
        payload = {
            "agent": f"REA eval_decompilebench ({'endpoint' if args.endpoint else 'platform-llm'})",
            "benchmark": "decompilebench",
            "category": "binary",
            "score": score,
            "trials": n,
            "methodology": methodology,
            "provenance": "OBSERVED",
        }
        req = urllib.request.Request(
            f"{REA_URL}/api/leaderboard",
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json", "cookie": f"rea_session={cookie or ''}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                body = res.read().decode()[:300]
            print(f"[eval] published to {REA_URL}/api/leaderboard: HTTP OK — {body}")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                print(f"[eval] {REA_URL}/api/leaderboard returned 404 — the leaderboard endpoint "
                      "is not deployed on this REA instance yet; result stays local (honest).")
            else:
                print(f"[eval] publish failed: HTTP {exc.code} {exc.read().decode()[:200]}")
        except urllib.error.URLError as exc:
            print(f"[eval] publish failed: cannot reach REA at {REA_URL}: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
