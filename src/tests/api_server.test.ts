import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

import { createLightningApiServer } from "../api/server.js";
import { FakeAdapter, LightningRuntime } from "../index.js";

async function startTestServer(serverOptions: { allowedHosts?: string[] } = {}) {
  const runtime = new LightningRuntime();
  runtime.registerAdapter(new FakeAdapter());

  const server = createLightningApiServer({
    runtime,
    defaultBackend: "fake",
    defaultModelRef: "fake-echo-v1",
    ...serverOptions
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine API server address.");
  }

  return {
    runtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: async () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

/** Send a raw HTTP request (fetch cannot set Host or force chunked encoding). */
function rawRequest(input: {
  port: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  chunks?: Buffer[];
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: input.port,
      method: input.method,
      path: input.path,
      headers: input.headers
    });

    req.on("error", reject);
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });

    for (const chunk of input.chunks ?? []) {
      req.write(chunk);
    }
    req.end();
  });
}

test("thread endpoint persists a conversation and appends the assistant reply", async () => {
  const harness = await startTestServer();

  try {
    const response = await fetch(`${harness.baseUrl}/v1/threads/demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          content: "Hello endpoint"
        }
      })
    });

    const payload = (await response.json()) as { reply?: string; headCheckpointId?: string };
    assert.equal(response.status, 200);
    assert.match(payload.reply ?? "", /Hello endpoint/);
    assert.ok(payload.headCheckpointId);
    assert.equal(harness.runtime.getMessages("demo").length, 2);
  } finally {
    await harness.close();
  }
});

test("openai-compatible endpoint deduplicates full transcripts for persistent threads", async () => {
  const harness = await startTestServer();

  try {
    const firstResponse = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fake-echo-v1",
        thread_id: "thread-1",
        messages: [
          {
            role: "user",
            content: "First turn"
          }
        ]
      })
    });

    assert.equal(firstResponse.status, 200);
    assert.equal(harness.runtime.getMessages("thread-1").length, 2);

    const secondResponse = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fake-echo-v1",
        thread_id: "thread-1",
        messages: [
          {
            role: "user",
            content: "First turn"
          },
          {
            role: "assistant",
            content: "branch:thread-1 | model:fake-echo-v1 | echo:First turn"
          },
          {
            role: "user",
            content: "Second turn"
          }
        ]
      })
    });

    const secondPayload = (await secondResponse.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      lightning?: { checkpoint_id?: string };
    };

    assert.equal(secondResponse.status, 200);
    assert.match(secondPayload.choices?.[0]?.message?.content ?? "", /Second turn/);
    assert.ok(secondPayload.lightning?.checkpoint_id);
    assert.equal(harness.runtime.getMessages("thread-1").length, 4);
  } finally {
    await harness.close();
  }
});

test("checkpoint endpoint can continue from a saved checkpoint and advance a thread head", async () => {
  const harness = await startTestServer();

  try {
    const firstResponse = await fetch(`${harness.baseUrl}/v1/threads/checkpoint-demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          content: "Checkpoint me"
        }
      })
    });

    const firstPayload = (await firstResponse.json()) as { headCheckpointId?: string };
    assert.ok(firstPayload.headCheckpointId);

    const secondResponse = await fetch(
      `${harness.baseUrl}/v1/checkpoints/${firstPayload.headCheckpointId}/respond`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          thread_id: "checkpoint-demo",
          message: {
            content: "Continue from the checkpoint"
          }
        })
      }
    );

    const secondPayload = (await secondResponse.json()) as {
      nextCheckpointId?: string;
      headCheckpointId?: string;
      reply?: string;
    };

    assert.equal(secondResponse.status, 200);
    assert.match(secondPayload.reply ?? "", /Continue from the checkpoint/);
    assert.ok(secondPayload.nextCheckpointId);
    assert.equal(secondPayload.headCheckpointId, secondPayload.nextCheckpointId);
    assert.equal(
      harness.runtime.getThreadHead("checkpoint-demo"),
      secondPayload.nextCheckpointId
    );
  } finally {
    await harness.close();
  }
});

