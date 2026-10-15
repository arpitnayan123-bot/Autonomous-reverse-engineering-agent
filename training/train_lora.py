#!/usr/bin/env python3
"""
LoRA fine-tune a code LLM on REA-mined RE task datasets (GPU host REQUIRED).

Fine-tunes Qwen/Qwen2.5-Coder-7B-Instruct (or --base-model: Llama/DeepSeek
coder variants) with peft+transformers:
  - 4-bit NF4 quantization via bitsandbytes (double quant, bf16 compute);
  - LoRA r=16, alpha=32, dropout=0.05 on the q,k,v,o,gate,up,down projections;
  - cosine LR schedule at 2e-4, 3 epochs, bf16, gradient checkpointing;
  - prompt-masked loss (labels = -100 on the system+user part);
  - saves to training/out/<task>-lora/ (+ training_meta.json for the registry);
  - --merge exports MERGED standalone weights (training/out/<task>-lora-merged/)
    that a vLLM / llama.cpp server can serve directly, so REA can register it
    via /api/models as adapter "openai-compatible".

HARDWARE HONESTY: this needs a real CUDA GPU — 1x A100 40GB is the minimum for
a 7B model in 4-bit LoRA (batch 2 + grad accum 8, seq len 2048). The sandbox
host that REA runs on has NO GPU by design: training is out-of-band. The script
refuses to start without CUDA instead of silently training on CPU.

The system prompts are byte-identical to src/server/models/adapters.ts
(TASK_PROMPTS) so the model is trained and served against the SAME contract.

Usage (on a GPU host):
    pip install "transformers>=4.44" peft bitsandbytes accelerate torch
    python3 training/train_lora.py --task function-name-recovery \
        --dataset training/data/function-name-recovery.train.jsonl
    python3 training/train_lora.py --task decompile-cleanup --merge
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = REPO_ROOT / "training" / "data"
DEFAULT_OUT_ROOT = REPO_ROOT / "training" / "out"

TASKS = [
    "function-name-recovery",
    "struct-reconstruction",
    "decompile-cleanup",
    "malware-triage",
    "binary-similarity",
]

DEFAULT_BASE_MODEL = "Qwen/Qwen2.5-Coder-7B-Instruct"

# ---------------------------------------------------------------------------
# System prompts — MIRRORS of src/server/models/adapters.ts TASK_PROMPTS.
# Keep both copies in sync: training and inference must share the contract.
# ---------------------------------------------------------------------------

PROMPTS = {
    "function-name-recovery": """You are a reverse-engineering assistant specializing in FUNCTION NAME RECOVERY.

You receive a decompiled function body (Ghidra/rizin/IDA style). The function and
its callees may carry placeholder names (FUN_14001ab2, sub_4010f0, fcn.004010f0,
thunk_FUN_..., nullsub_...). Suggest meaningful identifiers for the PLACEHOLDER
names.

Ground every suggestion ONLY in evidence visible in the input:
- how arguments are used (calling convention, count, types implied by arithmetic);
- string literals, constants and magic numbers it touches;
- library/API calls it invokes — these names are GIVEN, never invent new ones;
- control-flow shape and structure access patterns (offsets on a base pointer);
- comparisons against known OS error codes, protocol values, encodings.

Hard constraints:
- SUGGEST ONLY. You are one signal inside a larger recovery pipeline; never assert.
- NEVER invent API calls, imports, library names, file paths or hashes absent
  from the input.
- Mark uncertainty explicitly: every suggestion carries (confidence: high|medium|low).
- If the evidence supports no better name, output "UNDEFINED" for that placeholder
  instead of guessing — an honest gap beats a fabricated identifier.

Output format — one line per placeholder, nothing else:
PLACEHOLDER -> suggested_name (confidence: level) — one-line evidence-based reason""",

    "struct-reconstruction": """You are a reverse-engineering assistant specializing in STRUCT RECONSTRUCTION.

You receive decompiled code that touches memory through raw base pointers and
numeric offsets, e.g. *(undefined4 *)(param_1 + 0x10) or *(int *)(a1 + 0x18) = v3.

Reconstruct the C struct definition(s) implied by the OBSERVED offsets.

