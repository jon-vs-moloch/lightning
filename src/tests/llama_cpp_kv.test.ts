import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { LlamaCppAdapter } from "../backends/llama_cpp.js";
import { createBranchRecord } from "../core/branch.js";
import { LightningRuntime } from "../core/runtime.js";

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

interface RecordedCall {
  method: string;
  path: string;
  body: any;
}

interface IndexedCall {
  call: RecordedCall;
  index: number;
}

interface FakeLlamaServer {
  baseUrl: string;
  calls: RecordedCall[];
  close(): Promise<void>;
}

interface ChatCompletionBody {
  id_slot?: number;
  cache_prompt?: boolean;
  max_tokens?: number;
  messages?: Array<{ role: string; content: string }>;
}

interface KvMeta {
  mode: string;
  savedTo?: string;
  restoredFrom?: string;
  timings?: { cache_n?: number };
}

async function startFakeLlamaServer(opts: {
  slotSave: boolean;
  totalSlots: number;
}): Promise<FakeLlamaServer> {
  const calls: RecordedCall[] = [];

  function respond(res: import("node:http").ServerResponse, status: number, payload: unknown): void {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  }

  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: any = raw.length > 0 ? (JSON.parse(raw) as any) : undefined;
      calls.push({ method: req.method ?? "", path: req.url ?? "", body });

      const [route, query = ""] = (req.url ?? "").split("?");
      const action = new URLSearchParams(query).get("action");
      const slotMatch = /^\/slots\/(\d+)$/.exec(route ?? "");
      const slotId = slotMatch === null ? -1 : Number(slotMatch[1]);

      if (req.method === "GET" && route === "/props") {
        respond(res, 200, { total_slots: opts.totalSlots, build_info: "b-test" });
        return;
      }

      if (req.method === "POST" && slotMatch !== null && action === "save") {
        if (!opts.slotSave) {
          respond(res, 501, {
            error: {
              message:
                "This server does not support slots action. Start it with `--slot-save-path`"
            }
          });
          return;
        }
        respond(res, 200, { id_slot: slotId, filename: body.filename, n_saved: 10 });
        return;
      }

      if (req.method === "POST" && slotMatch !== null && action === "restore") {
        respond(res, 200, { id_slot: slotId, n_restored: 10 });
        return;
      }

      if (req.method === "POST" && slotMatch !== null && action === "erase") {
        respond(res, 200, { n_erased: 0 });
        return;
      }

      if (req.method === "POST" && route === CHAT_COMPLETIONS_PATH) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        respond(res, 200, {
          model: "tiny",
          choices: [
            {
              message: {
                role: "assistant",
                content: "reply-" + body.messages.length
              },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          timings: {
            cache_n: body.id_slot === undefined ? 0 : 40,
            prompt_n: 3,
            prompt_ms: 1.5,
            predicted_n: 2,
            predicted_ms: 2
          }
        });
        return;
      }

      respond(res, 404, { error: { message: `unexpected ${req.method} ${req.url}` } });
    })().catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine test server address.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        upstream.closeIdleConnections();
        upstream.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

interface BranchInput {
  id: string;
  parentId?: string | null;
}

function createTestBranch(input: BranchInput) {
  return createBranchRecord({
    id: input.id,
    title: input.id,
    kind: "chat",
    category: "conversation",
    responsibility: "t",
    backend: "llama.cpp",
    modelRef: "tiny",
    ...(input.parentId === undefined ? {} : { parentId: input.parentId })
  });
}

function chatCalls(calls: RecordedCall[]): IndexedCall[] {
  return calls
    .map((call, index) => ({ call, index }))
    .filter((entry) => entry.call.method === "POST" && entry.call.path === CHAT_COMPLETIONS_PATH);
}

function slotActionCalls(calls: RecordedCall[], action: string): IndexedCall[] {
  const pattern = new RegExp(`^/slots/\\d+\\?action=${action}$`);
  return calls
    .map((call, index) => ({ call, index }))
    .filter((entry) => entry.call.method === "POST" && pattern.test(entry.call.path));
}

