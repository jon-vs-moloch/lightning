# Lightning

Lightning is a hierarchical persistent cognition runtime.

It is the substrate that Candle wants to run on.

Where Candle demonstrates the product shape of:
- chat
- background cognition
- managed context

Lightning is the engine that makes those ideas scalable:
- branch-based cognition
- write-frequency hierarchy
- thermal branch scheduling
- explicit succession and archival
- backend adapters for local and server inference engines

## Status

This repository is an initial scaffold.

It currently provides:
- architecture documentation
- a runtime-oriented type skeleton
- backend adapter interfaces
- a handoff document for continuing implementation
- an in-memory runtime with a fake adapter demo
- a `llama.cpp` HTTP adapter
- a minimal Lightning API server

It does not yet provide:
- a working inference backend
- checkpoint persistence
- branch scheduling implementation
- Candle integration

## Layout

- [docs/ARCHITECTURE.md](/Users/jon/Projects/lightning/docs/ARCHITECTURE.md): Lightning architecture spec
- [docs/ROADMAP.md](/Users/jon/Projects/lightning/docs/ROADMAP.md): staged implementation plan
- [docs/HANDOFF.md](/Users/jon/Projects/lightning/docs/HANDOFF.md): explicit continuation note
- [src/core/types.ts](/Users/jon/Projects/lightning/src/core/types.ts): core runtime types
- [src/core/adapter.ts](/Users/jon/Projects/lightning/src/core/adapter.ts): backend adapter contract
- [src/core/scheduler.ts](/Users/jon/Projects/lightning/src/core/scheduler.ts): scheduler skeleton
- [src/core/branch.ts](/Users/jon/Projects/lightning/src/core/branch.ts): branch store helpers
- [src/index.ts](/Users/jon/Projects/lightning/src/index.ts): package entrypoint

## Immediate Goal

Build the smallest working Lightning loop:

1. create a branch
2. append messages to it
3. generate from it through an adapter
4. checkpoint/freeze/thaw the branch
5. observe branch stats and thermal state

That will be enough to validate the first real engine layer before rebuilding Candle on top.

## Try It

Run:

```bash
npm run demo
```

This exercises the in-memory runtime by:
- creating a chat branch
- forking a background branch
- appending messages
- generating through the fake adapter
- checkpointing and thermal planning

## API Mode

`Lightning` can now manage `llama.cpp` locally and expose a persistent conversation API.

The default path is managed mode:

```bash
LIGHTNING_MODEL=/absolute/path/to/model.gguf \
npm run serve
```

Lightning will start `llama-server` for you on `127.0.0.1:8080` by default, wait for it to become healthy, and then expose the Lightning API on `http://127.0.0.1:8787`.

If you want Lightning to attach to an already-running `llama.cpp` server instead, use external mode:

```bash
LLAMA_CPP_BASE_URL=http://127.0.0.1:8080 \
LIGHTNING_MODEL=/absolute/path/to/model.gguf \
npm run serve
```

Useful managed-mode settings:
- `LLAMA_CPP_BINARY`: path to the `llama-server` binary
- `LLAMA_CPP_HOST`: host for the managed `llama-server` process
- `LLAMA_CPP_PORT`: port for the managed `llama-server` process
- `LLAMA_CPP_ARGS`: extra raw arguments passed to `llama-server`
- `LLAMA_CPP_MANAGED=0`: force external-server mode

### Persistent thread endpoint

```bash
curl -s http://127.0.0.1:8787/v1/threads/demo/messages \
  -H 'content-type: application/json' \
  -d '{
    "message": {
      "content": "What should I work on next?"
    }
  }'
```

This appends the user message to the stored thread, generates through `llama.cpp`, appends the assistant reply, and returns the updated stats.

### OpenAI-compatible shim

Lightning also exposes:

```text
POST /v1/chat/completions
```

Use `thread_id` to make the request persistent:

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "/absolute/path/to/model.gguf",
    "thread_id": "demo-thread",
    "messages": [
      { "role": "user", "content": "Hello" }
    ]
  }'
```

If the same `thread_id` is reused, Lightning deduplicates the already-stored prefix of the transcript and only appends the new suffix. That makes it possible to keep a mostly OpenAI-style client while shifting thread continuity into Lightning.

One caveat:
- branch continuity is persistent, but any future summarization or cache-compaction layer may be nondeterministic, so "continue this old conversation" can eventually mean replaying the same visible thread into a slightly different latent state representation.
