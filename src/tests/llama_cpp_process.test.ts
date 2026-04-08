import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ManagedLlamaCppServer } from "../backends/llama_cpp_process.js";

test("managed llama.cpp server starts a local process and waits for health", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "lightning-llama-process-"));
  const scriptPath = join(tempDir, "fake-llama-server.mjs");

  await writeFile(
    scriptPath,
    `
import { createServer } from "node:http";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] ?? 8080);
const host = args[args.indexOf("--host") + 1] ?? "127.0.0.1";

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.statusCode = 200;
    res.end("ok");
    return;
  }

  res.statusCode = 404;
  res.end("nope");
});

server.listen(port, host);

const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
`
  );

  const manager = new ManagedLlamaCppServer({
    binaryPath: process.execPath,
    modelPath: "/tmp/fake-model.gguf",
    host: "127.0.0.1",
    port: 18080,
    commandArgsPrefix: [scriptPath],
    startupTimeoutMs: 5_000
  });

  try {
    await manager.start();
    const response = await fetch(`${manager.baseUrl}/health`);
    assert.equal(response.status, 200);
  } finally {
    await manager.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});