test("thread inspection returns branch state and current head checkpoint", async () => {
  const harness = await startTestServer();

  try {
    const createResponse = await fetch(`${harness.baseUrl}/v1/threads/inspect-demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          content: "Inspect this thread"
        }
      })
    });

    const created = (await createResponse.json()) as { headCheckpointId?: string };

    const inspectResponse = await fetch(`${harness.baseUrl}/v1/threads/inspect-demo`);
    const inspected = (await inspectResponse.json()) as {
      headCheckpointId?: string;
      recentMessages?: Array<{ content?: string }>;
      branch?: { id?: string };
    };

    assert.equal(inspectResponse.status, 200);
    assert.equal(inspected.branch?.id, "inspect-demo");
    assert.equal(inspected.headCheckpointId, created.headCheckpointId);
    assert.equal(inspected.recentMessages?.length, 2);
  } finally {
    await harness.close();
  }
});

test("checkpoint inspection returns saved checkpoint state", async () => {
  const harness = await startTestServer();

  try {
    const createResponse = await fetch(`${harness.baseUrl}/v1/threads/checkpoint-inspect/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          content: "Checkpoint inspection"
        }
      })
    });

    const created = (await createResponse.json()) as { headCheckpointId?: string };
    assert.ok(created.headCheckpointId);

    const inspectResponse = await fetch(
      `${harness.baseUrl}/v1/checkpoints/${created.headCheckpointId}`
    );
    const inspected = (await inspectResponse.json()) as {
      checkpoint?: { id?: string };
      branch?: { id?: string };
      messageCount?: number;
      threadId?: string;
    };

    assert.equal(inspectResponse.status, 200);
    assert.equal(inspected.checkpoint?.id, created.headCheckpointId);
    assert.equal(inspected.branch?.id, "checkpoint-inspect");
    assert.equal(inspected.messageCount, 2);
    assert.equal(inspected.threadId, "checkpoint-inspect");
  } finally {
    await harness.close();
  }
});

test("thread pinning imports transcript state and sets a new head checkpoint", async () => {
  const harness = await startTestServer();

  try {
    const response = await fetch(`${harness.baseUrl}/v1/threads/pin-demo/pin`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: "You are a pinned conversation."
          },
          {
            role: "user",
            content: "Imported turn one."
          },
          {
            role: "assistant",
            content: "Imported answer one."
          }
        ]
      })
    });

    const payload = (await response.json()) as {
      headCheckpointId?: string;
      recentMessages?: Array<{ content?: string }>;
    };

    assert.equal(response.status, 200);
    assert.ok(payload.headCheckpointId);
    assert.equal(harness.runtime.getThreadHead("pin-demo"), payload.headCheckpointId);
    assert.equal(harness.runtime.getMessages("pin-demo").length, 3);
    assert.equal(payload.recentMessages?.[2]?.content, "Imported answer one.");
  } finally {
    await harness.close();
  }
});

test("branch list reports branches, message counts, thread heads and adapter capabilities", async () => {
  const harness = await startTestServer();

  try {
    await fetch(`${harness.baseUrl}/v1/threads/listed/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: { content: "List me" } })
    });

    const response = await fetch(`${harness.baseUrl}/v1/branches`);
    const payload = (await response.json()) as {
      defaultBackend?: string;
      adapters?: Array<{ id: string; capabilities: Record<string, string> }>;
      branches?: Array<{ id: string; messageCount: number; headCheckpointId?: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.defaultBackend, "fake");
    assert.equal(payload.adapters?.[0]?.id, "fake");
    assert.equal(payload.adapters?.[0]?.capabilities.prefixReuse, "unsupported");
    const listed = payload.branches?.find((branch) => branch.id === "listed");
    assert.equal(listed?.messageCount, 2);
    assert.equal(listed?.headCheckpointId, harness.runtime.getThreadHead("listed"));
  } finally {
    await harness.close();
  }
});

test("root serves the inspector page", async () => {
  const harness = await startTestServer();

  try {
    const response = await fetch(`${harness.baseUrl}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(body, /<title>Lightning<\/title>/);
  } finally {
    await harness.close();
  }
});

test("frozen branches refuse turns, pins and checkpoint responses until thawed", async () => {
  const harness = await startTestServer();

  try {
    const beforeResponse = await fetch(`${harness.baseUrl}/v1/threads/frozen-demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          content: "Before freezing"
        }
      })
    });

    const beforePayload = (await beforeResponse.json()) as { headCheckpointId?: string };
    assert.equal(beforeResponse.status, 200);
    assert.ok(beforePayload.headCheckpointId);

    await harness.runtime.freezeBranch("frozen-demo");

    const frozenTurnResponse = await fetch(`${harness.baseUrl}/v1/threads/frozen-demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          content: "After freezing"
        }
      })
    });

    const frozenTurnPayload = (await frozenTurnResponse.json()) as { error?: string };
    assert.equal(frozenTurnResponse.status, 409);
    assert.match(frozenTurnPayload.error ?? "", /frozen/);

    const frozenChatResponse = await fetch(`${harness.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "fake-echo-v1",
        thread_id: "frozen-demo",
        messages: [
          { role: "user", content: "Before freezing" },
          { role: "assistant", content: "x" },
          { role: "user", content: "Compat turn" }
        ]
      })
    });
    await frozenChatResponse.json();
    assert.equal(frozenChatResponse.status, 409);

    const frozenPinResponse = await fetch(`${harness.baseUrl}/v1/threads/frozen-demo/pin`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Replaced" }]
      })
    });
    await frozenPinResponse.json();
    assert.equal(frozenPinResponse.status, 409);

    const frozenRespondResponse = await fetch(
      `${harness.baseUrl}/v1/checkpoints/${beforePayload.headCheckpointId}/respond`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          thread_id: "frozen-demo",
          message: {
            content: "From checkpoint"
          }
        })
      }
    );
    await frozenRespondResponse.json();
    assert.equal(frozenRespondResponse.status, 409);

    assert.equal(harness.runtime.getMessages("frozen-demo").length, 2);
    assert.equal(harness.runtime.getBranch("frozen-demo").temperature, "frozen");

    await harness.runtime.thawBranch("frozen-demo");

    const thawedResponse = await fetch(`${harness.baseUrl}/v1/threads/frozen-demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          content: "After thawing"
        }
      })
    });

    await thawedResponse.json();
    assert.equal(thawedResponse.status, 200);
    assert.equal(harness.runtime.getMessages("frozen-demo").length, 4);
  } finally {
    await harness.close();
  }
});

