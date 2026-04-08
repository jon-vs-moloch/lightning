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

interface FakeBranchState {
  branch: BranchRecord;
  messages: MessageRecord[];
  summaries: string[];
  frozen: boolean;
}

export class FakeAdapter implements LightningAdapter {
  readonly id = "fake";
  readonly label = "Fake in-memory adapter";

  private readonly loadedModels = new Set<string>();
  private readonly branches = new Map<string, FakeBranchState>();
  private readonly checkpoints = new Map<string, BranchCheckpoint>();

  capabilities(): AdapterCapabilities {
    return {
      loadModel: "native",
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
    const state = this.requireBranch(branchId);
    state.summaries.push(summaryArtifact);
  }

  async generate(branchId: string, request: GenerateRequest): Promise<GenerateResult> {
    const state = this.requireBranch(branchId);
    const prompt = [...state.messages, ...(request.messages ?? [])];
    const lastUserMessage = [...prompt].reverse().find((message) => message.role === "user");

    return {
      text: [
        `branch:${branchId}`,
        `model:${state.branch.modelRef}`,
        lastUserMessage ? `echo:${lastUserMessage.content}` : "echo:no-user-message"
      ].join(" | "),
      stopReason: "end",
      usage: {
        promptTokens: prompt.reduce((count, message) => count + this.estimateContentTokens(message.content), 0),
        completionTokens: 12,
        totalTokens:
          prompt.reduce((count, message) => count + this.estimateContentTokens(message.content), 0) + 12
      },
      metadata: {
        frozen: state.frozen,
        summaries: state.summaries.length
      }
    };
  }

  async generateEphemeral(branchId: string, request: GenerateRequest): Promise<GenerateResult> {
    const result = await this.generate(branchId, request);
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
    const checkpoint: BranchCheckpoint = {
      id: `fake-${branchId}-${this.checkpoints.size + 1}`,
      branchId,
      createdAt: new Date().toISOString(),
      label,
      summary: state.summaries.at(-1),
      backendRef: `${this.id}:${branchId}`
    };
    this.checkpoints.set(checkpoint.id, checkpoint);
    return { ...checkpoint };
  }

  async restoreBranch(branchId: string, checkpointRef: string): Promise<void> {
    const checkpoint = this.checkpoints.get(checkpointRef);
    if (!checkpoint || checkpoint.branchId !== branchId) {
      throw new Error(`Unknown fake checkpoint for branch ${branchId}: ${checkpointRef}`);
    }
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
        (checkpoint) => checkpoint.branchId === branchId
      ).length,
      messageCount: state.messages.length,
      metadata: {
        summaries: state.summaries.length,
        frozen: state.frozen
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
      loadedModels: this.loadedModels.size,
      branches: this.branches.size
    };
  }

  async checkpointStats(): Promise<Record<string, unknown>> {
    return {
      checkpoints: this.checkpoints.size
    };
  }

  private requireBranch(branchId: string): FakeBranchState {
    const state = this.branches.get(branchId);
    if (!state) {
      throw new Error(`Unknown fake adapter branch: ${branchId}`);
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
