// Full bridge spawn driven by me (sponsor=fondant), with screen capture to catch the crash.
import { spawn } from "./src/spawn.js";
import { importPrivateKey } from "@agiterra/wire-tools";
// dev crew-tools (carries my awaited-confirm fix) — runtime duck-typing across the two copies is fine
import { Orchestrator, createBackend, detectTerminal, screen } from "/Users/tim/Projects/Agiterra/crew-tools/src/index.ts";
import { $ } from "bun";

const id = "fondant-gate-test";
const sname = `wire-${id}`;
const t = { sshHost: "tim@patisserie.tail3ef8a5.ts.net", runAsUid: "_ephemeral" };
const vault = `/Users/_ephemeral/.knowledge-vaults/${id}`;
await $`ssh -o BatchMode=yes patisserie.tail3ef8a5.ts.net ${`sudo -n -u _ephemeral mkdir -p ${vault}/meta`}`.nothrow().quiet();
await $`ssh -o BatchMode=yes patisserie.tail3ef8a5.ts.net ${`sudo -n -u _ephemeral env HOME=/Users/_ephemeral SCREENDIR=/Users/_ephemeral/.screen /opt/homebrew/bin/screen -S ${sname} -X quit`}`.nothrow().quiet();
await $`sqlite3 /Users/tim/.wire/crews.db ${`DELETE FROM agents WHERE id='${id}'`}`.nothrow().quiet();

const parent_signing_key = await importPrivateKey(process.env.AGENT_PRIVATE_KEY!);
const orchestrator = new Orchestrator(await createBackend(await detectTerminal()), "/Users/tim/.wire/crews.db");
const deps = { orchestrator, wire_url: process.env.WIRE_URL || "http://localhost:9800", parent_agent_id: "fondant", parent_signing_key };
const opts = {
  agent_id: id, roles: ["gate-test"],
  task: "You are fondant-gate-test on the Mini. Once booted, send a wire IPC message to 'fondant' (topic 'ipc') text 'GATE OUTBOUND OK'. Then reply READY and idle.",
  machine: "mini", project_dir: "/opt/fabrica/fabrica-v3", force_rotate: true,
};

console.log("FULL bridge spawn (sponsor=fondant, machine=mini) — confirm is now AWAITED inside launchAgent...");
const t0 = Date.now();
try { console.log("SPAWN RESULT:", JSON.stringify(await spawn(opts, deps, new Map()))); }
catch (e) { console.log("spawn threw:", (e as Error).message); }
console.log(`spawn took ${Math.round((Date.now() - t0) / 1000)}s`);

const alive = await screen.readRemoteOutput(sname, t).catch(() => "(dead)");
console.log("=== screen right after spawn ===");
console.log(alive === "(dead)" || !alive ? "(dead)" : alive.split("\n").filter((l) => l.trim()).slice(-5).join("\n"));

console.log("=== watching patisserie for session + outbound (the full chain) ===");
for (let i = 10; i <= 60; i += 10) {
  await new Promise((r) => setTimeout(r, 10000));
  const r = await $`ssh -o BatchMode=yes patisserie.tail3ef8a5.ts.net ${`sqlite3 -readonly ~/.wire/wire-mini.db "SELECT (SELECT count(*) FROM agent_sessions WHERE agent_id='${id}' AND disconnected_at IS NULL)||'|'||(SELECT count(*) FROM messages WHERE source='${id}')"`}`.nothrow().quiet().text();
  const [sess, out] = r.trim().split("|");
  console.log(`  t=${i}s  live_session=${sess}  outbound=${out}`);
  if (Number(out) > 0) { console.log("  *** OUTBOUND LANDED — full cross-machine spawn proven end-to-end ***"); break; }
}
