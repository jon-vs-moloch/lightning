import { createLightningApiServer } from "./api/server.js";
import { LlamaCppAdapter } from "./backends/llama_cpp.js";
import { ManagedLlamaCppServer } from "./backends/llama_cpp_process.js";
import { LightningRuntime } from "./core/runtime.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  const externalBaseUrl = process.env.LLAMA_CPP_BASE_URL;
  const modelRef = process.env.LIGHTNING_MODEL ?? "local-model";
  const managedHost = process.env.LLAMA_CPP_HOST ?? "127.0.0.1";
  const managedPort = Number(process.env.LLAMA_CPP_PORT ?? 8080);
  const managedBinary = process.env.LLAMA_CPP_BINARY ?? "llama-server";
  const managedArgs = process.env.LLAMA_CPP_ARGS
    ? process.env.LLAMA_CPP_ARGS.split(/\s+/).filter(Boolean)
    : [];
  const managedMode = shouldManageLlamaCpp(externalBaseUrl, process.env.LLAMA_CPP_MANAGED);

  let managedServer: ManagedLlamaCppServer | undefined;
  let baseUrl = externalBaseUrl ?? `http://${managedHost}:${managedPort}`;

  if (managedMode) {
    if (!process.env.LIGHTNING_MODEL) {
      throw new Error(
        "Managed llama.cpp mode requires LIGHTNING_MODEL to point to a local GGUF model."
      );
    }

    managedServer = new ManagedLlamaCppServer({
      binaryPath: managedBinary,
      modelPath: process.env.LIGHTNING_MODEL,
      host: managedHost,
      port: managedPort,
      extraArgs: managedArgs
    });

    await managedServer.start();
    baseUrl = managedServer.baseUrl;
  }

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

  const shutdown = async () => {
    server.close();
    if (managedServer) {
      await managedServer.stop();
    }
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  server.listen(port, host, () => {
    console.log(`Lightning API listening on http://${host}:${port}`);
    console.log(
      managedMode
        ? `Managing llama.cpp locally at ${baseUrl}`
        : `Proxying generation to ${baseUrl}`
    );
  });
}

function shouldManageLlamaCpp(
  externalBaseUrl: string | undefined,
  managedFlag: string | undefined
): boolean {
  if (managedFlag === "1" || managedFlag === "true") {
    return true;
  }

  if (managedFlag === "0" || managedFlag === "false") {
    return false;
  }

  return !externalBaseUrl;
}

void main();
