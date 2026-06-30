# @agiterra/bridge-tools

Runtime-agnostic composite functions for **bridge** — the orchestrator's plugin within the Agiterra Multi-Agent Toolkit (AMAT).

bridge collapses an orchestrator's N-step dances (sponsor + register a wire identity → env-map assembly → crew launch → pane create → attach → IPC kickoff) into single function calls. This package is the library layer; the MCP servers that expose these functions to Claude Code and Codex live in `bridge-claude-code` and `bridge-codex`.

In toolkit terms: a **personai** is a permanent agent (its own repo, vault, spawn scripts — persists across days and machines); an **ephemeral** is a short-lived worker a personai spawns to parallelize one job. `bridge.spawn` is how a personai spawns an ephemeral — the personai *sponsors* the new ephemeral's Ed25519 identity (signs its registration with the personai's own key) and forwards the minted private key via env. Bootstrapping a *permanent* agent is an operator/dashboard concern, not bridge's.

## Composite functions

| Function | Collapses |
|---|---|
| `spawn` | pre_spawn hooks → sponsor + register the ephemeral's wire identity → env assembly → crew `agent_launch` (local **or** cross-machine) → pane create + attach (or headless) → wire-ipc kickoff |
| `paneNear` | crew tree walk → resolved pane spec (`near <pane-or-agent>`, `direction`) |
| `composeBrief` | dry-run preview of what `spawn` *would* do — assembled env, resolved placement, and which hooks would run. No spawn, no hook side effects. |
| `health` | wire reachability + crew DB liveness (agents/panes/tabs) + knowledge vault integrity |
| `handoff` | wire `bridge.handoff` ack → crew `agent_close` (graceful `/exit`, lets SessionEnd hooks fire) → optional `pane_close` |
| `close` | `agent_read` snapshot → crew `agent_close` → optional `pane_close` |

bridge is intentionally policy-naive. `handoff` and `close` do **not** run `/knowledge:save`, gate on an audit checklist, or touch Linear — the agent persists its own state before signaling ready, and the orchestrator owns whatever discipline checks it maintains upstream. bridge just collapses the mechanical dance.

### Cross-machine spawn

`spawn` can place an ephemeral on another host. Pass `machine` (a name registered via crew's `machine_register`) and `run_as_uid` (the per-UID account to run under, e.g. `_ephemeral`). When the machine is non-local, the spawn goes **remote**: crew creates the screen there over ssh + `sudo -u`, the agent runs headless (no local pane), its `WIRE_URL` points at the remote host's *local* broker, and — "approach A" — its wire identity is registered against the remote's **public `broker_url`** (federation relays messages but not registrations, so the key must live on the broker the agent actually dials).

## Integration plugins — `bridge-X` pattern

bridge stays domain-naive. Capability-specific behavior (GitHub token minting, Linear ticket sync, etc.) ships as separate **integration plugins** that implement the `BridgeHook` contract. v1 fires hooks at the `pre_spawn` stage:

```ts
import type { BridgeHook } from "@agiterra/bridge-tools/types";

export const bridgeHooks: BridgeHook[] = [
  {
    stage: "pre_spawn",
    capability: "github",
    async run(ctx) {
      const token = await mintInstallationToken(ctx.spawn?.roles, ctx.spawn?.task);
      return { env: { GH_TOKEN: token } };
    }
  }
];
```

A hook returns a `BridgeHookContribution` — `env` vars merged into the spawn env (in capability-iteration order; per-spawn `env` overrides win) and an optional diagnostic `note`. A `spawn` call lists the `capabilities` it wants; each capability with a registered hook runs, missing ones are silently skipped.

Each integration plugin's `plugin.json` declares its hook entry:

```json
{
  "bridge_integration": {
    "capability": "github",
    "stages": ["pre_spawn"],
    "entry": "./dist/bridge-hooks.js"
  }
}
```

The MCP adapter (`bridge-claude-code`) scans installed plugins at boot, finds matching declarations, dynamic-imports the entry module, and registers each `BridgeHook` into the runtime registry it passes to `spawn`. The integration plugin imports the `BridgeHook` *type* from `@agiterra/bridge-tools/types` but does not import bridge runtime code — coupling is one-way via the type contract.

Naming convention: integration repos are `bridge-{capability}` (e.g., `bridge-github`, `bridge-linear`, `bridge-gitlab`). External adopters writing their own integration follow the same shape.

## Roles are opaque

`spawn` takes a `roles: string[]` and a fully-assembled `task` brief. Role *definitions*, *composition*, and *catalog* are **not** bridge's responsibility — the orchestrator owns them and assembles the brief upstream. bridge forwards roles to the worker as the `AGENT_ROLES` env var and uses them in audit logs; it does not interpret, look up, or merge role fragments. A `Role` TypeScript type is exported from the main entry purely as a convenience for orchestrators who write their role files in TypeScript.

## Status

v1.2.0. Six composite functions ship (`spawn`, `paneNear`, `composeBrief`, `health`, `handoff`, `close`), plus the `BridgeHook` contract for integration plugins. `spawn` supports local and cross-machine placement (relative, explicit, new-tab, new-workspace, and headless/detached). The surface may still change as the composite-tool shape stabilizes through real usage. See [plan-bridge.md](https://github.com/agiterra/Fondant/blob/main/.knowledge/plan-bridge.md) for the implementation roadmap (private; ask Tim or Brioche).

## License

MIT
