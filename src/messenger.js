import { randomUUID } from 'node:crypto';
import { definitions, history, nativeAccepted, selectorMatches, status } from './projection.js';

// One stuck peer must not block the whole messenger: every delivery step is bounded.
const DELIVERY_STEP_TIMEOUT_MS = 90000;

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`messenger delivery timed out after ${ms}ms while ${what}`)), ms);
    }),
  ]);
}

/** Host port owns agent lifecycle, persistence barriers, and native inbox delivery. */
export class Messenger {
  constructor(host, config) {
    this.host = host;
    this.config = config;
    this.channels = new Map();
    this.errors = new Map();
    this.serial = Promise.resolve();
    this.draining = undefined;
    this.disposed = false;
  }

  lock(task) {
    const result = this.serial.then(task);
    this.serial = result.catch(() => {});
    return result;
  }

  async restore() {
    return this.lock(async () => {
      const logs = [];
      // Only sessions known to lack messenger records can be skipped: reading
      // the rest is a full-history pass for nothing. An unknown flag still reads.
      for (const peer of await this.host.catalog()) {
        if (peer.hasChannels === false) continue;
        try { logs.push(await this.host.read(peer.id)); }
        catch (error) { this.host.report(new Error(`skipping unreadable session ${peer.id}: ${error}`)); }
      }
      this.channels = definitions(logs);
    });
  }

  allowed(from, to) {
    return this.config.allow.some(rule => selectorMatches(rule.from, from) && selectorMatches(rule.to, to));
  }

  async requirePair(senderId, targetId) {
    const from = await this.host.peer(senderId);
    const to = await this.host.peer(targetId);
    if (!this.allowed(from, to)) throw new Error('Messenger policy denies this sender/recipient pair');
    return { from, to };
  }

  channel(callerId, channelId) {
    const channel = this.channels.get(channelId);
    if (!channel || !channel.participants.includes(callerId)) throw new Error('Channel unavailable to this session');
    return channel;
  }

  async create(callerId, targetId) {
    return this.lock(async () => {
      if (callerId === targetId) throw new Error('A channel requires two different sessions');
      await this.requirePair(callerId, targetId);
      const channel = {
        version: 1, channelId: randomUUID(), participants: [callerId, targetId],
        createdBy: callerId, createdAt: new Date().toISOString(),
      };
      await this.host.append(callerId, 'messenger/channel_created', channel);
      // Publication follows the initiator's durable record. A missing joined copy
      // can be repaired from this definition after a crash.
      this.channels.set(channel.channelId, channel);
      try {
        await this.join(targetId, channel);
      } catch (error) {
        this.errors.set(channel.channelId, String(error));
      }
      return structuredClone(channel);
    });
  }

  async join(sessionId, channel) {
    const log = await this.host.read(sessionId);
    const exists = log.events.some(event => ['messenger/channel_created', 'messenger/channel_joined'].includes(event.type)
      && event.data.channelId === channel.channelId);
    if (!exists) await this.host.append(sessionId, 'messenger/channel_joined', channel);
  }

  async send(callerId, channelId, text, messageId = randomUUID()) {
    const result = await this.lock(async () => {
      const channel = this.channel(callerId, channelId);
      if (typeof text !== 'string' || !text.trim()) throw new Error('Message text is empty');
      const recipients = channel.participants.filter(id => id !== callerId);
      for (const id of recipients) await this.requirePair(callerId, id);
      const log = await this.host.read(callerId);
      const existing = log.events.find(event => event.type === 'messenger/message' && event.data.messageId === messageId);
      if (existing) {
        if (existing.data.channelId !== channelId || existing.data.text !== text
          || existing.data.senderSessionId !== callerId) throw new Error('Message ID reused with different content');
      } else {
        const logs = await Promise.all(channel.participants.map(id => this.host.read(id)));
        const sequence = 1 + Math.max(0, ...history(channel, logs).map(message => message.sequence));
        await this.host.append(callerId, 'messenger/message', {
          version: 1, channelId, messageId, senderSessionId: callerId,
          sequence, text, sentAt: new Date().toISOString(),
        });
      }
      return { channelId, messageId, status: 'queued' };
    });
    // Persistence of the sender's outbox is the send boundary, not receiver work.
    this.kick();
    return result;
  }

  kick() {
    if (this.disposed) return;
    if (this.draining) { this.redrain = true; return; }
    this.draining = this.lock(() => this.drain()).catch(error => {
      this.host.report(error);
    }).finally(() => {
      this.draining = undefined;
      if (this.redrain) { this.redrain = false; this.kick(); }
    });
  }

  async settle() {
    do {
      await this.serial;
      await this.draining;
    } while (this.draining);
  }

