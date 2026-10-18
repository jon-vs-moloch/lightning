/**
 * Inspector demo: the real Lightning runtime and API server, wired to the
 * FakeAdapter instead of llama.cpp, seeded with a small branch tree.
 *
 * Everything you see in the inspector is live runtime state. The only thing
 * that is fake is generation: the FakeAdapter echoes the last user message.
 *
 *   npm run demo:ui   →   http://127.0.0.1:8787
 */
import { createLightningApiServer, FakeAdapter, LightningRuntime } from "../index.js";

const MODEL = "fake-echo-v1";

async function seed(runtime: LightningRuntime): Promise<void> {
  const base = { backend: "fake", modelRef: MODEL } as const;

  // Elder layer: slow, compressed history. Q1 was succeeded by Q2 and frozen.
  await runtime.createBranch({
    ...base,
    id: "elder-2026-q2",
    title: "Elder · 2026 Q2",
    kind: "elder",
    category: "history",
    responsibility: "Compressed long-horizon memory; consulted, rarely written",
    priority: 1
  });
  await runtime.createBranch({
    ...base,
    id: "elder-2026-q1",
    title: "Elder · 2026 Q1",
    kind: "elder",
    category: "history",
    responsibility: "Archived predecessor, kept for lineage",
    successorId: "elder-2026-q2",
    priority: 0
  });
  await runtime.appendMessages("elder-2026-q2", [
    { role: "system", content: "Summary: the user is building a checkpoint-native runtime; prefers honest status over polish." }
  ]);
  await runtime.checkpointBranch("elder-2026-q2", "succession", "Successor of elder-2026-q1");
  await runtime.freezeBranch("elder-2026-q1");

  // Mid-frequency: an active project.
  await runtime.createBranch({
    ...base,
    id: "project-lightning",
    title: "Project · Lightning",
    kind: "project",
    category: "project",
    responsibility: "Active project state: goals, decisions, open questions",
    parentId: "elder-2026-q2",
    priority: 5
  });
  await runtime.appendMessages("project-lightning", [
    { role: "system", content: "Decision: llama.cpp first, then MLX, then vLLM." },
    { role: "system", content: "Open question: what does a portable KV checkpoint look like?" }
  ]);
  await runtime.checkpointBranch("project-lightning", "weekly", "Weekly upward pass from chat + research");

  await runtime.createBranch({
    ...base,
    id: "research-kv",
    title: "Research · KV snapshot formats",
    kind: "research",
    category: "research",
    responsibility: "Survey cache save/restore across backends",
    parentId: "project-lightning",
    priority: 3
  });
  await runtime.appendMessages("research-kv", [
    { role: "user", content: "Which backends can save and restore a slot's KV cache?" }
  ]);
  await runtime.generate("research-kv").then((generation) =>
    runtime.appendMessages("research-kv", [{ role: "assistant", content: generation.text }])
  );

  // Hot layer: the chat lane and its children.
  await runtime.createBranch({
    ...base,
    id: "chat-main",
    title: "Chat · main",
    kind: "chat",
    category: "conversation",
    responsibility: "User-facing conversation",
    parentId: "project-lightning",
    priority: 10
  });
  await runtime.appendMessages("chat-main", [
    { role: "system", content: "You are Lightning, a branch-and-checkpoint runtime." },
    { role: "user", content: "What should I work on next?" }
  ]);
  const reply = await runtime.generate("chat-main");
  await runtime.appendMessages("chat-main", [{ role: "assistant", content: reply.text }]);
  const head = await runtime.checkpointBranch("chat-main", "turn-1");
  runtime.setThreadHead("chat-main", head.id);

  await runtime.forkBranch("chat-main", {
    id: "bg-main",
    title: "Background · main",
    kind: "background",
    category: "background",
    responsibility: "Longer-horizon thinking that must not interrupt chat"
  });
  await runtime.forkBranch("chat-main", {
    id: "sub-refactor",
    title: "Subagent · refactor store",
    kind: "task",
    category: "task",
    responsibility: "Absorb local churn; return a compressed result"
  });

  // Let the real thermal planner decide hot / warm / cold.
  runtime.applyThermalPlan(["chat-main", "sub-refactor"], 2);
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const runtime = new LightningRuntime();
  runtime.registerAdapter(new FakeAdapter());
  await seed(runtime);

  const server = createLightningApiServer({
    runtime,
    defaultBackend: "fake",
    defaultModelRef: MODEL
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Lightning inspector (fake adapter, demo data) on http://127.0.0.1:${port}`);
  });

  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

void main();
