import assert from 'node:assert/strict';
import test from 'node:test';
import { Messenger } from '../src/messenger.js';
import { discoverAgents, listChannels, newChannel } from '../src/discovery.js';

test('discovery exposes only creatable preset names and five latest permitted sessions', async () => {
  const peers = [{ id: 'a', preset: 'assistant' }, ...Array.from({ length: 7 }, (_, i) => ({
    id: `b${i}`, preset: 'orchestrator', status: 'idle', title: `Task ${i}`,
    lastActivityAt: `2026-10-04T00:00:0${i}.000Z`,
  }))];
  const logs = new Map(peers.map(peer => [peer.id, { header: { id: peer.id }, events: [] }]));
  const presets = [
    { id: 'orchestrator', name: 'Nix Orchestrator', description: 'Coordinate tasks' },
    { id: 'denied', name: 'Hidden' }, { id: 'unconfigured', name: 'Not configured' },
    { id: 'broken', name: 'Broken', broken: { message: 'Cannot load' } },
  ];
  const host = {
    async presets() { return presets; }, async catalog() { return peers; },
    async peer(id) { return peers.find(peer => peer.id === id); },
    async read(id) { return structuredClone(logs.get(id)); },
    async append(id, type, data) { logs.get(id).events.push({ type, data: structuredClone(data) }); },
    async create(preset, title) {
      assert.equal(preset, 'orchestrator');
      const peer = { id: 'new', preset, status: 'idle', title };
      peers.push(peer); logs.set(peer.id, { header: { id: peer.id }, events: [] });
      return peer;
    },
  };
  const messenger = new Messenger(host, {
    allow: [{ from: 'preset:assistant', to: 'preset:orchestrator' },
      { from: 'preset:assistant', to: 'preset:unconfigured' }, { from: 'preset:assistant', to: 'preset:broken' }],
    supervisors: [], peers: { orchestrator: {}, denied: {}, broken: {} },
  });
  const discovered = await discoverAgents(messenger, 'a');
  assert.deepEqual(discovered.map(row => row.preset), ['Nix Orchestrator']);
  assert.deepEqual(discovered[0].sessions.map(row => row.session_id), ['b6', 'b5', 'b4', 'b3', 'b2']);
  assert.equal(discovered[0].description, 'Coordinate tasks');
  assert.equal(discovered[0].sessions[0].title, 'Task 6');
  assert.equal('id' in discovered[0], false);
  await assert.rejects(newChannel(messenger, 'a', { preset: 'orchestrator' }), /unavailable/);
  await assert.rejects(newChannel(messenger, 'a', { preset: 'Nix Orchestrator', target_session_id: 'b0' }), /exactly one/);
  const created = await newChannel(messenger, 'a', { preset: 'Nix Orchestrator', title: 'Research' });
  assert.equal(created.session.preset, 'Nix Orchestrator');
  assert.equal(created.session.title, 'Research');
  assert.equal('title' in created, false);
  assert.equal('title' in logs.get('a').events.at(-1).data, false);
  await assert.rejects(newChannel(messenger, 'a', { target_session_id: 'b0', title: 'Rename' }), /only to a newly created session/);
  await assert.rejects(newChannel(messenger, 'a', { preset: 'Nix Orchestrator', title: '  ' }), /visible characters/);
  const listed = await listChannels(messenger, 'a');
  assert.equal(listed[0].channel_id, created.channel_id);
  assert.equal(listed[0].sessions[0].session_id, 'new');
  assert.equal(listed[0].sessions[0].title, 'Research');
  assert.equal('title' in listed[0], false);
  assert.deepEqual(await listChannels(messenger, 'b0'), []);
});

test('session discovery hides unassociated peers and searches shared messages', async () => {
  const logs = new Map(['a', 'b', 'c'].map(id => [id, { header: { id }, events: [] }]));
  const peers = [{ id: 'a', preset: 'assistant' }, { id: 'b', preset: 'orchestrator' }, { id: 'c', preset: 'orchestrator' }];
  const host = {
    async catalog() { return peers; },
    async peer(id) { return peers.find(peer => peer.id === id); },
    async read(id) { return structuredClone(logs.get(id)); },
    async append(id, type, data) { logs.get(id).events.push({ type, data: structuredClone(data) }); },
    async steer() {}, report() {},
  };
  const messenger = new Messenger(host, {
    allow: [{ from: 'preset:assistant', to: 'preset:orchestrator' }], supervisors: [], peers: {},
  });
  assert.deepEqual((await messenger.sessions('a')).map(peer => peer.id), ['a']);
  const channel = await messenger.create('a', 'b');
  await host.append('a', 'messenger/message', {
    version: 1, channelId: channel.channelId, messageId: 'research', senderSessionId: 'a', sequence: 1,
    text: 'Research AI Engineering', sentAt: new Date().toISOString(),
  });
  assert.deepEqual((await messenger.sessions('a')).map(peer => peer.id), ['a', 'b']);
  assert.deepEqual((await messenger.sessions('a', 'AI Engineering')).map(peer => peer.id), ['a', 'b']);
  assert.deepEqual(await messenger.sessions('a', 'PRIVATE MEMORY'), []);
});
