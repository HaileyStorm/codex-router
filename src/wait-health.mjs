import { PORTS, loopback } from "./paths.mjs";
import { waitForRouterHealth } from "./router-health.mjs";

const url = process.argv[2] || loopback(PORTS.router, "/health");
const platform = process.env.CODEX_ROUTER_SERVICE_PLATFORM || process.platform;
// Matches service.mjs: Windows includes the hidden launcher, forwarders, and
// LiteLLM frontend around the gateway's 300s cold-start allowance. install.ps1
// calls this with no explicit timeout right after the service is installed;
// callers may still provide a shorter or longer timeout as argument three.
const defaultTimeoutMs = platform === "win32" ? 600_000 : 300_000;
const timeoutMs = Number(process.argv[3] || defaultTimeoutMs);
const health = await waitForRouterHealth({ url, timeoutMs });
if (health.ok) {
  process.stdout.write(`${JSON.stringify(health.payload)}\n`);
  process.exit(0);
}
console.error(`Timed out waiting for ${url}: ${health.error}`);
process.exit(1);
