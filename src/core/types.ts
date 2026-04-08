export type BranchTemperature = "hot" | "warm" | "cold" | "frozen";

export type CapabilityMode = "native" | "emulated" | "unsupported";

export type BranchKind =
  | "chat"
  | "background"
  | "task"
  | "project"
  | "research"
  | "elder"
  | "scratch"
  | "custom";

export interface BranchCheckpoint {
  id: string;
  branchId: string;
  createdAt: string;
  label?: string;
  summary?: string;
  backendRef?: string;
}

export interface BranchRecord {
  id: string;
  title: string;
  kind: BranchKind;
  category: string;
  responsibility: string;
  parentId: string | null;
  successorId: string | null;
  backend: string;
  modelRef: string;
  temperature: BranchTemperature;
  priority: number;
  createdAt: string;
  updatedAt: string;
  checkpoints: BranchCheckpoint[];
  metadata: Record<string, unknown>;
}

export interface MessageRecord {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface GenerateRequest {
  messages?: MessageRecord[];
  maxOutputTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  stopReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface BranchStats {
  branchId: string;
  promptTokens?: number;
  cachedTokens?: number;
  checkpointCount: number;
  messageCount: number;
  metadata?: Record<string, unknown>;
}

export interface AdapterCapabilities {
  loadModel: CapabilityMode;
  checkpoint: CapabilityMode;
  restore: CapabilityMode;
  freeze: CapabilityMode;
  thaw: CapabilityMode;
  fork: CapabilityMode;
  ephemeralConsult: CapabilityMode;
  prefixReuse: CapabilityMode;
}
