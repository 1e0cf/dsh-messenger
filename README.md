# dsh-messenger

Channels between independent DeepSeek Harness agents. A channel is a queue and a
history of messages exchanged by its member sessions. It does not expose the
participants' private tool calls, thinking, or conversations with other agents.

Prototype for DSH `0.2.0-rc.2`. Requires the Session `ignorable: true` patch in the
companion `deepseek-harness-messenger` fork. Plugin startup probes the API and
refuses an unpatched runtime before writing anything to real sessions.

Sources are TypeScript and the plugin is consumed as built ESM from `lib/`.
Development tooling uses the Bun canary line: `bun fmt`, `bun lint`, and
`bun check` are canary-only, so run `bun upgrade --canary` before the gate.

## Runtime and installation

Use one DSH process with the standard `agents`, `sessions`, `sessionPersistence`,
`tools`, and `llm` services. Independent peers require the standard
`agentPresets` registry. Keep one package instance of each DSH service; installing
a second copy of the Session package only for this plugin is insufficient.

Clone this repository alongside the patched runtime. Resolve peer dependencies
from that runtime, then build the plugin and add a Cordis entry pointing to the
built `lib/index.js`. For example:

```sh
bun install
bun run build
```

```yaml
- name: file:///home/nikita/Projects/dsh-messenger/lib/index.js
  config:
    allow:
      - from: preset:nix-assistant
        to: preset:orchestrator
      - from: preset:orchestrator
        to: preset:nix-assistant
    supervisors:
      - preset:orchestrator
    peers:
      orchestrator:
        cwd: /home/nikita/Projects/work
        agentOptions:
          provider: YOUR_EXISTING_PROVIDER
          model: YOUR_EXISTING_MODEL
```

Configured preset IDs must exist in the host profile. Existing live sessions retain their
host composition. New and resumed peer sessions mount their recorded preset; a
cold session without a configured peer profile fails visibly instead of falling
back to an empty or default agent. Resume uses the last recorded model route,
falling back to the configured route for a session that has never called a model.

For a DSH profile's `cordis.patch.yml`, wrap newly added rows in `- insert:`.
An ordinary row keyed by `id` only overrides an existing row; it does not add
a new plugin or preset. Keep messenger, shared services, and peer preset
definitions in one profile, such as `multiagent`.

Instruction/tool plugins inside a preset can include `messenger` in their
`inject` list. The plugin provides `ctx.messenger.api` only after channel
restoration and global tool registration. This makes preset initialization wait
for those tools before applying a scoped tool allowlist.

Policies are directional and default to deny. Selectors are `preset:ID` or
`session:ID`; a trailing `*` matches a prefix, and `*` matches everything. Channel
creation checks the initiating direction. Configure the reverse direction if
the peer must answer. A session's preset comes from its live binding or native
`agent-preset/selected` events, not from model-supplied arguments.

Tools registered here must also be permitted by any host/preset tool restriction.
An explicit empty allowlist in an existing assistant preset remains an empty
allowlist until its host configuration is updated.

## Model tools

Shared agent guidance lives in [the dsh-messenger skill](skills/dsh-messenger/SKILL.md).
Place one shared copy in `$DSH_HOME/skills/dsh-messenger/SKILL.md` and expose that
root through each agent's native skill provider and `skill` tool. Role instructions
should require loading it before messenger operations rather than copying the API
workflow into every prompt. Creating a peer session does not assign or start work;
the first sent message does. Do not send stop messages to unused empty sessions.

Five tools are exposed. Search and private-session diagnostics are disabled for
all agents, including supervisors. Their implementation remains in
`src/legacy-tools.ts` and the core; the active plugin does not register them.

