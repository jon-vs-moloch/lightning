import test from "node:test";
import assert from "node:assert/strict";

import { FakeAdapter, LightningRuntime } from "../index.js";
import {
  extractiveSummary,
  loadVane,
  routeQuery,
  summarizeBranch,
  tokenize
} from "../core/router.js";
import type { VaneModule } from "../core/router.js";
import type { MessageRecord } from "../core/types.js";

const msg = (role: MessageRecord["role"], content: string): MessageRecord => ({
  role,
  content,
  createdAt: "2026-10-18T00:00:00.000Z"
});

async function runtimeWith(branches: Array<{ id: string; messages: Array<[MessageRecord["role"], string]> }>) {
  const runtime = new LightningRuntime();
  runtime.registerAdapter(new FakeAdapter());
  for (const spec of branches) {
    await runtime.createBranch({
      id: spec.id,
      title: spec.id,
      kind: "chat",
      category: "test",
      responsibility: "test",
      backend: "fake",
      modelRef: "fake"
    });
    await runtime.appendMessages(
      spec.id,
      spec.messages.map(([role, content]) => ({ role, content }))
    );
    await runtime.checkpointBranch(spec.id, "tip");
  }
  return runtime;
}

test("tokenize drops stopwords and folds plurals", () => {
  assert.deepEqual(tokenize("What are the Tomatoes watered with?"), ["tomatoe", "watered"]);
  assert.deepEqual(tokenize("glass of water"), ["glass", "water"]);
});

test("routeQuery ranks by lexical match and falls back to recency", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const docs = [
    { branchId: "garden", checkpointId: "g", text: "tomato bed drip timer", updatedAt: now - 3_600_000 },
    { branchId: "taxes", checkpointId: "t", text: "quarterly estimated payment accountant", updatedAt: now },
    { branchId: "car", checkpointId: "c", text: "serpentine belt service", updatedAt: now - 7_200_000 }
  ];
  const route = routeQuery("when does the drip timer run", docs, { k: 2, now });
  assert.equal(route[0].branchId, "garden");
  assert.equal(route[0].lexical, 1);
  assert.equal(route.length, 2);

  const fallback = routeQuery("zebra", docs, { k: 1, now });
  assert.equal(fallback[0].branchId, "taxes", "no lexical match: most recent wins");
  assert.equal(fallback[0].lexical, 0);
});

test("extractive summary respects its token budget and says what it left out", () => {
  const messages = Array.from({ length: 10 }, (_, i) =>
    msg("user", `Message number ${i} talks about topic ${i}. More detail follows here.`)
  );
  const text = extractiveSummary("long", messages, 40);
  assert.ok(Math.ceil(text.length / 4) <= 40);
  assert.match(text, /\+ \d+ more/);
  assert.match(text, /Message number 0 talks about topic 0\./);
});

test("summarizeBranch records whether Vane or the extractive fallback produced it", async () => {
  const messages = [msg("user", "Plan the garden. Tomatoes first."), msg("assistant", "Sure. Drip timer.")];
  let seen: unknown;
  const vane: VaneModule = {
    fitTree(tree, options) {
      seen = { tree, options };
      return { text: "vane view", metrics: { mode: "full", coverage: 1, outputTokens: 3 } };
    }
  };
  const viaVane = await summarizeBranch("garden", messages, { budgetTokens: 50, vane });
  assert.equal(viaVane.method, "vane");
  assert.equal(viaVane.text, "vane view");
  assert.deepEqual((seen as any).options, { budget: { tokens: 50 }, order: "source" });
  assert.equal((seen as any).tree.children.length, 2);

  await summarizeBranch("garden", messages, { budgetTokens: 50, vane, tree: "sentences" });
  assert.deepEqual((seen as any).tree.children[0], {
    title: "user: Plan the garden.",
    children: [{ title: "Tomatoes first." }]
  });

  const viaFallback = await summarizeBranch("garden", messages, { budgetTokens: 50, vane: null });
  assert.equal(viaFallback.method, "extractive");
  assert.match(viaFallback.text, /- garden/);

  assert.equal(await loadVane("@owl-kestrel/definitely-not-installed"), undefined);
});

