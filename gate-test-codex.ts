// Full wire-codex bridge spawn driven by me (sponsor=fondant) — the Codex proof.
import { spawn } from "./src/spawn.js";
import { importPrivateKey } from "@agiterra/wire-tools";
import { Orchestrator, createBackend, detectTerminal } from "/Users/tim/Projects/Agiterra/crew-tools/src/index.ts";
import { $ } from "bun";

const id = "fondant-codex-gate";
const sname = `wire-${id}`;
await $`ssh -o BatchMode=yes patisserie.tail3ef8a5.ts.net ${`sudo -n -u _ephemeral env HOME=/Users/_ephemeral SCREENDIR=/Users/_ephemeral/.screen /opt/homebrew/bin/screen -S ${sname} -X quit`}`.nothrow().quiet();
await $`sqlite3 /Users/tim/.wire/crews.db ${`DELETE FROM agents WHERE id='${id}'`}`.nothrow().quiet();

const parent_signing_key = await importPrivateKey(process.env.AGENT_PRIVATE_KEY!);
const orchestrator = new Orchestrator(await createBackend(await detectTerminal()), "/Users/tim/.wire/crews.db");
const deps = { orchestrator, wire_url: process.env.WIRE_URL || "http://localhost:9800", parent_agent_id: "fondant", parent_signing_key };
const opts = {
  agent_id: id, roles: ["codex-gate-test"],
  task: "You are fondant-codex-gate, a wire-codex cross-machine spawn verification agent on the Mac Mini. As soon as you finish booting, use your Wire IPC send_message tool to send a message to agent 'fondant' on topic 'ipc' with text 'CODEX GATE OUTBOUND OK'. Then idle.",
  machine: "mini", run_as_uid: "_ephemeral", project_dir: "/opt/fabrica/fabrica-v3", force_rotate: true,
  runtime: "wire-codex",
};

console.log("FULL wire-codex bridge spawn (sponsor=fondant, machine=mini)...");
try { console.log("SPAWN RESULT:", JSON.stringify(await spawn(opts, deps, new Map()))); }
catch (e) { console.log("spawn threw:", (e as Error).message); }

console.log("watching patisserie for codex session + outbound (codex boot is slower than CC)...");
for (let i = 10; i <= 120; i += 10) {
  await new Promise((r) => setTimeout(r, 10000));
  const r = await $`ssh -o BatchMode=yes patisserie.tail3ef8a5.ts.net ${`sqlite3 -readonly ~/.wire/wire-mini.db "SELECT (SELECT count(*) FROM agent_sessions WHERE agent_id='${id}' AND disconnected_at IS NULL)||'|'||(SELECT count(*) FROM messages WHERE source='${id}')"`}`.nothrow().quiet().text();
  const [sess, out] = r.trim().split("|");
  console.log(`  t=${i}s  live_session=${sess}  outbound=${out}`);
  if (Number(out) > 0) { console.log("  *** CODEX OUTBOUND LANDED — wire-codex cross-machine spawn proven ***"); break; }
}
console.log("=== injector log tail (wire-codex.log) ===");
const log = await $`ssh -o BatchMode=yes patisserie.tail3ef8a5.ts.net ${`sudo -n -u _ephemeral bash -c 'f=$(ls -td /Users/_ephemeral/.wire/codex-spawn/*/wire-codex.log 2>/dev/null | head -1); echo "log: $f"; tail -12 "$f" 2>/dev/null'`}`.nothrow().quiet().text();
console.log(log);
