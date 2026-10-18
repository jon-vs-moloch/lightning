import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { AppendMessageInput, LightningRuntime } from "../core/runtime.js";
import type { BranchCheckpoint, BranchRecord, GenerateResult, MessageRecord } from "../core/types.js";

export interface LightningApiServerOptions {
  runtime: LightningRuntime;
  defaultBackend: string;
  defaultModelRef: string;

  /**
   * Extra Host-header values the server answers to, besides localhost, 127.0.0.1 and [::1] on its own port.
   * Each entry is `host` (matches with any port or none) or `host:port` (matches only that port; no port in
   * the Host header means 80). Hostnames are case-insensitive and IPv6 goes in brackets. Entries that cannot
   * be parsed are ignored. Loopback names arriving on another port (for example a container's 8787 published
   * as localhost:9000) are also checked against this list. Every other Host is refused with 403.
   */
  allowedHosts?: string[];
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

interface ThreadPinRequest {
  messages: Array<{
    role: MessageRecord["role"];
    content: string;
    metadata?: Record<string, unknown>;
  }>;
  branch?: Partial<Pick<BranchRecord, "title" | "kind" | "category" | "responsibility">> & {
    priority?: number;
    metadata?: Record<string, unknown>;
  };
  model?: string;
  checkpoint_label?: string;
  checkpoint_summary?: string;
}

/** Largest request body the API accepts, in bytes. Larger bodies are refused with 413 and never buffered whole. */
const MAX_BODY_BYTES = 1024 * 1024;

/** An error whose HTTP status the server answers with (every other error is a 500). */
class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Loopback names always accepted in the Host header with the port the request arrived on; with any other port only when `allowedHosts` lists them. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Split a Host header into a lower-cased hostname (IPv6 keeps its brackets) and an optional port string. Returns undefined when it cannot be parsed. */
function parseHostHeader(value: string): { hostname: string; port?: string } | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing === -1) {
      return undefined;
    }
    const hostname = trimmed.slice(0, closing + 1);
    const rest = trimmed.slice(closing + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) {
      return undefined;
    }
    return { hostname, port: rest === "" ? undefined : rest.slice(1) };
  }

  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) {
    return { hostname: trimmed };
  }
  if (trimmed.indexOf(":", firstColon + 1) !== -1) {
    return undefined;
  }
  const hostname = trimmed.slice(0, firstColon);
  const port = trimmed.slice(firstColon + 1);
  if (!hostname || !/^\d+$/.test(port)) {
    return undefined;
  }
  return { hostname, port };
}

/** DNS-rebinding defence: the Host header must name this server. */
function isAllowedHost(req: IncomingMessage, options: LightningApiServerOptions): boolean {
  const header = req.headers.host;
  if (typeof header !== "string" || header === "") {
    return false;
  }
  const parsed = parseHostHeader(header);
  if (!parsed) {
    return false;
  }

  if (
    LOOPBACK_HOSTNAMES.has(parsed.hostname) &&
    (parsed.port ?? "80") === String(req.socket.localPort)
  ) {
    return true;
  }

  return matchesAllowedHost(parsed, options.allowedHosts ?? []);
}

/** True when an explicitly configured entry names this Host: `host` matches any port, `host:port` only that port (no port in the header means 80). Unparseable entries match nothing. */
function matchesAllowedHost(
  parsed: { hostname: string; port?: string },
  allowedHosts: string[]
): boolean {
  for (const entry of allowedHosts) {
    const allowed = parseHostHeader(entry);
    if (!allowed) {
      continue;
    }
    if (allowed.hostname !== parsed.hostname) {
      continue;
    }
    if (allowed.port === undefined) {
      return true;
    }
    if (allowed.port === (parsed.port ?? "80")) {
      return true;
    }
  }
  return false;
}

