import test from "node:test";
import assert from "node:assert/strict";

import { FakeAdapter, LightningRuntime } from "../index.js";

async function createRuntime(): Promise<LightningRuntime> {
  const runtime = new LightningRuntime();
  runtime.registerAdapter(new FakeAdapter());

  await runtime.createBranch({
    id: "chat-main",
    title: "Main Chat",
    kind: "chat",
    category: "conversation",
    responsibility: "Primary lane",
    backend: "fake",
    modelRef: "fake-echo-v1",
    priority: 1,
    temperature: "hot"
  });

  return runtime;
}

test("generate uses stored branch context once", async () => {
  const runtime = await createRuntime();

  await runtime.appendMessages("chat-main", [
    { role: "system", content: "You are Lightning." },
    { role: "user", content: "Count me once." }
  ]);

  const result = await runtime.generate("chat-main");
  const stats = await runtime.branchStats("chat-main");

  assert.equal(result.text, "branch:chat-main | model:fake-echo-v1 | echo:Count me once.");
  assert.equal(result.usage?.promptTokens, stats.promptTokens);
});

test("fork can change branch kind while inheriting parent messages", async () => {
  const runtime = await createRuntime();

  await runtime.appendMessages("chat-main", [
    { role: "user", content: "Parent context." }
  ]);

  const fork = await runtime.forkBranch("chat-main", {
    id: "bg-main",
    title: "Background Lane",
    kind: "background",
    category: "background",
    responsibility: "Longer horizon work"
  });

  assert.equal(fork.kind, "background");
  assert.equal(fork.parentId, "chat-main");
  assert.equal(runtime.getMessages("bg-main").length, 1);
});

test("restore rewinds messages to the checkpoint snapshot", async () => {
  const runtime = await createRuntime();

  await runtime.appendMessages("chat-main", [
    { role: "user", content: "Before checkpoint." }
  ]);

  const checkpoint = await runtime.checkpointBranch("chat-main", "baseline");

  await runtime.appendMessages("chat-main", [
    { role: "assistant", content: "After checkpoint." }
  ]);

  assert.equal(runtime.getMessages("chat-main").length, 2);

  await runtime.restoreBranch("chat-main", checkpoint.id);

  const restoredMessages = runtime.getMessages("chat-main");
  assert.equal(restoredMessages.length, 1);
  assert.equal(restoredMessages[0]?.content, "Before checkpoint.");
});
