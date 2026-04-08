# Lightning Roadmap

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
- run Lightning locally on Jon's Mac

Preferred first backends:
1. `llama.cpp` for GGUF
2. `MLX` for MLX-native models

Deliverables:
- one working adapter
- branch generate
- checkpoint/freeze/thaw
- native vs emulated capability reporting

## Phase 3: Successor compaction

Goal:
- make branch succession real

Deliverables:
- compress branch into successor
- archive old branch
- consult elder branch ephemerally
- explicit parent/child/successor lineage

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
