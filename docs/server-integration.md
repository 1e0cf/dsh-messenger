# Telegram integration

Read when changing the deployed multiagent profile or its systemd service.

The server uses one DSH process under `dsh-telegram.service`, with profile
`~/.dsh/profiles/multiagent`. Its CLI comes from the isolated patched runtime
`~/Projects/dsh-messenger-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`. The
messenger plugin is loaded from the built entry
`~/Projects/dsh-messenger/lib/index.js`; rebuild it there (`bun install && bun
run build`) before restarting, because `src/index.ts` is not a runtime entry.
The former `telegram` profile and the previous systemd unit backup remain
available. Session and workspace storage stays under the same DSH home.

The profile declares two presets:

| Preset ID          | Display name     | Capabilities                                                         |
| ------------------ | ---------------- | -------------------------------------------------------------------- |
| `nix-assistant`    | Nix Assistant    | Telegram conversation, messenger channels, preset discovery/creation |
| `nix-orchestrator` | Nix Orchestrator | Messenger communication; session diagnostics disabled                |

The assistant's ID is `nix-assistant`. Existing persisted `standard` preset
references were migrated with backups under DSH home; session IDs, messages and
channel identities remain unchanged. The built-in standard preset is disabled.
Its instructions come from
`~/Projects/nix-dsh-assistant/NIX_MULTIAGENT_SYSTEM.md`. Its preset loader reads
`~/Projects/nix-dsh-assistant/AGENTS.md` and replaces the labeled DSH AGENTS block
at mount time. This file defines channel selection, parallel-task tracking,
explicit routing and status reporting. Other OpenClaw source blocks remain
snapshots. Each preset has its own AGENTS.md; no shared workflow file is loaded.
The orchestrator reads `~/Projects/nix-dsh-orchestrator/AGENTS.md`.

Both preset instruction plugins inject `messenger` and restrict global tools to
the five messenger tools listed in the README. Search and private-session
diagnostic tools are not registered. Neither preset currently has shell,
browser or filesystem
execution tools. The orchestrator is a communication prototype, not yet a
replacement for the OpenClaw executor.

Policy permits assistant/orchestrator messages in both directions.
Private-session diagnostic tools are temporarily disabled for both presets;
the internal supervision policy remains configured. New orchestrator sessions use
the existing Codex provider with GPT-6 Luna/xhigh; the assistant retains the
session's selected model. OpenCode Go remains configured.

A one-time host plugin verified both deployed presets, native tool availability,
creation of an independent orchestrator root, and creation of a shared channel.
Its result is `/tmp/dsh-multiagent-health.json`. The verifier is disabled after
the check and makes no model API calls. Runtime transport/restart tests use
`scripts/restart-smoke.ts` with a deterministic mock adapter.
