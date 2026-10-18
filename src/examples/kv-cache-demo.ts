import os from "node:os";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { LlamaCppAdapter, LightningRuntime } from "../index.js";
import type { GenerateResult, MessageRecord } from "../index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Timings {
  cache_n?: number;
  prompt_n?: number;
  prompt_ms?: number;
  predicted_n?: number;
  predicted_ms?: number;
}

interface TipSample {
  tipId: string;
  slot?: number;
  reply: string;
  wallMs?: number;
  prompt_n?: number;
  cache_n?: number;
  prompt_ms?: number;
  predicted_n?: number;
  predicted_ms?: number;
}

interface RepReport {
  rep: number;
  trunk: {
    branchId: string;
    slot?: number;
    prompt_n?: number;
    cache_n?: number;
    prompt_ms?: number;
    predicted_n?: number;
    predicted_ms?: number;
  };
  forks: TipSample[];
  fanout: {
    wallMs: number;
    tips: TipSample[];
  };
  coldSequential: {
    wallMs: number;
    tips: TipSample[];
  };
  coldParallel: {
    wallMs: number;
    tips: TipSample[];
  };
  sameTextAsColdSequential: boolean[];
}

interface Conditions {
  baseUrl: string;
  branches: number;
  reps: number;
  label: string;
  buildInfo: string;
  modelPath: string;
  totalSlots: number;
  nCtxPerSlot: number | "unknown";
  nodeVersion: string;
  hostname: string;
  cpu: string;
  totalMemGiB: number;
  startedAt: string;
  finishedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`POST ${url} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return (await response.json()) as any;
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${url} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return (await response.json()) as any;
}

function extractKv(gen: GenerateResult): { slot?: number; timings: Timings } {
  const kv = (gen.metadata?.kv as { timings?: Timings; slot?: number } | undefined) ?? {};
  return { slot: kv.slot, timings: kv.timings ?? {} };
}

function median(nums: number[]): number {
  if (nums.length === 0) {
    return NaN;
  }
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pad(text: string, width: number): string {
  return text.padEnd(width);
}

function num(value: number | undefined, digits = 0, width = 16): string {
  return (value === undefined || Number.isNaN(value) ? "n/a" : value.toFixed(digits)).padStart(
    width
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const baseUrl = argValue("base-url") ?? "http://127.0.0.1:8080";
  const branches = Number(argValue("branches") ?? "3");
  const reps = Number(argValue("reps") ?? "3");
  const outPath = argValue("out") ?? "kv-cache-results.json";
  const label = argValue("label") ?? "";
  const startedAt = new Date().toISOString();

  const focusPrompts = [
    "Focus on deliveries.",
    "Focus on returns.",
    "Focus on balances.",
    "Focus on anomalies.",
    "Focus on the smallest districts.",
    "Focus on the largest districts.",
    "Focus on trends.",
    "Focus on totals."
  ];

  // 1. Probe: refuse to run without native KV checkpoints.
  const adapter = new LlamaCppAdapter({ baseUrl });
  const probe = await adapter.probeKvSupport();
  if (probe.mode !== "native") {
    console.error(`KV checkpoints are EMULATED: ${probe.reason}`);
    process.exit(2);
  }
  if (probe.slots < branches) {
    console.error(
      `llama-server has ${probe.slots} slot(s) but the demo needs at least ${branches} (one slot per branch tip for the fan-out and parallel cold runs).`
    );
    process.exit(2);
  }

  const props = (await getJson(`${baseUrl}/props`)) as {
    total_slots?: number;
    build_info?: string;
    model_path?: string;
  };
  const slotsList = (await getJson(`${baseUrl}/slots`)) as Array<{ n_ctx?: number }>;
  const nCtxPerSlot: number | "unknown" =
    typeof slotsList[0]?.n_ctx === "number" ? (slotsList[0].n_ctx as number) : "unknown";

  // 2. Long deterministic shared document (~3k tokens).
  const doc = Array.from({ length: 90 }, (_, i) => `Note ${i + 1}: the ledger for district ${i + 1} records ${(i + 1) * 7} deliveries, ${(i + 1) * 3} returns and a balance of ${(i + 1) * 11} credits.`).join(" ");

  // 3. Repetitions.
  const repReports: RepReport[] = [];

  for (let rep = 1; rep <= reps; rep += 1) {
    const runtime = new LightningRuntime();
    runtime.registerAdapter(adapter);

    // a. Trunk: long shared prefill, checkpointed once.
    const trunkId = `trunk-r${rep}`;
    await runtime.createBranch({
      id: trunkId,
      title: "Trunk",
      kind: "chat",
      category: "conversation",
      responsibility: "Long shared conversation",
      backend: "llama.cpp",
      modelRef: "local"
    });
    await runtime.appendMessages(trunkId, [
      { role: "system", content: "You are a concise analyst. Answer in one sentence." },
      {
        role: "user",
        content: `Here is the district ledger. ${doc} Which district has the largest balance?`
      }
    ]);
    const trunkGen = await runtime.generate(trunkId, { maxOutputTokens: 48, temperature: 0 });
    await runtime.appendMessages(trunkId, [{ role: "assistant", content: trunkGen.text }]);
    const trunkCk = await runtime.checkpointBranch(trunkId, "trunk");
    const trunkKv = extractKv(trunkGen);

    // b. Fork M tips sequentially; each fork turn should reuse the trunk KV prefix.
    const forks: TipSample[] = [];
    const tipCkIds: string[] = [];
    for (let i = 0; i < branches; i += 1) {
      const tipId = `tip-${i}-r${rep}`;
      await runtime.forkBranch(trunkId, { id: tipId, title: `Tip ${i}` });
      await runtime.appendMessages(tipId, [
        {
          role: "user",
          content: `${focusPrompts[i % 8]} Give one observation about district ${i + 3}.`
        }
      ]);
      const g = await runtime.generate(tipId, { maxOutputTokens: 48, temperature: 0 });
      await runtime.appendMessages(tipId, [{ role: "assistant", content: g.text }]);
      const tipCk = await runtime.checkpointBranch(tipId, "tip");
      tipCkIds.push(tipCk.id);

      const forkKv = extractKv(g);
      forks.push({
        tipId,
        slot: forkKv.slot,
        reply: g.text,
        prompt_n: forkKv.timings.prompt_n,
        cache_n: forkKv.timings.cache_n,
        prompt_ms: forkKv.timings.prompt_ms,
        predicted_n: forkKv.timings.predicted_n,
        predicted_ms: forkKv.timings.predicted_ms
      });
    }

    // c. Fan-out: the same question to all M tips in parallel, each continuing
    //    from its saved KV.
    const question =
      "Given everything so far, state the single most important number and why, in one sentence.";
    const t0 = performance.now();
    const fanResults = await runtime.fanOutFromCheckpoints(
      tipCkIds,
      { role: "user", content: question },
      { maxOutputTokens: 32, temperature: 0 }
    );
    const fanWallMs = performance.now() - t0;

    const fanTips: TipSample[] = fanResults.map((result) => {
      const { slot, timings } = extractKv(result.generation);
      return {
        tipId: result.branch.id,
        slot,
        reply: result.generation.text,
        prompt_n: timings.prompt_n,
        cache_n: timings.cache_n,
        prompt_ms: timings.prompt_ms,
        predicted_n: timings.predicted_n,
        predicted_ms: timings.predicted_ms
      };
    });

    // d. Cold baselines: identical prompts, fresh slot, no prompt cache.
    const tipCheckpointSnapshots = tipCkIds.map((tipCkId) =>
      runtime.inspectCheckpoint(tipCkId)
    );
    const coldMessages: Array<Array<{ role: NonNullable<MessageRecord["role"]>; content: string }>> =
      tipCheckpointSnapshots.map((snapshot) => [
        ...snapshot.messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        { role: "user", content: question }
      ]);

    // Sequential cold: re-prefill one tip at a time on slot 0.
    const coldSeqTips: TipSample[] = [];
    const t1 = performance.now();
    for (let i = 0; i < branches; i += 1) {
      const requestStart = performance.now();
      await postJson(`${baseUrl}/slots/0?action=erase`, {});
      const payload = await postJson(`${baseUrl}/v1/chat/completions`, {
        messages: coldMessages[i],
        max_tokens: 32,
        temperature: 0,
        id_slot: 0,
        cache_prompt: false,
        stream: false
      });
      const typed = payload as {
        choices?: Array<{ message?: { content?: string } }>;
        timings?: Timings;
      };
      coldSeqTips.push({
        tipId: `tip-${i}-r${rep}`,
        slot: 0,
        reply: typed.choices?.[0]?.message?.content ?? "",
        wallMs: performance.now() - requestStart,
        prompt_n: typed.timings?.prompt_n,
        cache_n: typed.timings?.cache_n,
        prompt_ms: typed.timings?.prompt_ms,
        predicted_n: typed.timings?.predicted_n,
        predicted_ms: typed.timings?.predicted_ms
      });
    }
    const coldSeqWallMs = performance.now() - t1;

    // Parallel cold: erase all slots first, then one request per slot at once.
    for (let slot = 0; slot < branches; slot += 1) {
      await postJson(`${baseUrl}/slots/${slot}?action=erase`, {});
    }
    const t2 = performance.now();
    const coldParPayloads = await Promise.all(
      coldMessages.map((messages, i) =>
        postJson(`${baseUrl}/v1/chat/completions`, {
          messages,
          max_tokens: 32,
          temperature: 0,
          id_slot: i,
          cache_prompt: false,
          stream: false
        })
      )
    );
    const coldParWallMs = performance.now() - t2;
    const coldParTips: TipSample[] = coldParPayloads.map((payload, i) => {
      const typed = payload as {
        choices?: Array<{ message?: { content?: string } }>;
        timings?: Timings;
      };
      return {
        tipId: `tip-${i}-r${rep}`,
        slot: i,
        reply: typed.choices?.[0]?.message?.content ?? "",
        prompt_n: typed.timings?.prompt_n,
        cache_n: typed.timings?.cache_n,
        prompt_ms: typed.timings?.prompt_ms,
        predicted_n: typed.timings?.predicted_n,
        predicted_ms: typed.timings?.predicted_ms
      };
    });

    repReports.push({
      rep,
      trunk: {
        branchId: trunkId,
        slot: trunkKv.slot,
        prompt_n: trunkKv.timings.prompt_n,
        cache_n: trunkKv.timings.cache_n,
        prompt_ms: trunkKv.timings.prompt_ms,
        predicted_n: trunkKv.timings.predicted_n,
        predicted_ms: trunkKv.timings.predicted_ms
      },
      forks,
      fanout: { wallMs: fanWallMs, tips: fanTips },
      coldSequential: { wallMs: coldSeqWallMs, tips: coldSeqTips },
      coldParallel: { wallMs: coldParWallMs, tips: coldParTips },
      sameTextAsColdSequential: fanTips.map((tip, i) => tip.reply === coldSeqTips[i]?.reply)
    });
  }

  const finishedAt = new Date().toISOString();

  // 4. Medians across tips and reps.
  const fanoutPromptN = repReports
    .flatMap((report) => report.fanout.tips.map((tip) => tip.prompt_n))
    .filter((value): value is number => typeof value === "number");
  const fanoutCacheN = repReports
    .flatMap((report) => report.fanout.tips.map((tip) => tip.cache_n))
    .filter((value): value is number => typeof value === "number");
  const fanoutPromptMs = repReports
    .flatMap((report) => report.fanout.tips.map((tip) => tip.prompt_ms))
    .filter((value): value is number => typeof value === "number");
  const coldPromptN = repReports
    .flatMap((report) => report.coldSequential.tips.map((tip) => tip.prompt_n))
    .filter((value): value is number => typeof value === "number");
  const coldPromptMs = repReports
    .flatMap((report) => report.coldSequential.tips.map((tip) => tip.prompt_ms))
    .filter((value): value is number => typeof value === "number");
  const forkPromptN = repReports
    .flatMap((report) => report.forks.map((tip) => tip.prompt_n))
    .filter((value): value is number => typeof value === "number");
  const forkCacheN = repReports
    .flatMap((report) => report.forks.map((tip) => tip.cache_n))
    .filter((value): value is number => typeof value === "number");
  const forkPromptMs = repReports
    .flatMap((report) => report.forks.map((tip) => tip.prompt_ms))
    .filter((value): value is number => typeof value === "number");
  const fanWallValues = repReports.map((report) => report.fanout.wallMs);
  const coldSeqWallValues = repReports.map((report) => report.coldSequential.wallMs);
  const coldParWallValues = repReports.map((report) => report.coldParallel.wallMs);

  const medians = {
    fanout: {
      prompt_n: median(fanoutPromptN),
      cache_n: median(fanoutCacheN),
      prompt_ms: median(fanoutPromptMs)
    },
    cold: {
      prompt_n: median(coldPromptN),
      prompt_ms: median(coldPromptMs)
    },
    fork: {
      prompt_n: median(forkPromptN),
      cache_n: median(forkCacheN),
      prompt_ms: median(forkPromptMs)
    },
    fanWallMs: median(fanWallValues),
    coldSeqWallMs: median(coldSeqWallValues),
    coldParWallMs: median(coldParWallValues),
    speedupVsSequentialCold:
      median(coldSeqWallValues) / median(fanWallValues),
    speedupVsParallelCold: median(coldParWallValues) / median(fanWallValues)
  };

  // 5. Readable report.
  const cpus = os.cpus();
  const conditions: Conditions = {
    baseUrl,
    branches,
    reps,
    label,
    buildInfo: props.build_info ?? probe.buildInfo ?? "unknown",
    modelPath: props.model_path ?? "unknown",
    totalSlots: props.total_slots ?? probe.slots,
    nCtxPerSlot,
    nodeVersion: process.version,
    hostname: os.hostname(),
    cpu: `${cpus.length} x ${cpus[0]?.model ?? "unknown"}`,
    totalMemGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    startedAt,
    finishedAt
  };

  console.log("Lightning KV cache demo — llama-server branch continuation vs cold prefill");
  console.log(`  base url          ${conditions.baseUrl}`);
  console.log(`  build info        ${conditions.buildInfo}`);
  console.log(`  model path        ${conditions.modelPath}`);
  console.log(`  total slots       ${conditions.totalSlots}`);
  console.log(`  n_ctx per slot    ${conditions.nCtxPerSlot}`);
  console.log(`  branches (M)      ${conditions.branches}`);
  console.log(`  reps              ${conditions.reps}`);
  console.log(`  label             ${conditions.label || "(none)"}`);
  console.log(`  node              ${conditions.nodeVersion}`);
  console.log(`  host              ${conditions.hostname}`);
  console.log(`  cpu               ${conditions.cpu}`);
  console.log(`  memory            ${conditions.totalMemGiB} GiB`);
  console.log(`  started           ${conditions.startedAt}`);
  console.log(`  finished          ${conditions.finishedAt}`);

  console.log("");
  console.log(
    `${pad("scenario", 34)}${pad("prompt_n (evaluated)", 16)}${pad("cache_n (reused)", 16)}${pad("prompt_ms", 12)}`
  );
  console.log(
    `${pad("restored continuation (per tip)", 34)}${num(medians.fanout.prompt_n)}${num(
      medians.fanout.cache_n
    )}${num(medians.fanout.prompt_ms, 1, 12)}`
  );
  console.log(
    `${pad("cold re-prefill (per tip)", 34)}${num(medians.cold.prompt_n)}${pad("-", 16)}${num(
      medians.cold.prompt_ms,
      1,
      12
    )}`
  );
  console.log(
    `${pad("fork turn from trunk (per tip)", 34)}${num(medians.fork.prompt_n)}${num(
      medians.fork.cache_n
    )}${num(medians.fork.prompt_ms, 1, 12)}`
  );

  console.log("");
  console.log(
    `M-way fan-out (restored, parallel)   ${num(medians.fanWallMs, 0, 12)} ms  [per rep: ${fanWallValues
      .map((value) => value.toFixed(0))
      .join(", ")}]`
  );
  console.log(
    `M sequential cold prefills           ${num(medians.coldSeqWallMs, 0, 12)} ms  [per rep: ${coldSeqWallValues
      .map((value) => value.toFixed(0))
      .join(", ")}]`
  );
  console.log(
    `M parallel cold prefills             ${num(medians.coldParWallMs, 0, 12)} ms  [per rep: ${coldParWallValues
      .map((value) => value.toFixed(0))
      .join(", ")}]`
  );
  console.log(`speedup vs sequential cold           ${medians.speedupVsSequentialCold.toFixed(1)}x`);
  console.log(`speedup vs parallel cold             ${medians.speedupVsParallelCold.toFixed(1)}x`);
  console.log("");
  console.log(
    `replies identical to cold sequential: ${repReports
      .map((report) => `[rep ${report.rep}] ${report.sameTextAsColdSequential.join(", ")}`)
      .join("  ")}`
  );

  // 6. JSON output.
  const result = {
    schema: "lightning-kv-cache-demo/v1",
    startedAt,
    finishedAt,
    conditions,
    probe,
    reps: repReports,
    medians
  };
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(`\nResults written to ${outPath}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
