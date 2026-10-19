# The managed KV tree

Native KV checkpoints made a branch tip real saved state. That raises three new jobs, and this document describes how Lightning does each one today and what is still a design:

1. **Tiering and cleanup.** Slot files are about 12 KiB per token for a 0.5B model, so they must be kept, moved and deleted on purpose.
2. **Routing.** With many tips, a question should fan out only to the relevant ones.
3. **Compaction.** A long branch can be continued from a shorter summary of itself.

A fourth job ties them together: a **maintainer** that runs these steps as part of the system's own upkeep. It is a design only; see the last section.

Measured results are in the README and in [`docs/results/`](results). This page describes behaviour and rules.

## Ground rule: text is canonical, KV is a cache

The transcript is the source of truth. Every generation sends the whole transcript, and llama-server reuses only the common token prefix of whatever KV is in the slot. So a missing, stale or wrong slot file can make an answer slower, never wrong. Everything below follows from that: Lightning may delete any slot file at any time, and it does.

## 1. Tiers and cleanup

| Tier | Where the branch's KV is | Next turn costs |
|---|---|---|
| hot | resident in a llama-server slot | only the new suffix; no restore |
| warm | a slot file on disk | a restore, then only the new suffix |
| cold | nowhere; text only | a full prefill of the transcript |

The thermal planner ([`src/core/scheduler.ts`](../src/core/scheduler.ts)) already ranked branches into hot, warm and cold. `LightningRuntime.manageKv(activeBranchIds, maxHot)` runs it and passes every decision to the backend through the optional adapter hook `applyTemperature`. The llama.cpp adapter then:

- **hot**: prefers the idle slot that still holds the branch's KV (slot affinity) and skips the restore. Generation metadata reports `kv.tier` and `kv.residentHit`. `slotAffinity: false` turns this off.
- **warm**: restores the slot file, as before.
- **cold**: releases the branch's files, including those of its own checkpoints, and deletes every file nobody else holds. A fork or another branch that shares a file keeps it alive.

### Who holds a file

The adapter keeps a ledger ([`src/core/kv_cache.ts`](../src/core/kv_cache.ts)) of every slot file it saved: size and token count from llama-server's save response, plus its holders. A holder is a branch head (`branch:<id>`) or a checkpoint (`ckpt:<id>`).

- A new save replaces the branch's previous file. The old file is deleted at once unless a checkpoint or a fork still holds it.
- `close()` deletes every file the adapter still owns. The branch store is in memory, so the files are useless after the process ends.
- The API server calls `close()` on SIGINT and SIGTERM. At startup it sweeps files left by Lightning processes that are no longer running (`sweepOrphanSlotFiles`, same host only).

llama-server has no delete action. Files can only be deleted through the local path behind `--slot-save-path`. The adapter therefore needs `slotSaveDir` (`LLAMA_CPP_SLOT_SAVE_PATH` for the API server) pointing at that directory on the same host. Without it, cleanup is reported as disabled and nothing is deleted.

File names are `lightning-<pid>-<8 random hex>-<branch>-<n>.bin`. Two Lightning processes sharing one llama-server can no longer overwrite each other's files.

### The disk limit

The harm being prevented is disk exhaustion: a full disk fails llama-server's next save and everything else on that filesystem. The limit is derived from that, not picked:

- **Reserve.** Keep enough free space for every slot to save a full context: `slots × n_ctx per slot × bytes per token`. The bytes per token come from the save responses Lightning has seen, and n_ctx from `GET /props`. Example: on the Cedar setup that is 4 × 8,192 × about 12.3 KB, about 400 MB.
- **Filesystem bound.** Lightning's own files may use whatever the filesystem has free beyond that reserve. They count as reclaimable, because evicting them frees the space.
- **Operator budget.** An operator can set `kvDiskBudgetBytes` as a tighter ceiling. The default has no budget and no other cap.

After every save, the adapter computes the limit (`kvCacheReport().limit` says which bound applied). If it is over, it evicts files coldest first:

1. files only checkpoints hold, before branch heads;
2. cold before warm or frozen, warm before hot;
3. within that, least recently used first.

The file just saved is never evicted. An evicted branch simply goes cold.

### Invalidation

KV bytes are only valid for one llama.cpp build, one model file and quantization, and one per-slot context. The adapter fingerprints all four from `GET /props` (`build_info`, `model_path`, `model_ftype`, `default_generation_settings.n_ctx`). If the fingerprint changes, every slot file is dropped, and the change is recorded in `kvCacheReport().lastInvalidation` with both fingerprint ids.

