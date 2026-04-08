import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import type { AppendMessageInput, LightningRuntime } from "../core/runtime.js";
import type { BranchRecord, GenerateResult, MessageRecord } from "../core/types.js";

export interface LightningApiServerOptions {
  runtime: LightningRuntime;
  defaultBackend: string;
  defaultModelRef: string;
}

interface ThreadMessageRequest {
  message: {
    role?: MessageRecord["role"];
    content: string;
    metadata?: Record<string, unknown>;
  };
  branch?: Partial<Pick<BranchRecord, "title" | "kind" | "category" | "responsibility">> & {
    priority?: number;
    metadata?: Record<string, unknown>;
  };
  generation?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

interface ChatCompletionsRequest {
  model?: string;
  messages?: Array<{
    role: MessageRecord["role"];
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  thread_id?: string;
  user?: string;
  metadata?: Record<string, unknown>;
}

interface CheckpointRespondRequest {
  message: {
    role?: MessageRecord["role"];
    content: string;
    metadata?: Record<string, unknown>;
  };
  generation?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
  thread_id?: string;
  checkpoint_label?: string;
  checkpoint_summary?: string;
}

export function createLightningApiServer(options: LightningApiServerOptions) {
  const server = createServer(async (req, res) => {
    try {
      await routeRequest(req, res, options);
    } catch (error) {
      writeJson(res, 500, {
        error: error instanceof Error ? error.message : "Unexpected server error"
      });
    }
  });

  return server;
}

async function routeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: LightningApiServerOptions
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (method === "GET" && url.pathname === "/healthz") {
    writeJson(res, 200, {
      ok: true,
      adapters: options.runtime.listAdapters()
    });
    return;
  }

  if (method === "POST" && url.pathname.startsWith("/v1/threads/") && url.pathname.endsWith("/messages")) {
    const threadId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const body = (await readJson(req)) as ThreadMessageRequest;
    const payload = await handleThreadMessage(threadId, body, options);
    writeJson(res, 200, payload);
    return;
  }

  if (method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = (await readJson(req)) as ChatCompletionsRequest;
    const payload = await handleChatCompletion(body, options);
    writeJson(res, 200, payload);
    return;
  }

  if (method === "POST" && url.pathname.startsWith("/v1/checkpoints/") && url.pathname.endsWith("/respond")) {
    const checkpointId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const body = (await readJson(req)) as CheckpointRespondRequest;
    const payload = await handleCheckpointRespond(checkpointId, body, options);
    writeJson(res, 200, payload);
    return;
  }

