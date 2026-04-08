import { addCheckpoint, createBranchRecord, setBranchTemperature, touchBranch } from "./branch.js";
import type {
  BranchCheckpoint,
  BranchRecord,
  BranchStats,
  BranchTemperature,
  MessageRecord
} from "./types.js";

export interface CreateCheckpointInput {
  label?: string;
  summary?: string;
  backendRef?: string;
}

export interface ForkBranchInput {
  id: string;
  title: string;
  responsibility?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

interface BranchState {
  branch: BranchRecord;
  messages: MessageRecord[];
}

interface CheckpointSnapshot {
  checkpoint: BranchCheckpoint;
  branch: BranchRecord;
  messages: MessageRecord[];
}

export class InMemoryBranchStore {
  private readonly branches = new Map<string, BranchState>();
  private readonly checkpoints = new Map<string, CheckpointSnapshot>();

  createBranch(input: Parameters<typeof createBranchRecord>[0]): BranchRecord {
    if (this.branches.has(input.id)) {
      throw new Error(`Branch already exists: ${input.id}`);
    }

    const branch = createBranchRecord(input);
    this.branches.set(branch.id, {
      branch,
      messages: []
    });
    return this.cloneBranch(branch);
  }

  forkBranch(branchId: string, input: ForkBranchInput): BranchRecord {
    if (this.branches.has(input.id)) {
      throw new Error(`Branch already exists: ${input.id}`);
    }

    const parentState = this.requireState(branchId);
    const parentBranch = parentState.branch;
    const now = new Date().toISOString();

    const forkedBranch: BranchRecord = {
      ...parentBranch,
      id: input.id,
      title: input.title,
      category: input.category ?? parentBranch.category,
      responsibility: input.responsibility ?? parentBranch.responsibility,
      parentId: parentBranch.id,
      successorId: null,
      temperature: "warm",
      createdAt: now,
      updatedAt: now,
      checkpoints: [],
      metadata: {
        ...parentBranch.metadata,
        ...input.metadata
      }
    };

    this.branches.set(forkedBranch.id, {
      branch: forkedBranch,
      messages: this.cloneMessages(parentState.messages)
    });

    return this.cloneBranch(forkedBranch);
  }

  deleteBranch(branchId: string): void {
    this.requireState(branchId);
    this.branches.delete(branchId);
  }

  getBranch(branchId: string): BranchRecord {
    return this.cloneBranch(this.requireState(branchId).branch);
  }

  listBranches(): BranchRecord[] {
    return [...this.branches.values()].map((state) => this.cloneBranch(state.branch));
  }

  getMessages(branchId: string): MessageRecord[] {
    return this.cloneMessages(this.requireState(branchId).messages);
  }

  appendMessages(branchId: string, messages: MessageRecord[]): BranchRecord {
    const state = this.requireState(branchId);
    state.messages.push(...this.cloneMessages(messages));
    state.branch = touchBranch(state.branch);
    return this.cloneBranch(state.branch);
  }

  freezeBranch(branchId: string): BranchRecord {
    return this.setTemperature(branchId, "frozen");
  }

  thawBranch(branchId: string, temperature: BranchTemperature = "warm"): BranchRecord {
    return this.setTemperature(branchId, temperature === "frozen" ? "warm" : temperature);
  }

  setTemperature(branchId: string, temperature: BranchTemperature): BranchRecord {
    const state = this.requireState(branchId);
    state.branch = setBranchTemperature(state.branch, temperature);
    return this.cloneBranch(state.branch);
  }

  checkpointBranch(branchId: string, input: CreateCheckpointInput = {}): BranchCheckpoint {
    const state = this.requireState(branchId);
    const checkpoint: BranchCheckpoint = {
      id: `ckpt-${branchId}-${state.branch.checkpoints.length + 1}`,
      branchId,
      createdAt: new Date().toISOString(),
      label: input.label,
      summary: input.summary,
      backendRef: input.backendRef
    };

    state.branch = addCheckpoint(state.branch, checkpoint);
    this.checkpoints.set(checkpoint.id, {
      checkpoint,
      branch: this.cloneBranch(state.branch),
      messages: this.cloneMessages(state.messages)
    });

    return { ...checkpoint };
  }

  restoreCheckpoint(branchId: string, checkpointId: string): BranchRecord {
    const snapshot = this.checkpoints.get(checkpointId);
    if (!snapshot || snapshot.checkpoint.branchId !== branchId) {
      throw new Error(`Checkpoint not found for branch ${branchId}: ${checkpointId}`);
    }

    this.branches.set(branchId, {
      branch: this.cloneBranch(snapshot.branch),
      messages: this.cloneMessages(snapshot.messages)
    });

    return this.cloneBranch(snapshot.branch);
  }

  branchStats(branchId: string): BranchStats {
    const state = this.requireState(branchId);
    const promptTokens = state.messages.reduce(
      (count, message) => count + this.estimateMessageTokens(message.content),
      0
    );

    return {
      branchId,
      promptTokens,
      cachedTokens: state.branch.temperature === "hot" ? promptTokens : 0,
      checkpointCount: state.branch.checkpoints.length,
      messageCount: state.messages.length,
      metadata: {
        temperature: state.branch.temperature
      }
    };
  }

  private requireState(branchId: string): BranchState {
    const state = this.branches.get(branchId);
    if (!state) {
      throw new Error(`Unknown branch: ${branchId}`);
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

  private cloneMessages(messages: MessageRecord[]): MessageRecord[] {
    return messages.map((message) => ({
      ...message,
      metadata: message.metadata ? { ...message.metadata } : undefined
    }));
  }

  private estimateMessageTokens(content: string): number {
    const trimmed = content.trim();
    return trimmed ? Math.ceil(trimmed.split(/\s+/).length * 1.3) : 0;
  }
}