Rules:
- A field exists only if the input shows that offset being accessed. Derive its
  type from the decompiler's access type (undefined4 -> int/uint32_t,
  undefined8 -> pointer or uint64_t, undefined -> char[size]) and its usage.
- Preserve exact offsets: annotate every field with a comment, e.g.
  /* 0x10 */ int refcount; — declare explicit padding where a gap is observed.
- Declare the struct PARTIAL: never invent fields for offsets the code never
  touches; state the proven size only when the code proves it (allocation size,
  memset range, highest touched offset).
- Mark guessed types/meanings with /* UNCERTAIN */.
- stdint types are allowed; NEVER invent API calls or library types.

Output: C code only — one or more 'typedef struct { ... } name_t;' blocks with
offset comments, then a '// known offsets not covered: ...' note listing any
touched offsets you could not attribute.""",

    "decompile-cleanup": """You are a reverse-engineering assistant specializing in DECOMPILER OUTPUT CLEANUP.

You receive raw decompiled C that is correct but hard to read: junk casts
(undefined4, unknown_*), decompiler temporaries (uVar1, auStack_28), noise.

Rewrite it for a human reviewer WITHOUT changing behavior:
- Rename local variables by MEANING derived from their use (retry_count,
  entry_len, flags); keep the function's own name and parameter order untouched.
- Drop provably dead casts and pure temporaries; every branch, side effect,
  comparison and constant must survive EXACTLY as-is.
- Replace a magic number ONLY when the surrounding code forces its meaning
  (e.g. 0x1F used as a mask); leave every other constant untouched.
- Do NOT add function calls, includes, headers or library usages that are not
  in the input; do NOT speculate about API semantics.
- Where a construct is ambiguous, keep the original and add
  /* UNCERTAIN: <one line why> */.

