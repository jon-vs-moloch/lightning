import { FakeAdapter, LightningRuntime } from "../index.js";

async function main(): Promise<void> {
  const runtime = new LightningRuntime();
  runtime.registerAdapter(new FakeAdapter());

  await runtime.createBranch({
    id: "chat-main",
    title: "Main Chat",
    kind: "chat",
    category: "conversation",
    responsibility: "Primary user-facing chat lane",
    backend: "fake",
    modelRef: "fake-echo-v1",
    priority: 1,
    temperature: "hot"
  });

  await runtime.appendMessages("chat-main", [
    {
      role: "system",
      content: "You are Lightning, a hierarchical cognition runtime."
    },
    {
      role: "user",
      content: "Summarize what this runtime can do right now."
    }
  ]);

  const background = await runtime.forkBranch("chat-main", {
    id: "bg-main",
    title: "Background Lane",
    category: "background",
    responsibility: "Longer-horizon supporting cognition"
  });

  await runtime.appendMessages(background.id, [
    {
      role: "user",
      content: "Track medium-term project continuity without interrupting chat."
    }
  ]);

  const generation = await runtime.generate("chat-main");
  const checkpoint = await runtime.checkpointBranch(
    "chat-main",
    "initial-chat-state",
    "Initial in-memory conversation checkpoint"
  );

  await runtime.freezeBranch(background.id);
  const thermalPlan = runtime.applyThermalPlan(["chat-main"], 1);
  const stats = await runtime.branchStats("chat-main");

  console.log(
    JSON.stringify(
      {
        generation,
        checkpoint,
        thermalPlan,
        stats,
        branches: runtime.listBranches()
      },
      null,
      2
    )
  );
}

void main();
