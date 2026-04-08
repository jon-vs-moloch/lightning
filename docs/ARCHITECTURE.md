# Lightning Architecture

Lightning is a hierarchical persistent cognition architecture in which many mostly append-only branches are stratified by:
- write frequency
- compression depth
- time horizon
- semantic responsibility

The architecture is designed to minimize broad cache invalidation while preserving simultaneous access to:
- hot realtime state
- active project continuity
- low-frequency durable memory

## Core Ideas

### Branches

A branch is the unit of runtime continuity.

Each branch has:
- identity
- parent/child relationships
- category
- responsibility boundary
- thermal state
- checkpoint lineage
- backend association

### Frequency hierarchy

Lightning is primarily a write-frequency hierarchy.

- Hot branches: volatile, local, high-churn
- Mid-frequency branches: active project/task state
- Elder branches: compressed, durable, slow-changing

### Thermal management

Not every branch should remain equally live.

Branches may be:
- hot
- warm
- cold
- frozen

This allows Lightning to focus on a relevant subtree while leaving unrelated work inactive.

### Delegation

Lightning wants both:
- subagents
- superagents

Subagents absorb local churn and return compressed results.

Superagents absorb accumulated local history and rewrite it into slower, more durable form.

### Successor-based compaction

Compaction should usually create a successor representation rather than endlessly rewriting the same branch.

This preserves:
- continuity
- cache locality
- explicit inheritance

### Semantic routing

The branch tree is not only a compression hierarchy.

It is also a routing hierarchy.

Queries should be routed into semantically relevant branches rather than broadcast to every leaf.

### Upward passes

Upward summarization is the natural pass through the tree.

A leaf can summarize locally to its parent, the parent can summarize to its parent, and so on.

This keeps each write local to the end of a branch's active tail.

## Backend split

Lightning should own:
- branch topology
- thermal scheduling
- delegation
- compaction
- succession

Backends should own:
- model loading
- token generation
- batching
- native cache primitives

Likely early backends:
- `llama.cpp` for local GGUF
- `MLX` for Apple-native local inference
- `vLLM` for the serious hosted/server backend
