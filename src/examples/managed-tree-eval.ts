/**
 * Managed KV tree evaluation: router hit rate (offline), and on a real
 * llama-server the hot/warm/cold tiers, slot-file cleanup, the disk budget,
 * routed fan-out answers and compaction drift. Every number it prints is
 * measured in this run; conditions are recorded alongside.
 *
 *   npm run eval:managed                       # offline router eval only
 *   npm run eval:managed -- --base-url http://127.0.0.1:8080 --slot-dir /path/to/slot-save-path --out results.json
 */
import os from "node:os";
import { readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";

import { FakeAdapter, LightningRuntime, LlamaCppAdapter, loadVane } from "../index.js";
import type { GenerateResult, VaneModule } from "../index.js";
import { EVAL_BRANCHES, EVAL_QUERIES, answerMatches } from "./managed-tree-eval-data.js";
import type { EvalQuery } from "./managed-tree-eval-data.js";

const SYSTEM_PROMPT =
  "You are a helpful assistant. Answer the user's last question in one short sentence using facts from this conversation.";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const num = (value: string | undefined, fallback: number) => (value === undefined ? fallback : Number(value));
const frac = (hits: number, total: number) => ({ hits, total, rate: total ? hits / total : 0 });
const pct = (f: { hits: number; total: number; rate: number }) =>
  `${f.hits}/${f.total} (${(f.rate * 100).toFixed(1)}%)`;
const round = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 10) / 10);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function kvOf(result: GenerateResult) {
  const kv = (result.metadata?.kv ?? {}) as Record<string, any>;
  return {
    tier: kv.tier as string | undefined,
    prompt_n: kv.timings?.prompt_n as number | undefined,
    cache_n: kv.timings?.cache_n as number | undefined,
    prompt_ms: round(kv.timings?.prompt_ms) as number | undefined
  };
}

async function scanSlotDir(dir: string | undefined, prefix: string) {
  if (!dir) return { files: 0, bytes: 0, note: "no --slot-dir" };
  let files = 0;
  let bytes = 0;
  for (const name of await readdir(dir)) {
    if (!name.startsWith(prefix)) continue;
    files += 1;
    bytes += (await stat(join(dir, name))).size;
  }
  return { files, bytes };
}

async function buildBranches(runtime: LightningRuntime, backend: string, ids?: string[]) {
  const built: Array<{ id: string; wallMs: number; prefill?: ReturnType<typeof kvOf> }> = [];
  for (const branch of EVAL_BRANCHES) {
    if (ids && !ids.includes(branch.id)) continue;
    await runtime.createBranch({
      id: branch.id,
      title: branch.title,
      kind: "chat",
      category: "eval",
      responsibility: "synthetic eval branch",
      backend,
      modelRef: backend === "fake" ? "fake" : ""
    });
    await runtime.appendMessages(branch.id, [
      { role: "system", content: SYSTEM_PROMPT },
      ...branch.messages.map((m) => ({ role: m.role, content: m.content }))
    ]);
    const t0 = performance.now();
    let prefill: ReturnType<typeof kvOf> | undefined;
    if (backend !== "fake") {
      prefill = kvOf(await runtime.generate(branch.id, { maxOutputTokens: 1, temperature: 0 }));
    }
    built.push({ id: branch.id, wallMs: round(performance.now() - t0) ?? 0, ...(prefill ? { prefill } : {}) });
    await runtime.checkpointBranch(branch.id, "tip");
  }
  return built;
}