test("fanOutRouted answers only the routed tips and does not grow branches", async () => {
  const runtime = await runtimeWith([
    { id: "garden", messages: [["user", "The drip timer waters the tomato bed."]] },
    { id: "taxes", messages: [["user", "The accountant set the quarterly payment."]] },
    { id: "car", messages: [["user", "The mechanic replaced the serpentine belt."]] }
  ]);
  const before = runtime.getMessages("garden").length;
  const result = await runtime.fanOutRouted("when does the drip timer water tomatoes", 1, {}, { vane: null });
  assert.deepEqual(result.route.map((r) => r.branchId), ["garden"]);
  assert.equal(result.answers.length, 1);
  assert.match(result.answers[0].generation.text, /echo:when does the drip timer water tomatoes/);
  assert.equal(result.summaries.garden.method, "extractive");
  assert.equal(runtime.getMessages("garden").length, before, "ephemeral fan-out leaves the branch as it was");

  const persisted = await runtime.fanOutRouted("serpentine belt", 1, {}, { vane: null, persist: true });
  assert.deepEqual(persisted.route.map((r) => r.branchId), ["car"]);
  assert.ok(persisted.answers[0].checkpoint, "persist=true checkpoints the answer");
});

test("compactBranch keeps the original intact and starts a new checkpointed branch", async () => {
  const runtime = await runtimeWith([
    {
      id: "long",
      messages: [
        ["system", "Answer briefly."],
        ...Array.from({ length: 12 }, (_, i): [MessageRecord["role"], string] => [
          i % 2 === 0 ? "user" : "assistant",
          `Turn ${i} says something. It has a second sentence with detail ${i}.`
        ])
      ]
    }
  ]);
  const original = runtime.getMessages("long");
  const compacted = await runtime.compactBranch("long", { newBranchId: "long-c", budgetTokens: 60, vane: null });

  assert.deepEqual(runtime.getMessages("long"), original, "original transcript unchanged");
  const messages = runtime.getMessages("long-c");
  assert.equal(messages[0].content, "Answer briefly.", "leading system instructions kept verbatim");
  assert.match(messages[1].content, /^Compacted context of branch "long" \(extractive, 12 messages\):/);
  assert.equal(compacted.branch.metadata.compactedFrom, "long");
  assert.equal(compacted.branch.parentId, null);
  assert.equal(compacted.checkpoint.branchId, "long-c");
  assert.ok(compacted.prefill, "prefilled once");
  assert.ok(compacted.summary.text.length < original.map((m) => m.content).join("\n").length);
});

test("continuing from an abandoned later checkpoint works (F-03)", async () => {
  const runtime = await runtimeWith([{ id: "b", messages: [["user", "one"]] }]);
  const first = runtime.getBranch("b").checkpoints[0].id;
  await runtime.appendMessages("b", [{ role: "user", content: "two" }]);
  const second = await runtime.checkpointBranch("b");
  await runtime.respondFromCheckpoint(first, { role: "user", content: "alt" });
  const resumed = await runtime.respondFromCheckpoint(second.id, { role: "user", content: "back" });
  assert.equal(resumed.branch.id, "b");
  assert.deepEqual(
    runtime.getMessages("b").map((m) => m.content).slice(0, 3),
    ["one", "two", "back"]
  );
});

test("manageKv forwards every thermal decision to the adapter", async () => {
  const runtime = new LightningRuntime();
  const seen: Array<[string, string]> = [];
  const adapter = new FakeAdapter();
  (adapter as any).applyTemperature = async (id: string, t: string) => {
    seen.push([id, t]);
  };
  runtime.registerAdapter(adapter);
  for (const id of ["a", "b", "c", "d", "e"]) {
    await runtime.createBranch({
      id,
      title: id,
      kind: "chat",
      category: "t",
      responsibility: "t",
      backend: "fake",
      modelRef: "fake"
    });
  }
  const decisions = await runtime.manageKv(["e"], 1);
  assert.equal(decisions.length, 5);
  assert.equal(seen.length, 5);
  assert.deepEqual(seen.find(([id]) => id === "e"), ["e", "hot"]);
  assert.equal(seen.filter(([, t]) => t === "cold").length, 1);
});
