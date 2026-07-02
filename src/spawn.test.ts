import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, SPAWN_RPC_TIMEOUT_MS, type CrewSpawnReply } from "./spawn";
import type { SpawnDeps } from "./spawn";
import type { SpawnOptions } from "./types";
import { generateKeyPair } from "@agiterra/wire-tools";

// The worktree guard and machine refusal fire at the very top of spawn(),
// before any deps are touched, so an empty deps object is fine for those.
const fakeDeps = {} as unknown as SpawnDeps;
const base: SpawnOptions = { agent_id: "x", roles: ["eng"], task: "t" };

async function messageOf(opts: SpawnOptions, deps: SpawnDeps = fakeDeps): Promise<string> {
  try {
    await spawn(opts, deps, new Map());
    return "<no throw>";
  } catch (e) {
    return (e as Error).message;
  }
}

describe("spawn — git-worktree subpath guard", () => {
  for (const dir of [
    "/Users/tim/Projects/Fabrica/fabrica-v3/worktrees/eng-3012-foo",
    "fabrica-v3/worktrees/branch",
    "/repo/worktrees/a/b",
  ]) {
    test(`rejects a worktree subpath: ${dir}`, async () => {
      await expect(spawn({ ...base, project_dir: dir }, fakeDeps, new Map())).rejects.toThrow(/worktrees/);
    });
  }

  test("a normal project root passes the guard (fails later, not on worktrees)", async () => {
    // Passes the guard, then fails at Wire registration against empty deps —
    // the point is the failure is NOT the worktree guard.
    const msg = await messageOf({ ...base, project_dir: "/Users/tim/Projects/Agiterra/wallet-extension" });
    expect(msg).not.toContain("worktrees");
  });

  test("does NOT false-positive on 'myworktrees' (path-segment boundary respected)", async () => {
    const msg = await messageOf({ ...base, project_dir: "/Users/tim/myworktrees/x" });
    expect(msg).not.toContain("worktrees");
  });

  test("no project_dir → guard is a no-op", async () => {
    const msg = await messageOf({ ...base });
    expect(msg).not.toContain("worktrees");
  });
});

describe("spawn — machine targeting refused (run_as_uid path deleted)", () => {
  test("opts.machine throws loud, before any deps are touched", async () => {
    const msg = await messageOf({ ...base, machine: "mini" });
    expect(msg).toContain("no longer supported");
    expect(msg).toContain("crew-service");
  });
});

