import type { LightningAdapter } from "./adapter.js";
import { routeQuery, summarizeBranch } from "./router.js";
import type { BranchSummary, RouteScore, RouterDoc, VaneModule } from "./router.js";
import { planThermalTransitions } from "./scheduler.js";
import { InMemoryBranchStore } from "./store.js";
import type {
  AdapterCapabilities,
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
  kind?: BranchRecord["kind"];
  category?: string;
  responsibility?: string;
  metadata?: Record<string, unknown>;
}

export class LightningRuntime {
  private readonly store = new InMemoryBranchStore();
  private readonly adapters = new Map<string, LightningAdapter>();
  private readonly threadHeads = new Map<string, string>();
  private readonly summaryCache = new Map<string, { key: string; summary: BranchSummary }>();

  registerAdapter(adapter: LightningAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  listAdapters(): string[] {
    return [...this.adapters.keys()];
  }

  /** Adapter ids, labels and their native/emulated/unsupported capability report. */
  describeAdapters(): Array<{ id: string; label: string; capabilities: AdapterCapabilities }> {
    return [...this.adapters.values()].map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      capabilities: adapter.capabilities()
    }));
  }

  listBranches(): BranchRecord[] {
    return this.store.listBranches();
  }

  listThreadHeads(): Array<{ threadId: string; checkpointId: string }> {
    return [...this.threadHeads.entries()].map(([threadId, checkpointId]) => ({
      threadId,
      checkpointId
    }));
  }

  getBranch(branchId: string): BranchRecord {
    return this.store.getBranch(branchId);
  }

  getMessages(branchId: string): MessageRecord[] {
    return this.store.getMessages(branchId);
  }

  getCheckpoint(checkpointId: string): BranchCheckpoint {
    return this.store.getCheckpoint(checkpointId);
  }

  inspectCheckpoint(checkpointId: string): {
    checkpoint: BranchCheckpoint;
    branch: BranchRecord;
    messages: MessageRecord[];
  } {
    return this.store.getCheckpointSnapshot(checkpointId);
  }

  getThreadHead(threadId: string): string | undefined {
    return this.threadHeads.get(threadId);
  }

  setThreadHead(threadId: string, checkpointId: string): void {
    this.threadHeads.set(threadId, checkpointId);
  }

  async deleteBranch(branchId: string): Promise<void> {
    const branch = this.store.getBranch(branchId);
    await this.requireAdapter(branch.backend).then((adapter) => adapter.deleteBranch(branchId));
    this.store.deleteBranch(branchId);
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
    return this.requireAdapter(branch.backend).then((adapter) => adapter.generate(branchId, request));
  }

  async generateEphemeral(branchId: string, request: GenerateRequest = {}): Promise<GenerateResult> {
    const branch = this.store.getBranch(branchId);
    return this.requireAdapter(branch.backend).then((adapter) =>
      adapter.generateEphemeral(branchId, request)
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

  async replaceBranchMessages(branchId: string, messages: AppendMessageInput[]): Promise<BranchRecord> {
    const branch = this.store.getBranch(branchId);
    await this.requireAdapter(branch.backend).then((adapter) => adapter.deleteBranch(branchId));
    this.store.deleteBranch(branchId);

    const recreated = this.store.createBranch({
      id: branch.id,
      title: branch.title,
      kind: branch.kind,
      category: branch.category,
      responsibility: branch.responsibility,
      backend: branch.backend,
      modelRef: branch.modelRef,
      parentId: branch.parentId,
      successorId: branch.successorId,
      priority: branch.priority,
      temperature: branch.temperature,
      metadata: branch.metadata
    });

    await this.requireAdapter(recreated.backend).then((adapter) => adapter.createBranch(recreated));

    if (messages.length > 0) {
      return this.appendMessages(branchId, messages);
    }

    return recreated;
  }

  async respondFromCheckpoint(
    checkpointId: string,
    requestMessage: AppendMessageInput,
    request: GenerateRequest = {},
    options?: {
      checkpointLabel?: string;
      checkpointSummary?: string;
      threadId?: string;
    }
  ): Promise<{
    branch: BranchRecord;
    generation: GenerateResult;
    checkpoint: BranchCheckpoint;
  }> {
    const checkpoint = this.getCheckpoint(checkpointId);
    const restoredBranch = await this.restoreBranch(checkpoint.branchId, checkpoint.id);

    await this.appendMessages(restoredBranch.id, [requestMessage]);
    const generation = await this.generate(restoredBranch.id, request);
    await this.appendMessages(restoredBranch.id, [
      {
        role: "assistant",
        content: generation.text
      }
    ]);

    const nextCheckpoint = await this.checkpointBranch(
      restoredBranch.id,
      options?.checkpointLabel,
      options?.checkpointSummary
    );

    if (options?.threadId) {
      this.setThreadHead(options.threadId, nextCheckpoint.id);
    }

    return {
      branch: this.getBranch(restoredBranch.id),
      generation,
      checkpoint: nextCheckpoint
    };
  }

  /**
   * Fan one request out to several checkpoints at once: each checkpoint is restored on its own branch,
   * answered, and checkpointed again, in parallel. With a native-KV adapter each branch continues from its
   * saved KV state, so only the new suffix is prefilled. The checkpoints must be on distinct branches,
   * because one branch can only hold one head at a time.
   */
  async fanOutFromCheckpoints(
    checkpointIds: string[],
    requestMessage: AppendMessageInput,
    request: GenerateRequest = {},
    options?: { checkpointLabel?: string }
  ): Promise<
    Array<{
      checkpointId: string;
      branch: BranchRecord;
      generation: GenerateResult;
      checkpoint: BranchCheckpoint;
    }>
  > {
    if (checkpointIds.length === 0) {
      throw new Error("fanOutFromCheckpoints needs at least one checkpoint id");
    }

    const branchByCheckpoint = checkpointIds.map((checkpointId) => ({
      checkpointId,
      branchId: this.getCheckpoint(checkpointId).branchId
    }));
    const branchOwners = new Map<string, string>();
    branchByCheckpoint.forEach(({ checkpointId, branchId }) => {
      const previousCheckpointId = branchOwners.get(branchId);
      if (previousCheckpointId !== undefined) {
        throw new Error(
          `fanOutFromCheckpoints: checkpoints ${previousCheckpointId} and ${checkpointId} are both on branch ${branchId}; fan-out needs distinct branches`
        );
      }
      branchOwners.set(branchId, checkpointId);
    });

    return Promise.all(
      branchByCheckpoint.map(async ({ checkpointId }) => {
        const result = await this.respondFromCheckpoint(checkpointId, requestMessage, request, {
          checkpointLabel: options?.checkpointLabel
        });
        return { checkpointId, ...result };
      })
    );
  }

  async restoreBranch(branchId: string, checkpointId: string): Promise<BranchRecord> {
    const branch = this.store.getBranch(branchId);
    // Resolve from the store's checkpoint index, not branch.checkpoints: a restore
    // rewinds the branch's CURRENT checkpoint list, so a later abandoned checkpoint
    // would no longer be listed there even though it is still addressable.
    let checkpoint: BranchCheckpoint;
    try {
      checkpoint = this.store.getCheckpoint(checkpointId);
    } catch {
      throw new Error(`Unknown checkpoint for branch ${branchId}: ${checkpointId}`);
    }
    if (checkpoint.branchId !== branchId) {
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

    if (adapterStats.cachedTokensSource === "measured") {
      return {
        ...localStats,
        promptTokens: adapterStats.promptTokens,
        cachedTokens: adapterStats.cachedTokens,
        cachedTokensSource: "measured",
        metadata: {
          ...localStats.metadata,
          adapter: adapterStats.metadata ?? {}
        }
      };
    }

    return {
      ...localStats,
      promptTokens: Math.max(localStats.promptTokens ?? 0, adapterStats.promptTokens ?? 0),
      cachedTokens: Math.max(localStats.cachedTokens ?? 0, adapterStats.cachedTokens ?? 0),
      cachedTokensSource: "estimated",
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

  /**
   * Run the thermal planner and tell the backend each branch's current tier.
   * Every decision is forwarded to the branch's adapter via the optional
   * `applyTemperature` hook — for ALL decisions, not only changed ones, so a newly
   * attached backend learns every tier. Call this on events (new turn, branch going
   * idle) to keep backend-side KV residency in step with the planner. Returns the
   * planner's decisions.
   */
  async manageKv(activeBranchIds: string[] = [], maxHotBranches?: number) {
    const decisions = this.applyThermalPlan(activeBranchIds, maxHotBranches);
    for (const decision of decisions) {
      const adapter = await this.requireAdapter(this.getBranch(decision.branchId).backend);
      await adapter.applyTemperature?.(decision.branchId, decision.to);
    }
    return decisions;
  }

  /**
   * Summarize a branch (Vane when installed, extractive fallback otherwise),
   * cached per branch until its message count, updatedAt, budget or vane setting
   * change, so repeated routing does not re-run the fit.
   */
  async summarizeBranch(
    branchId: string,
    options: { budgetTokens?: number; vane?: VaneModule | null } = {}
  ): Promise<BranchSummary> {
    const branch = this.getBranch(branchId);
    const messages = this.getMessages(branchId);
    const key = `${messages.length}:${branch.updatedAt}:${options.budgetTokens ?? 160}:${
      options.vane === null ? "novane" : "auto"
    }`;
    const cached = this.summaryCache.get(branchId);
    if (cached && cached.key === key) {
      return cached.summary;
    }
    const summary = await summarizeBranch(branch.title, messages, options);
    this.summaryCache.set(branchId, { key, summary });
    return summary;
  }

  /**
   * Route a query to the most relevant branch tips. Candidates are non-frozen
   * branches that have at least one checkpoint; the tip is the LAST entry of
   * branch.checkpoints. With index "summary" (default) the router scores
   * title + "\n" + summary.text; with "full" it scores the title plus the whole
   * transcript text (all message contents joined by "\n"). Summaries are computed
   * in both modes so callers can display them.
   */
  async routeBranches(
    query: string,
    options: {
      k: number;
      index?: "summary" | "full";
      budgetTokens?: number;
      vane?: VaneModule | null;
      recencyWeight?: number;
      halfLifeMs?: number;
      now?: number;
    }
  ): Promise<{ route: RouteScore[]; summaries: Record<string, BranchSummary> }> {
    const docs: RouterDoc[] = [];
    const summaries: Record<string, BranchSummary> = {};
    for (const branch of this.listBranches()) {
      if (branch.temperature === "frozen") continue;
      const tip = branch.checkpoints[branch.checkpoints.length - 1];
      if (!tip) continue;
      summaries[branch.id] = await this.summarizeBranch(branch.id, {
        budgetTokens: options.budgetTokens,
        vane: options.vane
      });
      const text =
        options.index === "full"
          ? `${branch.title}\n${this.getMessages(branch.id)
              .map((message) => message.content)
              .join("\n")}`
          : `${branch.title}\n${summaries[branch.id].text}`;
      docs.push({
        branchId: branch.id,
        checkpointId: tip.id,
        text,
        updatedAt: Date.parse(branch.updatedAt)
      });
    }
    const route = routeQuery(query, docs, {
      k: options.k,
      recencyWeight: options.recencyWeight,
      halfLifeMs: options.halfLifeMs,
      now: options.now
    });
    return { route, summaries };
  }

  /**
   * Router picks the top-k tips and the query fans out to them in parallel.
   * persist=false (default) answers ephemerally: each selected branch is answered
   * from its CURRENT head without restoring to a checkpoint or appending
   * anything, so the branches do not change (no post-checkpoint messages are
   * dropped); `checkpointId` in each answer is the routed tip. persist=true uses
   * the persisting fan-out from checkpoints instead.
   * Returns the route, the summaries used, and the per-branch answers.
   */
  async fanOutRouted(
    query: string,
    k: number,
    request: GenerateRequest = {},
    options: {
      persist?: boolean;
      index?: "summary" | "full";
      budgetTokens?: number;
      vane?: VaneModule | null;
      recencyWeight?: number;
    } = {}
  ): Promise<{
    route: RouteScore[];
    summaries: Record<string, BranchSummary>;
    answers: Array<{
      branchId: string;
      checkpointId: string;
      generation: GenerateResult;
      checkpoint?: BranchCheckpoint;
    }>;
  }> {
    const { route, summaries } = await this.routeBranches(query, {
      k,
      index: options.index,
      budgetTokens: options.budgetTokens,
      vane: options.vane,
      recencyWeight: options.recencyWeight
    });
    if (route.length === 0) {
      return { route, summaries, answers: [] };
    }

    if (options.persist) {
      const results = await this.fanOutFromCheckpoints(
        route.map((entry) => entry.checkpointId),
        { role: "user", content: query },
        request
      );
      return {
        route,
        summaries,
        answers: results.map((result) => ({
          branchId: result.branch.id,
          checkpointId: result.checkpointId,
          generation: result.generation,
          checkpoint: result.checkpoint
        }))
      };
    }

    const answers = await Promise.all(
      route.map(async (entry) => ({
        branchId: entry.branchId,
        checkpointId: entry.checkpointId,
        generation: await this.generateEphemeral(entry.branchId, {
          ...request,
          messages: [
            ...this.getMessages(entry.branchId),
            { role: "user", content: query, createdAt: new Date().toISOString() }
          ]
        })
      }))
    );
    return { route, summaries, answers };
  }

  /**
   * Compaction keeps the original branch intact and creates a NEW branch whose
   * messages are the original's leading system messages plus a sentence-level
   * Vane fit (or extractive fallback, recorded in summary.method) of the rest
   * of the transcript at `budgetTokens`; with prefill
   * (default true) the new branch is prefilled once on the backend so its KV is
   * saved, then checkpointed. The canonical original text is never modified.
   *
   * parentId is deliberately null: a backend may inherit a parent's KV state on
   * createBranch, and the compacted branch must NOT start from the original's KV
   * (its prompt is different). Lineage is recorded in metadata.compactedFrom
   * instead.
   */
  async compactBranch(
    branchId: string,
    options: { newBranchId: string; budgetTokens: number; prefill?: boolean; vane?: VaneModule | null }
  ): Promise<{
    branch: BranchRecord;
    checkpoint: BranchCheckpoint;
    summary: BranchSummary;
    prefill?: GenerateResult;
  }> {
    const source = this.getBranch(branchId);
    const allMessages = this.getMessages(branchId);
    // Leading system messages are instructions, not history: they are kept
    // verbatim and only the conversation after them is compacted.
    const leadingSystem: MessageRecord[] = [];
    for (const message of allMessages) {
      if (message.role !== "system") break;
      leadingSystem.push(message);
    }
    const messages = allMessages.slice(leadingSystem.length);
    // The router.ts function, NOT the cached summarizeBranch method: the fit must
    // always run at the caller's budget.
    const summary = await summarizeBranch(source.title, messages, {
      budgetTokens: options.budgetTokens,
      vane: options.vane,
      tree: "sentences"
    });
    const branch = await this.createBranch({
      id: options.newBranchId,
      title: `${source.title} (compacted)`,
      kind: source.kind,
      category: source.category,
      responsibility: source.responsibility,
      backend: source.backend,
      modelRef: source.modelRef,
      parentId: null,
      priority: source.priority,
      metadata: {
        ...source.metadata,
        compactedFrom: source.id,
        compactedFromCheckpoint: source.checkpoints.at(-1)?.id ?? null,
        compaction: {
          method: summary.method,
          budgetTokens: options.budgetTokens,
          sourceChars: summary.sourceChars,
          outputChars: summary.text.length,
          sourceMessages: messages.length
        }
      }
    });
    await this.appendMessages(branch.id, [
      ...leadingSystem.map((message) => ({ role: message.role, content: message.content })),
      {
        role: "system",
        content: `Compacted context of branch "${source.title}" (${summary.method}, ${messages.length} messages):\n${summary.text}`
      }
    ]);
    let prefill;
    if (options.prefill !== false) {
      prefill = await this.generate(branch.id, { maxOutputTokens: 1, temperature: 0 });
    }
    const checkpoint = await this.checkpointBranch(branch.id, "compacted");
    return {
      branch: this.getBranch(branch.id),
      checkpoint,
      summary,
      ...(prefill ? { prefill } : {})
    };
  }

  private async requireAdapter(adapterId: string): Promise<LightningAdapter> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`No adapter registered for backend: ${adapterId}`);
    }

    return adapter;
  }
}