function slotIdFromPath(path: string): number {
  const match = /^\/slots\/(\d+)/.exec(path);
  if (!match) {
    throw new Error(`Not a slot path: ${path}`);
  }
  return Number(match[1]);
}

function userMessage(content: string) {
  return { role: "user" as const, content, createdAt: new Date().toISOString() };
}

function assistantMessage(content: string) {
  return { role: "assistant" as const, content, createdAt: new Date().toISOString() };
}

test("llama.cpp adapter reports emulated KV with the refusal reason when slot save is unavailable", async () => {
  const fake = await startFakeLlamaServer({ slotSave: false, totalSlots: 2 });
  try {
    const adapter = new LlamaCppAdapter({ baseUrl: fake.baseUrl });
    const probe = await adapter.probeKvSupport();

    assert.equal(probe.mode, "emulated");
    assert.ok(probe.reason.includes("HTTP 501"));
    assert.ok(probe.reason.includes("--slot-save-path"));
    const capabilities = adapter.capabilities();
    assert.equal(capabilities.checkpoint, "emulated");
    assert.equal(capabilities.prefixReuse, "unsupported");

    const branch = createTestBranch({ id: "trunk" });
    await adapter.createBranch(branch);
    await adapter.appendMessages("trunk", [userMessage("hi")]);
    const result = await adapter.generate("trunk", {});

    const chats = chatCalls(fake.calls);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].call.body.id_slot, undefined);
    assert.equal(chats[0].call.body.cache_prompt, undefined);

    const kv = result.metadata?.kv as KvMeta;
    assert.equal(kv.mode, "emulated");
  } finally {
    await fake.close();
  }
});

test("llama.cpp adapter uses native slot save/restore once probed", async () => {
  const fake = await startFakeLlamaServer({ slotSave: true, totalSlots: 2 });
  try {
    const adapter = new LlamaCppAdapter({ baseUrl: fake.baseUrl });
    const probe = await adapter.probeKvSupport();

    assert.equal(probe.mode, "native");
    assert.equal(probe.slots, 2);
    const capabilities = adapter.capabilities();
    assert.equal(capabilities.checkpoint, "native");
    assert.equal(capabilities.restore, "native");
    assert.equal(capabilities.fork, "native");
    assert.equal(capabilities.prefixReuse, "native");

    const branch = createTestBranch({ id: "trunk" });
    await adapter.createBranch(branch);
    await adapter.appendMessages("trunk", [userMessage("hi")]);

    const firstResult = await adapter.generate("trunk", {});
    const firstKv = firstResult.metadata?.kv as KvMeta;

    assert.ok(
      slotActionCalls(fake.calls, "erase").length > 0,
      "first generation erases a slot instead of restoring"
    );

    const firstChat = chatCalls(fake.calls)[0];
    if (!firstChat) {
      throw new Error("expected the first generation to send a chat completion");
    }
    const firstSave = slotActionCalls(fake.calls, "save").find(
      (entry) =>
        entry.index > firstChat.index &&
        typeof entry.call.body.filename === "string" &&
        /^lightning-trunk-\d+\.bin$/.test(entry.call.body.filename)
    );
    if (!firstSave) {
      throw new Error("expected the first generation to save a slot file after the chat call");
    }
    const firstSavedTo = String(firstSave.call.body.filename);
    assert.equal(firstKv.savedTo, firstSavedTo);
    assert.equal(firstKv.timings?.cache_n, 40);

    await adapter.appendMessages("trunk", [
      assistantMessage(firstResult.text),
      userMessage("more")
    ]);
    await adapter.generate("trunk", {});

    const firstRestore = slotActionCalls(fake.calls, "restore")[0];
    if (!firstRestore) {
      throw new Error("expected the second generation to restore the previously saved KV");
    }
    assert.equal(firstRestore.call.body.filename, firstSavedTo);
    const restoredSlotId = slotIdFromPath(firstRestore.call.path);
    const secondChat = chatCalls(fake.calls).find((entry) => entry.index > firstRestore.index);
    if (!secondChat) {
      throw new Error("expected a chat completion after the restore");
    }
    assert.equal(secondChat.call.body.id_slot, restoredSlotId);
    assert.equal(secondChat.call.body.cache_prompt, true);

    const ck = await adapter.checkpointBranch("trunk");
    assert.equal(ck.branchId, "trunk");

    const thirdResult = await adapter.generate("trunk", {});
    const thirdKv = thirdResult.metadata?.kv as KvMeta;

    const trunkSaves = slotActionCalls(fake.calls, "save").filter(
      (entry) =>
        typeof entry.call.body.filename === "string" &&
        /^lightning-trunk-\d+\.bin$/.test(entry.call.body.filename)
    );
    assert.equal(trunkSaves.length, 3);
    const fileAtCheckpoint = String(trunkSaves[1].call.body.filename);
    const fileAfterCheckpoint = String(trunkSaves[2].call.body.filename);
    assert.equal(thirdKv.savedTo, fileAfterCheckpoint);

    await adapter.restoreBranch("trunk", ck.id);
    await adapter.generate("trunk", {});

    const restoreAfterCheckpoint = slotActionCalls(fake.calls, "restore").at(-1);
    if (!restoreAfterCheckpoint) {
      throw new Error("expected a restore call after restoring the checkpoint");
    }
    assert.equal(restoreAfterCheckpoint.call.body.filename, fileAtCheckpoint);
    assert.notEqual(restoreAfterCheckpoint.call.body.filename, fileAfterCheckpoint);

    const stats = await adapter.branchStats("trunk");
    assert.equal(stats.cachedTokensSource, "measured");
    assert.equal(stats.cachedTokens, 40);
  } finally {
    await fake.close();
  }
});

