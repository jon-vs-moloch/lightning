import { createHash, randomBytes } from "node:crypto";
import * as os from "node:os";
import { join } from "node:path";
import * as fsp from "node:fs/promises";
import {
  KvFileLedger,
  computeKvDiskLimit,
  kvFingerprintId,
  kvReserveBytes,
  tierRank,
  type KvDiskLimit,
  type KvFileEntry,
  type KvFingerprint
} from "../core/kv_cache.js";
import type { LightningAdapter } from "../core/adapter.js";
import type {
  AdapterCapabilities,
  BranchCheckpoint,
  BranchRecord,
  BranchStats,
  BranchTemperature,
  GenerateRequest,
  GenerateResult,
  LlamaCppTimings,
  MessageRecord
} from "../core/types.js";

export interface LlamaCppAdapterOptions {
  baseUrl: string;
  defaultModelRef?: string;
  fetchImpl?: typeof fetch;
  slotFilePrefix?: string;
  /**
   * Local path of llama-server's `--slot-save-path` (same host). When set,
   * Lightning deletes slot files it no longer needs; without it files cannot
   * be deleted (llama-server has no delete action) and cleanup is reported
   * as disabled.
   */
  slotSaveDir?: string;
  /**
   * Optional operator ceiling for Lightning's own slot files, in bytes.
   * Without it the limit is derived from the filesystem: our files may grow
   * only while the filesystem keeps `kvReserveBytes` free (enough for every
   * slot to save a full context at the measured bytes/token), which prevents
   * disk exhaustion; there is no other cap.
   */
  kvDiskBudgetBytes?: number;
  /**
   * Hot tier: reuse a slot that still holds a branch's KV instead of restoring
   * its file (default true). Set false to always restore from disk (warm),
   * e.g. to measure the difference.
   */
  slotAffinity?: boolean;
  /** Filesystem hooks for tests. */
  fsImpl?: LlamaCppFs;
}

/**
 * Filesystem hooks so tests can stub disk operations without touching a real
 * filesystem. Mirrors the small subset of node:fs/promises Lightning uses.
 */
export interface LlamaCppFs {
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  statfs(path: string): Promise<{ bavail: number | bigint; bsize: number | bigint }>;
}

const defaultLlamaCppFs: LlamaCppFs = {
  unlink: (path) => fsp.unlink(path),
  readdir: (path) => fsp.readdir(path),
  statfs: (path) => fsp.statfs(path)
};

/**
 * First 8 hex chars of sha256(hostname): identifies the host a slot file was
 * created on, so a slot directory shared across hosts can tell apart files of
 * processes running on different machines.
 */
export function hostTag(): string {
  return createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
}

/**
 * Per-host, per-process file prefix (`lightning-<8 hex host>-<pid>-<8 hex>`), so
 * two Lightning processes sharing one llama-server — even on different hosts
 * sharing one directory — never overwrite each other's slot files, and the
 * orphan sweep only ever touches same-host files.
 * An explicit `slotFilePrefix` option still wins.
 */
