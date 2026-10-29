#!/usr/bin/env node
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp.js";

const diagnostic = "MCP transport failed.\n";
let diagnosed = false;
const report = (): void => {
  if (diagnosed) return;
  diagnosed = true;
  process.stderr.write(diagnostic);
};

try {
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65_536 });
  const handle = serveStdio(() => createMcpServer(), { legacy: "serve", transport, onerror: report });
  let closing = false;
  const remove = (): void => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  };
  const signal = (received: "SIGINT" | "SIGTERM"): void => {
    if (!closing) {
      closing = true;
      void handle.close().finally(remove);
      return;
    }
    remove();
    process.kill(process.pid, received);
  };
  const interrupt = (): void => signal("SIGINT");
  const terminate = (): void => signal("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
} catch {
  report();
  process.exitCode = 5;
}
