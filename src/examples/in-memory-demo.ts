import { FakeAdapter, LightningRuntime } from "../index.js";
import type {
  BranchCheckpoint,
  BranchRecord,
  BranchStats,
  BranchTemperature,
  GenerateResult,
  SchedulerDecision
} from "../index.js";

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
    kind: "background",
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

  const report = {
    generation,
    checkpoint,
    thermalPlan,
    stats,
    branches: runtime.listBranches()
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printReport(report);
}

// ---------------------------------------------------------------------------
// Human-readable output (pass --json for the raw objects)
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint("1");
const dim = paint("2");
const THERMAL: Record<BranchTemperature, (text: string) => string> = {
  hot: paint("38;5;203"),
  warm: paint("38;5;214"),
  cold: paint("38;5;75"),
  frozen: paint("38;5;153")
};

function printReport(report: {
  generation: GenerateResult;
  checkpoint: BranchCheckpoint;
  thermalPlan: SchedulerDecision[];
  stats: BranchStats;
  branches: BranchRecord[];
}): void {
  const line = (label: string, value: string) => console.log(`  ${dim(label.padEnd(12))}${value}`);

  console.log(`\n${bold("⚡ Lightning")} ${dim("in-memory runtime · fake adapter")}\n`);

  console.log(bold("Branches"));
  const roots = report.branches.filter((branch) => !branch.parentId);
  const children = (id: string) => report.branches.filter((branch) => branch.parentId === id);
  const walk = (branch: BranchRecord, prefix: string, last: boolean, depth: number) => {
    const connector = depth === 0 ? "" : last ? "└─ " : "├─ ";
    const temperature = THERMAL[branch.temperature](`● ${branch.temperature}`);
    console.log(`  ${dim(prefix + connector)}${bold(branch.id)}  ${temperature}  ${dim(branch.kind)}`);
    const kids = children(branch.id);
    kids.forEach((child, index) =>
      walk(child, depth === 0 ? prefix : prefix + (last ? "   " : "│  "), index === kids.length - 1, depth + 1)
    );
  };
  roots.forEach((root, index) => walk(root, "", index === roots.length - 1, 0));

  console.log(`\n${bold("Generate")} ${dim("chat-main")}`);
  line("reply", report.generation.text);
  line("tokens", `${report.generation.usage?.promptTokens ?? "?"} prompt · ${report.generation.usage?.completionTokens ?? "?"} completion`);

  console.log(`\n${bold("Checkpoint")}`);
  line("id", report.checkpoint.id);
  line("label", report.checkpoint.label ?? "—");
  line("summary", report.checkpoint.summary ?? "—");

  console.log(`\n${bold("Thermal plan")} ${dim("active: chat-main · max hot: 1")}`);
  for (const decision of report.thermalPlan) {
    const change =
      decision.from === decision.to
        ? THERMAL[decision.to](decision.to)
        : `${THERMAL[decision.from](decision.from)} → ${THERMAL[decision.to](decision.to)}`;
    line(decision.branchId, `${change}  ${dim(decision.reason)}`);
  }

  console.log(`\n${bold("Stats")} ${dim("chat-main")}`);
  line("messages", String(report.stats.messageCount));
  line("checkpoints", String(report.stats.checkpointCount));
  console.log(dim("\n  Run with --json for the raw objects.\n"));
}

void main();
