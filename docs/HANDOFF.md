# Handoff

This repository was scaffolded as the sister project to Candle.

The intent is:
- Lightning becomes the reusable cognition/runtime substrate
- Candle becomes a client/product running on top of Lightning once the substrate is real

## What Exists

The current repo contains:
- architecture docs
- roadmap
- backend adapter contract
- initial TypeScript runtime skeleton

It does not yet contain:
- real persistence
- real backend integration
- real scheduler logic
- real cache checkpointing

## Immediate Next Step

Build the first end-to-end in-memory runtime slice:

1. `BranchStore`
   - create branch
   - fork branch
   - freeze/thaw branch
   - checkpoint metadata

2. `Scheduler`
   - choose which branches are hot/warm/cold
   - enforce simple thermal rules

3. `Adapter capability model`
   - report native vs emulated support

4. one fake adapter
   - enough to exercise the runtime without committing to a backend

## First Real Backend

Because development is Mac-first, the likely order is:
1. `llama.cpp`
2. `MLX`
3. later `vLLM`

The key principle is:
- do not rely only on OpenAI-compatible server wrappers
- Lightning needs branch/state control, not just completions

## What To Preserve From Candle

Carry forward these lessons:
- chat and background lanes should remain conceptually distinct
- managed state must be inspectable
- proactive/background behavior should be visible in trace form
- thread/branch stability matters more than prompt cleverness
- write-frequency stratification is the real optimization target

## Practical Goal

Get to a point where Candle can ask Lightning to:
- open a chat branch
- open a background branch
- append to each independently
- checkpoint/freeze/thaw them
- consult elder branches ephemerally

Once that exists, Candle can be rebuilt against Lightning instead of growing more internal engine logic.