Output: the cleaned C code in a single ```c fenced block, nothing else.""",

    "malware-triage": """You are a malware analyst assistant performing FIRST-PASS STATIC TRIAGE.

You receive evidence snippets from static analysis: strings, imports, section
names, hexdumps, or decompiled fragments. They may be tiny, partial or even
benign-looking.

Produce a triage note with EXACTLY these sections:
1. Summary — 2-4 sentences: likely capability class (loader, keylogger, C2
   beacon, ransomware, packer, installer, ...) and overall confidence.
2. Indicators — ONLY artifacts visible in the input: strings, mutexes, registry
   paths, URLs/IPs/domains, file names. Copy them verbatim; NEVER invent or
   normalize indicators that are not present.
3. Capability hypotheses — bullet list; each hypothesis MUST cite the exact
   input element supporting it (short quote). No citation, no claim.
4. What would confirm — 2-3 concrete next analysis steps.

Hard constraints: hedge family attributions ("Emotet-like" only with strong
evidence); never fabricate hashes, IPs, campaign names or victim details;
if the evidence is too thin for a capability class, say "insufficient
evidence" — that is an acceptable, honest answer.""",

    "binary-similarity": """You are a reverse-engineering assistant assessing BINARY FUNCTION SIMILARITY.

You receive one or two function descriptions (decompiled bodies, callee/caller
lists, constants, string references, structural features). Judge how likely
they represent the same original source function.

Score each dimension 0-10 with one line of evidence from the input:
- structural: basic-block shape, branch nesting, loop count;
- data: constants, magic numbers, string literals;
- call context: called/calling names (ignore placeholder names);
- semantics: what the code does end to end.

Output exactly:
similarity: <N>/100
verdict: same-function | related-variant | different | insufficient-evidence
reasons:
- <dimension>: <score>/10 — <evidence>

Hard constraints: the 0-100 score must be consistent with the dimension scores;
when the input is too partial to compare, answer insufficient-evidence instead
of guessing; never claim compiler, architecture or provenance facts that the
input does not show.""",
}


# ---------------------------------------------------------------------------
# CLI + data
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LoRA fine-tune for REA RE tasks")
    parser.add_argument("--task", required=True, choices=TASKS)
    parser.add_argument("--dataset", default=None,
                        help="JSONL with {task,input,output,source} (default training/data/<task>.train.jsonl)")
    parser.add_argument("--val-dataset", default=None,
                        help="optional JSONL for eval loss (default training/data/<task>.val.jsonl if present)")
    parser.add_argument("--base-model", default=DEFAULT_BASE_MODEL,
                        help=f"HF model id (default {DEFAULT_BASE_MODEL})")
    parser.add_argument("--out", default=None,
                        help="output dir (default training/out/<task>-lora)")
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--lora-dropout", type=float, default=0.05)
    parser.add_argument("--max-len", type=int, default=2048)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--grad-accum", type=int, default=8)
    parser.add_argument("--merge", action="store_true",
                        help="after training, merge LoRA into the base and save a standalone HF dir for vLLM")
    return parser.parse_args()


def load_jsonl(path: Path, task: str) -> list[dict]:
    """Load and validate pairs. Honesty rules: missing file/0 rows is fatal here
    (training on nothing would silently 'succeed'), rows for other tasks are
    skipped with a count."""
    if not path.exists():
        raise SystemExit(f"[train_lora] dataset not found: {path} — run training/dataset_miner.py first")
    rows: list[dict] = []
    skipped_other_task = skipped_bad = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            skipped_bad += 1
            continue
        if row.get("task") != task:
            skipped_other_task += 1
            continue
        if not (isinstance(row.get("input"), str) and row["input"].strip()
                and isinstance(row.get("output"), str) and row["output"].strip()):
            skipped_bad += 1
            continue
        rows.append(row)
    if not rows:
        raise SystemExit(
            f"[train_lora] {path} contains 0 usable pairs for task '{task}' — refusing to "
            f"fabricate training data (other-task={skipped_other_task}, bad={skipped_bad})"
        )
    print(f"[train_lora] loaded {len(rows)} pairs from {path} "
          f"(skipped: other-task={skipped_other_task}, bad={skipped_bad})")
    return rows


def build_example(tokenizer, task: str, row: dict, max_len: int) -> dict:
    """Chat-formatted example with prompt-masked labels (-100 on the prompt)."""
    prompt_text = tokenizer.apply_chat_template(
        [
            {"role": "system", "content": PROMPTS[task]},
            {"role": "user", "content": row["input"]},
        ],
        tokenize=False,
        add_generation_prompt=True,
    )
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
    full_ids = tokenizer(
        prompt_text + row["output"] + tokenizer.eos_token, add_special_tokens=False
    )["input_ids"]
    full_ids = full_ids[:max_len]
    n_prompt = min(len(prompt_ids), len(full_ids))
    labels = [-100] * n_prompt + full_ids[n_prompt:]
    return {"input_ids": full_ids, "labels": labels}


class Collator:
    """Right-pads input_ids/labels (pad token contributes -100 labels)."""

    def __init__(self, pad_id: int):
        self.pad_id = pad_id

    def __call__(self, features: list[dict]) -> dict:
        maxlen = max(len(f["input_ids"]) for f in features)
        input_ids, labels, attention = [], [], []
        for f in features:
            pad = maxlen - len(f["input_ids"])
            input_ids.append(f["input_ids"] + [self.pad_id] * pad)
            labels.append(f["labels"] + [-100] * pad)
            attention.append([1] * len(f["input_ids"]) + [0] * pad)
        return {
            "input_ids": input_ids,
            "labels": labels,
            "attention_mask": attention,
        }


# ---------------------------------------------------------------------------
# Training / merging (heavy imports live here so --help works without torch)
# ---------------------------------------------------------------------------

def maybe_merge(args: argparse.Namespace, out_dir: Path) -> None:
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer

    merged_dir = Path(str(out_dir) + "-merged")
    print(f"[train_lora] merging LoRA from {out_dir} into {args.base_model} → {merged_dir}")
    base = AutoModelForCausalLM.from_pretrained(
        args.base_model, torch_dtype=torch.bfloat16, device_map="auto"
    )
    model = PeftModel.from_pretrained(base, str(out_dir))
    merged = model.merge_and_unload()
    merged.save_pretrained(str(merged_dir))
    tokenizer = AutoTokenizer.from_pretrained(str(out_dir))
    tokenizer.save_pretrained(str(merged_dir))
    print(
        f"[train_lora] merged weights written to {merged_dir}\n"
        f"[train_lora] serve them with vLLM and register in REA:\n"
        f"[train_lora]   vllm serve {merged_dir} --served-model-name {args.task}\n"
        f"[train_lora]   curl -X POST $REA_URL/api/models -H 'content-type: application/json' \\\n"
        f"[train_lora]     -b rea_session=<cookie> -d '{{\"action\":\"register\",\"name\":\"{args.task} lora\","
        f"\"task\":\"{args.task}\",\"baseModel\":\"{args.base_model}\","
        f"\"adapter\":\"openai-compatible\",\"endpoint\":\"http://<gpu-host>:8000/v1/chat/completions\","
        f"\"priority\":10}}'"
    )


def main() -> int:
    args = parse_args()

    out_dir = Path(args.out) if args.out else DEFAULT_OUT_ROOT / f"{args.task}-lora"

    try:
        import torch
    except ImportError:
        raise SystemExit("[train_lora] torch not installed — training needs a GPU host, see training/README.md")

    if not torch.cuda.is_available():
        raise SystemExit(
            "[train_lora] NO CUDA device available — refusing to train. This host (the REA "
            "sandbox) has no GPU by design; run this script on a GPU machine "
            "(1x A100 40GB minimum for a 7B model in 4-bit LoRA)."
        )

    from datasets import Dataset
    from peft import LoraConfig, prepare_model_for_kbit_training, get_peft_model
    from transformers import (
        AutoModelForCausalLM,
        AutoTokenizer,
        BitsAndBytesConfig,
        Trainer,
        TrainingArguments,
    )

    dataset_path = Path(args.dataset) if args.dataset else DEFAULT_DATA_DIR / f"{args.task}.train.jsonl"
    rows = load_jsonl(dataset_path, args.task)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    examples = [build_example(tokenizer, args.task, r, args.max_len) for r in rows]
    train_ds = Dataset.from_list(examples)

    val_path = Path(args.val_dataset) if args.val_dataset else DEFAULT_DATA_DIR / f"{args.task}.val.jsonl"
    eval_ds = None
    if val_path.exists():
        val_rows = load_jsonl(val_path, args.task)
        if val_rows:
            eval_ds = Dataset.from_list(
                [build_example(tokenizer, args.task, r, args.max_len) for r in val_rows]
            )

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=torch.bfloat16,
    )
    model = AutoModelForCausalLM.from_pretrained(
        args.base_model, quantization_config=bnb, device_map="auto"
    )
    model.config.use_cache = False
    model = prepare_model_for_kbit_training(model)
    model.gradient_checkpointing_enable()

    lora = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=args.lora_dropout,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    targs = TrainingArguments(
        output_dir=str(out_dir),
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        bf16=True,
        gradient_checkpointing=True,
        logging_steps=10,
        save_strategy="epoch",
        eval_strategy="epoch" if eval_ds is not None else "no",
        report_to=[],
        optim="paged_adamw_8bit",
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=targs,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=Collator(tokenizer.pad_token_id),
    )
    trainer.train()

    model.save_pretrained(str(out_dir))
    tokenizer.save_pretrained(str(out_dir))

    history = trainer.state.log_history or []
    losses = [h["loss"] for h in history if isinstance(h.get("loss"), (int, float))]
    meta = {
        "task": args.task,
        "baseModel": args.base_model,
        "dataset": str(dataset_path),
        "pairs": len(rows),
        "lora": {"r": args.lora_r, "alpha": args.lora_alpha, "dropout": args.lora_dropout,
                 "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]},
        "training": {"epochs": args.epochs, "lr": args.lr, "scheduler": "cosine", "bf16": True,
                     "quantization": "nf4-4bit", "gradient_checkpointing": True},
        "final_loss": losses[-1] if losses else None,
        "provenance": "INFERRED",  # trained on mined pairs, not verified tool output
    }
    (out_dir / "training_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"[train_lora] adapter saved to {out_dir} (training_meta.json written)")
    print(f"[train_lora] final loss: {meta['final_loss']}")

    if args.merge:
        maybe_merge(args, out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
