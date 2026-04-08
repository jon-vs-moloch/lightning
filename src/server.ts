import { createLightningApiServer } from "./api/server.js";
import { LlamaCppAdapter } from "./backends/llama_cpp.js";
import { LightningRuntime } from "./core/runtime.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const baseUrl = process.env.LLAMA_CPP_BASE_URL ?? "http://127.0.0.1:8080";
  const modelRef = process.env.LIGHTNING_MODEL ?? "local-model";

  const runtime = new LightningRuntime();
  runtime.registerAdapter(
    new LlamaCppAdapter({
      baseUrl,
      defaultModelRef: modelRef
    })
  );

  const server = createLightningApiServer({
    runtime,
    defaultBackend: "llama.cpp",
    defaultModelRef: modelRef
  });

  server.listen(port, host, () => {
    console.log(`Lightning API listening on http://${host}:${port}`);
    console.log(`Proxying generation to ${baseUrl}`);
  });
}

void main();