test("a forked branch inherits its parent's KV file", async () => {
  const fake = await startFakeLlamaServer({ slotSave: true, totalSlots: 2 });
  try {
    const adapter = new LlamaCppAdapter({ baseUrl: fake.baseUrl });
    await adapter.probeKvSupport();

    await adapter.createBranch(createTestBranch({ id: "p" }));
    await adapter.appendMessages("p", [userMessage("parent seed")]);
    const parentResult = await adapter.generate("p", {});

    const parentChat = chatCalls(fake.calls)[0];
    if (!parentChat) {
      throw new Error("expected the parent generation to send a chat completion");
    }
    const parentSave = slotActionCalls(fake.calls, "save").find(
      (entry) =>
        entry.index > parentChat.index &&
        typeof entry.call.body.filename === "string" &&
        /^lightning-p-\d+\.bin$/.test(entry.call.body.filename)
    );
    if (!parentSave) {
      throw new Error("expected the parent generation to save a slot file");
    }
    const inheritedFile = String(parentSave.call.body.filename);

    await adapter.createBranch(createTestBranch({ id: "c", parentId: "p" }));
    await adapter.appendMessages("c", [
      assistantMessage(parentResult.text),
      userMessage("child question")
    ]);
    const childResult = await adapter.generate("c", {});
    const childKv = childResult.metadata?.kv as KvMeta;
    assert.equal(childKv.restoredFrom, inheritedFile);
    assert.equal(childKv.mode, "native");

    const childRestore = slotActionCalls(fake.calls, "restore")[0];
    if (!childRestore) {
      throw new Error("expected the child generation to restore its parent's KV file");
    }
    assert.equal(childRestore.call.body.filename, inheritedFile);
  } finally {
    await fake.close();
  }
});