| Tool                        | Parameters and result                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messenger_discover_agents` | No arguments. Allowed agents by name, ID and description, `can_create_session`, `can_open_channel`, and up to five recent permitted sessions          |
| `messenger_channels_new`    | Exactly one of `target_session_id` or `preset`, plus optional `title`. Creates a channel, creating an independent peer when a preset name is supplied |
| `messenger_channels_list`   | No arguments. Only the caller's channels, with peer session IDs, preset names, status, session titles, and ISO last activity                          |
| `messenger_channel_read`    | `channel_id`. Shared messages with sender, ISO time and delivery/read receipts                                                                        |
| `messenger_send_message`    | `channel_id`, `text`. Generates and returns `message_id`, `channel_id`, and `status: queued`                                                          |

Use the exact preset name from discovery, not an internal preset ID.
Denied agents and presets absent from the registry do not appear. Communication
permission is independent of session creation: `can_open_channel` allows a channel
to an existing permitted session via `target_session_id`; `can_create_session`
allows a new independent session plus its channel via `preset`. Each specific
recipient is checked again against policy. A missing launch profile or broken
preset prevents new-session creation without hiding permitted communication.
Recent-session discovery exposes metadata only, never private history.
Ambiguous preset names are rejected rather than choosing an agent arbitrarily.
Host policy configuration still uses stable internal preset IDs.

The optional `title` in `messenger_channels_new` names the new session, using
the native persisted session-title service. It is accepted only with `preset`;
omit it when joining an existing session. Channels have no titles.

Channel list results contain `channel_id`, `last_activity_at`, and
`agents_participants` describing all participants, including the caller. Each
participant has `agent_preset` (stable preset ID), `preset_name` (display name),
`session_id`, `status`, `title`, and `last_activity_at`. Channel activity means its
latest shared message, or creation if empty. Session activity means its latest
native log event. Times are ISO datetimes; an absent session title is empty.
Channel access requires the caller to be a member, even if policy permits
contacting that peer generally.

Answers are explicit sends to a channel. There is no reply-to-last tool and no
automatic forwarding of an agent's normal assistant response. User/Telegram
messages keep the standard DSH format and are outside this plugin.

## Events and storage

All persistent records use the participants' standard Session JSONL files. No
channel log, side database, or persistent queue is created.

| Event                         | Written in                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `messenger/channel_created`   | Initiator session                                                                 |
| `messenger/channel_joined`    | Other member session                                                              |
| `messenger/message`           | Sender outbox first; recipient session before native delivery                     |
| `messenger/message_delivered` | Recipient after native inbox acceptance and flush                                 |
| `messenger/message_read`      | Recipient on the first response chunk from a model request containing the message |

All records carry `ignorable: true` and payload `version: 1`. Other readers can
skip these plugin events while still reading native events. `channel_created`
and `channel_joined` contain the same complete definition: channel UUID, fixed
session IDs, creator, and ISO creation time. Historical title fields are ignored
by the active tools; existing logs are not rewritten. A single member log can
recover the definition. Recovering the complete transcript/statuses generally
requires all member logs; a lost sender outbox cannot recover an undelivered
message that was never copied to the recipient.

Each message contains `channelId`, stable `messageId`, `senderSessionId`, a
host-assigned channel `sequence`, text, and ISO `sentAt`. Sequence allocation and
dispatch are serialized in the single host process. It preserves queue order
even when timestamps coincide. The model-visible delivery includes channel ID,
sender, and ISO datetime, followed by the original message body.

Send returns `queued` after the sender's record is flushed. A worker copies the
message to the recipient, calls native `Agent.steer`, and flushes its inbox.
It never waits for the recipient's response. Native user-role input carries a
`dsh-messenger` source and the same stable message ID as the outgoing record.

`delivered` means native inbox acceptance was recorded, not that the recipient
finished its task. `read` is conservative: inbox claim alone is insufficient;
the model must begin returning a response for a request containing that input.
A failure before the first response chunk leaves it delivered but unread.

On restart, the plugin reconstructs channels and outstanding outboxes from
session logs. It repairs missing joined/message copies and uses native inbox
insertion/user-message records to avoid repeated delivery. This deduplicates
transport acceptance; it does not make a model's task or external side effects
exactly-once. Internal transport retries retain the same message ID; reuse with different content is rejected. Model-facing sends generate their own ID.

Delivery errors appear in channel reads/listing and host logs. Pending delivery
is retried at startup, when agents are created/resumed, or on another send.
There are no rate limits, automatic loop prevention, or implicit routing.

## Verification

```sh
bun install
bun run gate                 # fmt check, lint, type check, tests
bun run build                # lib/index.js and lib/messenger.js
bun scripts/restart-smoke.ts # needs the patched runtime
```

The smoke test needs the complete patched DSH runtime. It uses real Cordis,
presets, AgentLoop, tool dispatch, and JSONL persistence with a deterministic
mock LLM. It makes no provider API calls. Separate processes verify restart
reconstruction, pending-outbox recovery, and no repeated model calls for already
delivered input. It also checks preset-name discovery, disabled diagnostic tools, independent root
creation, cold resume with the correct preset, and channel isolation.

## Prototype boundaries

- Single host process. No transport between different DSH processes/servers.
- Creation API currently creates two-member channels. Event membership is an
  array so a later group-channel API can use the same addressing model.
- No membership changes, channel deletion, retention, or session replacement.
- Startup scans stored sessions once. A derived in-memory cache retains only
  messenger/native delivery, preset, title, and model-route events, plus last activity metadata. Native append
  notifications update it incrementally; cold logs use persistence revisions
  for invalidation. The retained internal supervisor inspection method reads the full session; its model tool is disabled.
- Not connected to the existing Telegram assistant by default. It needs an
  orchestrator preset and a deliberate host tool-allowlist update first.