  writeJson(res, 404, {
    error: `No route for ${method} ${url.pathname}`
  });
}

async function handleThreadMessage(
  threadId: string,
  body: ThreadMessageRequest,
  options: LightningApiServerOptions
) {
  await ensureBranch(threadId, body.branch, options);

  await options.runtime.appendMessages(threadId, [
    {
      role: body.message.role ?? "user",
      content: body.message.content,
      metadata: body.message.metadata
    }
  ]);

  const generation = await options.runtime.generate(threadId, body.generation);
  await appendAssistantReply(threadId, generation, options.runtime);
  const checkpoint = await options.runtime.checkpointBranch(threadId, `turn-${Date.now()}`);
  options.runtime.setThreadHead(threadId, checkpoint.id);
  const stats = await options.runtime.branchStats(threadId);

  return {
    threadId,
    headCheckpointId: checkpoint.id,
    reply: generation.text,
    generation,
    checkpoint,
    stats,
    branch: options.runtime.getBranch(threadId)
  };
}

async function handleChatCompletion(
  body: ChatCompletionsRequest,
  options: LightningApiServerOptions
) {
  if (body.stream) {
    throw new Error("Streaming is not implemented yet.");
  }

  const incomingMessages = body.messages ?? [];
  if (incomingMessages.length === 0) {
    throw new Error("Chat completions require at least one message.");
  }

  const persistentThreadId = getThreadId(body);
  const modelRef = body.model ?? options.defaultModelRef;
  const generationOptions = {
    temperature: body.temperature,
    maxOutputTokens: body.max_tokens
  };

  if (!persistentThreadId) {
    const ephemeralThreadId = `ephemeral-${randomUUID()}`;
    await options.runtime.createBranch({
      id: ephemeralThreadId,
      title: "Ephemeral Request",
      kind: "scratch",
      category: "api",
      responsibility: "One-shot compatibility request",
      backend: options.defaultBackend,
      modelRef
    });

    try {
      await options.runtime.appendMessages(ephemeralThreadId, incomingMessages);
      const generation = await options.runtime.generate(ephemeralThreadId, generationOptions);
      const checkpoint = await options.runtime.checkpointBranch(
        ephemeralThreadId,
        `compat-turn-${Date.now()}`
      );
      return toOpenAiChatCompletion(ephemeralThreadId, modelRef, generation, checkpoint.id);
    } finally {
      await options.runtime.deleteBranch(ephemeralThreadId);
    }
  }

  await ensureBranch(
    persistentThreadId,
    {
      title: `Thread ${persistentThreadId}`,
      kind: "chat",
      category: "conversation",
      responsibility: "Persistent chat API thread"
    },
    options,
    modelRef
  );

  const existingMessages = options.runtime.getMessages(persistentThreadId);
  const suffix = reconcileMessages(existingMessages, incomingMessages);
  if (suffix.length > 0) {
    await options.runtime.appendMessages(persistentThreadId, suffix);
  }

  const generation = await options.runtime.generate(persistentThreadId, generationOptions);
  await appendAssistantReply(persistentThreadId, generation, options.runtime);
  const checkpoint = await options.runtime.checkpointBranch(
    persistentThreadId,
    `compat-turn-${Date.now()}`
  );
  options.runtime.setThreadHead(persistentThreadId, checkpoint.id);

  return toOpenAiChatCompletion(persistentThreadId, modelRef, generation, checkpoint.id);
}

async function handleCheckpointRespond(
  checkpointId: string,
  body: CheckpointRespondRequest,
  options: LightningApiServerOptions
) {
  const result = await options.runtime.respondFromCheckpoint(
    checkpointId,
    {
      role: body.message.role ?? "user",
      content: body.message.content,
      metadata: body.message.metadata
    },
    body.generation,
    {
      checkpointLabel: body.checkpoint_label ?? `checkpoint-turn-${Date.now()}`,
      checkpointSummary: body.checkpoint_summary,
      threadId: body.thread_id
    }
  );

  const stats = await options.runtime.branchStats(result.branch.id);

  return {
    checkpointId,
    nextCheckpointId: result.checkpoint.id,
    threadId: body.thread_id,
    headCheckpointId: body.thread_id ? options.runtime.getThreadHead(body.thread_id) : undefined,
    reply: result.generation.text,
    generation: result.generation,
    checkpoint: result.checkpoint,
    stats,
    branch: result.branch
  };
}

async function ensureBranch(
  branchId: string,
  branch: ThreadMessageRequest["branch"] | undefined,
  options: LightningApiServerOptions,
  modelRef = options.defaultModelRef
): Promise<void> {
  try {
    options.runtime.getBranch(branchId);
    return;
  } catch {
    await options.runtime.createBranch({
      id: branchId,
      title: branch?.title ?? `Thread ${branchId}`,
      kind: branch?.kind ?? "chat",
      category: branch?.category ?? "conversation",
      responsibility: branch?.responsibility ?? "Persistent API thread",
      backend: options.defaultBackend,
      modelRef,
      priority: branch?.priority,
      metadata: branch?.metadata
    });
  }
}

function reconcileMessages(
  existing: MessageRecord[],
  incoming: ChatCompletionsRequest["messages"]
): AppendMessageInput[] {
  const normalizedIncoming = (incoming ?? []).map((message) => ({
    role: message.role,
    content: message.content
  }));

  const prefixMatches =
    existing.length <= normalizedIncoming.length &&
    existing.every(
      (message, index) =>
        message.role === normalizedIncoming[index]?.role &&
        message.content === normalizedIncoming[index]?.content
    );

  if (!prefixMatches) {
    throw new Error(
      "Incoming transcript diverges from stored thread state. Reset or use a new thread_id."
    );
  }

  return normalizedIncoming.slice(existing.length);
}

async function appendAssistantReply(
  branchId: string,
  generation: GenerateResult,
  runtime: LightningRuntime
): Promise<void> {
  await runtime.appendMessages(branchId, [
    {
      role: "assistant",
      content: generation.text
    }
  ]);
}

function getThreadId(body: ChatCompletionsRequest): string | undefined {
  const metadataThreadId =
    body.metadata && typeof body.metadata.thread_id === "string"
      ? body.metadata.thread_id
      : undefined;

  return body.thread_id ?? metadataThreadId ?? body.user ?? undefined;
}

function toOpenAiChatCompletion(
  threadId: string,
  modelRef: string,
  generation: GenerateResult,
  checkpointId?: string
) {
  return {
    id: `chatcmpl-${threadId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelRef,
    choices: [
      {
        index: 0,
        finish_reason: generation.stopReason ?? "stop",
        message: {
          role: "assistant",
          content: generation.text
        }
      }
    ],
    usage: {
      prompt_tokens: generation.usage?.promptTokens,
      completion_tokens: generation.usage?.completionTokens,
      total_tokens: generation.usage?.totalTokens
    },
    lightning: {
      thread_id: threadId,
      checkpoint_id: checkpointId
    }
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload, null, 2));
}
