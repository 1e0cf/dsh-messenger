import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import Group from '@deepseek-ai/cordis-plugin-group';
import Presets from '@deepseek-ai/dsh-agent-preset-registry';
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Config, inject, start } from '../src/index.ts';
import type { DshHost } from '../src/host.ts';
import type { Messenger } from '../src/messenger.ts';
import type { MessengerConfig } from '../src/types.ts';

const [phase, root] = process.argv.slice(2);
if (!phase) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-messenger-smoke-'));
  for (const action of ['write', 'read', 'queue', 'recover', 'read']) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), action, directory], {
      stdio: 'inherit',
      timeout: 30000,
    });
    assert.equal(result.status, 0, `smoke subprocess ${action} failed`);
  }
  console.log(`PASS: separate-process restart and queue recovery; logs: ${directory}`);
  process.exit(0);
}

class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = [];
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    const text = 'received';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
const ctx = new Context();
const handles: AgentHandle[] = [];
const adapter = new Adapter();
const ids = ['messenger-assistant', 'messenger-orchestrator', 'messenger-unrelated'];
const presets = ['assistant', 'orchestrator', 'unrelated'];
const config: MessengerConfig = {
  allow: [
    { from: 'preset:assistant', to: 'preset:orchestrator' },
    { from: 'preset:orchestrator', to: 'preset:assistant' },
  ],
  supervisors: ['preset:orchestrator'],
  peers: { orchestrator: { agentOptions: { provider: 'mock', model: 'mock' } } },
};
let messenger!: Messenger<DshHost>;
try {
  await ctx.plugin(Loader);
  ctx.loader.builtins.group = Group;
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(Projections);
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools, { mode: 'native' });
  await ctx.plugin(Agents);
  await ctx.plugin(Jsonl, { root, compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Presets, { default: 'assistant' });
  for (const preset of presets) {
    await ctx.plugin({
      inject: ['agentPresets'],
      async *apply(child: Context) {
        yield await child.agentPresets.register({
          id: preset,
          name: preset === 'orchestrator' ? 'Orchestrator' : preset,
          description: `Independent ${preset}`,
          plugins: [],
        });
      },
    });
  }
  ctx.llm.registerAdapter(['mock'], adapter);
  for (const [index, id] of ids.entries()) {
    handles.push(
      phase === 'write'
        ? await ctx.agents.create({
            sessionId: SessionId(id),
            agentOptions: { provider: 'mock', model: 'mock' },
            meta: { agentPreset: presets[index] },
            setup: async (agentCtx) => {
              await ctx.agentPresets.mount(agentCtx, presets[index]);
            },
          })
        : await ctx.agents.resume({
            resumeSessionId: SessionId(id),
            agentOptions: { provider: 'mock', model: 'mock' },
            setup: async (agentCtx) => {
              await ctx.agentPresets.mount(agentCtx, presets[index]);
            },
          }),
    );
  }
  await ctx.plugin(
    {
      name: 'messenger-smoke',
      inject,
      Config,
      async apply(child) {
        messenger = await start(child, config);
      },
    },
    config,
  );
  const [a, b, c] = handles.map((handle) => handle.agent);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (agent: Agent, name: string, args: Record<string, unknown>): Promise<any> => {
    const value = await ctx.tools.execute({
      callId: ToolCallId(randomUUID()),
      name,
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
    assert.equal(value.isError, false, JSON.stringify(value));
    return value.value;
  };
  if (phase === 'write') {
    for (const agent of [a, b]) {
      for (const name of [
        'messenger_sessions',
        'messenger_tools',
        'messenger_channels',
        'messenger_send',
        'messenger_channels_search',
        'messenger_messages_search',
      ]) {
        assert.equal(ctx.tools.get(name, agent), undefined, `Disabled tool exposed: ${name}`);
      }
    }
    const roster = await call(a, 'messenger_discover_agents', {});
    assert.deepEqual(
      roster.agents.map((peer: { preset: string }) => peer.preset),
      ['Orchestrator'],
    );
    assert.equal(roster.agents[0].description, 'Independent orchestrator');
    assert.deepEqual(
      roster.agents[0].sessions.map((peer: { session_id: string }) => peer.session_id),
      [b.id],
    );
    assert.equal('id' in roster.agents[0], false);
    const created = await call(a, 'messenger_channels_new', { target_session_id: b.id, title: 'research' });
    const channel = { channelId: created.channel_id };
    const listed = await call(a, 'messenger_channels_list', {});
    assert.equal(listed.channels.length, 1);
    assert.equal(listed.channels[0].sessions[0].session_id, b.id);
    assert.equal(listed.channels[0].sessions[0].preset, 'Orchestrator');
    assert.match(listed.channels[0].last_activity_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual((await call(c, 'messenger_channels_list', {})).channels, []);
    const sent = await call(a, 'messenger_send_message', {
      channel_id: channel.channelId,
      text: 'Investigate this project',
    });
    assert.equal(sent.status, 'queued');
    assert.ok(sent.message_id);
    const sendProperties = ctx.tools.get('messenger_send_message', a)!.parameters.properties;
    assert.deepEqual(Object.keys(sendProperties).sort(), ['channel_id', 'text']);
    await messenger.settle();
    await b.whenIdle();
    assert.equal(adapter.requests.length, 1);
    assert.ok(adapter.requests[0].messages.some((message) => message.source?.kind === 'dsh-messenger'));
    const { messages } = await call(a, 'messenger_channel_read', { channel_id: channel.channelId });
    assert.equal(messages[0].recipients[0].status, 'read');
    const denied = await ctx.tools.execute({
      callId: ToolCallId(randomUUID()),
      name: 'messenger_channel_read',
      arguments: { channel_id: channel.channelId },
      agent: c,
      signal: new AbortController().signal,
    });
    assert.equal(denied.isError, true);
    b.followup(
      createUserMessage({ content: [{ type: 'text', text: 'PRIVATE USER MESSAGE' }], source: { kind: 'user' } }),
    );
    await b.whenIdle();
    assert.doesNotMatch(JSON.stringify(await messenger.read(a.id, channel.channelId)), /PRIVATE/);
    const fresh = await call(a, 'messenger_channels_new', { preset: 'Orchestrator' });
    assert.equal(ctx.agents.isOwnedBy(fresh.session.session_id, a), false, 'peer became a subagent');
    assert.ok(ctx.agents.roots().some((agent) => agent.id === fresh.session.session_id));
    await call(a, 'messenger_send_message', {
      channel_id: fresh.channel_id,
      text: 'First message to an independent peer',
    });
    await messenger.settle();
    const freshAgent = ctx.agents.get(fresh.session.session_id)!;
    await freshAgent.whenIdle();
    // Dispose only the messenger-owned peer, then send to its persisted session.
    await messenger.host.owned.get(fresh.session.session_id)!.dispose();
    messenger.host.owned.delete(fresh.session.session_id);
    assert.equal((await messenger.host.peer(fresh.session.session_id)).status, 'inactive');
    await call(a, 'messenger_send_message', {
      channel_id: fresh.channel_id,
      text: 'Resume the same peer after disposal',
    });
    await messenger.settle();
    const resumed = ctx.agents.get(fresh.session.session_id);
    assert.ok(resumed, 'cold peer was not resumed');
    await resumed.whenIdle();
    assert.equal(ctx.agentPresets.composedPreset(resumed.ctx), 'orchestrator');
    assert.equal((await messenger.read(a.id, fresh.channel_id)).length, 2);
    console.log(
      'PASS: native tools, preset-name discovery, disabled diagnostics, independent roots, steer, read receipt, channel isolation',
    );
    console.log('PASS: peer creation, root autonomy, cold resume with recorded preset and model');
  } else {
    await messenger.settle();
    await b.whenIdle();
    const channel = (await messenger.list(a.id)).find((row) => (row as { title?: string }).title === 'research');
    assert.ok(channel);
    if (phase === 'queue') {
      // Deliberately terminate after the durable outbox record, before dispatch.
      await messenger.host.append(a.id, 'messenger/message', {
        version: 1,
        channelId: channel.channelId,
        messageId: randomUUID(),
        sequence:
          1 + Math.max(0, ...(await messenger.read(a.id, channel.channelId)).map((message) => message.sequence)),
        senderSessionId: a.id,
        text: 'Pending across process restart',
        sentAt: new Date().toISOString(),
      });
      assert.equal(adapter.requests.length, 0);
      console.log('PASS: left a durable message queued without native delivery');
    } else if (phase === 'recover') {
      assert.equal(adapter.requests.length, 1, 'pending message did not produce exactly one model request');
      assert.equal((await messenger.read(a.id, channel.channelId)).length, 2);
      console.log('PASS: restored outbox delivered through the native agent loop exactly once');
    } else {
      assert.equal(adapter.requests.length, 0, 'restart resent an already delivered message');
      console.log('PASS: restored channel/history with no duplicate model calls');
    }
  }
} finally {
  if (messenger) await messenger.close();
  for (const handle of handles) await handle.dispose();
  await ctx.fiber.dispose();
}
