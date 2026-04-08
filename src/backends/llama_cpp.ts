import type { LightningAdapter } from "../core/adapter.js";
import type {
  AdapterCapabilities,
  BranchCheckpoint,
  BranchRecord,
  BranchStats,
  GenerateRequest,
  GenerateResult,
  MessageRecord
} from "../core/types.js";

export interface LlamaCppAdapterOptions {
  baseUrl: string;
  defaultModelRef?: string;
  fetchImpl?: typeof fetch;
}

interface LlamaCppBranchState {
  branch: BranchRecord;
  messages: MessageRecord[];
  summaries: string[];
  frozen: boolean;
}

interface LlamaCppCheckpointSnapshot {
  checkpoint: BranchCheckpoint;
  messages: MessageRecord[];
  summaries: string[];
  frozen: boolean;
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
}

export class LlamaCppAdapter implements LightningAdapter {
  readonly id = "llama.cpp";
  readonly label = "llama.cpp HTTP adapter";

  private readonly baseUrl: string;
  private readonly defaultModelRef?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly loadedModels = new Set<string>();
  private readonly branches = new Map<string, LlamaCppBranchState>();
  private readonly checkpoints = new Map<string, LlamaCppCheckpointSnapshot>();

  constructor(options: LlamaCppAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.defaultModelRef = options.defaultModelRef;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  capabilities(): AdapterCapabilities {
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
    this.branches.set(branch.id, {
      branch: this.cloneBranch(branch),
      messages: [],
      summaries: [],
      frozen: branch.temperature === "frozen"
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
    return this.generateFromMessages(state.branch, request.messages ?? state.messages, request);
  }

  async generateEphemeral(branchId: string, request: GenerateRequest): Promise<GenerateResult> {
    const state = this.requireBranch(branchId);
    const result = await this.generateFromMessages(state.branch, request.messages ?? state.messages, request);
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
      frozen: state.frozen
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
  }

  async freezeBranch(branchId: string): Promise<void> {
    this.requireBranch(branchId).frozen = true;
  }

  async thawBranch(branchId: string): Promise<void> {
    this.requireBranch(branchId).frozen = false;
  }

  async branchStats(branchId: string): Promise<BranchStats> {
    const state = this.requireBranch(branchId);
    const promptTokens = state.messages.reduce(
      (count, message) => count + this.estimateContentTokens(message.content),
      0
    );

    return {
      branchId,
      promptTokens,
      cachedTokens: state.frozen ? 0 : promptTokens,
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
      loadedModels: [...this.loadedModels]
    };
  }

  async checkpointStats(): Promise<Record<string, unknown>> {
    return {
      checkpoints: this.checkpoints.size
    };
  }

  private async generateFromMessages(
    branch: BranchRecord,
    messages: MessageRecord[],
    request: GenerateRequest
  ): Promise<GenerateResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: branch.modelRef || this.defaultModelRef,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        temperature: request.temperature,
        max_tokens: request.maxOutputTokens,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`llama.cpp request failed with ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as LlamaCppChatCompletionResponse;
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
        model: payload.model ?? branch.modelRef
      }
    };
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
