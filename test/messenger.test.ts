import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Messenger } from '../src/messenger.ts';
import type { Host, MessengerConfig, MessengerMessage, Peer, SessionLog, SessionLogEvent } from '../src/types.ts';

class MemoryHost implements Host {
  logs: Map<string, SessionLog>;
  steers: { id: string; message: MessengerMessage }[];
  failBeforeSteer: boolean;
  errors: string[];

  constructor() {
    this.logs = new Map(
      ['a', 'b', 'c'].map(
        (id) =>
          [
            id,
            {
              header: { id, createdAt: 0, agentPreset: id === 'a' ? 'assistant' : 'orchestrator' },
              events: [],
            },
          ] as const,
      ),
    );
    this.steers = [];
    this.failBeforeSteer = false;
    this.errors = [];
  }
  async catalog() {
    return Promise.all([...this.logs.keys()].map((id) => this.peer(id)));
  }
  async peer(id: string): Promise<Peer> {
    const log = this.logs.get(id);
    if (!log) throw new Error('Unknown session');
    return { id, preset: log.header.agentPreset, status: 'idle' };
  }
  async read(id: string): Promise<SessionLog> {
    return structuredClone(this.logs.get(id)!);
  }
  async append(id: string, type: string, data: unknown): Promise<void> {
    this.logs.get(id)!.events.push({ type, data: structuredClone(data) } as SessionLogEvent);
  }
  async steer(id: string, message: MessengerMessage): Promise<void> {
    if (this.failBeforeSteer) throw new Error('Simulated crash before native acceptance');
    this.steers.push({ id, message });
    this.logs
      .get(id)!
      .events.push({ type: 'agent/inbox/spliced', data: { inserted: [{ id: message.messageId }] } } as SessionLogEvent);
  }
  async create(preset: string, title?: string): Promise<Peer> {
    const peer: Peer = { id: 'created', preset, ...(title === undefined ? {} : { title }) };
    this.logs.set(peer.id, { header: { id: peer.id, createdAt: 0, agentPreset: preset }, events: [] });
    return peer;
  }
  async presets() {
    return [];
  }
  report(error: unknown): void {
    this.errors.push(String(error));
  }
}
const config: MessengerConfig = {
  allow: [
    { from: 'preset:assistant', to: 'preset:orchestrator' },
    { from: 'preset:orchestrator', to: 'preset:assistant' },
  ],
  supervisors: ['preset:orchestrator'],
  peers: {},
};

test('send queues durably and steers without awaiting a model answer', async () => {
  const host = new MemoryHost();
  const messenger = new Messenger(host, config);
  const channel = await messenger.create('a', 'b');
  const sent = await messenger.send('a', channel.channelId, 'Investigate this project', 'm1');
  assert.equal(sent.status, 'queued');
  await messenger.settle();
  assert.equal(host.steers.length, 1);
  const [message] = await messenger.read('a', channel.channelId);
  assert.equal(message.recipients[0].status, 'delivered');
  assert.match(message.sentAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('restart recovers a recipient record without native inbox acceptance', async () => {
  const host = new MemoryHost();
  host.failBeforeSteer = true;
  const original = new Messenger(host, config);
  const channel = await original.create('a', 'b');
  await original.send('a', channel.channelId, 'hello', 'm1');
  await original.settle();
  assert.equal((await original.read('a', channel.channelId))[0].recipients[0].status, 'queued');
  assert.equal(host.logs.get('b')!.events.filter((event) => event.type === 'messenger/message').length, 1);
  await original.close();
  host.failBeforeSteer = false;
  const restored = new Messenger(host, config);
  await restored.restore();
  restored.kick();
  await restored.settle();
  assert.equal(host.steers.length, 1);
  assert.equal(host.logs.get('b')!.events.filter((event) => event.type === 'messenger/message').length, 1);
});

test('retry and restart do not steer an already accepted message twice', async () => {
  const host = new MemoryHost();
  const first = new Messenger(host, config);
  const channel = await first.create('a', 'b');
  await first.send('a', channel.channelId, 'hello', 'same');
  await first.settle();
  const restored = new Messenger(host, config);
  await restored.restore();
  await restored.send('a', channel.channelId, 'hello', 'same');
  await restored.settle();
  assert.equal(host.steers.length, 1);
  await assert.rejects(restored.send('a', channel.channelId, 'different', 'same'), /different content/);
});

test('channel read exposes no private trace or messages from another channel', async () => {
  const host = new MemoryHost();
  const messenger = new Messenger(host, config);
  const ab = await messenger.create('a', 'b');
  const ac = await messenger.create('a', 'c');
  await messenger.send('a', ab.channelId, 'public in AB', 'ab-message');
  await messenger.send('a', ac.channelId, 'secret in AC', 'ac-message');
  await messenger.settle();
  await host.append('b', 'assistant/attempt', { thinking: 'PRIVATE THINKING' });
  await host.append('b', 'tool/result', { content: 'PRIVATE TOOL OUTPUT' });
  const result = JSON.stringify(await messenger.read('b', ab.channelId));
  assert.match(result, /public in AB/);
  assert.doesNotMatch(result, /secret in AC|PRIVATE/);
  await assert.rejects(messenger.read('b', ac.channelId), /unavailable/);
  await assert.rejects(messenger.inspect('a', 'b'), /supervision/);
  assert.match(JSON.stringify(await messenger.inspect('b', 'a')), /public in AB/);
});

test('deny-by-default applies to creation, discovery, and send after policy change', async () => {
  const host = new MemoryHost();
  const messenger = new Messenger(host, { ...config, allow: [] });
  await assert.rejects(messenger.create('a', 'b'), /denies/);
  assert.deepEqual(
    (await messenger.sessions('a')).map((peer) => peer.id),
    ['a'],
  );
  messenger.config = config;
  const channel = await messenger.create('a', 'b');
  messenger.config = { ...config, allow: [] };
  await assert.rejects(messenger.send('a', channel.channelId, 'hello'), /denies/);
});

test('one surviving session log reconstructs the complete channel definition', async () => {
  const host = new MemoryHost();
  const messenger = new Messenger(host, config);
  const channel = await messenger.create('a', 'b');
  host.logs.get('a')!.events = [];
  const restored = new Messenger(host, config);
  await restored.restore();
  assert.deepEqual(restored.channels.get(channel.channelId), channel);
  assert.equal((await restored.list('a')).length, 1);
});

test('several queued sends are drained even while delivery is already running', async () => {
  const host = new MemoryHost();
  const messenger = new Messenger(host, config);
  const channel = await messenger.create('a', 'b');
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => messenger.send('a', channel.channelId, `message ${i}`, `m${i}`)),
  );
  await messenger.settle();
  assert.equal(host.steers.length, 8);
  assert.equal(new Set(host.steers.map((row) => row.message.messageId)).size, 8);
  assert.deepEqual(
    host.steers.map((row) => row.message.text),
    Array.from({ length: 8 }, (_, i) => `message ${i}`),
  );
});