The check runs at probe time, after any failed restore, and whenever `checkKvFingerprint()` is called. Unlike a re-probe, `checkKvFingerprint()` does not reset the slot pool, so it is safe while generations are running.

A failed restore never fails the turn. The file is dropped, the slot is erased, and the turn is answered from the full transcript. Generation metadata carries `kv.restoreFailed`.

Known gap: a different model file written to the same path, with the same quantization label, would not change the fingerprint.

## 2. Router v0

[`src/core/router.ts`](../src/core/router.ts):

- **Summary per branch.** The summary uses Vane (`@owl-kestrel/vane`, O+K's deterministic tree-fitting text level-of-detail library) when it is installed. Otherwise it falls back to a plain extractive outline: the first sentence of each turn, then `+ N more`. Every summary records which method made it. Vane is not a dependency of this public repository. It is loaded with a dynamic import and used only if something already installed it; there is never a `file:` path.
  - The Vane tree has one node per turn. Its title is the first sentence, its summary the first 400 characters, and its detail the full text. The nodes are equally ranked, so Vane's coverage-first fit shows as many turns as fit.
- **Scoring.** BM25 over the summary text (or over the full transcript with `index: "full"`), normalized to the best match, plus `0.15 ×` a recency term with a 24-hour half-life. Both are v0 defaults, not tuned constants. When nothing matches lexically, the most recent tips win, and `lexical: 0` shows that.
- **`fanOutRouted(query, k)`.** Routes, then answers the query on the top-k tips in parallel. By default this is ephemeral: the branches do not grow. Use `persist: true` to append and checkpoint, as `fanOutFromCheckpoints` does.

Not done yet: embeddings. llama.cpp can serve them, but an embedding model was not run in this slice. The lexical router is the measured baseline that an embedding scorer must beat.

## 3. Compaction v0

`LightningRuntime.compactBranch(branchId, { newBranchId, budgetTokens })`:

1. Fits the conversation to `budgetTokens` with Vane, or the extractive fallback, which is recorded.
2. Creates a new branch whose messages are:
   - the original's leading system messages, verbatim;
   - one system message carrying the compacted context.
3. Prefills that branch once, so its KV is saved, and checkpoints it.

The original branch is untouched. The new branch records `metadata.compactedFrom` and the compaction method and sizes. It is deliberately not a child in `parentId` terms, so it never inherits the original's KV.

Vane compaction here is extractive: Vane chooses which turns to show at which level of detail. It does not paraphrase. A fact deep inside a turn survives only if the budget reaches that turn's summary or detail level. The eval measures exactly that, and reports `factRetained` along with answer drift.

## 4. The maintainer (design, not built)

Goal: a managed tree that keeps itself in shape without anyone calling `manageKv` or `compactBranch` by hand. Jon's direction is that this is triggered by events, with timers only as a safety net.

**Events and the work they start:**

| Event | Work |
|---|---|
| a turn completes on a branch (the API server already sees this) | `manageKv([branch])` so the active branch stays hot; if the branch passed a length threshold, queue a compaction prefill |
| a branch has seen no turn for a while | `applyTemperature(branch, "cold")`. The trigger is the absence of an event, measured when the next event or the safety-net tick arrives, not by polling each branch. |
| a slot file save pushes usage over the disk limit | eviction (already built: runs after every save) |
| a failed restore, or a llama-server restart reported by the process manager | `checkKvFingerprint()` (already built for failed restores) |
| spare capacity: Thermals reports the host idle, or llama-server has idle slots and an empty queue | run queued background work: compaction prefills, re-warming branches the planner expects next |
| Lightning shutdown | `close()` (already built in the API server) |

**Background work** is low priority and preemptible. It only uses a slot that no foreground request is waiting for, and it yields as soon as a request arrives. Host load comes from Thermals' published state when it is installed, with a degraded local check otherwise: Lightning prefers Thermals but does not depend on it.

**Safety-net timer.** A single fallback tick re-runs the planner and the eviction check, for the case where events stop arriving: a crashed consumer, or a missed signal. Its period should come from the measured event rate and recovery bounds, not a guess, and the tick records whether it found anything to fix. A tick that keeps finding work means an event path is missing.

**Observability.** Everything the maintainer does is already visible in `kvCacheReport()`: counters for saved, deleted, evicted, dropped-cold, restore failures, invalidations and resident hits; the current limit; the last eviction and invalidation. The maintainer should add its queue, its last action and its next trigger, so an operator can see what it will do next.

Open questions for the build:

- the compaction trigger: a length threshold, or the measured re-prefill cost of the branch;
- whether a compacted branch should replace the original as the routing candidate;
- how to persist the branch tree, so slot files can outlive a process.
