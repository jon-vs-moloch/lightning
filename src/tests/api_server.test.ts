import test from "node:test";
import assert from "node:assert/strict";

import { createLightningApiServer } from "../api/server.js";
import { FakeAdapter, LightningRuntime } from "../index.js";

async function startTestServer() {
  const runtime = new LightningRuntime();
  runtime.registerAdapter(new FakeAdapter());

  const server = createLightningApiServer({
    runtime,
    defaultBackend: "fake",
    defaultModelRef: "fake-echo-v1"
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine API server address.");
  }

  return {
    runtime,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
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
