import { createLightningApiServer } from "./api/server.js";
import { LlamaCppAdapter } from "./backends/llama_cpp.js";
import { ManagedLlamaCppServer } from "./backends/llama_cpp_process.js";
import { LightningRuntime } from "./core/runtime.js";

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "127.0.0.1";
  // The Host check is a DNS-rebinding defence; a wildcard bind or a port-mapped/proxied setup needs LIGHTNING_ALLOWED_HOSTS (host or host:port entries).
  const allowedHosts = (process.env.LIGHTNING_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (host && !["0.0.0.0", "::", "[::]"].includes(host)) {
    // Bound to PORT: only explicitly configured LIGHTNING_ALLOWED_HOSTS entries widen the accepted ports.
    allowedHosts.push(`${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`);
  }
  const externalBaseUrl = process.env.LLAMA_CPP_BASE_URL;
  const modelRef = process.env.LIGHTNING_MODEL ?? "local-model";
  const managedHost = process.env.LLAMA_CPP_HOST ?? "127.0.0.1";
  const managedPort = Number(process.env.LLAMA_CPP_PORT ?? 8080);
  const managedBinary = process.env.LLAMA_CPP_BINARY ?? "llama-server";
  const managedArgs = process.env.LLAMA_CPP_ARGS
    ? process.env.LLAMA_CPP_ARGS.split(/\s+/).filter(Boolean)
    : [];
  const managedMode = shouldManageLlamaCpp(externalBaseUrl, process.env.LLAMA_CPP_MANAGED);
  const slotSavePath = process.env.LLAMA_CPP_SLOT_SAVE_PATH;
  const parallelEnv = process.env.LLAMA_CPP_PARALLEL;
  const parallel = parallelEnv === undefined ? undefined : Number(parallelEnv);

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
      slotSavePath,
      parallel,
      extraArgs: managedArgs
    });

    await managedServer.start();
    baseUrl = managedServer.baseUrl;
  }

  const runtime = new LightningRuntime();
  const adapter = new LlamaCppAdapter({
    baseUrl,
    defaultModelRef: modelRef
  });
  runtime.registerAdapter(adapter);

  const kv = await adapter.probeKvSupport();
  console.log(`llama.cpp KV checkpoints: ${kv.mode} (${kv.reason})`);
  if (kv.mode === "emulated") {
    console.warn(
      "Checkpoints, restore and prefix reuse are EMULATED (message snapshots); start llama-server with --slot-save-path and --parallel N for native KV checkpoints."
    );
  }

  const server = createLightningApiServer({
    runtime,
    defaultBackend: "llama.cpp",
    defaultModelRef: modelRef,
    allowedHosts
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
