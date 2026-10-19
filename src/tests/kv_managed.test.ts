import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

import { LlamaCppAdapter } from "../backends/llama_cpp.js";
import type { LlamaCppFs } from "../backends/llama_cpp.js";
import { createBranchRecord } from "../core/branch.js";
import { KvFileLedger, computeKvDiskLimit, kvReserveBytes, tierRank } from "../core/kv_cache.js";

// A small llama-server stand-in for the managed KV cache: it reports a
// fingerprint in /props, answers saves with n_saved/n_written, and can be told
// to refuse restores or erases.
interface Call {
  method: string;
  path: string;
  body: any;
}

interface FakeServer {
  baseUrl: string;
  calls: Call[];
  props: Record<string, unknown>;
  failRestore: boolean;
  failErase: boolean;
  bytesPerSave: number;
  close(): Promise<void>;
}

async function startFake(totalSlots: number): Promise<FakeServer> {
  const state: Omit<FakeServer, "baseUrl" | "close"> = {
    calls: [],
    props: {
      total_slots: totalSlots,
      build_info: "b-test",
      model_path: "/models/tiny.gguf",
      model_ftype: "Q8_0",
      default_generation_settings: { n_ctx: 100 }
    },
    failRestore: false,
    failErase: false,
    bytesPerSave: 1000
  };

  const respond = (res: ServerResponse, status: number, payload: unknown): void => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(payload));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: any = raw ? JSON.parse(raw) : undefined;
      state.calls.push({ method: req.method ?? "", path: req.url ?? "", body });
      const [route, query = ""] = (req.url ?? "").split("?");
      const action = new URLSearchParams(query).get("action");
      if (req.method === "GET" && route === "/props") return respond(res, 200, state.props);
      if (route?.startsWith("/slots/") && action === "save") {
        return respond(res, 200, { filename: body.filename, n_saved: 10, n_written: state.bytesPerSave });
      }
      if (route?.startsWith("/slots/") && action === "restore") {
        return state.failRestore
          ? respond(res, 400, { error: { message: "failed to restore" } })
          : respond(res, 200, { n_restored: 10 });
      }
      if (route?.startsWith("/slots/") && action === "erase") {
        return state.failErase
          ? respond(res, 500, { error: { message: "erase failed" } })
          : respond(res, 200, { n_erased: 0 });
      }
      if (route === "/v1/chat/completions") {
        return respond(res, 200, {
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          timings: { cache_n: 5, prompt_n: 3, prompt_ms: 1 }
        });
      }
      respond(res, 404, {});
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const fake = state as FakeServer;
  fake.baseUrl = `http://127.0.0.1:${address.port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}

interface FakeFs extends LlamaCppFs {
  unlinked: string[];
  dir: string[];
}

/**
 * capacity: free bytes before any slot file exists. Free space shrinks by
 * bytesPerFile for each saved (non-probe) file still on "disk".
 */
function fakeFs(capacity = 1e12, fake?: FakeServer): FakeFs {
  const fs: FakeFs = {
    unlinked: [],
    dir: [],
    unlink: async (path: string) => {
      fs.unlinked.push(path.split("/").at(-1) ?? path);
    },
    readdir: async () => [...fs.dir],
    statfs: async () => {
      const saved = fake
        ? actions(fake.calls, "save").filter((call) => !String(call.body?.filename).endsWith("-probe.bin")).length
        : 0;
      const deleted = fs.unlinked.filter((name) => !name.endsWith("-probe.bin")).length;
      const used = (saved - deleted) * (fake?.bytesPerSave ?? 0);
      return { bavail: capacity - used, bsize: 1 };
    }
  };
  return fs;
}

function branch(id: string, temperature: "hot" | "warm" | "cold" = "warm") {
  return createBranchRecord({
    id,
    title: id,
    kind: "chat",
    category: "test",
    responsibility: "test",
    backend: "llama.cpp",
    modelRef: "tiny",
    temperature
  });
}

const actions = (calls: Call[], action: string) =>
  calls.filter((call) => call.method === "POST" && call.path.includes(`action=${action}`));

const kvOf = (result: { metadata?: Record<string, unknown> }) =>
  result.metadata?.kv as Record<string, any>;

async function nativeAdapter(fake: FakeServer, fs: FakeFs, extra: Record<string, unknown> = {}) {
  const adapter = new LlamaCppAdapter({ baseUrl: fake.baseUrl, slotSaveDir: "/slots", fsImpl: fs, ...extra });
  const probe = await adapter.probeKvSupport();
  assert.equal(probe.mode, "native");
  return adapter;
}

test("kv_cache: reserve, disk limit and eviction order", () => {
  assert.equal(kvReserveBytes({ slots: 4, nCtxPerSlot: 8192, bytesPerToken: 12_000 }), 393_216_000);
  assert.equal(kvReserveBytes({ slots: 4, bytesPerToken: 12_000 }), 0);

  assert.deepEqual(computeKvDiskLimit({ ownBytes: 0, reserveBytes: 0 }), {
    limitBytes: Number.POSITIVE_INFINITY,
    boundBy: "none"
  });
  // our own files count as reclaimable: 300 free + 200 ours - 100 reserve
  assert.deepEqual(computeKvDiskLimit({ fsAvailableBytes: 300, ownBytes: 200, reserveBytes: 100 }), {
    limitBytes: 400,
    boundBy: "filesystem"
  });
  assert.deepEqual(
    computeKvDiskLimit({ budgetBytes: 50, fsAvailableBytes: 300, ownBytes: 200, reserveBytes: 100 }),
    { limitBytes: 50, boundBy: "budget" }
  );

  const ledger = new KvFileLedger();
  ledger.add("a", 100, 10, 1);
  ledger.add("b", 100, 10, 2);
  ledger.add("c", 100, 10, 3);
  ledger.hold("a", "branch:hot");
  ledger.hold("b", "branch:cold");
  ledger.hold("c", "branch:cold");
  const rank = (name: string) => (name === "a" ? tierRank("hot") : tierRank("cold"));
  assert.deepEqual(ledger.planEviction(150, (entry) => rank(entry.name)), ["b", "c"]);
  assert.deepEqual(ledger.planEviction(150, (entry) => rank(entry.name), new Set(["b"])), ["c", "a"]);
  assert.equal(ledger.bytesPerToken(), 10);
  assert.deepEqual(ledger.release("a", "branch:hot"), ["a"]);
  assert.equal(ledger.has("a"), false);
});

test("slot files are named per process and the probe file is deleted", async () => {
  const fake = await startFake(2);
  try {
    const fs = fakeFs();
    const a = await nativeAdapter(fake, fs);
    const b = await nativeAdapter(fake, fs);
    const prefixA = String(a.kvCacheReport().slotFilePrefix);
    const prefixB = String(b.kvCacheReport().slotFilePrefix);
    assert.match(prefixA, new RegExp(`^lightning-${process.pid}-[0-9a-f]{8}$`));
    assert.notEqual(prefixA, prefixB);
    assert.ok(fs.unlinked.includes(`${prefixA}-probe.bin`));

    await a.createBranch(branch("t"));
    await a.appendMessages("t", [{ role: "user", content: "hi", createdAt: "" }]);
    const result = await a.generate("t", {});
    assert.match(String(kvOf(result).savedTo), new RegExp(`^${prefixA}-t-\\d+\\.bin$`));
  } finally {
    await fake.close();
  }
});

test("superseded slot files are deleted unless a checkpoint holds them; close deletes the rest", async () => {
  const fake = await startFake(1);
  try {
    const fs = fakeFs();
    const adapter = await nativeAdapter(fake, fs);
    await adapter.createBranch(branch("t"));
    await adapter.appendMessages("t", [{ role: "user", content: "hi", createdAt: "" }]);

    const first = kvOf(await adapter.generate("t", {})).savedTo as string;
    const second = kvOf(await adapter.generate("t", {})).savedTo as string;
    assert.ok(fs.unlinked.includes(first), "first file superseded and unheld");

    await adapter.checkpointBranch("t");
    const third = kvOf(await adapter.generate("t", {})).savedTo as string;
    assert.ok(!fs.unlinked.includes(second), "checkpoint keeps its file");
    assert.equal(adapter.kvCacheReport().files, 2);

    const closed = await adapter.close();
    assert.equal(closed.filesDeleted, 2);
    assert.ok(fs.unlinked.includes(second) && fs.unlinked.includes(third));
    assert.equal(adapter.kvCacheReport().files, 0);
  } finally {
    await fake.close();
  }
});

test("hot tier reuses the resident slot; warm restores; cold re-prefills", async () => {
  const fake = await startFake(1);
  try {
    const fs = fakeFs();
    const adapter = await nativeAdapter(fake, fs);
    for (const id of ["a", "b"]) {
      await adapter.createBranch(branch(id));
      await adapter.appendMessages(id, [{ role: "user", content: id, createdAt: "" }]);
    }

    assert.equal(kvOf(await adapter.generate("a", {})).tier, "cold");
    const restoresBefore = actions(fake.calls, "restore").length;
    const hot = kvOf(await adapter.generate("a", {}));
    assert.equal(hot.tier, "hot");
    assert.equal(hot.residentHit, true);
    assert.equal(actions(fake.calls, "restore").length, restoresBefore, "no restore for a resident slot");

    const afterEphemeral = await adapter.generateEphemeral("a", {
      messages: [{ role: "user", content: "a side question", createdAt: "" }]
    });
    assert.equal(kvOf(afterEphemeral).tier, "hot");
    assert.equal(kvOf(await adapter.generate("a", {})).tier, "hot", "an ephemeral turn keeps the slot resident");

    await adapter.generate("b", {}); // b takes the only slot
    const warm = kvOf(await adapter.generate("a", {}));
    assert.equal(warm.tier, "warm");
    assert.ok(warm.restoredFrom);

    await adapter.applyTemperature("a", "cold");
    assert.ok(fs.unlinked.includes(warm.savedTo), "cold drops the branch's KV file");
    const erasesBefore = actions(fake.calls, "erase").length;
    const cold = kvOf(await adapter.generate("a", {}));
    assert.equal(cold.tier, "cold");
    assert.equal(actions(fake.calls, "erase").length, erasesBefore + 1);
  } finally {
    await fake.close();
  }
});

test("disk budget evicts the coldest files first and evicted branches re-prefill", async () => {
  const fake = await startFake(1);
  try {
    const fs = fakeFs();
    const adapter = await nativeAdapter(fake, fs, { kvDiskBudgetBytes: 2_500, slotAffinity: false });
    for (const [id, temperature] of [
      ["hotb", "hot"],
      ["coldb", "cold"],
      ["warmb", "warm"]
    ] as const) {
      await adapter.createBranch(branch(id, temperature));
      await adapter.appendMessages(id, [{ role: "user", content: id, createdAt: "" }]);
    }
    const hotFile = kvOf(await adapter.generate("hotb", {})).savedTo;
    const coldFile = kvOf(await adapter.generate("coldb", {})).savedTo;
    const warmFile = kvOf(await adapter.generate("warmb", {})).savedTo;

    const report = adapter.kvCacheReport() as any;
    assert.equal(report.counters.evictedForBudget, 1);
    assert.equal(report.limit.boundBy, "budget");
    assert.ok(fs.unlinked.includes(coldFile), "cold branch evicted first");
    assert.ok(!fs.unlinked.includes(hotFile) && !fs.unlinked.includes(warmFile));
    assert.equal(kvOf(await adapter.generate("coldb", {})).tier, "cold");
  } finally {
    await fake.close();
  }
});

test("without an operator budget the filesystem bounds the cache, keeping a full-context reserve", async () => {
  const fake = await startFake(1);
  try {
    // reserve = 1 slot x 100 ctx x 100 bytes/token = 10,000; 11,500 free before
    // any file leaves room for one 1,000-byte file above the reserve
    const fs = fakeFs(11_500, fake);
    const adapter = await nativeAdapter(fake, fs, { slotAffinity: false });
    for (const id of ["x", "y"]) {
      await adapter.createBranch(branch(id));
      await adapter.appendMessages(id, [{ role: "user", content: id, createdAt: "" }]);
      await adapter.generate(id, {});
    }
    const report = adapter.kvCacheReport() as any;
    assert.equal(report.limit.boundBy, "filesystem");
    assert.equal(report.limit.reserveBytes, 10_000);
    assert.equal(report.counters.evictedForBudget, 1);
    assert.equal(report.files, 1);
  } finally {
    await fake.close();
  }
});

test("a failed restore drops the file, erases the slot and still answers from the transcript", async () => {
  const fake = await startFake(1);
  try {
    const fs = fakeFs();
    const adapter = await nativeAdapter(fake, fs, { slotAffinity: false });
    await adapter.createBranch(branch("t"));
    await adapter.appendMessages("t", [{ role: "user", content: "hi", createdAt: "" }]);
    const saved = kvOf(await adapter.generate("t", {})).savedTo;

    fake.failRestore = true;
    const result = await adapter.generate("t", {});
    const kv = kvOf(result);
    assert.equal(result.text, "ok");
    assert.equal(kv.tier, "cold");
    assert.deepEqual(kv.restoreFailed, { file: saved, status: 400 });
    assert.ok(fs.unlinked.includes(saved));
    assert.equal((adapter.kvCacheReport() as any).counters.restoreFailures, 1);
  } finally {
    await fake.close();
  }
});

test("a changed build, model, quantization or context invalidates every slot file", async () => {
  const fake = await startFake(1);
  try {
    const fs = fakeFs();
    const adapter = await nativeAdapter(fake, fs);
    await adapter.createBranch(branch("t"));
    await adapter.appendMessages("t", [{ role: "user", content: "hi", createdAt: "" }]);
    const saved = kvOf(await adapter.generate("t", {})).savedTo;

    assert.equal((await adapter.checkKvFingerprint()).changed, false);
    fake.props = { ...fake.props, model_ftype: "Q4_K_M" };
    const check = await adapter.checkKvFingerprint();
    assert.equal(check.changed, true);
    const report = adapter.kvCacheReport() as any;
    assert.equal(report.counters.invalidations, 1);
    assert.equal(report.lastInvalidation.filesDropped, 1);
    assert.equal(report.files, 0);
    assert.ok(fs.unlinked.includes(saved));
    assert.equal(kvOf(await adapter.generate("t", {})).tier, "cold");
  } finally {
    await fake.close();
  }
});

test("a refused slot erase is an error, not a silent continue (F-02)", async () => {
  const fake = await startFake(1);
  try {
    const adapter = await nativeAdapter(fake, fakeFs());
    await adapter.createBranch(branch("t"));
    await adapter.appendMessages("t", [{ role: "user", content: "hi", createdAt: "" }]);
    fake.failErase = true;
    await assert.rejects(() => adapter.generate("t", {}), /slot erase failed with HTTP 500/);
  } finally {
    await fake.close();
  }
});

test("orphan sweep deletes only files of dead Lightning processes", async () => {
  const fake = await startFake(1);
  try {
    const fs = fakeFs();
    const adapter = await nativeAdapter(fake, fs);
    const dead = "lightning-2147483646-0badc0de-t-1.bin";
    const mine = `lightning-${process.pid}-0badc0de-t-1.bin`;
    fs.dir.push(dead, mine, "someone-else.bin");
    fs.unlinked.length = 0;
    const swept = await adapter.sweepOrphanSlotFiles();
    assert.deepEqual(swept.deleted, [dead]);
    assert.deepEqual(fs.unlinked, [dead]);
  } finally {
    await fake.close();
  }
});
