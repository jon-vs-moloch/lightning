import type { LightningAdapter } from "../core/adapter.js";
import type {
  AdapterCapabilities,
  BranchCheckpoint,
  BranchRecord,
  BranchStats,
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
 * Slot files are immutable and named per generation; nothing deletes them yet.
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

  private kvMode: "native" | "emulated" = "emulated";
  private kvReason = "not probed: call probeKvSupport() to enable native KV checkpoints";
  private slotCount = 0;
  private buildInfo?: string;
  private freeSlots: number[] = [];
  private slotWaiters: Array<(slot: number) => void> = [];
  private fileCounter = 0;

  constructor(options: LlamaCppAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.defaultModelRef = options.defaultModelRef;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.slotFilePrefix = options.slotFilePrefix ?? "lightning";
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

      const probeResponse = await this.postJson("/slots/0?action=save", {
        filename: `${this.slotFilePrefix}-probe.bin`
      });

      if (probeResponse.ok) {
        this.kvMode = "native";
        this.slotCount = slotCount;
        this.freeSlots = Array.from({ length: slotCount }, (_, index) => index);
        this.kvReason = `llama-server slot save/restore active: ${slotCount} slots (${this.buildInfo})`;
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
    let kvFile: string | undefined;
    if (branch.parentId) {
      kvFile = this.branches.get(branch.parentId)?.kvFile;
    }

    this.branches.set(branch.id, {
      branch: this.cloneBranch(branch),
      messages: [],
      summaries: [],
      frozen: branch.temperature === "frozen",
      ...(kvFile === undefined ? {} : { kvFile })
    });
  }

  async deleteBranch(branchId: string): Promise<void> {
    this.branches.delete(branchId);
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

    this.checkpoints.set(checkpoint.id, {
      checkpoint,
      messages: state.messages.map((message) => this.cloneMessage(message)),
      summaries: [...state.summaries],
      frozen: state.frozen,
      ...(state.kvFile === undefined ? {} : { kvFile: state.kvFile })
    });

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
    state.kvFile = snapshot.kvFile;
    state.lastTimings = undefined;
  }

  async freezeBranch(branchId: string): Promise<void> {
    this.requireBranch(branchId).frozen = true;
  }

  async thawBranch(branchId: string): Promise<void> {
    this.requireBranch(branchId).frozen = false;
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
      kv: this.kvStatus()
    };
  }

  async checkpointStats(): Promise<Record<string, unknown>> {
    return {
      checkpoints: this.checkpoints.size
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

    const previousKvFile = state.kvFile;
    const slot = await this.acquireSlot();
    try {
      if (previousKvFile) {
        const restoreResponse = await this.postJson(`/slots/${slot}?action=restore`, {
          filename: previousKvFile
        });
        if (!restoreResponse.ok) {
          throw new Error(
            `llama.cpp slot restore of ${previousKvFile} failed with HTTP ${restoreResponse.status}`
          );
        }
      } else {
        await this.postJson(`/slots/${slot}?action=erase`, {});
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
        state.kvFile = filename;
        state.lastTimings = payload.timings;
        savedTo = filename;
      }

      return this.buildGenerateResult(state.branch, payload, {
        mode: "native",
        slot,
        ...(previousKvFile === undefined ? {} : { restoredFrom: previousKvFile }),
        ...(savedTo === undefined ? {} : { savedTo }),
        timings: payload.timings
      });
    } finally {
      this.releaseSlot(slot);
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

  private acquireSlot(): Promise<number> {
    const freeSlot = this.freeSlots.pop();
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
