// Spawn a persistent CC agent on the Mini (as _ephemeral) for Tim to attach + drive Linear OAuth.
import { spawn } from "./src/spawn.js";
import { importPrivateKey } from "@agiterra/wire-tools";
import { Orchestrator, createBackend, detectTerminal } from "/Users/tim/Projects/Agiterra/crew-tools/src/index.ts";

const id = "mini-linear";
const parent_signing_key = await importPrivateKey(process.env.AGENT_PRIVATE_KEY!);
const orchestrator = new Orchestrator(await createBackend(await detectTerminal()), "/Users/tim/.wire/crews.db");
const deps = { orchestrator, wire_url: process.env.WIRE_URL || "http://localhost:9800", parent_agent_id: "fondant", parent_signing_key };
const opts = {
  agent_id: id, roles: ["mini-setup"],
  task: "You are running on the Mac Mini as the _ephemeral user, in /opt/fabrica/fabrica-v3, in a pane Tim will attach. PURPOSE: Tim will drive a Linear MCP OAuth login through you so that _ephemeral's codex agents on this machine can authenticate to the Linear MCP (mcp.linear.app). When Tim engages, help him complete the Linear OAuth/device flow (the linear MCP server will surface an auth prompt — follow it, surface the URL/code to Tim, and confirm when authenticated). Until he engages, just idle and acknowledge you're ready. Do NOT do anything else.",
  machine: "mini", run_as_uid: "_ephemeral", project_dir: "/opt/fabrica/fabrica-v3", force_rotate: true,
  runtime: "claude-code",
};

console.log("spawning CC agent on the Mini (sponsor=fondant)...");
try {
  const res = await spawn(opts, deps, new Map());
  console.log("SPAWN RESULT:", JSON.stringify(res));
} catch (e) { console.log("spawn threw:", (e as Error).message); }
console.log("screen_name on Mini:", `wire-${id}`);
