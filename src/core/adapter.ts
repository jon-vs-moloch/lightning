import type {
  AdapterCapabilities,
  BranchCheckpoint,
  BranchRecord,
  BranchStats,
  GenerateRequest,
  GenerateResult,
  MessageRecord
} from "./types.js";

export interface LightningAdapter {
  readonly id: string;
  readonly label: string;

  capabilities(): AdapterCapabilities;

  loadModel(modelRef: string, options?: Record<string, unknown>): Promise<void>;
  unloadModel(modelRef: string): Promise<void>;
  listLoadedModels(): Promise<string[]>;

  createBranch(branch: BranchRecord, options?: Record<string, unknown>): Promise<void>;
  deleteBranch(branchId: string): Promise<void>;

  appendMessages(branchId: string, messages: MessageRecord[]): Promise<void>;
  appendSummary(branchId: string, summaryArtifact: string): Promise<void>;

  generate(branchId: string, request: GenerateRequest): Promise<GenerateResult>;
  generateEphemeral(branchId: string, request: GenerateRequest): Promise<GenerateResult>;

  checkpointBranch(branchId: string, label?: string): Promise<BranchCheckpoint>;
  restoreBranch(branchId: string, checkpointRef: string): Promise<void>;

  freezeBranch(branchId: string): Promise<void>;
  thawBranch(branchId: string): Promise<void>;

  branchStats(branchId: string): Promise<BranchStats>;
  estimateTokens(branchId: string, payload: GenerateRequest): Promise<number>;
  cacheStats(): Promise<Record<string, unknown>>;
  checkpointStats(): Promise<Record<string, unknown>>;
}
