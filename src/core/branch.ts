import type { BranchCheckpoint, BranchRecord, BranchTemperature } from "./types.js";

export interface CreateBranchInput {
  id: string;
  title: string;
  kind: BranchRecord["kind"];
  category: string;
  responsibility: string;
  backend: string;
  modelRef: string;
  parentId?: string | null;
  successorId?: string | null;
  temperature?: BranchTemperature;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export function createBranchRecord(input: CreateBranchInput): BranchRecord {
  const timestamp = new Date().toISOString();
  return {
    id: input.id,
    title: input.title,
    kind: input.kind,
    category: input.category,
    responsibility: input.responsibility,
    parentId: input.parentId ?? null,
    successorId: input.successorId ?? null,
    backend: input.backend,
    modelRef: input.modelRef,
    temperature: input.temperature ?? "warm",
    priority: input.priority ?? 0.5,
    createdAt: timestamp,
    updatedAt: timestamp,
    checkpoints: [],
    metadata: input.metadata ?? {}
  };
}

export function touchBranch(branch: BranchRecord): BranchRecord {
  return {
    ...branch,
    updatedAt: new Date().toISOString()
  };
}

export function setBranchTemperature(
  branch: BranchRecord,
  temperature: BranchTemperature
): BranchRecord {
  return {
    ...touchBranch(branch),
    temperature
  };
}

export function addCheckpoint(
  branch: BranchRecord,
  checkpoint: BranchCheckpoint
): BranchRecord {
  return {
    ...touchBranch(branch),
    checkpoints: [...branch.checkpoints, checkpoint]
  };
}
