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

### Checkpoints over transcripts

Lightning should treat a checkpoint as the primary runnable context object.

The long-term runtime shape is:
- request
- model
- context checkpoint
- response

not simply:
- transcript/context
- request
- model
- response

A visible conversation transcript is only one possible serialization of state.
It is useful for interoperability, but it is not the full runtime object.

Checkpoint state may eventually include:
- branch topology
- summaries and compactions
- thermal state
- backend/cache lineage
- latent state artifacts that are not faithfully represented by raw chat history

### Canonical replay

Lightning should eventually support deliberate reconstruction of a canonical context snapshot from a conversation transcript.

This is not the same thing as ordinary continuation.
It is a replay procedure whose job is to recover a deterministic, replayable checkpoint from visible conversation history.

A likely future approach is:
- replay the conversation
- run a model with fixed parameters
- ask it to generate a reasoning trace or intermediate state that would plausibly lead to the observed outputs
- iterate until the reconstructed state is close enough to the organically-grown state to serve as a canonical snapshot

The goal is not exact historical recovery.
The goal is a deterministic checkpoint representation that can be replayed later and used as a stable continuity primitive.

This should be treated as a future capability, not a Phase 1 requirement.

### Lightning-capable models

Not every model that can answer prompts or even call tools will necessarily be suitable for Lightning.

A model should be considered Lightning-capable if it can stably participate in:
- checkpoint-based continuation
- branch-aware state evolution
- summarization and compaction without severe drift
- recursive or multi-stage runtime flows without collapsing into loops or incoherence

This is best understood as an operational capability, not necessarily a deliberately architected vendor feature.
A model may simply either be capable of inhabiting the Lightning runtime or not.

This suggests at least three different notions of compatibility:
- backend-compatible: Lightning can run the model through an adapter
- interface-compatible: the model can satisfy basic request/response and tool-use expectations
- Lightning-capable: the model can reliably operate inside Lightning's checkpointed branch regime

This should eventually become an evaluation concern, but it does not need a concrete implementation in the current milestone.

## Product direction

Lightning should eventually become an end-user product, not only a systems project for enthusiasts.

The default user experience should aim for:
- click-to-install local models
- automatic hardware detection
- automatic choice of sane runtime settings
- advanced inference features enabled by default behind simple, marketable controls
- minimal or zero required knowledge about language models, quantization, serving stacks, or decoding internals

In other words:
- a non-technical user should be able to get a local inference endpoint running with essentially no manual tuning
- a power user should still be able to inspect, override, and customize the full stack when needed

This means the architecture should preserve room for:
- one-click model installation
- hardware-aware backend selection
- profile-based optimization presets
- user-facing feature labels that hide low-level inference complexity
- a "simple by default, deep when wanted" control surface

Lightning should win on both:
- raw runtime quality
- approachability for people who do not think of themselves as AI or systems users

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
