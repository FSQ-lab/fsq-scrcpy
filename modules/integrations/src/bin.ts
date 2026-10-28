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
const cancel = (): void => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const io: CliIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, question };
try {
  process.exitCode = await executeCli(process.argv.slice(2), io, undefined, controller.signal);
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
