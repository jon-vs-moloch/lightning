import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { LlamaCppAdapter } from "../backends/llama_cpp.js";
import { createBranchRecord } from "../core/branch.js";

test("llama.cpp adapter sends chat completions to the configured server", async () => {
  let capturedBody = "";

  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    capturedBody = Buffer.concat(chunks).toString("utf8");

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        model: "tiny-local",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello from llama.cpp"
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 4,
          total_tokens: 15
        }
      })
    );
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine test server address.");
  }

  try {
    const adapter = new LlamaCppAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`
    });

    const branch = createBranchRecord({
      id: "chat-main",
      title: "Chat Main",
      kind: "chat",
      category: "conversation",
      responsibility: "Test",
      backend: "llama.cpp",
      modelRef: "tiny-local"
    });

    await adapter.createBranch(branch);
    await adapter.appendMessages(branch.id, [
      {
        role: "user",
        content: "Hello there",
        createdAt: new Date().toISOString()
      }
    ]);

    const result = await adapter.generate(branch.id, {});

    assert.equal(result.text, "Hello from llama.cpp");
    assert.equal(result.usage?.totalTokens, 15);

    const requestBody = JSON.parse(capturedBody) as { model?: string; messages?: Array<{ content: string }> };
    assert.equal(requestBody.model, "tiny-local");
    assert.equal(requestBody.messages?.[0]?.content, "Hello there");
  } finally {
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
