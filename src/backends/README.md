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

1. takes an idle slot, preferring one that still holds the branch's KV (hot: no restore); otherwise restores the branch's last saved KV file (warm), or erases the slot when the branch has no file (cold);
2. sends the full transcript, so correctness never depends on the file — `llama-server` only reuses the common token prefix;
3. saves the slot to a new file afterwards.

Mapping to the branch model: forks inherit the parent's KV file, checkpoints record it, and restore puts the recorded file back. `--slot-save-path` on `llama-server` decides where the files land. Files are named `lightning-<host tag>-<pid>-<random>-<branch>-<n>.bin`, so two Lightning processes sharing one server never collide.

Slot files are a derived cache and are managed (see [`docs/MANAGED_TREE.md`](../../docs/MANAGED_TREE.md)). With `slotSaveDir` set to the same directory on the local host:

- a superseded file is deleted as soon as no branch head, fork or checkpoint holds it;
- after each save, files are evicted coldest-first when Lightning's files exceed the disk limit: the filesystem's free space minus a reserve big enough for every slot to save a full context (measured bytes per token × per-slot context), or a tighter operator `kvDiskBudgetBytes`;
- `applyTemperature(branch, "cold")` and `deleteBranch` drop a branch's files (head and checkpoints); `close()` deletes everything the adapter owns; `sweepOrphanSlotFiles()` removes files of exited Lightning processes on this host only (files tagged with another host are left alone);
- a change of llama.cpp build, model path, quantization or per-slot context (from `GET /props`) invalidates every file; a failed restore drops the file and answers from the transcript.

`kvCacheReport()` (also under `cacheStats().kvCache`) shows files, bytes, bytes per token, the current limit and which bound applied, counters, the last eviction and invalidation, and which file each slot holds. llama-server has no delete action, so without `slotSaveDir` nothing can be deleted and the report says cleanup is disabled.

`LightningRuntime.fanOutFromCheckpoints()` runs one request against several checkpoints on distinct branches in parallel, one slot each. Fan-out width is capped by the slot count; extra requests wait for a free slot.

Even in native mode, `loadModel`, `freeze`, `thaw` and `ephemeralConsult` stay emulated at the message level. When the server has no slot save path, all branch operations fall back to message-level emulation — and the adapter says so, with the reason.
