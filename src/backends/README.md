# Backends

Lightning backends should implement the adapter contract in [src/core/adapter.ts](../core/adapter.ts).

Planned early backends:
- `llama.cpp`
- `MLX`
- later `vLLM`

The adapter should expose whether branch operations are:
- native
- emulated
- unsupported

This repository should not assume that all backends offer identical cache/state primitives.

## llama.cpp

[`llama_cpp.ts`](llama_cpp.ts) talks to `llama-server` over HTTP and can give Lightning real KV checkpoints.

Native mode: `probeKvSupport()` checks `GET /props` for `total_slots` and tries a real slot save. Only if both work are checkpoint, restore, fork and prefix reuse reported `native`. Otherwise they stay `emulated`, and the reason is kept in the capability status (the API server logs it at startup and warns).

In native mode, each generation:

1. restores the branch's last saved KV file into an idle slot;
2. sends the full transcript, so correctness never depends on the file — `llama-server` only reuses the common token prefix;
3. saves the slot to a new file afterwards.

Mapping to the branch model: forks inherit the parent's KV file, checkpoints record it, and restore puts the recorded file back. `--slot-save-path` on `llama-server` decides where the files land; they are named per generation and nothing deletes them yet.

`LightningRuntime.fanOutFromCheckpoints()` runs one request against several checkpoints on distinct branches in parallel, one slot each. Fan-out width is capped by the slot count; extra requests wait for a free slot.

Even in native mode, `loadModel`, `freeze`, `thaw` and `ephemeralConsult` stay emulated at the message level. When the server has no slot save path, all branch operations fall back to message-level emulation — and the adapter says so, with the reason.
