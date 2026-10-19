# Lightning

> KVCache rules everything around me.

Lightning is a sketch of a different shape for LLM runtimes: stop treating context as a transcript you replay, and start treating it as a checkpoint you continue from.

It is an idea with a runnable first slice, not a finished runtime. The branch model, the HTTP API and a working `llama.cpp` backend exist. Real llama.cpp KV-cache checkpoints also exist now, when `llama-server` is started with `--slot-save-path`; measured so far on one small CPU setup (see [Measured: branches without prefill](#measured-branches-without-prefill)).

![Lightning architecture: a tree of branches stratified by write frequency, with checkpoints instead of transcripts](docs/architecture.svg)

## The idea

Almost every chat system today runs this loop:

```
transcript + request → model → response
```

Every turn, you re-send the history (or a summary of it) and hope the server's prefix cache still matches. Memory systems, background "thinking" and summarization all fight over that same transcript, and every rewrite near the top invalidates the cache below it.

Lightning flips it:

```
request + checkpoint → model → response + next checkpoint
```

A visible conversation is just one way to serialize the state. The runnable object is the checkpoint.

Once you think that way, the rest of the architecture falls out:

- **Branches, not one thread.** Continuity lives in a tree of mostly append-only branches. A chat lane, a background lane, a project, a research thread: each is its own branch with a parent, a responsibility and a lineage.
- **Stratify by write frequency.** Hot branches churn. Mid-frequency branches hold active project state. *Elder* branches are compressed and slow-changing. Keeping fast writes away from slow state is what keeps caches valid, and that is the real optimization target.
- **Thermal scheduling.** Branches are hot, warm, cold or frozen, so the runtime can focus on the relevant subtree and let the rest sleep.
- **Succession, not rewriting.** Compaction creates a *successor* branch instead of endlessly rewriting the old one. That preserves continuity, cache locality and an explicit inheritance chain. Summaries flow upward, leaf to parent to grandparent, so every write stays at the tail of some branch.
- **Subagents and superagents.** Subagents absorb local churn and return something compressed. Superagents absorb accumulated history and rewrite it into slower, more durable form.
- **"Lightning-capable" models.** Being able to answer prompts isn't enough. A model has to hold up under checkpointed, recursive, branch-aware continuation without looping or drifting. That should become something you evaluate, not something you assume.

The far end of the roadmap is *canonical replay*: given only a visible transcript, reconstruct a deterministic checkpoint that plausibly produced it, and use that as a stable continuity primitive.

The full design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What exists

A small, typed, tested TypeScript scaffold (about 3k lines, no runtime dependencies) that makes the shape concrete:

- an in-memory branch store with create, fork, freeze, thaw, checkpoint and restore;
- a thermal planner that ranks branches and assigns hot, warm and cold;
- a backend adapter contract where every capability (checkpoint, fork, prefix reuse, …) reports itself as `native`, `emulated` or `unsupported`;
- a fake adapter for demos and tests;
- a working `llama.cpp` adapter with native KV checkpoints when `llama-server` runs with `--slot-save-path` (slot save/restore, checked by a startup probe), plus a process manager that starts and supervises `llama-server` for you;
- fan-out from checkpoints (`fanOutFromCheckpoints`): one request against several checkpoints on distinct branches in parallel, one slot each;
- a managed KV tree ([`docs/MANAGED_TREE.md`](docs/MANAGED_TREE.md)): hot, warm and cold tiers driven by the thermal planner (`manageKv`); slot files deleted when nothing holds them; and a disk limit derived from free space, with an optional operator budget;
  - invalidation when the llama.cpp build, model, quantization or context changes;
- a router (`fanOutRouted(query, k)`) that picks the relevant tips by a per-branch summary (Vane when installed, else extractive) plus BM25 and recency, then fans out to them;
- compaction v0 (`compactBranch`): a new, prefilled branch holding a Vane fit of a long branch, with the original left intact;
- an HTTP API on `127.0.0.1:8787`:
  - persistent threads: `POST /v1/threads/:id/messages`, `GET /v1/threads/:id`, `POST /v1/threads/:id/pin`;
  - checkpoint-native turns: `POST /v1/checkpoints/:id/respond`, `GET /v1/checkpoints/:id`;
  - an OpenAI-compatible `POST /v1/chat/completions`. Pass a `thread_id` and Lightning dedupes the prefix it already has, then appends only the new suffix;
  - `GET /v1/branches` and a branch inspector page at `/`.
  - POST bodies must be `content-type: application/json` and at most 1 MiB (otherwise `415` or `413`). A frozen branch is read-only: turns, pins and checkpoint responses on it get `409` until it is thawed.
  - The server only answers requests whose `Host` header names it: `localhost`, `127.0.0.1` or `[::1]` with the port it listens on, plus any configured host. Everything else gets `403`. This blocks DNS-rebinding pages from reaching the API through the browser. `HOST` set to a specific address is allowed automatically on `PORT`. If you bind a wildcard address (`HOST=0.0.0.0`), sit behind a proxy, or publish the port under another number (a container's `8787` mapped to `localhost:9000`), list what clients send in `LIGHTNING_ALLOWED_HOSTS` (comma-separated; `host` matches any port, `host:port` only that port). A loopback name on another port is accepted only when it is listed, so the check stays fail-closed. Bad request bodies (a missing `message`, or a missing, empty or malformed `messages` array) get `400`, and an unknown thread or checkpoint gets `404`.

What is honest to say about it today: native KV checkpoints exist for `llama.cpp` when the server is started with a slot save path; otherwise the adapter reports the branch operations as emulated and says why. Slot files are now managed: tiered, deleted and kept under a disk limit (when Lightning can reach the slot directory on the same host). The router and compaction are v0 and measured on a small synthetic set (below). The branch store and checkpoint metadata are in memory, so persistence, the background maintainer and streaming are still not done.

## Measured: branches without prefill

A branch tip is saved KV state, not just a list of messages. So one query can be answered from many branch tips without re-prefilling any of them, and serial conversations stop being the unit.

Setup: a ~3,000-token trunk conversation, checkpointed; forked into 4 tips with one extra turn each; then one question fanned out to all 4 tips. M = 4, 3 repetitions, medians below.

| Per tip | Evaluated | Reused from KV | prompt_ms |
|---|---:|---:|---:|
| Restored continuation (fan-out) | 28 | 3,085 | 668 |
| Fork turn from trunk checkpoint | 22 | 3,037 | 257 |
| Cold full re-prefill | 3,113 | – | 13,463 |

Wall clock for the 4 tips:

- 4-way fan-out from restored tips: 3,413 ms (per rep: 3,356 / 3,413 / 3,447)
- 4 sequential cold prefills: 56,908 ms — 16.7x slower
- 4 parallel cold prefills: 57,470 ms — 16.8x slower

Parallel cold was not faster than sequential on this 4-core CPU: prefill is compute-bound.

Conditions: Oracle Cloud Ampere A1, 4 x Neoverse-N1 vCPU, 23.4 GiB RAM, CPU only. llama.cpp release b11719, Qwen2.5-0.5B-Instruct Q8_0 GGUF, `llama-server --parallel 4 -c 32768 --slot-save-path DIR --cache-ram 0 -t 4`, Node v22.23.2. `--cache-ram 0` disables llama-server's own RAM prompt cache, so every reused token comes from Lightning's restored checkpoint.

Fidelity: cache_n + prompt_n of the restored run equals the cold prompt_n exactly (3,085 + 28 = 3,113), so the restored KV is token-identical to the re-rendered transcript — no chat-template drift for this model. At temperature 0, 7 of 12 fan-out replies were byte-identical to the sequential cold replies. The cold parallel run also differed from cold sequential on 5 of 12, so the differences come from batched CPU floating-point order, not from the restore.

Cost: each saved slot file is about 12 KiB per token for this model — about 37 MB for a 3k-token branch. 28 files took 984 MB after the 3-rep run of this demo, which predates slot-file management (next section).

What is still emulated:

- `loadModel`, `freeze`, `thaw` and ephemeral consult
- the branch store and checkpoint metadata are in memory (the KV files survive a crash; the tree does not)
- no streaming, so the demo reports server-side prompt_ms, not client time-to-first-token
- one model on one CPU host; a slot pool larger than llama-server's `--parallel` is not possible, so fan-out width is capped by slots and extra requests wait

To reproduce, see [With a real model](#with-a-real-model) below. Raw results: [`docs/results/kv-cache-cedar-b11719-20261018.json`](docs/results/kv-cache-cedar-b11719-20261018.json) ([.txt](docs/results/kv-cache-cedar-b11719-20261018.txt)). Demo source: [`src/examples/kv-cache-demo.ts`](src/examples/kv-cache-demo.ts).

## Measured: the managed tree

A tree of KV tips needs upkeep: deleting files nobody needs, deciding which branches stay hot, picking which tips a question should reach, and compacting long branches. [`docs/MANAGED_TREE.md`](docs/MANAGED_TREE.md) describes the rules. The eval below ([`src/examples/managed-tree-eval.ts`](src/examples/managed-tree-eval.ts), `npm run eval:managed`) measures them on the same Cedar host and model as above. It uses 16 synthetic branches of 8 turns each, about 520 prompt tokens per branch. Twelve branches hold one planted fact each, and there are 24 questions, two per fact: a "close" wording and a "far" paraphrase. Four distractor branches share vocabulary with the fact branches.

**Conditions.** llama.cpp b11719, Qwen2.5-0.5B-Instruct Q8_0, `--parallel 4 -c 32768 --cache-ram 0 -t 4`, Node v22.23.2, answers at temperature 0 with up to 48 tokens. The host was **shared**: another benchmark's llama-server was using the CPU throughout, with load average 7.6 to 9.9 on 4 cores. Generation ran at about 6 tokens/s, so treat every wall time here as a contended upper bound. Token counts and hit rates do not depend on load. Vane `@owl-kestrel/vane` 0.1.0 was installed for this run. Single run, 2026-10-19 00:13Z to 00:26Z.

**Cleanup and tiers**

| | Measured |
|---|---|
| 16 branches built: ledger vs disk | 16 files, 102,859,376 B, identical on both sides (12,305 B per token) |
| Disk limit with no operator budget | filesystem-bound; reserve 403,219,083 B (4 slots × 8,192 ctx × measured B/token) |
| `manageKv` with 4 active branches | 4 hot, 3 warm, 9 cold; files on disk 16 → 7 (102.9 MB → 45.5 MB) |
| Question on a cold branch (text only) | full re-prefill: 532 evaluated, 0 reused; answer still correct |
| Same question twice on one branch | warm (restore): 20 evaluated / 505 reused → hot (resident slot, no restore): 1 evaluated / 524 reused |
| Operator budget of 3 × mean file (19,286,133 B), 6 branches built | 4 files evicted coldest-first; 2 files (13,117,344 B) left, on disk and in the ledger; the evicted oldest branch answered from a cold re-prefill, correct |
| `close()` at the end | 43 + 2 files deleted; 0 of this run's files left on disk |
| Server restarted with a different per-slot context (separate check) | fingerprint changed, 1 file invalidated and deleted, next turn ran cold ([log](docs/results/managed-tree-fingerprint-check-20261019.txt)) |

**Router v0** (lexical BM25 + recency; offline, no model)

| Index | hit@1 | hit@3 | Summary size |
|---|---:|---:|---:|
| Vane summary (160-token fit) | 19/24 | 22/24 | ~433 chars |
| Extractive summary (160 tokens at 4 chars/token) | 21/24 | 23/24 | ~573 chars |
| Full transcript text | 22/24 | 24/24 | whole branch |

The two summary budgets are not equal in characters: Vane counts about 3 characters per token, the extractive fallback 4, so the Vane summaries were about 25% shorter. The Vane tree mapping was changed once after measuring on this same set: dropping a recency salience moved hit@1 from 16/24 to 19/24. So these are not held-out numbers.

**Routed fan-out on the model** (k = 3, Vane summary index)

- The relevant branch was among the 3 tips for 22 of 24 questions (misses: `party-far`, `kitchen-close`).
- The relevant tip answered correctly for 16 of 24. The oracle, which asks only the known branch, got 18 of 24, so the 0.5B model is the main ceiling, not the router.
- Mean wall time: 8.5 s per question for 3 parallel answers (contended).
- Tips served hot 32 times and warm 40 times.

**Compaction v0** (Vane sentence-level fit of each fact branch, prefilled as a new branch; the 24 questions asked on the compacted tip)

| Budget (× source tokens) | Fact kept in the summary | Correct: full branch | Correct: compacted | Lost / gained | Prompt tokens per answer: full / compacted |
|---|---:|---:|---:|---:|---:|
| 0.25 | 0/12 | 18/24 | 1/24 | 17 / 0 | 546 / 154 |
| 0.5 | 0/12 | 18/24 | 1/24 | 17 / 0 | 546 / 255 |
| 0.75 | 12/12 | 18/24 | 21/24 | 1 / 4 | 546 / 350 |

Read this honestly:

- Vane compaction is extractive. It chooses which turns and sentences to show; it does not paraphrase. Each planted fact is the second sentence of the fourth turn. At 0.25 and 0.5 the fit drops the fact, and the answers fail.
- At 0.75 every fact survives, and this small model answered more questions correctly from the shorter context than from the full one.
- The sentence-level tree replaced a turn-level tree after a text-only check on this set: the turn-level tree kept 0 of 12 facts even at 0.75. Like the router number, this is not held out.
- A real compaction trigger needs a better summary than extraction at low budgets.

Raw results: [`docs/results/managed-tree-cedar-b11719-20261019.json`](docs/results/managed-tree-cedar-b11719-20261019.json) ([.txt](docs/results/managed-tree-cedar-b11719-20261019.txt)).

## The inspector

The API server also serves a small inspector at `/`: the branch tree with its thermal state, each branch's lineage, checkpoints and recent messages, the adapter's capability report, and a box to send a turn to any branch that is not frozen (frozen branches are read-only). With native KV checkpoints, the cached-tokens tile says whether it is measured (llama-server's `timings.cache_n` for the last turn) or an estimate, and each checkpoint row has a "Continue from here" button that calls `POST /v1/checkpoints/:id/respond`.

| Light | Dark |
|---|---|
| ![Lightning inspector, light theme](docs/screenshots/inspector-desktop-light.png) | ![Lightning inspector, dark theme](docs/screenshots/inspector-desktop-dark.png) |

<p align="center">
  <img src="docs/screenshots/inspector-mobile-light.png" width="240" alt="Lightning inspector on a phone, light theme">
  <img src="docs/screenshots/inspector-mobile-dark.png" width="240" alt="Lightning inspector on a phone, dark theme">
</p>

The screenshots are from `npm run demo:ui`: the real runtime and API with the fake adapter and a seeded branch tree. The page says **Demo data** whenever the fake adapter is active. Branches, forks, checkpoints and thermal state are real runtime state; only generation is fake (it echoes your message).

## Try it

Requires Node.js (tested with 22) and npm.

```bash
git clone https://github.com/jon-vs-moloch/lightning.git
cd lightning
npm install
npm test           # builds, then runs the test suite
npm run demo       # in-memory runtime + fake adapter, printed to the terminal
npm run demo:ui    # the inspector with demo data at http://127.0.0.1:8787
```

`npm run demo` creates a chat branch, forks a background branch, generates, checkpoints and plans thermals:

```
⚡ Lightning in-memory runtime · fake adapter

Branches
  chat-main  ● hot  chat
  └─ bg-main  ● frozen  background

Generate chat-main
  reply       branch:chat-main | model:fake-echo-v1 | echo:Summarize what this runtime can do right now.
  tokens      21 prompt · 12 completion

Checkpoint
  id          ckpt-chat-main-1
  label       initial-chat-state
  summary     Initial in-memory conversation checkpoint
…
```

### With a real model

With a local GGUF model and `llama-server` (from [llama.cpp](https://github.com/ggml-org/llama.cpp)) on your `PATH`:

```bash
LIGHTNING_MODEL=/path/to/model.gguf npm run serve
```

Lightning starts `llama-server` on `127.0.0.1:8080`, waits for it to become healthy, and serves its own API and the inspector on `http://127.0.0.1:8787`. To attach to a `llama.cpp` server you already run, set `LLAMA_CPP_BASE_URL=http://127.0.0.1:8080` instead. Other settings: `LLAMA_CPP_BINARY`, `LLAMA_CPP_HOST`, `LLAMA_CPP_PORT`, `LLAMA_CPP_ARGS`, `LLAMA_CPP_MANAGED=0|1`, `HOST`, `PORT`, `LIGHTNING_ALLOWED_HOSTS`.

Native KV checkpoints need `llama-server` started with `--slot-save-path <dir> --parallel <N> --cache-ram 0`. In managed mode, `LLAMA_CPP_SLOT_SAVE_PATH` and `LLAMA_CPP_PARALLEL` pass the slot save path and `--parallel` for you; `--cache-ram 0` can go through `LLAMA_CPP_ARGS`. The adapter only reports the checkpoint operations as native when its startup probe succeeds.

The KV-cache demo ([`src/examples/kv-cache-demo.ts`](src/examples/kv-cache-demo.ts)) measures branch continuation against cold prefill and refuses to run if KV checkpoints are not native:

```bash
npm run build && node dist/examples/kv-cache-demo.js --base-url http://127.0.0.1:8080 --branches 4 --reps 3 --out results.json
npm run demo:kv -- --base-url http://127.0.0.1:8080
```

```bash
curl -s http://127.0.0.1:8787/v1/threads/demo/messages \
  -H 'content-type: application/json' \
  -d '{"message": {"content": "What should I work on next?"}}'
```

That appends your message to the `demo` branch, generates through `llama.cpp`, appends the reply, checkpoints, and returns the new head checkpoint and branch stats.

## Where it came from

Lightning grew out of [Candle](https://github.com/jon-vs-moloch/candle), a browser experiment in giving a chat agent a continuous inner loop and actively managed context. Candle made the product shape visible. It also kept growing engine logic inside a browser tab, and the bottlenecks pointed at the runtime underneath. Lightning is the attempt to build that runtime, so Candle-like products can sit on top of it. Candle was never rebuilt on it.

## Layout

| Path | What it is |
|---|---|
| [`src/core/`](src/core) | Types, adapter contract, branch store, runtime and thermal planner |
| [`src/backends/`](src/backends) | Fake adapter, `llama.cpp` adapter and `llama-server` process manager |
| [`src/api/server.ts`](src/api/server.ts) | HTTP API and inspector route |
| [`public/index.html`](public/index.html) | The inspector (one static file) |
| [`src/examples/`](src/examples) | `npm run demo`, `npm run demo:ui`, `npm run demo:kv` and `npm run eval:managed` |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The design |
| [`docs/MANAGED_TREE.md`](docs/MANAGED_TREE.md) | KV tiers and cleanup, router, compaction, and the maintainer design |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases, with current status |
| [`docs/results/`](docs/results) | Benchmark results: the KV-cache run and the managed-tree eval |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | The original continuation note |

## Status

**Early scaffold and design essay.** The architecture is the point; the code is the first slice that makes it runnable. Phases 0 and 1 of the [roadmap](docs/ROADMAP.md) are done and Phase 2 is partly done. Native KV-cache checkpoints exist for `llama.cpp` via llama-server slot files, and the slot files are managed. A router and a compaction v0 exist and are measured on a small synthetic set. There is still no persistence, no background maintainer and no streaming.

## License

[Apache-2.0](LICENSE) © 2026 Jonathan Meriwether