export function defaultSlotFilePrefix(): string {
  return `lightning-${hostTag()}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

/** Coerce llama-server save-response numbers; missing/NaN counts as 0. */
function kvNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** True when `pid` is a live process on this host (signal 0 probes existence). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown })?.code === "EPERM";
  }
}

export interface KvSlotProbe {
  mode: "native" | "emulated";
  reason: string;
  slots: number;
  buildInfo?: string;
}

interface LlamaCppBranchState {
  branch: BranchRecord;
  messages: MessageRecord[];
  summaries: string[];
  frozen: boolean;
  kvFile?: string;
  lastTimings?: LlamaCppTimings;
}

interface LlamaCppCheckpointSnapshot {
  checkpoint: BranchCheckpoint;
  messages: MessageRecord[];
  summaries: string[];
  frozen: boolean;
  kvFile?: string;
}

interface LlamaCppChatCompletionResponse {
  id?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string;
    message?: {
      role?: string;
      content?: string | null;
    };
    text?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  timings?: LlamaCppTimings;
}

/**
 * llama.cpp KV checkpointing.
 *
 * In native mode each generation restores the branch's last saved slot file
 * into an idle slot, sends the full transcript (so correctness never depends
 * on the KV file; it is a pure accelerator), and saves the slot afterwards.
 * Slot files are immutable and named per process and per generation
 * (`defaultSlotFilePrefix()` + branch + counter), and they are a derived
 * cache: the transcript text is canonical and always re-sent, so deleting a
 * slot file only costs a re-prefill. Superseded files are deleted as soon as
 * no branch, fork or checkpoint holds them (when `slotSaveDir`, llama-server's
 * local `--slot-save-path`, is configured; without it files cannot be deleted
 * because llama-server has no delete action).
 */
export class LlamaCppAdapter implements LightningAdapter {
  readonly id = "llama.cpp";
  readonly label = "llama.cpp HTTP adapter";

  private readonly baseUrl: string;
  private readonly defaultModelRef?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly loadedModels = new Set<string>();
  private readonly branches = new Map<string, LlamaCppBranchState>();
  private readonly checkpoints = new Map<string, LlamaCppCheckpointSnapshot>();
  private readonly slotFilePrefix: string;
  private readonly ledger = new KvFileLedger();
  private readonly slotSaveDir?: string;
  private readonly kvDiskBudgetBytes?: number;
  private readonly slotAffinity: boolean;
  private readonly fs: LlamaCppFs;
  private readonly kvCounters = {
    saved: 0,
    filesDeleted: 0,
    bytesDeleted: 0,
    deleteErrors: 0,
    releasedWithoutDir: 0,
    evictedForBudget: 0,
    droppedCold: 0,
    restoreFailures: 0,
    invalidations: 0,
    residentHits: 0,
    restores: 0
  };

  private kvMode: "native" | "emulated" = "emulated";
  private kvReason = "not probed: call probeKvSupport() to enable native KV checkpoints";
  private slotCount = 0;
  private buildInfo?: string;
  private freeSlots: number[] = [];
  private slotWaiters: Array<(slot: number) => void> = [];
  private fileCounter = 0;
  private fingerprint?: KvFingerprint;
  private fingerprintIdValue?: string;
  /** Files an in-flight generation is about to restore; budget eviction skips them. */
  private readonly kvInUse = new Map<string, number>();
  /** slot -> slot file currently loaded in it (hot tier affinity). */
  private readonly slotResident = new Map<number, string>();
  private lastLimit?: KvDiskLimit & { reserveBytes: number; fsAvailableBytes: number | null; at: string };
  private lastEviction?: Record<string, unknown>;
  private lastInvalidation?: Record<string, unknown>;

  constructor(options: LlamaCppAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.defaultModelRef = options.defaultModelRef;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.slotSaveDir = options.slotSaveDir;
    this.kvDiskBudgetBytes = options.kvDiskBudgetBytes;
    this.slotAffinity = options.slotAffinity ?? true;
    this.fs = options.fsImpl ?? defaultLlamaCppFs;
    this.slotFilePrefix = options.slotFilePrefix ?? defaultSlotFilePrefix();
  }

  async probeKvSupport(): Promise<KvSlotProbe> {
    try {
      const propsResponse = await this.fetchImpl(`${this.baseUrl}/props`, {
        method: "GET",
        headers: { "accept": "application/json" }
      });

      if (!propsResponse.ok) {
        this.kvMode = "emulated";
        this.kvReason = `GET /props did not report total_slots (HTTP ${propsResponse.status})`;
        this.slotCount = 0;
        this.freeSlots = [];
        this.buildInfo = undefined;
        return this.kvStatus();
      }

      const props = (await propsResponse.json()) as {
        total_slots?: unknown;
        build_info?: unknown;
        model_path?: unknown;
        model_ftype?: unknown;
        default_generation_settings?: { n_ctx?: unknown };
      };
      const totalSlots = props.total_slots;
      const slotCount =
        typeof totalSlots === "number" && Number.isInteger(totalSlots) && totalSlots >= 1
          ? totalSlots
          : 0;

      if (slotCount < 1) {
        this.kvMode = "emulated";
        this.kvReason = `GET /props did not report total_slots (HTTP ${propsResponse.status})`;
        this.slotCount = 0;
        this.freeSlots = [];
        this.buildInfo = undefined;
        return this.kvStatus();
      }

      if (typeof props.build_info === "string") {
        this.buildInfo = props.build_info;
      }

      // KV slot files are valid only for the exact build, model file,
      // quantization and per-slot context, so fingerprint the server here.
      const fingerprint = this.fingerprintFromProps(props);
      await this.adoptFingerprint(fingerprint);

      const probeFilename = `${this.slotFilePrefix}-probe.bin`;
      const probeResponse = await this.postJson("/slots/0?action=save", {
        filename: probeFilename
      });

      if (probeResponse.ok) {
        this.kvMode = "native";
        this.slotCount = slotCount;
        this.freeSlots = Array.from({ length: slotCount }, (_, index) => index);
        this.kvReason = `llama-server slot save/restore active: ${slotCount} slots (${this.buildInfo})`;
        if (this.slotSaveDir !== undefined) {
          await this.deleteFiles([{ name: probeFilename, bytes: 0 }]);
        }
      } else {
        const bodyText = (await probeResponse.text()).slice(0, 200);
        this.kvMode = "emulated";
        this.kvReason = `slot save refused: HTTP ${probeResponse.status} ${bodyText}`;
        this.slotCount = 0;
        this.freeSlots = [];
      }

      return this.kvStatus();
    } catch (error) {
      this.kvMode = "emulated";
      this.kvReason = `probe failed: ${error instanceof Error ? error.message : String(error)}`;
      this.slotCount = 0;
      this.freeSlots = [];
      return this.kvStatus();
    }
  }

  kvStatus(): KvSlotProbe {
    return {
      mode: this.kvMode,
      reason: this.kvReason,
      slots: this.slotCount,
      ...(this.buildInfo === undefined ? {} : { buildInfo: this.buildInfo })
    };
  }

  /**
   * Extract the KV fingerprint from a GET /props body: KV bytes are only
   * valid for the exact llama.cpp build, model file, quantization and
   * per-slot context; any change invalidates every slot file.
   */
  private fingerprintFromProps(props: any): KvFingerprint {
    const nCtx = props?.default_generation_settings?.n_ctx;
    return {
      buildInfo: typeof props?.build_info === "string" ? props.build_info : undefined,
      modelPath: typeof props?.model_path === "string" ? props.model_path : undefined,
      modelFtype: typeof props?.model_ftype === "string" ? props.model_ftype : undefined,
      nCtxPerSlot:
        typeof nCtx === "number" && Number.isInteger(nCtx) && nCtx > 0 ? nCtx : undefined
    };
  }

  /**
   * Adopt a fingerprint; when it differs from the previous one, every slot
   * file is invalidated first. Returns whether an invalidation happened.
   */
  private async adoptFingerprint(fp: KvFingerprint): Promise<boolean> {
    const id = kvFingerprintId(fp);
    const previous = this.fingerprintIdValue;
    const changed = previous !== undefined && previous !== id;
    if (changed) {
      await this.invalidateAllKv(previous, id);
    }
    this.fingerprint = fp;
    this.fingerprintIdValue = id;
    return changed;
  }

  /**
   * Re-reads GET /props WITHOUT touching the slot pool (safe while
   * generations are in flight, unlike probeKvSupport) and invalidates every
   * slot file if the build, model, quantization or context changed.
   */
  public async checkKvFingerprint(): Promise<{ changed: boolean; fingerprintId?: string; error?: string }> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/props`, {
        method: "GET",
        headers: { "accept": "application/json" }
      });
      if (!response.ok) {
        return { changed: false, error: `GET /props failed with HTTP ${response.status}` };
      }
      const props = await response.json();
      const changed = await this.adoptFingerprint(this.fingerprintFromProps(props));
      return {
        changed,
        ...(this.fingerprintIdValue === undefined ? {} : { fingerprintId: this.fingerprintIdValue })
      };
    } catch (error) {
      return {
        changed: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /** Drop every ledger slot file because the KV fingerprint changed. */
  private async invalidateAllKv(from: string, to: string): Promise<void> {
    let filesDropped = 0;
    for (const name of this.ledger.names()) {
      await this.dropKvFile(name, "invalidated");
      filesDropped++;
    }
    this.kvCounters.invalidations++;
    this.lastInvalidation = {
      at: new Date().toISOString(),
      from,
      to,
      filesDropped
    };
  }

  capabilities(): AdapterCapabilities {
    if (this.kvMode === "native") {
      return {
        loadModel: "emulated",
        checkpoint: "native",
        restore: "native",
        freeze: "emulated",
        thaw: "emulated",
        fork: "native",
        ephemeralConsult: "emulated",
        prefixReuse: "native"
      };
    }

    return {
      loadModel: "emulated",
      checkpoint: "emulated",
      restore: "emulated",
      freeze: "emulated",
      thaw: "emulated",
      fork: "emulated",
      ephemeralConsult: "emulated",
      prefixReuse: "unsupported"
    };
  }

  async loadModel(modelRef: string): Promise<void> {
    this.loadedModels.add(modelRef);
  }

  async unloadModel(modelRef: string): Promise<void> {
    this.loadedModels.delete(modelRef);
  }

  async listLoadedModels(): Promise<string[]> {
    return [...this.loadedModels];
  }

  async createBranch(branch: BranchRecord): Promise<void> {
    const parentKvFile = branch.parentId ? this.branches.get(branch.parentId)?.kvFile : undefined;

    const state: LlamaCppBranchState = {
      branch: this.cloneBranch(branch),
      messages: [],
      summaries: [],
      frozen: branch.temperature === "frozen"
    };
    this.branches.set(branch.id, state);
    await this.setBranchKv(state, parentKvFile);
  }

  async deleteBranch(branchId: string): Promise<void> {
    const state = this.branches.get(branchId);
    if (state) {
      await this.setBranchKv(state, undefined);
    }
    this.branches.delete(branchId);
    // Checkpoint snapshots stay inspectable by the store, but they no longer
    // hold on to their KV files: release (and delete when freed) each one.
    for (const snapshot of this.checkpoints.values()) {
      if (snapshot.checkpoint.branchId !== branchId || snapshot.kvFile === undefined) {
        continue;
      }
      await this.deleteFiles(
        this.releaseHolder(snapshot.kvFile, "ckpt:" + snapshot.checkpoint.id)
      );
      snapshot.kvFile = undefined;
    }
  }

  async appendMessages(branchId: string, messages: MessageRecord[]): Promise<void> {
    const state = this.requireBranch(branchId);
    state.messages.push(...messages.map((message) => this.cloneMessage(message)));
  }

  async appendSummary(branchId: string, summaryArtifact: string): Promise<void> {
    this.requireBranch(branchId).summaries.push(summaryArtifact);
  }

  async generate(branchId: string, request: GenerateRequest): Promise<GenerateResult> {
    const state = this.requireBranch(branchId);
    return this.generateFromMessages(
      state,
      request.messages ?? state.messages,
      request,
      true
    );
  }

  async generateEphemeral(branchId: string, request: GenerateRequest): Promise<GenerateResult> {
    const state = this.requireBranch(branchId);
    const result = await this.generateFromMessages(
      state,
      request.messages ?? state.messages,
      request,
      false
    );
    return {
      ...result,
      metadata: {
        ...result.metadata,
        ephemeral: true
      }
    };
  }

  async checkpointBranch(branchId: string, label?: string): Promise<BranchCheckpoint> {
    const state = this.requireBranch(branchId);
    const checkpointId = `llama-cpp-${branchId}-${this.checkpoints.size + 1}`;
    const checkpoint: BranchCheckpoint = {
      id: checkpointId,
      branchId,
      createdAt: new Date().toISOString(),
      label,
      summary: state.summaries.at(-1),
      backendRef: checkpointId
    };

    const snapshot: LlamaCppCheckpointSnapshot = {
      checkpoint,
      messages: state.messages.map((message) => this.cloneMessage(message)),
      summaries: [...state.summaries],
      frozen: state.frozen
    };
    if (state.kvFile !== undefined && this.ledger.has(state.kvFile)) {
      this.ledger.hold(state.kvFile, "ckpt:" + checkpointId);
      snapshot.kvFile = state.kvFile;
    }
    this.checkpoints.set(checkpoint.id, snapshot);

    return { ...checkpoint };
  }

  async restoreBranch(branchId: string, checkpointRef: string): Promise<void> {
    const state = this.requireBranch(branchId);
    const snapshot = this.checkpoints.get(checkpointRef);
    if (!snapshot || snapshot.checkpoint.branchId !== branchId) {
      throw new Error(`Unknown llama.cpp checkpoint for branch ${branchId}: ${checkpointRef}`);
    }

    state.messages = snapshot.messages.map((message) => this.cloneMessage(message));
    state.summaries = [...snapshot.summaries];
    state.frozen = snapshot.frozen;
    await this.setBranchKv(
      state,
      snapshot.kvFile && this.ledger.has(snapshot.kvFile) ? snapshot.kvFile : undefined
    );
    state.lastTimings = undefined;
  }

  async freezeBranch(branchId: string): Promise<void> {
    this.requireBranch(branchId).frozen = true;
  }

  async thawBranch(branchId: string): Promise<void> {
    this.requireBranch(branchId).frozen = false;
  }

  /**
   * Tier control: "cold" releases every slot file held by this branch or by
   * its own checkpoints and deletes what is freed (a file another branch or
   * its checkpoints still hold survives); a later generation re-prefills
   * from the canonical transcript. Other temperatures only record the tier
   * used by budget eviction rankings.
   */
  public async applyTemperature(branchId: string, temperature: BranchTemperature): Promise<void> {
    const state = this.branches.get(branchId);
    if (state === undefined) return;
    state.branch.temperature = temperature;
    if (temperature !== "cold") return;

    const freed: string[] = [];
    for (const entry of this.ledger.entries()) {
      // Which of this branch's holders keep the file alive?
      const relevant: Array<{ holder: string; snapshot?: LlamaCppCheckpointSnapshot }> = [];
      for (const holder of entry.holders) {
        if (holder === `branch:${branchId}`) {
          relevant.push({ holder });
        } else if (holder.startsWith("ckpt:")) {
          const snapshot = this.checkpoints.get(holder.slice("ckpt:".length));
          if (snapshot?.checkpoint.branchId === branchId) {
            relevant.push({ holder, snapshot });
          }
        }
      }
      if (relevant.length === 0) continue;

      const bytes = entry.bytes;
      const releasedNames: string[] = [];
      for (const { holder, snapshot } of relevant) {
        // release() only deletes the entry when the LAST holder goes away,
        // so files still held by another branch survive.
        releasedNames.push(...this.ledger.release(entry.name, holder));
        if (snapshot !== undefined && snapshot.kvFile === entry.name) {
          snapshot.kvFile = undefined;
        }
      }
      if (state.kvFile === entry.name) {
        state.kvFile = undefined;
      }
      if (releasedNames.length > 0) {
        freed.push(...releasedNames);
        await this.deleteFiles(releasedNames.map((name) => ({ name, bytes })));
        this.kvCounters.droppedCold += releasedNames.length;
      }
    }

    const freedSet = new Set(freed);
    for (const [slot, file] of [...this.slotResident]) {
      if (freedSet.has(file)) this.slotResident.delete(slot);
    }
  }

  /**
   * Forget a slot file entirely (whoever holds it) and delete it from disk.
   * Branches and checkpoints that pointed at it become cold: their next
   * generation re-prefills from the canonical transcript.
   */
  private async dropKvFile(
    name: string,
    reason: "budget" | "cold" | "invalidated" | "restore-failed"
  ): Promise<void> {
    const bytes = this.ledger.get(name)?.bytes ?? 0;
    const holders = this.ledger.drop(name);
    for (const holder of holders) {
      if (holder.startsWith("branch:")) {
        const state = this.branches.get(holder.slice("branch:".length));
        if (state?.kvFile === name) state.kvFile = undefined;
      } else if (holder.startsWith("ckpt:")) {
        const snapshot = this.checkpoints.get(holder.slice("ckpt:".length));
        if (snapshot?.kvFile === name) snapshot.kvFile = undefined;
      }
    }
    for (const [slot, file] of [...this.slotResident]) {
      if (file === name) this.slotResident.delete(slot);
    }
    await this.deleteFiles([{ name, bytes }]);
    if (reason === "budget") this.kvCounters.evictedForBudget++;
    if (reason === "cold") this.kvCounters.droppedCold++;
  }

  /**
   * Keep Lightning's slot files inside the disk limit (see computeKvDiskLimit):
   * an optional operator budget, and otherwise the filesystem itself, keeping
   * kvReserveBytes free so every slot can still save a full context. The harm
   * prevented is disk exhaustion; there is no other cap. Coldest files go
   * first (cold < warm/frozen < hot, branch heads above checkpoint-only files,
   * then least recently used).
   */
  private async enforceKvBudget(protect: Set<string>): Promise<void> {
    const at = new Date().toISOString();
    if (this.slotSaveDir === undefined) {
      this.lastLimit = {
        limitBytes: Number.POSITIVE_INFINITY,
        boundBy: "none",
        reserveBytes: 0,
        fsAvailableBytes: null,
        at
      };
      return;
    }

    let fsAvailableBytes: number | undefined;
    try {
      const st = await this.fs.statfs(this.slotSaveDir);
      fsAvailableBytes = Number(st.bavail) * Number(st.bsize);
    } catch {
      fsAvailableBytes = undefined;
    }

    const reserveBytes = kvReserveBytes({
      slots: this.slotCount,
      nCtxPerSlot: this.fingerprint?.nCtxPerSlot,
      bytesPerToken: this.ledger.bytesPerToken()
    });
    const limit = computeKvDiskLimit({
      budgetBytes: this.kvDiskBudgetBytes,
      fsAvailableBytes,
      ownBytes: this.ledger.totalBytes(),
      reserveBytes
    });
    this.lastLimit = { ...limit, reserveBytes, fsAvailableBytes: fsAvailableBytes ?? null, at };

    const victims = this.ledger.planEviction(
      limit.limitBytes,
      (entry) => this.rankKvFile(entry),
      protect
    );
    for (const name of victims) {
      await this.dropKvFile(name, "budget");
    }
    if (victims.length > 0) {
      this.lastEviction = {
        at,
        evicted: victims.length,
        limitBytes: limit.limitBytes,
        boundBy: limit.boundBy,
        ownBytesAfter: this.ledger.totalBytes()
      };
    }
  }

  /** Eviction rank of a slot file: the highest tier among its holders (lower goes first). */
  private rankKvFile(entry: KvFileEntry): number {
    let rank = 0;
    for (const holder of entry.holders) {
      let holderRank = 0;
      if (holder.startsWith("branch:")) {
        const temperature = this.branches.get(holder.slice("branch:".length))?.branch.temperature;
        holderRank = temperature === undefined ? 0 : tierRank(temperature) + 0.5;
      } else if (holder.startsWith("ckpt:")) {
        const branchId = this.checkpoints.get(holder.slice("ckpt:".length))?.checkpoint.branchId;
        const temperature =
          branchId === undefined ? undefined : this.branches.get(branchId)?.branch.temperature;
        holderRank = temperature === undefined ? 0 : tierRank(temperature);
      }
      rank = Math.max(rank, holderRank);
    }
    return rank;
  }

  async branchStats(branchId: string): Promise<BranchStats> {
    const state = this.requireBranch(branchId);
    const cacheN = this.kvMode === "native" ? state.lastTimings?.cache_n : undefined;

    if (typeof cacheN === "number") {
      const promptN = state.lastTimings?.prompt_n ?? 0;
      const promptTokens = cacheN + promptN;
      return {
        branchId,
        promptTokens,
        cachedTokens: cacheN,
        cachedTokensSource: "measured",
        checkpointCount: [...this.checkpoints.values()].filter(
          (checkpoint) => checkpoint.checkpoint.branchId === branchId
        ).length,
        messageCount: state.messages.length,
        metadata: {
          baseUrl: this.baseUrl,
          frozen: state.frozen,
          summaries: state.summaries.length,
          lastTimings: state.lastTimings
        }
      };
    }

    const promptTokens = state.messages.reduce(
      (count, message) => count + this.estimateContentTokens(message.content),
      0
    );

    return {
      branchId,
      promptTokens,
      cachedTokens: state.frozen ? 0 : promptTokens,
      cachedTokensSource: "estimated",
      checkpointCount: [...this.checkpoints.values()].filter(
        (checkpoint) => checkpoint.checkpoint.branchId === branchId
      ).length,
      messageCount: state.messages.length,
      metadata: {
        baseUrl: this.baseUrl,
        frozen: state.frozen,
        summaries: state.summaries.length
      }
    };
  }

  async estimateTokens(branchId: string, payload: GenerateRequest): Promise<number> {
    this.requireBranch(branchId);
    return (payload.messages ?? []).reduce(
      (count, message) => count + this.estimateContentTokens(message.content),
      0
    );
  }

  async cacheStats(): Promise<Record<string, unknown>> {
    return {
      baseUrl: this.baseUrl,
      loadedModels: [...this.loadedModels],
      kv: this.kvStatus(),
      kvCache: this.kvCacheReport()
    };
  }

  async checkpointStats(): Promise<Record<string, unknown>> {
    return {
      checkpoints: this.checkpoints.size
    };
  }

  /**
   * Deletes every slot file this adapter still owns (the branch store is in
   * memory, so after the process ends the files are useless), then clears all
   * in-memory slot-file references. Returns the counts deleted by this call.
   */
  async close(): Promise<{ filesDeleted: number; bytesDeleted: number }> {
    const files = this.ledger.names().map((name) => ({
      name,
      bytes: this.ledger.get(name)?.bytes ?? 0
    }));
    for (const { name } of files) {
      this.ledger.drop(name);
    }

    const beforeFilesDeleted = this.kvCounters.filesDeleted;
    const beforeBytesDeleted = this.kvCounters.bytesDeleted;
    await this.deleteFiles(files);

    for (const state of this.branches.values()) {
      state.kvFile = undefined;
    }
    for (const snapshot of this.checkpoints.values()) {
      snapshot.kvFile = undefined;
    }

    return {
      filesDeleted: this.kvCounters.filesDeleted - beforeFilesDeleted,
      bytesDeleted: this.kvCounters.bytesDeleted - beforeBytesDeleted
    };
  }

  /**
   * Same-host only: deletes slot files in `slotSaveDir` named
   * `lightning-<8 hex host>-<pid>-<8 hex>-...bin` whose host tag is this host and
   * whose pid is neither this process nor a live process on this host (left
   * behind by a crashed or restarted Lightning). Files created by other hosts
   * sharing the directory, and files in the old pid-only format, are never
   * deleted. Returns { deleted: [] } when slotSaveDir is unset.
   */
  async sweepOrphanSlotFiles(): Promise<{ deleted: string[] }> {
    if (this.slotSaveDir === undefined) {
      return { deleted: [] };
    }

    const deleted: string[] = [];
    const entries = await this.fs.readdir(this.slotSaveDir);
    for (const entry of entries) {
      const match = /^lightning-([0-9a-f]{8})-(\d+)-[0-9a-f]{8}-.+\.bin$/.exec(entry);
      if (!match) continue;
      if (match[1] !== hostTag()) continue;
      const pid = Number.parseInt(match[2], 10);
      if (pid === process.pid || pidAlive(pid)) continue;

      try {
        await this.fs.unlink(join(this.slotSaveDir, entry));
        deleted.push(entry);
      } catch (error) {
        if ((error as { code?: unknown })?.code === "ENOENT") continue;
        throw error;
      }
    }
    return { deleted };
  }

  kvCacheReport(): Record<string, unknown> {
    return {
      slotFilePrefix: this.slotFilePrefix,
      slotSaveDir: this.slotSaveDir ?? null,
      cleanup: this.slotSaveDir
        ? "active"
        : "disabled: slotSaveDir not set (llama-server has no delete action)",
      files: this.ledger.size(),
      bytes: this.ledger.totalBytes(),
      bytesPerToken: this.ledger.bytesPerToken() ?? null,
      counters: { ...this.kvCounters },
      fingerprintId: this.fingerprintIdValue ?? null,
      fingerprint: this.fingerprint ?? null,
      limit: this.lastLimit ?? null,
      lastEviction: this.lastEviction ?? null,
      lastInvalidation: this.lastInvalidation ?? null,
      resident: Object.fromEntries(this.slotResident)
    };
  }

  private async generateFromMessages(
    state: LlamaCppBranchState,
    messages: MessageRecord[],
    request: GenerateRequest,
    persistKv: boolean
  ): Promise<GenerateResult> {
    if (this.kvMode !== "native") {
      const payload = await this.requestChatCompletion(
        state.branch,
        messages,
        request,
        undefined
      );
      return this.buildGenerateResult(state.branch, payload, {
        mode: "emulated",
        reason: this.kvReason,
        timings: payload.timings
      });
    }

    const stateKvFile = state.kvFile;
    const previousKvFile =
      stateKvFile !== undefined && this.ledger.has(stateKvFile) ? stateKvFile : undefined;
    if (previousKvFile !== undefined) {
      this.kvInUse.set(previousKvFile, (this.kvInUse.get(previousKvFile) ?? 0) + 1);
    }
    try {
      // Hot tier: prefer an idle slot that still holds this branch's KV.
      const slot = await this.acquireSlot(previousKvFile);
      let residentHit = false;
      let restored = false;
      let restoreFailed: { file: string; status: number } | undefined;
      try {
        if (
          this.slotAffinity &&
          previousKvFile !== undefined &&
          this.slotResident.get(slot) === previousKvFile
        ) {
          residentHit = true;
          this.kvCounters.residentHits++;
          this.ledger.touch(previousKvFile);
        } else {
          this.slotResident.delete(slot);
          if (previousKvFile !== undefined) {
            // Warm tier: load the saved slot file.
            this.kvCounters.restores++;
            const restoreResponse = await this.postJson(`/slots/${slot}?action=restore`, {
              filename: previousKvFile
            });
            if (restoreResponse.ok) {
              restored = true;
              this.slotResident.set(slot, previousKvFile);
              this.ledger.touch(previousKvFile);
            } else {
              // The file is a derived cache: forget it, check whether the server's
              // build/model changed, and answer from the canonical transcript.
              this.kvCounters.restoreFailures++;
              restoreFailed = { file: previousKvFile, status: restoreResponse.status };
              await this.dropKvFile(previousKvFile, "restore-failed");
              await this.checkKvFingerprint();
            }
          }
          if (!restored) {
            // Cold tier (or failed restore): start from an empty slot.
            const eraseResponse = await this.postJson(`/slots/${slot}?action=erase`, {});
            if (!eraseResponse.ok) {
              throw new Error(`llama.cpp slot erase failed with HTTP ${eraseResponse.status}`);
            }
          }
        }

        const payload = await this.requestChatCompletion(
          state.branch,
          messages,
          request,
          slot
        );

        let savedTo: string | undefined;
        if (persistKv) {
          const safeBranchId = state.branch.id.replace(/[^A-Za-z0-9_-]/g, "_");
          const filename = `${this.slotFilePrefix}-${safeBranchId}-${++this.fileCounter}.bin`;
          const saveResponse = await this.postJson(`/slots/${slot}?action=save`, {
            filename
          });
          if (!saveResponse.ok) {
            throw new Error(`llama.cpp slot save failed with HTTP ${saveResponse.status}`);
          }

          const saved = (await saveResponse.json()) as { n_saved?: unknown; n_written?: unknown };
          this.ledger.add(filename, kvNumber(saved.n_written), kvNumber(saved.n_saved));
          this.kvCounters.saved++;
          await this.setBranchKv(state, filename);
          state.lastTimings = payload.timings;
          savedTo = filename;
          this.slotResident.set(slot, filename);
          await this.enforceKvBudget(new Set([filename, ...this.kvInUse.keys()]));
        } else if (residentHit || restored) {
          // An ephemeral suffix now follows the branch's saved tokens in the slot.
          // The saved prefix is intact and llama-server reuses only the common
          // prefix, so the slot still serves this branch without a restore.
          this.slotResident.set(slot, previousKvFile as string);
        } else {
          this.slotResident.delete(slot);
        }

        return this.buildGenerateResult(state.branch, payload, {
          mode: "native",
          slot,
          tier: residentHit ? "hot" : restored ? "warm" : "cold",
          residentHit,
          ...(restored && previousKvFile !== undefined ? { restoredFrom: previousKvFile } : {}),
          ...(restoreFailed === undefined ? {} : { restoreFailed }),
          ...(savedTo === undefined ? {} : { savedTo }),
          timings: payload.timings
        });
      } finally {
        this.releaseSlot(slot);
      }
    } finally {
      if (previousKvFile !== undefined) {
        const left = (this.kvInUse.get(previousKvFile) ?? 1) - 1;
        if (left > 0) this.kvInUse.set(previousKvFile, left);
        else this.kvInUse.delete(previousKvFile);
      }
    }
  }

  private async requestChatCompletion(
    branch: BranchRecord,
    messages: MessageRecord[],
    request: GenerateRequest,
    slot: number | undefined
  ): Promise<LlamaCppChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: branch.modelRef || this.defaultModelRef,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      stream: false
    };
    if (slot !== undefined) {
      body.id_slot = slot;
      body.cache_prompt = true;
    }

    const response = await this.postJson("/v1/chat/completions", body);
    if (!response.ok) {
      throw new Error(`llama.cpp request failed with ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as LlamaCppChatCompletionResponse;
  }

  private buildGenerateResult(
    branch: BranchRecord,
    payload: LlamaCppChatCompletionResponse,
    kv: Record<string, unknown>
  ): GenerateResult {
    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? choice?.text ?? "";

    return {
      text,
      stopReason: choice?.finish_reason,
      usage: {
        promptTokens: payload.usage?.prompt_tokens,
        completionTokens: payload.usage?.completion_tokens,
        totalTokens: payload.usage?.total_tokens
      },
      metadata: {
        baseUrl: this.baseUrl,
        model: payload.model ?? branch.modelRef,
        kv
      }
    };
  }

  private postJson(path: string, body: unknown): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  private acquireSlot(preferredFile?: string): Promise<number> {
    if (preferredFile !== undefined) {
      const index = this.freeSlots.findIndex((slot) => this.slotResident.get(slot) === preferredFile);
      if (index >= 0) {
        const [slot] = this.freeSlots.splice(index, 1);
        return Promise.resolve(slot);
      }
    }
    // Otherwise prefer a slot holding nothing resident, so hot branches keep theirs.
    const emptyIndex = this.freeSlots.findIndex((slot) => !this.slotResident.has(slot));
    const freeSlot =
      emptyIndex >= 0 ? this.freeSlots.splice(emptyIndex, 1)[0] : this.freeSlots.pop();
    if (freeSlot !== undefined) {
      return Promise.resolve(freeSlot);
    }

    return new Promise<number>((resolve) => {
      this.slotWaiters.push(resolve);
    });
  }

  private releaseSlot(slot: number): void {
    const waiter = this.slotWaiters.shift();
    if (waiter) {
      waiter(slot);
      return;
    }
    this.freeSlots.push(slot);
  }

  /**
   * Point a branch at a slot file, holding the new file and releasing (and
   * deleting, when nobody else holds it) the superseded one. A file the
   * ledger no longer knows (unknown/evicted) is never referenced.
   */
  private async setBranchKv(state: LlamaCppBranchState, file: string | undefined): Promise<void> {
    if (state.kvFile === file) {
      return;
    }
    if (file !== undefined) {
      this.ledger.hold(file, "branch:" + state.branch.id);
    }
    if (state.kvFile !== undefined) {
      await this.deleteFiles(this.releaseHolder(state.kvFile, "branch:" + state.branch.id));
    }
    state.kvFile = file !== undefined && !this.ledger.has(file) ? undefined : file;
  }

  /**
   * Read a file's byte count BEFORE releasing, so the caller can still report
   * bytes deleted; `release` removes the entry when it drops the last holder.
   */
  private releaseHolder(name: string, holder: string): Array<{ name: string; bytes: number }> {
    const bytes = this.ledger.get(name)?.bytes ?? 0;
    return this.ledger.release(name, holder).map((releasedName) => ({ name: releasedName, bytes }));
  }

  /**
   * Delete slot files from `slotSaveDir`. llama-server has no delete action,
   * so when slotSaveDir is unset the files cannot be removed and the release
   * is only counted. ENOENT is ignored (the file was already gone).
   */
  private async deleteFiles(files: Array<{ name: string; bytes: number }>): Promise<void> {
    for (const { name, bytes } of files) {
      if (this.slotSaveDir === undefined) {
        this.kvCounters.releasedWithoutDir++;
        continue;
      }
      try {
        await this.fs.unlink(join(this.slotSaveDir, name));
        this.kvCounters.filesDeleted++;
        this.kvCounters.bytesDeleted += bytes;
      } catch (error) {
        if ((error as { code?: unknown })?.code === "ENOENT") {
          continue;
        }
        this.kvCounters.deleteErrors++;
      }
    }
  }

  private requireBranch(branchId: string): LlamaCppBranchState {
    const state = this.branches.get(branchId);
    if (!state) {
      throw new Error(`Unknown llama.cpp branch: ${branchId}`);
    }

    return state;
  }

  private cloneBranch(branch: BranchRecord): BranchRecord {
    return {
      ...branch,
      checkpoints: branch.checkpoints.map((checkpoint) => ({ ...checkpoint })),
      metadata: { ...branch.metadata }
    };
  }

  private cloneMessage(message: MessageRecord): MessageRecord {
    return {
      ...message,
      metadata: message.metadata ? { ...message.metadata } : undefined
    };
  }

  private estimateContentTokens(content: string): number {
    const trimmed = content.trim();
    return trimmed ? Math.ceil(trimmed.split(/\s+/).length * 1.3) : 0;
  }
}
