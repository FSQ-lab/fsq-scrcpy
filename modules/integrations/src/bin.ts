#!/usr/bin/env node
import { createInterface } from "node:readline";
import { executeCli, type CliIo } from "./cli.js";

function question(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const lines = createInterface({ input: process.stdin, terminal: false });
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      lines.close();
      resolve(value);
    };
    const abort = (): void => finish(undefined);
    lines.once("line", finish);
    lines.once("close", () => finish(undefined));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

const controller = new AbortController();
let firstSignal = false;
const signal = (received: "SIGINT" | "SIGTERM"): void => {
  if (!firstSignal) { firstSignal = true; controller.abort(); return; }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  process.kill(process.pid, received);
};
const interrupt = (): void => signal("SIGINT"), terminate = (): void => signal("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
const io: CliIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, question };
try {
  process.exitCode = await executeCli(process.argv.slice(2), io, undefined, controller.signal);
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
