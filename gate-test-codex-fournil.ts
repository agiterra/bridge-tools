// Codex gate test: full bridge spawn onto fournil as _ephemeral, sponsor=fondant, runtime=wire-codex.
// Verifies fournil's Codex layer: node/tsx injector boot -> wire register on fournil's broker -> outbound.
import { spawn } from "./src/spawn.js";
import { importPrivateKey } from "@agiterra/wire-tools";
import { Orchestrator, createBackend, detectTerminal } from "/Users/tim/Projects/Agiterra/crew-tools/src/index.ts";

const id = "fondant-fournil-codex-gate";
const parent_signing_key = await importPrivateKey(process.env.AGENT_PRIVATE_KEY!);
const orchestrator = new Orchestrator(await createBackend(await detectTerminal()), "/Users/tim/.wire/crews.db");
const deps = { orchestrator, wire_url: process.env.WIRE_URL || "http://localhost:9800", parent_agent_id: "fondant", parent_signing_key };
const opts = {
  agent_id: id, roles: ["gate-test"],
  task: "You are a Codex gate test running on fournil (the old MacBook Air) as the _ephemeral user. IMMEDIATELY send exactly ONE Wire message to agent 'fondant' with the content 'FOURNIL CODEX GATE OK' using the wire send_message tool. Then idle and do nothing else.",
  machine: "fournil", run_as_uid: "_ephemeral", project_dir: "/opt/fabrica/fabrica-v3", force_rotate: true,
  runtime: "wire-codex",
};

console.log("spawning Codex gate agent on fournil (sponsor=fondant, runtime=wire-codex)...");
try {
  const res = await spawn(opts, deps, new Map());
  console.log("SPAWN RESULT:", JSON.stringify(res));
} catch (e) { console.log("spawn threw:", (e as Error).message); }
console.log("screen on fournil:", `wire-${id}`);