test("runtime fans one query out to several checkpoints in parallel on distinct slots", async () => {
  const fake = await startFakeLlamaServer({ slotSave: true, totalSlots: 3 });
  try {
    const adapter = new LlamaCppAdapter({ baseUrl: fake.baseUrl });
    const probe = await adapter.probeKvSupport();
    assert.equal(probe.mode, "native");

    const runtime = new LightningRuntime();
    runtime.registerAdapter(adapter);

    await runtime.createBranch({
      id: "trunk",
      title: "Trunk",
      kind: "chat",
      category: "conversation",
      responsibility: "t",
      backend: "llama.cpp",
      modelRef: "tiny"
    });
    await runtime.appendMessages("trunk", [{ role: "user", content: "long" }]);
    const trunkGeneration = await runtime.generate("trunk");
    await runtime.appendMessages("trunk", [
      { role: "assistant", content: trunkGeneration.text }
    ]);
    await runtime.checkpointBranch("trunk", "trunk");

    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const tipId = `tip-${i}`;
      await runtime.forkBranch("trunk", { id: tipId, title: `Tip ${i}` });
      await runtime.appendMessages(tipId, [{ role: "user", content: `angle ${i}` }]);
      await runtime.generate(tipId);
      await runtime.appendMessages(tipId, [{ role: "assistant", content: "noted" }]);
      const tipCheckpoint = await runtime.checkpointBranch(tipId, "tip");
      ids.push(tipCheckpoint.id);
    }

    const results = await runtime.fanOutFromCheckpoints(
      ids,
      { role: "user", content: "Q" },
      { maxOutputTokens: 8 }
    );

    assert.equal(results.length, 3);
    results.forEach((result, index) => {
      assert.equal(result.checkpointId, ids[index]);
      const kv = result.generation.metadata?.kv as { mode: string };
      assert.equal(kv.mode, "native");
    });

    const allChats = chatCalls(fake.calls);
    assert.ok(allChats.length >= 3, "expected at least the three fan-out chat calls");
    const fanOutChats = allChats.slice(-3);
    assert.equal(fanOutChats.length, 3);
    const fanOutBody = fanOutChats.map((entry) => entry.call.body as ChatCompletionBody);
    const fanOutSlots = fanOutBody.map((chatBody) => chatBody.id_slot);
    const totalSlots = fanOutSlots.reduce<number>((sum, slot) => sum + (slot ?? 0), 0);
    assert.equal(totalSlots, 3, "three parallel fan-out requests used slots 0, 1 and 2");
    assert.equal(fanOutSlots.length, 3);
    assert.equal(new Set(fanOutSlots).size, 3);
    for (const chatBody of fanOutBody) {
      assert.equal(chatBody.max_tokens, 8);
    }

    const fanOutEntries = fanOutBody.map((chatBody) => {
      const entry = fanOutChats.find((item) => item.call.body === chatBody);
      if (!entry) {
        throw new Error("could not map fan-out chat body back to its recorded call");
      }
      return { chatBody, ...entry };
    });
    fanOutEntries.forEach((entry) => {
      const slotId = Number(entry.chatBody.id_slot);
      const lastActionOnSlot = fake.calls
        .map((call, index) => ({ call, index }))
        .filter(
          (item) =>
            item.index < entry.index &&
            item.call.method === "POST" &&
            item.call.path.startsWith("/slots/") &&
            slotIdFromPath(item.call.path) === slotId
        )
        .at(-1);
      if (!lastActionOnSlot) {
        throw new Error(`expected a slot action before the fan-out chat on slot ${slotId}`);
      }
      assert.match(lastActionOnSlot.call.path, /\?action=restore$/);
      assert.equal(slotIdFromPath(lastActionOnSlot.call.path), slotId);
    });
  } finally {
    await fake.close();
  }
});

test("fan-out refuses two checkpoints on the same branch", async () => {
  const fake = await startFakeLlamaServer({ slotSave: true, totalSlots: 3 });
  try {
    const adapter = new LlamaCppAdapter({ baseUrl: fake.baseUrl });
    const probe = await adapter.probeKvSupport();
    assert.equal(probe.mode, "native");

    const runtime = new LightningRuntime();
    runtime.registerAdapter(adapter);

    await runtime.createBranch({
      id: "solo",
      title: "Solo",
      kind: "chat",
      category: "conversation",
      responsibility: "t",
      backend: "llama.cpp",
      modelRef: "tiny"
    });
    await runtime.appendMessages("solo", [{ role: "user", content: "hello" }]);
    await runtime.generate("solo");

    const first = await runtime.checkpointBranch("solo", "first");
    const second = await runtime.checkpointBranch("solo", "second");

    await assert.rejects(
      runtime.fanOutFromCheckpoints([first.id, second.id], { role: "user", content: "Q" }),
      /distinct branches/
    );
  } finally {
    await fake.close();
  }
});