export function createLightningApiServer(options: LightningApiServerOptions) {
  const server = createServer(async (req, res) => {
    try {
      if (!isAllowedHost(req, options)) {
        throw new HttpError(
          403,
          "Host header not allowed. Lightning only answers to localhost, 127.0.0.1, [::1] and configured allowed hosts."
        );
      }
      await routeRequest(req, res, options);
    } catch (error) {
      writeJson(res, error instanceof HttpError ? error.statusCode : 500, {
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

  if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const page = loadInspectorPage();
    if (!page) {
      writeJson(res, 404, { error: "Inspector page not found (expected public/index.html)." });
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(page);
    return;
  }

  if (method === "GET" && url.pathname === "/v1/branches") {
    writeJson(res, 200, handleBranchList(options));
    return;
  }

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

  if (method === "GET" && url.pathname.startsWith("/v1/threads/") && url.pathname.split("/").length === 4) {
    const threadId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const payload = await handleThreadInspect(threadId, options);
    writeJson(res, 200, payload);
    return;
  }

  if (method === "POST" && url.pathname.startsWith("/v1/threads/") && url.pathname.endsWith("/pin")) {
    const threadId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const body = (await readJson(req)) as ThreadPinRequest;
    const payload = await handleThreadPin(threadId, body, options);
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

  if (method === "GET" && url.pathname.startsWith("/v1/checkpoints/") && url.pathname.split("/").length === 4) {
    const checkpointId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const payload = await handleCheckpointInspect(checkpointId, options);
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
  const message = requireMessage(body);
  assertBranchWritable(threadId, options);
  await ensureBranch(threadId, body.branch, options);

  await options.runtime.appendMessages(threadId, [
    {
      role: message.role ?? "user",
      content: message.content,
      metadata: message.metadata
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
  const incomingMessages = requireMessageArray(
    body,
    false,
    "Chat completions need a non-empty messages array of objects with string role and content."
  );

  if (body.stream) {
    throw new Error("Streaming is not implemented yet.");
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

  assertBranchWritable(persistentThreadId, options);
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
  const message = requireMessage(body);
  if (body.thread_id !== undefined && typeof body.thread_id !== "string") {
    throw new HttpError(400, "thread_id must be a string.");
  }
  assertBranchWritable(requireCheckpoint(checkpointId, options).branchId, options);
  if (body.thread_id) {
    assertBranchWritable(body.thread_id, options);
  }
  const result = await options.runtime.respondFromCheckpoint(
    checkpointId,
    {
      role: message.role ?? "user",
      content: message.content,
      metadata: message.metadata
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

/** Read-only snapshot of the whole branch set, used by the inspector page. */
function handleBranchList(options: LightningApiServerOptions) {
  const threadHeads = options.runtime.listThreadHeads();
  return {
    defaultBackend: options.defaultBackend,
    adapters: options.runtime.describeAdapters(),
    branches: options.runtime.listBranches().map((branch) => ({
      ...branch,
      messageCount: options.runtime.getMessages(branch.id).length,
      headCheckpointId: threadHeads.find((entry) => entry.threadId === branch.id)?.checkpointId
    })),
    threadHeads
  };
}

let inspectorPage: string | null | undefined;

/** The inspector is one static file at <package root>/public/index.html. */
function loadInspectorPage(): string | null {
  if (inspectorPage === undefined) {
    try {
      inspectorPage = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
    } catch {
      inspectorPage = null;
    }
  }
  return inspectorPage;
}

async function handleThreadInspect(threadId: string, options: LightningApiServerOptions) {
  const branch = requireBranch(threadId, options);
  const stats = await options.runtime.branchStats(threadId);
  const messages = options.runtime.getMessages(threadId);
  const headCheckpointId = options.runtime.getThreadHead(threadId);

  return {
    threadId,
    headCheckpointId,
    branch,
    stats,
    recentMessages: messages.slice(-20)
  };
}

async function handleCheckpointInspect(checkpointId: string, options: LightningApiServerOptions) {
  requireCheckpoint(checkpointId, options);
  const snapshot = options.runtime.inspectCheckpoint(checkpointId);
  const threadHead = options.runtime
    .listThreadHeads()
    .find((entry) => entry.checkpointId === checkpointId);

  return {
    checkpoint: snapshot.checkpoint,
    branch: snapshot.branch,
    messageCount: snapshot.messages.length,
    recentMessages: snapshot.messages.slice(-20),
    threadId: threadHead?.threadId
  };
}

async function handleThreadPin(
  threadId: string,
  body: ThreadPinRequest,
  options: LightningApiServerOptions
) {
  const messages = requireMessageArray(
    body,
    true,
    "Pin requests need a messages array of objects with string role and content."
  );

  assertBranchWritable(threadId, options);
  const modelRef = body.model ?? options.defaultModelRef;
  const branchConfig = {
    title: body.branch?.title ?? `Thread ${threadId}`,
    kind: body.branch?.kind ?? "chat",
    category: body.branch?.category ?? "conversation",
    responsibility: body.branch?.responsibility ?? "Pinned compatibility transcript",
    priority: body.branch?.priority,
    metadata: body.branch?.metadata
  };

  const appendableMessages = messages.map((message) => ({
    role: message.role,
    content: message.content,
    metadata: message.metadata
  }));

  try {
    options.runtime.getBranch(threadId);
  } catch {
    await options.runtime.createBranch({
      id: threadId,
      title: branchConfig.title,
      kind: branchConfig.kind,
      category: branchConfig.category,
      responsibility: branchConfig.responsibility,
      backend: options.defaultBackend,
      modelRef,
      priority: branchConfig.priority,
      metadata: branchConfig.metadata
    });
  }

  await options.runtime.replaceBranchMessages(threadId, appendableMessages);
  const checkpoint = await options.runtime.checkpointBranch(
    threadId,
    body.checkpoint_label ?? `pin-${Date.now()}`,
    body.checkpoint_summary
  );
  options.runtime.setThreadHead(threadId, checkpoint.id);

  return {
    threadId,
    headCheckpointId: checkpoint.id,
    checkpoint,
    branch: options.runtime.getBranch(threadId),
    stats: await options.runtime.branchStats(threadId),
    recentMessages: options.runtime.getMessages(threadId).slice(-20)
  };
}

/** Turn routes need `message.content` as a string; anything else is a client error, not a crash. */
function requireMessage(body: unknown): {
  role?: MessageRecord["role"];
  content: string;
  metadata?: Record<string, unknown>;
} {
  if (typeof body !== "object" || body === null) {
    throw new HttpError(400, "Request body needs a message object with a string content field.");
  }

  const record = body as Record<string, unknown>;
  if (typeof record.message !== "object" || record.message === null) {
    throw new HttpError(400, "Request body needs a message object with a string content field.");
  }

  const message = record.message as Record<string, unknown>;
  if (typeof message.content !== "string") {
    throw new HttpError(400, "Request body needs a message object with a string content field.");
  }

  return message as {
    role?: MessageRecord["role"];
    content: string;
    metadata?: Record<string, unknown>;
  };
}

/** Pin and chat-completion bodies need `messages` as an array of objects with string role and content; anything else is a 400, not a crash. */
function requireMessageArray(
  body: unknown,
  allowEmpty: boolean,
  errorMessage: string
): Array<{
  role: MessageRecord["role"];
  content: string;
  metadata?: Record<string, unknown>;
}> {
  if (typeof body !== "object" || body === null) {
    throw new HttpError(400, errorMessage);
  }

  const messages = (body as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) {
    throw new HttpError(400, errorMessage);
  }

  if (messages.length === 0 && !allowEmpty) {
    throw new HttpError(400, errorMessage);
  }

  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      throw new HttpError(400, errorMessage);
    }
    const record = message as Record<string, unknown>;
    if (typeof record.role !== "string" || typeof record.content !== "string") {
      throw new HttpError(400, errorMessage);
    }
  }

  return messages as Array<{
    role: MessageRecord["role"];
    content: string;
    metadata?: Record<string, unknown>;
  }>;
}

/** Look up a checkpoint, answering 404 for an unknown id instead of a 500. */
function requireCheckpoint(
  checkpointId: string,
  options: LightningApiServerOptions
): BranchCheckpoint {
  try {
    return options.runtime.getCheckpoint(checkpointId);
  } catch {
    throw new HttpError(404, `Unknown checkpoint: ${checkpointId}`);
  }
}

/** Look up a thread's branch, answering 404 for an unknown id instead of a 500. */
function requireBranch(threadId: string, options: LightningApiServerOptions): BranchRecord {
  try {
    return options.runtime.getBranch(threadId);
  } catch {
    throw new HttpError(404, `Unknown thread: ${threadId}`);
  }
}

/** Frozen branches are read-only: refuse any request that would add a turn to, rewind or replace one. Unknown ids pass (the route creates the branch). */
function assertBranchWritable(branchId: string, options: LightningApiServerOptions): void {
  let branch: BranchRecord;
  try {
    branch = options.runtime.getBranch(branchId);
  } catch {
    return;
  }
  if (branch.temperature === "frozen") {
    throw new HttpError(409, `Branch ${branchId} is frozen and read-only. Thaw it before sending it a turn.`);
  }
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
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Request body must be JSON: send content-type: application/json.");
  }

  const contentLength = Number(req.headers["content-length"] ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(413, `Request body is larger than ${MAX_BODY_BYTES} bytes.`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    if (!tooLarge) {
      chunks.push(buffer);
    }
  }

  if (tooLarge) {
    throw new HttpError(413, `Request body is larger than ${MAX_BODY_BYTES} bytes.`);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function writeJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload, null, 2));
}
