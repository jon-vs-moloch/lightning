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
- an HTTP API on `127.0.0.1:8787`:
  - persistent threads: `POST /v1/threads/:id/messages`, `GET /v1/threads/:id`, `POST /v1/threads/:id/pin`;
  - checkpoint-native turns: `POST /v1/checkpoints/:id/respond`, `GET /v1/checkpoints/:id`;
  - an OpenAI-compatible `POST /v1/chat/completions`. Pass a `thread_id` and Lightning dedupes the prefix it already has, then appends only the new suffix;
  - `GET /v1/branches` and a branch inspector page at `/`.
  - POST bodies must be `content-type: application/json` and at most 1 MiB (otherwise `415` or `413`). A frozen branch is read-only: turns, pins and checkpoint responses on it get `409` until it is thawed.
  - The server only answers requests whose `Host` header names it: `localhost`, `127.0.0.1` or `[::1]` with the port it listens on, plus any configured host. Everything else gets `403`. This blocks DNS-rebinding pages from reaching the API through the browser. `HOST` set to a specific address is allowed automatically on `PORT`. If you bind a wildcard address (`HOST=0.0.0.0`), sit behind a proxy, or publish the port under another number (a container's `8787` mapped to `localhost:9000`), list what clients send in `LIGHTNING_ALLOWED_HOSTS` (comma-separated; `host` matches any port, `host:port` only that port). A loopback name on another port is accepted only when it is listed, so the check stays fail-closed. Bad request bodies (a missing `message`, or a missing, empty or malformed `messages` array) get `400`, and an unknown thread or checkpoint gets `404`.

What is honest to say about it today: native KV checkpoints exist for `llama.cpp` when the server is started with a slot save path; otherwise the adapter reports the branch operations as emulated and says why. The branch store and checkpoint metadata are in memory, so persistence, successor compaction, slot-file garbage collection and streaming are still not done.

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

Cost: each saved slot file is about 12 KiB per token for this model — about 37 MB for a 3k-token branch. 28 files took 984 MB after the 3-rep run. Nothing garbage-collects them yet.

What is still emulated:

- `loadModel`, `freeze`, `thaw` and ephemeral consult
- the branch store and checkpoint metadata are in memory (the KV files survive a crash; the tree does not)
- no slot-file garbage collection
- no streaming, so the demo reports server-side prompt_ms, not client time-to-first-token
- one model on one CPU host; a slot pool larger than llama-server's `--parallel` is not possible, so fan-out width is capped by slots and extra requests wait

To reproduce, see [With a real model](#with-a-real-model) below. Raw results: [`docs/results/kv-cache-cedar-b11719-20261018.json`](docs/results/kv-cache-cedar-b11719-20261018.json) ([.txt](docs/results/kv-cache-cedar-b11719-20261018.txt)). Demo source: [`src/examples/kv-cache-demo.ts`](src/examples/kv-cache-demo.ts).

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
| [`src/examples/`](src/examples) | `npm run demo`, `npm run demo:ui` and `npm run demo:kv` |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The design |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases, with current status |
| [`docs/results/`](docs/results) | Benchmark results, such as the KV-cache run |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | The original continuation note |

## Status

**Early scaffold and design essay.** The architecture is the point; the code is the first slice that makes it runnable. Phases 0 and 1 of the [roadmap](docs/ROADMAP.md) are done and Phase 2 is partly done. Native KV-cache checkpoints exist for `llama.cpp` via llama-server slot files. There is still no persistence and no streaming.

## License

[Apache-2.0](LICENSE) © 2026 Jonathan Meriwether
