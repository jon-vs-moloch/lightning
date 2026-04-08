import { spawn, type ChildProcess } from "node:child_process";

export interface ManagedLlamaCppServerOptions {
  binaryPath?: string;
  modelPath: string;
  host?: string;
  port?: number;
  commandArgsPrefix?: string[];
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ManagedLlamaCppServer {
  readonly baseUrl: string;

  private readonly options: ManagedLlamaCppServerOptions;
  private readonly fetchImpl: typeof fetch;
  private child?: ChildProcess;
  private stopped = false;

  constructor(options: ManagedLlamaCppServerOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 8080;
    this.baseUrl = `http://${host}:${port}`;
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("Managed llama.cpp server is already running.");
    }

    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 8080;
    const args = [
      ...(this.options.commandArgsPrefix ?? []),
      "-m",
      this.options.modelPath,
      "--host",
      host,
      "--port",
      String(port),
      ...(this.options.extraArgs ?? [])
    ];

    const child = spawn(this.options.binaryPath ?? "llama-server", args, {
      env: {
        ...process.env,
        ...this.options.env
      },
      stdio: "inherit"
    });

    this.child = child;
    this.stopped = false;

    const exitPromise = new Promise<never>((_, reject) => {
      child.once("exit", (code, signal) => {
        this.child = undefined;
        if (this.stopped) {
          return;
        }

        reject(
          new Error(
            `Managed llama.cpp server exited before becoming ready (code=${code}, signal=${signal}).`
          )
        );
      });
      child.once("error", (error) => {
        this.child = undefined;
        reject(error);
      });
    });

    await Promise.race([this.waitForHealthy(), exitPromise]);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    this.stopped = true;

    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        this.child = undefined;
        resolve();
      });

      child.kill("SIGTERM");

      setTimeout(() => {
        if (this.child) {
          child.kill("SIGKILL");
        }
      }, 2_000).unref();
    });
  }

  private async waitForHealthy(): Promise<void> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 60_000);

    while (Date.now() < deadline) {
      if (await this.isHealthy()) {
        return;
      }
      await delay(250);
    }

    throw new Error(`Timed out waiting for managed llama.cpp server health at ${this.baseUrl}/health`);
  }

  private async isHealthy(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