describe("spawn — crew.agent_spawn RPC path", () => {
  // Stub broker: answers wire-tools registerOrRefresh (POST /agents/register)
  // and sendSignedMessage kickoff (POST /webhooks/:dest/:topic). A dest of
  // 'kickoff-fails' 500s the webhook so brief_sent=false is observable.
  let server: ReturnType<typeof Bun.serve>;
  let wireUrl: string;
  let signingKey: CryptoKey;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/agents/register") return Response.json({ ok: true });
        if (path.startsWith("/webhooks/kickoff-fails/")) return new Response("nope", { status: 500 });
        if (path.startsWith("/webhooks/")) return Response.json({ seq: 1 });
        return new Response("not found", { status: 404 });
      },
    });
    wireUrl = `http://localhost:${server.port}`;
    signingKey = (await generateKeyPair()).privateKey;
  });
  afterAll(() => server.stop(true));

  type RpcCall = { dest: string; method: string; params: any; timeoutMs?: number };

  /** Orchestrator stand-in whose every touch is recorded; throws on unexpected use. */
  function trapOrchestrator() {
    const touched: string[] = [];
    const panes = new Map([["anchor", { name: "anchor", tab: "work" }]]);
    const orchestrator = {
      store: {
        getPane: (n: string) => panes.get(n),
        getAgent: (_: string) => undefined,
        getTab: (_: string) => undefined,
      },
      createPane: async (tab: string, _n: undefined, dir: string, near: string) => {
        touched.push(`createPane(${tab},${dir},${near})`);
        return { name: "new-pane", tab };
      },
      createTab: async (name: string) => {
        touched.push(`createTab(${name})`);
        return { name, pane: { name: "tab-pane" } };
      },
      attachAgent: async (id: string, pane: string) => {
        touched.push(`attachAgent(${id},${pane})`);
      },
    };
    return { orchestrator: orchestrator as unknown as SpawnDeps["orchestrator"], touched };
  }

  function makeDeps(reply: Partial<CrewSpawnReply>, opts?: { rpcError?: string; dest?: string }) {
    const calls: RpcCall[] = [];
    const { orchestrator, touched } = trapOrchestrator();
    const deps: SpawnDeps = {
      orchestrator,
      wire_url: wireUrl,
      wire_ssh_host: "spawner-host.ts.net",
      parent_agent_id: "brioche",
      parent_signing_key: signingKey,
      crew_svc_dest: opts?.dest ?? "crew-svc@patisserie",
      rpc_request: async (dest, method, params, timeoutMs) => {
        calls.push({ dest, method, params, timeoutMs });
        if (opts?.rpcError) throw new Error(opts.rpcError);
        return {
          machine: "patisserie",
          spawned: "eng-7",
          screen_name: "wire-eng-7",
          screen_pid: 42,
          run_as_uid: null,
          ...reply,
        } satisfies CrewSpawnReply;
      },
    };
    return { deps, calls, touched };
  }

  test("happy path: RPC carries env/task/runtime, result maps the reply, kickoff sent", async () => {
    const { deps, calls, touched } = makeDeps({ run_as_uid: "_ephemeral" });
    const r = await spawn(
      {
        agent_id: "eng-7",
        roles: ["eng", "review"],
        task: "do the thing",
        runtime: "codex",
        project_dir: "/opt/fabrica/fabrica-v3",
        badge: "🔧",
        env: { CLAUDE_MODEL: "claude-fable-5" },
      },
      deps,
      new Map(),
    );
    expect(calls.length).toBe(1);
    const c = calls[0];
    expect(c.dest).toBe("crew-svc@patisserie");
    expect(c.method).toBe("crew.agent_spawn");
    expect(c.timeoutMs).toBe(SPAWN_RPC_TIMEOUT_MS);
    expect(c.params.prompt).toBe("do the thing");
    expect(c.params.runtime).toBe("codex");
    expect(c.params.project_dir).toBe("/opt/fabrica/fabrica-v3");
    expect(c.params.badge).toBe("🔧");
    // env assembly: identity + wire routing + per-spawn override
    expect(c.params.env.AGENT_ID).toBe("eng-7");
    expect(c.params.env.AGENT_PRIVATE_KEY).toBeTruthy();
    expect(c.params.env.AGENT_PARENT).toBe("brioche");
    expect(c.params.env.AGENT_ROLES).toBe("eng,review");
    expect(c.params.env.WIRE_URL).toBe(wireUrl);
    expect(c.params.env.WIRE_SSH_HOST).toBe("spawner-host.ts.net");
    expect(c.params.env.WIRE_RUN_AS_UID).toBe(""); // service overlays when it sudos
    expect(c.params.env.CLAUDE_MODEL).toBe("claude-fable-5");
    expect(JSON.parse(c.params.env.KNOWLEDGE_ENRICH_RULES)).toEqual({ ipc: { from: ["brioche"] } });
    // no uid/machine leakage into the RPC — the service owns account policy
    expect("run_as_uid" in c.params).toBe(false);
    expect("machine" in c.params).toBe(false);
    expect(r.agent_id).toBe("eng-7");
    expect(r.wire_identity).toBe("eng-7");
    expect(r.brief_sent).toBe(true);
    // sudo'd spawn → orchestrator never touched (no placement requested anyway)
    expect(touched).toEqual([]);
  });

  test("sudo'd spawn (service run_as_uid) forces headless — placement is ignored", async () => {
    const { deps, touched } = makeDeps({ run_as_uid: "_ephemeral" });
    const r = await spawn(
      { ...base, agent_id: "eng-8", placement: { near: "anchor", direction: "right" } },
      deps,
      new Map(),
    );
    expect(r.agent_id).toBe("eng-7"); // reply id, not opts id — crews.db row identity
    expect(touched).toEqual([]); // no pane created, no attach
  });

  test("same-uid spawn honors placement: pane created, agent attached", async () => {
    const { deps, touched } = makeDeps({ run_as_uid: null });
    await spawn(
      { ...base, agent_id: "eng-9", placement: { near: "anchor", direction: "right" } },
      deps,
      new Map(),
    );
    expect(touched).toEqual(["createPane(work,right,anchor)", "attachAgent(eng-7,new-pane)"]);
  });

  test("RPC failure names the dest and the writer/broker preconditions", async () => {
    const { deps } = makeDeps({}, { rpcError: "agent_spawn refused: 'brioche' is not on the writer allow-list" });
    const msg = await messageOf({ ...base, agent_id: "eng-10" }, deps);
    expect(msg).toContain("crew.agent_spawn RPC failed");
    expect(msg).toContain("crew-svc@patisserie");
    expect(msg).toContain("CREW_SVC_WRITERS");
    expect(msg).toContain("not on the writer allow-list");
  });

  test("kickoff failure → brief_sent=false, agent NOT unwound", async () => {
    const { deps } = makeDeps({ run_as_uid: "_ephemeral" });
    const r = await spawn({ ...base, agent_id: "kickoff-fails" }, deps, new Map());
    expect(r.agent_id).toBe("eng-7");
    expect(r.brief_sent).toBe(false);
  });

  test("per-spawn env overrides beat bridge defaults (WIRE_URL et al)", async () => {
    const { deps, calls } = makeDeps({});
    await spawn({ ...base, agent_id: "eng-11", env: { WIRE_URL: "http://elsewhere:1" } }, deps, new Map());
    expect(calls[0].params.env.WIRE_URL).toBe("http://elsewhere:1");
  });
});
