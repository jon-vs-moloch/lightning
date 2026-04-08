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