  async drain() {
    for (const channel of this.channels.values()) {
      let logs;
      try { logs = await Promise.all(channel.participants.map(id => withTimeout(this.host.read(id), DELIVERY_STEP_TIMEOUT_MS, `reading ${id}`))); }
      catch (error) { this.host.report(error); continue; }
      for (const message of history(channel, logs)) {
        for (const id of channel.participants.filter(id => id !== message.senderSessionId)) {
          const key = `${message.messageId}:${id}`;
          try {
            await withTimeout(this.deliver(message, channel, id), DELIVERY_STEP_TIMEOUT_MS, `delivering to ${id}`);
            this.errors.delete(key);
          } catch (error) {
            this.errors.set(key, String(error));
            this.host.report(error);
            // A dropped delivery must stay diagnosable: the in-memory error map
            // dies with the process, and logger.warn is not persisted anywhere.
            await this.host.append(message.senderSessionId, 'messenger/delivery_failed', {
              version: 1, channelId: channel.channelId, messageId: message.messageId,
              recipientSessionId: id, error: String(error), failedAt: new Date().toISOString(),
            }).catch(() => {});
          }
        }
      }
    }
  }

  async deliver(message, channel, id) {
    await this.requirePair(message.senderSessionId, id);
    let target = await this.host.read(id);
    if (nativeAccepted(target, message.messageId)) return;
    await this.join(id, channel);
    if (!target.events.some(event => event.type === 'messenger/message' && event.data.messageId === message.messageId)) {
      await this.host.append(id, 'messenger/message', message);
    }
    // Stable native message identity bridges crashes between record, steer,
    // native inbox flush, and receipt. No model response is awaited.
    await this.host.steer(id, message);
    target = await this.host.read(id);
    if (!nativeAccepted(target, message.messageId)) throw new Error('Native inbox did not accept the message');
    await this.host.append(id, 'messenger/message_delivered', {
      version: 1, channelId: channel.channelId, messageId: message.messageId,
      recipientSessionId: id, deliveredAt: new Date().toISOString(),
    });
  }

  async read(callerId, channelId, query = '') {
    const channel = this.channel(callerId, channelId);
    const logs = await Promise.all(channel.participants.map(id => this.host.read(id)));
    return history(channel, logs).filter(message => message.text.toLowerCase().includes(query.toLowerCase())).map(message => ({
      ...message,
      recipients: channel.participants.filter(id => id !== message.senderSessionId).map(id => ({
        sessionId: id, status: status(logs.find(log => log.header.id === id), message.messageId),
        ...(this.errors.has(`${message.messageId}:${id}`) ? { error: this.errors.get(`${message.messageId}:${id}`) } : {}),
      })),
    }));
  }

  async list(callerId, query = '') {
    const channels = [];
    for (const channel of this.channels.values()) {
      if (!channel.participants.includes(callerId)) continue;
      const messages = await this.read(callerId, channel.channelId);
      if (query && !messages.map(message => message.text).join('\n').toLowerCase().includes(query.toLowerCase())) continue;
      channels.push({
        ...structuredClone(channel), messageCount: messages.length,
        participants: await Promise.all(channel.participants.map(id => this.host.peer(id))),
        ...(this.errors.has(channel.channelId) ? { error: this.errors.get(channel.channelId) } : {}),
      });
    }
    return channels;
  }

  async sessions(callerId, query = '') {
    const caller = await this.host.peer(callerId);
    const supervisor = this.config.supervisors.some(selector => selectorMatches(selector, caller));
    const ownPeers = new Set([callerId]);
    for (const channel of this.channels.values()) {
      if (channel.participants.includes(callerId)) channel.participants.forEach(id => ownPeers.add(id));
    }
    const matchingPeers = new Set();
    if (query) {
      for (const channel of await this.list(callerId, query)) {
        channel.participants.forEach(peer => matchingPeers.add(peer.id));
      }
    }
    return (await this.host.catalog()).filter(peer => peer.id === callerId ||
      (this.allowed(caller, peer) && (supervisor || ownPeers.has(peer.id))))
      .filter(peer => matchingPeers.has(peer.id)
        || `${peer.id} ${peer.preset ?? ''} ${peer.title ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  }

  async newSession(callerId, preset) {
    const caller = await this.host.peer(callerId);
    if (!this.allowed(caller, { id: '', preset })) throw new Error('Messenger policy denies this preset');
    const peer = await this.host.create(preset);
    const channel = await this.create(callerId, peer.id);
    return { session: peer, channel };
  }

  async inspect(callerId, targetId) {
    const { from, to } = await this.requirePair(callerId, targetId);
    if (!this.config.supervisors.some(selector => selectorMatches(selector, from))) throw new Error('Session inspection requires supervision permission');
    return this.host.inspect ? this.host.inspect(to.id) : this.host.read(to.id);
  }

  async close() {
    this.disposed = true;
    await this.settle();
  }
}