test("POST bodies must be JSON and at most 1 MiB", async () => {
  const harness = await startTestServer();

  try {
    const plainResponse = await fetch(`${harness.baseUrl}/v1/threads/plain-demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "text/plain"
      },
      body: JSON.stringify({
        message: {
          content: "hi"
        }
      })
    });

    await plainResponse.json();
    assert.equal(plainResponse.status, 415);
    assert.throws(() => harness.runtime.getBranch("plain-demo"));

    const bigResponse = await fetch(`${harness.baseUrl}/v1/threads/big-demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        message: {
          content: "x".repeat(1024 * 1024 + 1)
        }
      })
    });

    await bigResponse.json();
    assert.equal(bigResponse.status, 413);
    assert.throws(() => harness.runtime.getBranch("big-demo"));

    const badJsonResponse = await fetch(`${harness.baseUrl}/v1/threads/bad-json-demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: "{not json"
    });

    await badJsonResponse.json();
    assert.equal(badJsonResponse.status, 400);

    const charsetResponse = await fetch(`${harness.baseUrl}/v1/threads/charset-demo/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        message: {
          content: "charset ok"
        }
      })
    });

    await charsetResponse.json();
    assert.equal(charsetResponse.status, 200);
  } finally {
    await harness.close();
  }
});

test("checkpoint responses cannot move a frozen thread's head (N-01)", async () => {
  const harness = await startTestServer();

  try {
    const openResponse = await fetch(`${harness.baseUrl}/v1/threads/open-demo/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          content: "Open"
        }
      })
    });
    const openPayload = (await openResponse.json()) as { headCheckpointId?: string };
    assert.equal(openResponse.status, 200);
    const openCheckpoint = openPayload.headCheckpointId;
    assert.ok(openCheckpoint);

    const frozenResponse = await fetch(`${harness.baseUrl}/v1/threads/frozen-head/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          content: "Frozen"
        }
      })
    });
    assert.equal(frozenResponse.status, 200);
    const frozenHead = harness.runtime.getThreadHead("frozen-head");

    await harness.runtime.freezeBranch("frozen-head");

    const sneakResponse = await fetch(
      `${harness.baseUrl}/v1/checkpoints/${openCheckpoint}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: "frozen-head",
          message: {
            content: "Sneak"
          }
        })
      }
    );
    const sneakPayload = (await sneakResponse.json()) as { error?: string };
    assert.equal(sneakResponse.status, 409);
    assert.match(sneakPayload.error ?? "", /frozen/);

    assert.equal(harness.runtime.getThreadHead("frozen-head"), frozenHead);
    assert.equal(harness.runtime.getMessages("open-demo").length, 2);

    const badThreadResponse = await fetch(
      `${harness.baseUrl}/v1/checkpoints/${openCheckpoint}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          thread_id: 42,
          message: {
            content: "Sneak"
          }
        })
      }
    );
    await badThreadResponse.json();
    assert.equal(badThreadResponse.status, 400);
  } finally {
    await harness.close();
  }
});