async function askOracle(runtime: LightningRuntime, branchId: string, question: string, answer: string, maxTokens: number) {
  const tip = runtime.getBranch(branchId).checkpoints.at(-1);
  if (!tip) throw new Error(`no tip for ${branchId}`);
  await runtime.restoreBranch(branchId, tip.id);
  const t0 = performance.now();
  const gen = await runtime.generateEphemeral(branchId, {
    maxOutputTokens: maxTokens,
    temperature: 0,
    messages: [...runtime.getMessages(branchId), { role: "user", content: question, createdAt: new Date().toISOString() }]
  });
  return {
    text: gen.text.slice(0, 200),
    correct: answerMatches(gen.text, answer),
    wallMs: round(performance.now() - t0),
    ...kvOf(gen)
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const loadStart = os.loadavg();
  const baseUrl = argValue("base-url") ?? process.env.LLAMA_CPP_BASE_URL;
  const slotDir = argValue("slot-dir") ?? process.env.LLAMA_CPP_SLOT_SAVE_PATH;
  const k = num(argValue("k"), 3);
  const maxTokens = num(argValue("max-tokens"), 48);
  const compactRatios = (argValue("compact-ratios") ?? "0.25,0.5,0.75").split(",").map(Number);
  const budgetFiles = num(argValue("budget-files"), 3);
  const out = argValue("out");
  const label = argValue("label") ?? "";
  const factIds = [...new Set(EVAL_QUERIES.map((q) => q.branchId))];
  const queryFor = (id: string, p: EvalQuery["paraphrase"]) =>
    EVAL_QUERIES.find((q) => q.branchId === id && q.paraphrase === p) as EvalQuery;

  const results: Record<string, unknown> = {};
  const vane: VaneModule | undefined = await loadVane();
  console.log(`Vane: ${vane ? "installed (@owl-kestrel/vane resolved)" : "unavailable (extractive fallback only)"}`);

  // PHASE 1: offline router eval
  {
    const runtime = new LightningRuntime();
    runtime.registerAdapter(new FakeAdapter());
    await buildBranches(runtime, "fake");
    const configs: Array<{ name: string; index: "summary" | "full"; vane: VaneModule | null | undefined }> = [];
    if (vane) configs.push({ name: "summary+vane", index: "summary", vane: undefined });
    configs.push({ name: "summary+extractive", index: "summary", vane: null });
    configs.push({ name: "full-text", index: "full", vane: null });

    const router: Array<Record<string, unknown>> = [];
    console.log(`\n[1] Router hit rate (${EVAL_BRANCHES.length} branches, ${EVAL_QUERIES.length} queries)`);
    for (const config of configs) {
      const lengths: number[] = [];
      const methods = new Set<string>();
      for (const branch of EVAL_BRANCHES) {
        const summary = await runtime.summarizeBranch(branch.id, { budgetTokens: 160, vane: config.vane });
        lengths.push(summary.text.length);
        methods.add(summary.method);
      }
      for (const kk of [1, 3]) {
        const tally = { all: [0, 0], close: [0, 0], far: [0, 0] };
        for (const q of EVAL_QUERIES) {
          const { route } = await runtime.routeBranches(q.question, {
            k: kk,
            index: config.index,
            vane: config.vane,
            budgetTokens: 160
          });
          const hit = route.some((r) => r.branchId === q.branchId) ? 1 : 0;
          for (const key of ["all", q.paraphrase] as const) {
            tally[key][0] += hit;
            tally[key][1] += 1;
          }
        }
        const row = {
          config: config.name,
          k: kk,
          summaryMethod: [...methods].join(","),
          meanSummaryChars: Math.round(mean(lengths)),
          all: frac(tally.all[0], tally.all[1]),
          close: frac(tally.close[0], tally.close[1]),
          far: frac(tally.far[0], tally.far[1])
        };
        router.push(row);
        console.log(
          `  ${config.name.padEnd(20)} k=${kk}  all ${pct(row.all)}  close ${pct(row.close)}  far ${pct(row.far)}  (summary ${row.summaryMethod}, ~${row.meanSummaryChars} chars)`
        );
      }
    }
    results.router = router;
  }

  const conditions: Record<string, unknown> = {
    label,
    baseUrl: baseUrl ?? null,
    nodeVersion: process.version,
    hostname: process.argv.includes("--redact-host") ? "redacted" : os.hostname(),
    cpu: os.cpus()[0]?.model,
    cpus: os.cpus().length,
    totalMemGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    loadavgStart: loadStart,
    startedAt,
    k,
    maxTokens,
    compactRatios,
    budgetFiles,
    vane: vane ? "installed" : "unavailable"
  };

  if (!baseUrl) {
    conditions.finishedAt = new Date().toISOString();
    if (out) await writeFile(out, JSON.stringify({ conditions, ...results }, null, 2));
    return;
  }

  // PHASE 2: live build
  const adapter = new LlamaCppAdapter({ baseUrl, slotSaveDir: slotDir });
  const probe = await adapter.probeKvSupport();
  if (probe.mode !== "native") {
    console.error(`llama-server KV slots not available: ${probe.reason}`);
    process.exit(1);
  }
  const report0 = adapter.kvCacheReport() as Record<string, any>;
  const prefix = String(report0.slotFilePrefix);
  const fingerprint = { ...(report0.fingerprint ?? {}) };
  if (typeof fingerprint.modelPath === "string") fingerprint.modelPath = basename(fingerprint.modelPath);
  Object.assign(conditions, { fingerprintId: report0.fingerprintId, fingerprint, totalSlots: probe.slots });
  const runtime = new LightningRuntime();
  runtime.registerAdapter(adapter);
  let adapterB: LlamaCppAdapter | undefined;
  const oracle = new Map<string, { correct: boolean; prompt_n?: number }>();
  let medianFileBytes = 0;

  try {
    console.log(`\n[2] Build ${EVAL_BRANCHES.length} branches on llama-server (one cold prefill each)`);
    const built = await buildBranches(runtime, "llama.cpp");
    const report = adapter.kvCacheReport() as Record<string, any>;
    const disk = await scanSlotDir(slotDir, prefix);
    medianFileBytes = report.files ? report.bytes / report.files : 0;
    results.build = {
      branches: built,
      medianPrefillPromptN: median(built.map((b) => b.prefill?.prompt_n ?? 0)),
      medianPrefillMs: median(built.map((b) => b.prefill?.prompt_ms ?? 0)),
      ledger: { files: report.files, bytes: report.bytes, bytesPerToken: report.bytesPerToken },
      disk,
      limit: report.limit
    };
    console.log(
      `  prefill median ${median(built.map((b) => b.prefill?.prompt_n ?? 0))} tokens / ${median(built.map((b) => b.prefill?.prompt_ms ?? 0))} ms; ledger ${report.files} files ${report.bytes} B; on disk ${disk.files} files ${disk.bytes} B; limit ${report.limit?.boundBy} (reserve ${report.limit?.reserveBytes} B)`
    );
  } catch (error) {
    results.build = { error: String(error) };
  }

  try {
    console.log(`\n[3] Oracle: ask each question on its known branch`);
    const rows = [];
    for (const q of EVAL_QUERIES) {
      const row = await askOracle(runtime, q.branchId, q.question, q.answer, maxTokens);
      oracle.set(q.id, { correct: row.correct, prompt_n: (row.prompt_n ?? 0) + (row.cache_n ?? 0) });
      rows.push({ id: q.id, ...row });
    }
    const correct = rows.filter((r) => r.correct).length;
    results.oracle = {
      answerRate: frac(correct, rows.length),
      tiers: countBy(rows.map((r) => r.tier ?? "?")),
      medianPromptMs: median(rows.map((r) => r.prompt_ms ?? 0)),
      rows
    };
    console.log(`  correct ${pct(frac(correct, rows.length))}; tiers ${JSON.stringify(countBy(rows.map((r) => r.tier ?? "?")))}`);
  } catch (error) {
    results.oracle = { error: String(error) };
  }

  try {
    console.log(`\n[4] Routed fan-out (k=${k}, summary index)`);
    const rows = [];
    for (const q of EVAL_QUERIES) {
      const t0 = performance.now();
      const r = await runtime.fanOutRouted(q.question, k, { maxOutputTokens: maxTokens, temperature: 0 }, {
        index: "summary",
        vane: vane ?? null
      });
      const wallMs = round(performance.now() - t0);
      rows.push({
        id: q.id,
        route: r.route.map((x) => x.branchId),
        routeHit: r.route.some((x) => x.branchId === q.branchId),
        answeredByRelevant: r.answers.some((a) => a.branchId === q.branchId && answerMatches(a.generation.text, q.answer)),
        anyMatch: r.answers.some((a) => answerMatches(a.generation.text, q.answer)),
        wallMs,
        answers: r.answers.map((a) => ({ branchId: a.branchId, text: a.generation.text.slice(0, 160), ...kvOf(a.generation) }))
      });
    }
    const n = rows.length;
    results.routed = {
      routeHitRate: frac(rows.filter((r) => r.routeHit).length, n),
      answeredByRelevantRate: frac(rows.filter((r) => r.answeredByRelevant).length, n),
      anyMatchRate: frac(rows.filter((r) => r.anyMatch).length, n),
      meanWallMs: round(mean(rows.map((r) => r.wallMs ?? 0))),
      tiers: countBy(rows.flatMap((r) => r.answers.map((a) => a.tier ?? "?"))),
      rows
    };
    const rr = results.routed as Record<string, any>;
    console.log(
      `  route hit ${pct(rr.routeHitRate)}; answered by relevant tip ${pct(rr.answeredByRelevantRate)}; any tip correct ${pct(rr.anyMatchRate)}; mean wall ${rr.meanWallMs} ms/query; tiers ${JSON.stringify(rr.tiers)}`
    );
  } catch (error) {
    results.routed = { error: String(error) };
  }

  try {
    console.log(`\n[5] Thermal tiering via manageKv (active: garden, taxes, rustbug, lisbon; 4 hot)`);
    const before = { ledger: pick(adapter.kvCacheReport()), disk: await scanSlotDir(slotDir, prefix) };
    const decisions = await runtime.manageKv(["garden", "taxes", "rustbug", "lisbon"], 4);
    const after = { ledger: pick(adapter.kvCacheReport()), disk: await scanSlotDir(slotDir, prefix) };
    const coldFact = decisions.filter((d) => d.to === "cold" && factIds.includes(d.branchId)).at(-1);
    const coldAsk = coldFact
      ? { branchId: coldFact.branchId, ...(await askOracle(runtime, coldFact.branchId, queryFor(coldFact.branchId, "far").question, queryFor(coldFact.branchId, "far").answer, maxTokens)) }
      : undefined;
    const g = queryFor("garden", "close");
    const repeat1 = await askOracle(runtime, "garden", g.question, g.answer, maxTokens);
    const repeat2 = await askOracle(runtime, "garden", g.question, g.answer, maxTokens);
    results.tiering = { decisions: countBy(decisions.map((d) => d.to)), before, after, coldAsk, gardenRepeat: [repeat1, repeat2] };
    console.log(`  decisions ${JSON.stringify(countBy(decisions.map((d) => d.to)))}; files ${before.disk.files} -> ${after.disk.files} on disk (${before.disk.bytes} -> ${after.disk.bytes} B)`);
    if (coldAsk) console.log(`  cold branch ${coldAsk.branchId}: tier ${coldAsk.tier}, prompt_n ${coldAsk.prompt_n}, cache_n ${coldAsk.cache_n}, ${coldAsk.prompt_ms} ms, correct ${coldAsk.correct}`);
    console.log(`  garden twice: ${repeat1.tier} ${repeat1.prompt_ms} ms -> ${repeat2.tier} ${repeat2.prompt_ms} ms`);
  } catch (error) {
    results.tiering = { error: String(error) };
  }

  const compaction: Array<Record<string, unknown>> = [];
  for (const compactRatio of compactRatios) try {
    console.log(`\n[6] Compaction drift (budget = ${compactRatio} x source tokens)`);
    const tag = String(compactRatio).replace(/[^0-9]/g, "");
    const rows = [];
    for (const id of factIds) {
      const branch = EVAL_BRANCHES.find((b) => b.id === id);
      if (!branch) continue;
      const sourceTokens = Math.ceil(branch.messages.reduce((n, m) => n + m.content.length, 0) / 4);
      const budgetTokens = Math.max(32, Math.ceil(sourceTokens * compactRatio));
      const t0 = performance.now();
      const c = await runtime.compactBranch(id, { newBranchId: `${id}-compact${tag}`, budgetTokens, vane: vane ?? null });
      const wallMs = round(performance.now() - t0);
      const answer = queryFor(id, "close").answer;
      const asks = [];
      for (const q of EVAL_QUERIES.filter((x) => x.branchId === id)) {
        const r = await askOracle(runtime, `${id}-compact${tag}`, q.question, q.answer, maxTokens);
        asks.push({ id: q.id, fullCorrect: oracle.get(q.id)?.correct, fullPromptTokens: oracle.get(q.id)?.prompt_n, compactCorrect: r.correct, compactPromptTokens: (r.prompt_n ?? 0) + (r.cache_n ?? 0), text: r.text });
      }
      rows.push({
        branchId: id,
        method: c.summary.method,
        sourceTokens,
        budgetTokens,
        summaryChars: c.summary.text.length,
        factRetained: answerMatches(c.summary.text, answer),
        prefill: c.prefill ? kvOf(c.prefill) : undefined,
        wallMs,
        asks
      });
    }
    const asks = rows.flatMap((r) => r.asks);
    const fullOk = asks.filter((a) => a.fullCorrect).length;
    const compactOk = asks.filter((a) => a.compactCorrect).length;
    compaction.push({
      compactRatio,
      methods: countBy(rows.map((r) => r.method)),
      factRetained: frac(rows.filter((r) => r.factRetained).length, rows.length),
      fullCorrect: frac(fullOk, asks.length),
      compactCorrect: frac(compactOk, asks.length),
      agreement: frac(asks.filter((a) => a.fullCorrect === a.compactCorrect).length, asks.length),
      lostByCompaction: asks.filter((a) => a.fullCorrect && !a.compactCorrect).length,
      gainedByCompaction: asks.filter((a) => !a.fullCorrect && a.compactCorrect).length,
      meanPromptTokensFull: Math.round(mean(asks.map((a) => a.fullPromptTokens ?? 0))),
      meanPromptTokensCompact: Math.round(mean(asks.map((a) => a.compactPromptTokens))),
      rows
    });
    results.compaction = compaction;
    const cr = compaction.at(-1) as Record<string, any>;
    console.log(`  method ${JSON.stringify(cr.methods)}; fact kept in summary ${pct(cr.factRetained)}`);
    console.log(`  correct: full ${pct(cr.fullCorrect)} vs compacted ${pct(cr.compactCorrect)}; agreement ${pct(cr.agreement)}; lost ${cr.lostByCompaction}, gained ${cr.gainedByCompaction}`);
    console.log(`  mean prompt tokens per answer: full ${cr.meanPromptTokensFull} vs compacted ${cr.meanPromptTokensCompact}`);
  } catch (error) {
    compaction.push({ compactRatio, error: String(error) });
    results.compaction = compaction;
  }

  try {
    const budgetBytes = Math.round(budgetFiles * medianFileBytes);
    console.log(`\n[7] Operator disk budget: ${budgetFiles} x mean file (${budgetBytes} B), 6 branches`);
    adapterB = new LlamaCppAdapter({ baseUrl, slotSaveDir: slotDir, kvDiskBudgetBytes: budgetBytes });
    const probeB = await adapterB.probeKvSupport();
    if (probeB.mode !== "native") throw new Error(`adapterB not native: ${probeB.reason}`);
    const runtimeB = new LightningRuntime();
    runtimeB.registerAdapter(adapterB);
    await buildBranches(runtimeB, "llama.cpp", ["garden", "taxes", "rustbug", "lisbon", "sourdough", "car"]);
    const reportB = adapterB.kvCacheReport() as Record<string, any>;
    const diskB = await scanSlotDir(slotDir, String(reportB.slotFilePrefix));
    const g = queryFor("garden", "close");
    const evictedAsk = await askOracle(runtimeB, "garden", g.question, g.answer, maxTokens);
    results.budget = { budgetBytes, ledger: pick(reportB), disk: diskB, limit: reportB.limit, lastEviction: reportB.lastEviction, evictedAsk };
    console.log(`  evicted ${reportB.counters.evictedForBudget}; ledger ${reportB.files} files ${reportB.bytes} B; disk ${diskB.files} files ${diskB.bytes} B; limit ${reportB.limit?.boundBy} ${reportB.limit?.limitBytes} B`);
    console.log(`  oldest branch (garden) after eviction: tier ${evictedAsk.tier}, prompt_n ${evictedAsk.prompt_n}, cache_n ${evictedAsk.cache_n}, correct ${evictedAsk.correct}`);
  } catch (error) {
    results.budget = { error: String(error) };
  }

  // PHASE 8: close always runs so slot files never outlive the process.
  const closeA = await adapter.close();
  const closeB = adapterB ? await adapterB.close() : undefined;
  const remainingA = await scanSlotDir(slotDir, prefix);
  const remainingB = adapterB ? await scanSlotDir(slotDir, String(adapterB.kvCacheReport().slotFilePrefix)) : undefined;
  results.close = { closeA, closeB, remainingA, remainingB, countersA: (adapter.kvCacheReport() as any).counters };
  console.log(`\n[8] close: deleted ${closeA.filesDeleted} + ${closeB?.filesDeleted ?? 0} files; remaining on disk ${remainingA.files} + ${remainingB?.files ?? 0}`);

  conditions.loadavgEnd = os.loadavg();
  conditions.finishedAt = new Date().toISOString();
  if (out) await writeFile(out, JSON.stringify({ conditions, ...results }, null, 2));
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

function pick(report: Record<string, unknown>) {
  const r = report as Record<string, any>;
  return { files: r.files, bytes: r.bytes, counters: r.counters };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
