import type { LightningAdapter } from "./adapter.js";
import { planThermalTransitions } from "./scheduler.js";
import { InMemoryBranchStore } from "./store.js";
import type {
  BranchCheckpoint,
  BranchRecord,
  BranchStats,
  BranchTemperature,
  GenerateRequest,
  GenerateResult,
  MessageRecord
} from "./types.js";

export interface AppendMessageInput {
  role: MessageRecord["role"];
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CreateRuntimeBranchInput {
  id: string;
  title: string;
  kind: BranchRecord["kind"];
  category: string;
  responsibility: string;
  backend: string;
  modelRef: string;
  parentId?: string | null;
  successorId?: string | null;
  priority?: number;
  temperature?: BranchTemperature;
  metadata?: Record<string, unknown>;
}

export interface ForkRuntimeBranchInput {
  id: string;
  title: string;
  category?: string;
  responsibility?: string;
  metadata?: Record<string, unknown>;
}

export class LightningRuntime {
  private readonly store = new InMemoryBranchStore();
  private readonly adapters = new Map<string, LightningAdapter>();

  registerAdapter(adapter: LightningAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  listAdapters(): string[] {
    return [...this.adapters.keys()];
  }

  listBranches(): BranchRecord[] {
    return this.store.listBranches();
  }

  getBranch(branchId: string): BranchRecord {
    return this.store.getBranch(branchId);
  }

  getMessages(branchId: string): MessageRecord[] {
    return this.store.getMessages(branchId);
  }

  async createBranch(input: CreateRuntimeBranchInput): Promise<BranchRecord> {
    const adapter = await this.requireAdapter(input.backend);
    await adapter.loadModel(input.modelRef);
    const branch = this.store.createBranch(input);
    await adapter.createBranch(branch);
    return branch;
  }

  async forkBranch(branchId: string, input: ForkRuntimeBranchInput): Promise<BranchRecord> {
    const parent = this.store.getBranch(branchId);
    const adapter = await this.requireAdapter(parent.backend);
    const branch = this.store.forkBranch(branchId, input);
    await adapter.createBranch(branch);
    const inheritedMessages = this.store.getMessages(branchId);
    if (inheritedMessages.length > 0) {
      await adapter.appendMessages(branch.id, inheritedMessages);
    }
    return branch;
  }

  async appendMessages(branchId: string, messages: AppendMessageInput[]): Promise<BranchRecord> {
    const branch = this.store.getBranch(branchId);
    const materializedMessages = messages.map((message) => ({
      ...message,
      createdAt: new Date().toISOString()
    }));
    const updatedBranch = this.store.appendMessages(branchId, materializedMessages);
    await this.requireAdapter(branch.backend).then((adapter) =>
      adapter.appendMessages(branchId, materializedMessages)
    );
    return updatedBranch;
  }

  async generate(branchId: string, request: GenerateRequest = {}): Promise<GenerateResult> {
    const branch = this.store.getBranch(branchId);
    return this.requireAdapter(branch.backend).then((adapter) =>
      adapter.generate(branchId, {
        ...request,
        messages: request.messages ?? this.store.getMessages(branchId)
      })
    );
  }

  async generateEphemeral(branchId: string, request: GenerateRequest = {}): Promise<GenerateResult> {
    const branch = this.store.getBranch(branchId);
    return this.requireAdapter(branch.backend).then((adapter) =>
      adapter.generateEphemeral(branchId, {
        ...request,
        messages: request.messages ?? this.store.getMessages(branchId)
      })
    );
  }

  async checkpointBranch(
    branchId: string,
    label?: string,
    summary?: string
  ): Promise<BranchCheckpoint> {
    const branch = this.store.getBranch(branchId);
    const adapter = await this.requireAdapter(branch.backend);
    if (summary) {
      await adapter.appendSummary(branchId, summary);
    }
    const backendCheckpoint = await adapter.checkpointBranch(branchId, label);
    return this.store.checkpointBranch(branchId, {
      label,
      summary,
      backendRef: backendCheckpoint.backendRef ?? backendCheckpoint.id
    });
  }

  async restoreBranch(branchId: string, checkpointId: string): Promise<BranchRecord> {
    const branch = this.store.getBranch(branchId);
    const checkpoint = branch.checkpoints.find((item) => item.id === checkpointId);
    if (!checkpoint) {
      throw new Error(`Unknown checkpoint for branch ${branchId}: ${checkpointId}`);
    }

    await this.requireAdapter(branch.backend).then((adapter) =>
      adapter.restoreBranch(branchId, checkpoint.backendRef ?? checkpoint.id)
    );
    return this.store.restoreCheckpoint(branchId, checkpointId);
  }

  async freezeBranch(branchId: string): Promise<BranchRecord> {
    const branch = this.store.getBranch(branchId);
    await this.requireAdapter(branch.backend).then((adapter) => adapter.freezeBranch(branchId));
    return this.store.freezeBranch(branchId);
  }

  async thawBranch(branchId: string, temperature: BranchTemperature = "warm"): Promise<BranchRecord> {
    const branch = this.store.getBranch(branchId);
    await this.requireAdapter(branch.backend).then((adapter) => adapter.thawBranch(branchId));
    return this.store.thawBranch(branchId, temperature);
  }

  async branchStats(branchId: string): Promise<BranchStats> {
    const branch = this.store.getBranch(branchId);
    const localStats = this.store.branchStats(branchId);
    const adapterStats = await this.requireAdapter(branch.backend).then((adapter) =>
      adapter.branchStats(branchId)
    );

    return {
      ...localStats,
      promptTokens: Math.max(localStats.promptTokens ?? 0, adapterStats.promptTokens ?? 0),
      cachedTokens: Math.max(localStats.cachedTokens ?? 0, adapterStats.cachedTokens ?? 0),
      metadata: {
        ...localStats.metadata,
        adapter: adapterStats.metadata ?? {}
      }
    };
  }

  applyThermalPlan(activeBranchIds: string[] = [], maxHotBranches?: number) {
    const decisions = planThermalTransitions({
      branches: this.store.listBranches(),
      activeBranchIds,
      maxHotBranches
    });

    decisions.forEach((decision) => {
      if (decision.from !== decision.to) {
        this.store.setTemperature(decision.branchId, decision.to);
      }
    });

    return decisions;
  }

  private async requireAdapter(adapterId: string): Promise<LightningAdapter> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`No adapter registered for backend: ${adapterId}`);
    }

    return adapter;
  }
}
