# AREA Training Pipeline — specialized RE models

Fine-tune open code LLMs on AREA's own reverse-engineering history and serve them
back to the platform as specialized models (Architecture C2). Everything in this
directory runs **out-of-band** on a GPU host — the AREA platform only consumes
trained models through registered `openai-compatible` endpoints.

> **Hardware honesty:** the machine hosting AREA has **no GPU** (and no training
> stack). These scripts are deliverables to run elsewhere; nothing here trains
> on the platform host.

## What's here

| Script | Purpose |
|---|---|
| `dataset_miner.py` | Mines AREA's SQLite DB (`Evidence` + `BuildArtifact` + `GraphNode`) into `(input, ground-truth)` pairs for **function-name-recovery** and **struct-reconstruction**. Deterministic 90/10 train/val split. Prints exactly what it mined; an empty/young DB yields 0 pairs — it never fabricates rows. |
| `train_lora.py` | peft+transformers LoRA fine-tune (4-bit NF4, r=16/α=32/dropout 0.05 on q,k,v,o,gate,up,down; cosine LR 2e-4; 3 epochs; bf16; gradient checkpointing). Refuses to run without CUDA. `--merge` exports standalone merged weights for vLLM. |
| `eval_decompilebench.py` | DecompileBench-style eval harness. Exact-match + token-F1 for name recovery. Inference against an OpenAI-compatible endpoint **or** AREA's own model chain (`/api/models` → `suggest`). `--publish` posts the aggregate to `/api/leaderboard` as provenance `OBSERVED` with a full methodology string. |

## 1. Mine a dataset (on the AREA host — no GPU needed)

```bash
python3 training/dataset_miner.py                       # AREA_DB env or db/custom.db
python3 training/dataset_miner.py --min-confidence high # stricter evidence filter
```

- Reads `BuildArtifact` rows whose path ends in `decompiled.c`, extracts function
  blocks with a **regex + brace-matching heuristic** (documented as a heuristic —
  it is not a full C parser), and pairs placeholder-named functions
  (`FUN_14001a2c4`, `sub_4010f0`, `fcn.004010f0`, …) with candidate ground-truth
  names from `GraphNode(kind='function')` labels (OBSERVED provenance) and
  `Evidence.subjectName` rows passing the confidence filter.
- Matching order (most→least trusted): **address** (Ghidra placeholders embed the
  entry address; matched against `0x…` values in GraphNode.meta / Evidence.payload
  and address comments) → **direct evidence** (Evidence payload mentions the
  placeholder) → opt-in **unique 1:1 pairing** (`--allow-unique-pair`).
- Struct pairs come from Evidence payloads containing C struct definitions.
- Emits `training/data/<task>.train.jsonl` / `<task>.val.jsonl` with rows
  `{ task, input, output, source }`; `source` carries full provenance for every pair.

Copy `training/data/` to your GPU host (or mount the repo).

## 2. Train (GPU host — 1× A100 40GB minimum for a 7B model)

```bash
pip install "transformers>=4.44" peft bitsandbytes accelerate datasets torch

python3 training/train_lora.py --task function-name-recovery \
    --dataset training/data/function-name-recovery.train.jsonl
# other --task values: struct-reconstruction | decompile-cleanup | malware-triage | binary-similarity
# --base-model works with Llama / DeepSeek coder variants, e.g.:
#   --base-model deepseek-ai/deepseek-coder-6.7b-instruct
```

VRAM guidance (4-bit LoRA, seq 2048): 7B ≈ 12–20 GB weights + activations —
**1× A100 40GB minimum** (24 GB consumer cards work with `--batch-size 1`).
Output: `training/out/<task>-lora/` (adapter + `training_meta.json`).

The system prompts in `train_lora.py` are byte-identical mirrors of
`src/server/models/adapters.ts` (`TASK_PROMPTS`) — training and serving share the
same contract. Keep them in sync.

## 3. Export merged weights and serve

```bash
python3 training/train_lora.py --task function-name-recovery --merge
# → training/out/function-name-recovery-lora-merged/  (standalone HF dir)

pip install vllm
vllm serve training/out/function-name-recovery-lora-merged \
    --served-model-name function-name-recovery --port 8000
# llama.cpp works too: llama-server -m <merged gguf> --port 8000
```

## 4. Point AREA at the trained model

On the AREA host, register the endpoint (auth required — log in first and reuse
the `area_session` cookie):

```bash
curl -X POST http://127.0.0.1:3000/api/models \
  -H 'content-type: application/json' -b 'area_session=<cookie>' \
  -d '{
    "action": "register",
    "name": "qwen25-coder-7b lora (name recovery)",
    "task": "function-name-recovery",
    "baseModel": "Qwen/Qwen2.5-Coder-7B-Instruct",
    "adapter": "openai-compatible",
    "endpoint": "http://<gpu-host>:8000/v1/chat/completions",
    "priority": 10
  }'
```

- `priority` = lower wins. The five seeded `platform-llm` fallback rows sit at
  priority 100, so any registered model at priority < 100 takes over the task;
  set it higher than 100 to shadow the platform LLM instead.
- The adapter layer monitors health: an observed endpoint failure flips the row
  to `status: "unavailable"` and traffic degrades to the platform LLM until you
  re-register or POST `{"action":"status","id":…,"status":"available"}`.
- Verify with `GET /api/models` and one honest inference:

```bash
curl -X POST http://127.0.0.1:3000/api/models \
  -H 'content-type: application/json' -b 'area_session=<cookie>' \
  -d '{"action":"suggest","task":"function-name-recovery","payload":"int FUN_14001a2c4(int a1){ return *(int*)(a1+0x10); }"}'
```

## 5. Evaluate + publish to the leaderboard

```bash
# against the served model:
python3 training/eval_decompilebench.py \
    --dataset decompilebench.jsonl \
    --endpoint http://<gpu-host>:8000/v1/chat/completions

# against AREA's platform fallback (uses /api/models → suggest):
AREA_URL=http://127.0.0.1:3000 AREA_EMAIL=you@example.com AREA_PASSWORD='…' \
    python3 training/eval_decompilebench.py --dataset decompilebench.jsonl

# publish the aggregate as provenance OBSERVED with a methodology string:
... eval_decompilebench.py ... --publish
```

Scoring: **exact-match** and **token-F1** (identifier-aware: snake_case /
camelCase tokenization) on `function-name-recovery`. Other tasks are listed with
a non-empty-output presence check only. Without a dataset the harness generates
a tiny synthetic fixture and **says so loudly** — those numbers are smoke tests,
never benchmark results, and `--publish` flags them as such in the methodology.
