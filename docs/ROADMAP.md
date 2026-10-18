# Lightning Roadmap

Status as of October 2026: Phases 0 and 1 are done. Phase 2 is partly done: the `llama.cpp` adapter has native KV checkpoints — restore, fork and prefix reuse via llama-server slot save/restore, measured on one small CPU setup. Remaining Phase 2 gaps: `freeze`/`thaw`/`loadModel` are still emulated, there is no slot-file garbage collection and no persistence. Phases 3 onward have not started.

## Phase 0: Scaffold

Goal:
- establish the runtime vocabulary and repository structure

Deliverables:
- core types
- adapter contract
- scheduler skeleton
- branch store helpers
- architecture docs

## Phase 1: In-memory runtime

Goal:
- prove the branch model before integrating a real inference engine

Deliverables:
- branch registry
- branch creation/forking
- append-only branch logs
- checkpoint metadata
- thermal state transitions
- basic scheduler decisions

## Phase 2: First real backend

Goal:
- run Lightning locally on a laptop

Preferred first backends:
1. `llama.cpp` for GGUF
2. `MLX` for MLX-native models

Deliverables:
- one working adapter
- branch generate
- checkpoint/freeze/thaw
- native vs emulated capability reporting

Status:
- done: one working adapter (`llama.cpp`) plus the managed `llama-server` lifecycle
- done: branch generate
- done: checkpoint/restore, fork and prefix reuse as native KV operations when `llama-server` runs with `--slot-save-path` (startup probe; reported native or emulated, with the reason); measured 2026-10-18
- open: `freeze`, `thaw` and `loadModel` are still emulated
- open: slot-file garbage collection
- open: persistence (the branch store and checkpoint metadata are in memory)

## Phase 3: Successor compaction

Goal:
- make branch succession real

Deliverables:
- compress branch into successor
- archive old branch
- consult elder branch ephemerally
- explicit parent/child/successor lineage
- begin explicit checkpoint-head semantics instead of implicit transcript continuity

## Phase 4: Candle integration

Goal:
- rebuild Candle on top of Lightning instead of ad hoc prompt assembly

Deliverables:
- Candle uses Lightning branches for:
  - chat
  - background cognition
  - conversation trace
  - subconscious trace
- Candle UI becomes a client/operator surface for Lightning

## Phase 5: Hosted backend

Goal:
- add the serious server backend

Preferred target:
- `vLLM`

Deliverables:
- vLLM adapter
- better checkpoint/cache economics
- wider concurrency
- real branch scheduling under load

## Phase 6: Consumer local runtime

Goal:
- make Lightning approachable as a consumer-grade local inference product

Possible deliverables:
- guided local setup flow
- one-click recommended model installs
- automatic hardware detection and backend selection
- default optimization presets tuned without user intervention
- simple branded controls for advanced runtime features
- optional advanced configuration for power users

Principle:
- users should not need to understand inference internals in order to benefit from a better runtime

## Later Research Track

Goal:
- canonical replay from transcript to deterministic checkpoint

Possible deliverables:
- transcript-to-checkpoint reconstruction pipeline
- fixed-parameter replay mode
- canonical reasoning-trace synthesis
- deterministic snapshot export/import

Notes:
- this is a deliberate reconstruction workflow, not normal conversation continuation
- exact historical recovery is less important than producing a stable replayable checkpoint