test("a streamed oversize body without content-length gets 413 (N-02)", async () => {
  const harness = await startTestServer();

  try {
    const chunks = Array.from({ length: 32 }, () => Buffer.alloc(64 * 1024, "x"));
    const bigResponse = await rawRequest({
      port: harness.port,
      method: "POST",
      path: "/v1/threads/stream-big/messages",
      headers: { "content-type": "application/json" },
      chunks
    });

    assert.equal(bigResponse.status, 413);
    assert.match((JSON.parse(bigResponse.body) as { error?: string }).error ?? "", /larger than/);
    assert.throws(() => harness.runtime.getBranch("stream-big"));

    const smallResponse = await rawRequest({
      port: harness.port,
      method: "POST",
      path: "/v1/threads/stream-small/messages",
      headers: { "content-type": "application/json" },
      chunks: [Buffer.from(JSON.stringify({ message: { content: "small stream" } }))]
    });

    assert.equal(smallResponse.status, 200);
  } finally {
    await harness.close();
  }
});

test("turn routes answer 400 for a missing message and 404 for an unknown checkpoint", async () => {
  const harness = await startTestServer();

  try {
    const noMessageResponse = await fetch(`${harness.baseUrl}/v1/threads/no-message/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    await noMessageResponse.json();
    assert.equal(noMessageResponse.status, 400);
    assert.throws(() => harness.runtime.getBranch("no-message"));

    const noContentResponse = await fetch(`${harness.baseUrl}/v1/threads/no-content/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          role: "user"
        }
      })
    });
    await noContentResponse.json();
    assert.equal(noContentResponse.status, 400);

    const nullBodyResponse = await fetch(`${harness.baseUrl}/v1/threads/null-body/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null"
    });
    await nullBodyResponse.json();
    assert.equal(nullBodyResponse.status, 400);

    const createResponse = await fetch(`${harness.baseUrl}/v1/threads/has-ckpt/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          content: "hi"
        }
      })
    });
    const created = (await createResponse.json()) as { headCheckpointId?: string };
    assert.ok(created.headCheckpointId);

    const emptyRespondResponse = await fetch(
      `${harness.baseUrl}/v1/checkpoints/${created.headCheckpointId}/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }
    );
    await emptyRespondResponse.json();
    assert.equal(emptyRespondResponse.status, 400);

    const unknownRespondResponse = await fetch(
      `${harness.baseUrl}/v1/checkpoints/ckpt-does-not-exist/respond`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            content: "x"
          }
        })
      }
    );
    const unknownRespondPayload = (await unknownRespondResponse.json()) as { error?: string };
    assert.equal(unknownRespondResponse.status, 404);
    assert.match(unknownRespondPayload.error ?? "", /Unknown checkpoint/);

    const unknownInspectResponse = await fetch(
      `${harness.baseUrl}/v1/checkpoints/ckpt-does-not-exist`
    );
    await unknownInspectResponse.json();
    assert.equal(unknownInspectResponse.status, 404);
  } finally {
    await harness.close();
  }
});

test("only loopback and configured Host headers are answered (DNS-rebinding defence)", async () => {
  const harness = await startTestServer();

  try {
    const hostCases: Array<[string, number]> = [
      [`localhost:${harness.port}`, 200],
      [`127.0.0.1:${harness.port}`, 200],
      [`[::1]:${harness.port}`, 200],
      [`LOCALHOST:${harness.port}`, 200],
      [`evil.example:${harness.port}`, 403],
      ["evil.example", 403],
      [`localhost:${harness.port + 1}`, 403],
      ["localhost", 403],
      [`127.0.0.1.evil.example:${harness.port}`, 403]
    ];

    for (const [host, expectedStatus] of hostCases) {
      const response = await rawRequest({
        port: harness.port,
        method: "GET",
        path: "/v1/branches",
        headers: { host }
      });
      assert.equal(response.status, expectedStatus, `host ${host} must answer ${expectedStatus}`);
    }

    const rebindResponse = await rawRequest({
      port: harness.port,
      method: "POST",
      path: "/v1/threads/rebind/messages",
      headers: { host: `attacker.example:${harness.port}`, "content-type": "application/json" },
      chunks: [Buffer.from(JSON.stringify({ message: { content: "x" } }))]
    });
    assert.equal(rebindResponse.status, 403);
    assert.throws(() => harness.runtime.getBranch("rebind"));
  } finally {
    await harness.close();
  }

  const configured = await startTestServer({ allowedHosts: ["Lightning.Test"] });

  try {
    const configuredCases: Array<[string, number]> = [
      [`lightning.test:${configured.port}`, 200],
      ["lightning.test", 200],
      [`other.test:${configured.port}`, 403]
    ];

    for (const [host, expectedStatus] of configuredCases) {
      const response = await rawRequest({
        port: configured.port,
        method: "GET",
        path: "/v1/branches",
        headers: { host }
      });
      assert.equal(response.status, expectedStatus, `host ${host} must answer ${expectedStatus}`);
    }
  } finally {
    await configured.close();
  }
});
