/**
 * rpc-transport-check.ts — de-risk the bridge's crew.agent_spawn RPC transport
 * WITHOUT launching a heavy agent (rate-limit-safe). Proves:
 *   1. the bridge's RpcClient/WireConnection round-trips to a live crew-service
 *      (crew.ping reply routes back under the shared parent identity), and
 *   2. crew.agent_spawn is REACHED past the verified-writer gate for this
 *      identity (empty env → "env.AGENT_ID is required", not a gate refusal).
 *
 *   AGENT_ID=fondant AGENT_PRIVATE_KEY=... WIRE_URL=http://localhost:9800 \
 *     bun run scripts/rpc-transport-check.ts crew-svc@the-wire
 */
import { RpcClient, WireConnection, importPrivateKey, derivePublicKeyB64 } from "@agiterra/wire-tools";

const dest = process.argv[2] ?? "crew-svc@the-wire";
const me = process.env.AGENT_ID!;
const key = await importPrivateKey(process.env.AGENT_PRIVATE_KEY!);
const pub = await derivePublicKeyB64(key);
const url = process.env.WIRE_URL ?? "http://localhost:9800";

const client = new RpcClient({ url, agentId: me, signingKey: key });
const conn = new WireConnection({
  url, agentId: me, agentName: me, keyPair: { publicKey: pub, privateKey: key },
  ccSessionId: `bridge-rpc-check-${me}`,
  deliver: async ({ raw }) => { client.handleEvent(raw); },
});
await conn.start();

let ok = true;
try {
  // 1. Transport + reply routing.
  const pong = await client.request(dest, "crew.ping", {}, 15_000);
  console.log("crew.ping →", JSON.stringify(pong));
  if (!(pong as any)?.machine) { console.error("FAIL: ping had no machine"); ok = false; }

  // 2. Write path reached past the writer gate (empty env fails validation,
  //    NOT the gate — proves this identity is an accepted writer).
  try {
    await client.request(dest, "crew.agent_spawn", { env: {} }, 15_000);
    console.error("FAIL: empty-env agent_spawn should have thrown");
    ok = false;
  } catch (e) {
    const m = (e as Error).message;
    if (/AGENT_ID is required/.test(m)) {
      console.log("crew.agent_spawn gate PASSED, validation reached →", m);
    } else if (/writes disabled|not on the writer allow-list|no broker-verified source_pubkey/.test(m)) {
      console.error("FAIL: blocked at the writer gate (not reached) →", m);
      ok = false;
    } else {
      console.error("FAIL: unexpected agent_spawn error →", m);
      ok = false;
    }
  }
} finally {
  await conn.stop();
}
console.log(ok ? "\nTRANSPORT CHECK: PASS" : "\nTRANSPORT CHECK: FAIL");
process.exit(ok ? 0 : 1);
