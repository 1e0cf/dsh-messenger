import { randomUUID } from 'node:crypto';
import { definitions, history, nativeAccepted, selectorMatches, status } from './projection.ts';
import type {
  ChannelDefinition,
  ChannelSummary,
  Host,
  MessengerConfig,
  MessengerMessage,
  Peer,
  ReadMessage,
  SessionLog,
} from './types.ts';

// One stuck peer must not block the whole messenger: every delivery step is bounded.
const DELIVERY_STEP_TIMEOUT_MS = 90000;

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`messenger delivery timed out after ${ms}ms while ${what}`)), ms);
    }),
  ]);
}

export interface SendResult {
  channelId: string;
  messageId: string;
  status: 'queued';
}

export interface ChannelSnapshot {
  session: Peer;
  channel: ChannelDefinition;
}

/** Host port owns agent lifecycle, persistence barriers, and native inbox delivery. */
export class Messenger<H extends Host = Host> {
  host: H;
  config: MessengerConfig;
  channels: Map<string, ChannelDefinition>;
  errors: Map<string, string>;
  serial: Promise<unknown>;
  delivery: Promise<unknown>;
  draining?: Promise<void>;
  redrain?: boolean;
  disposed: boolean;
  /** Channels with work the last sweep has not confirmed: everything else is skipped. */
  dirty: Set<string>;
  /** Message ids already seen per channel: delivery copies are not new work. */
  known: Map<string, Set<string>>;

  constructor(host: H, config: MessengerConfig) {
    this.host = host;
    this.config = config;
    this.channels = new Map();
    this.errors = new Map();
    this.serial = Promise.resolve();
    // Delivery sweeps get their own chain: a slow drain must never queue a send.
    this.delivery = Promise.resolve();
    this.draining = undefined;
    this.disposed = false;
    this.dirty = new Set<string>();
    this.known = new Map<string, Set<string>>();
    // Channel membership is written by the participants themselves, so every
    // definition arrives as an ordinary session event: no rebuild on agent creation.
    host.eventSink = (sessionId, event) => this.observeChannelEvent(sessionId, event);
  }

  /** Fold one channel definition event into the in-memory channel map. */
  private observeChannelEvent(sessionId: string, event: SessionLog['events'][number]): void {
    if (event.type === 'messenger/message') {
      const data = event.data as { channelId?: string; messageId?: string };
      if (!data.channelId) return;
      const seen = this.known.get(data.channelId) ?? new Set<string>();
      this.known.set(data.channelId, seen);
      if (data.messageId && seen.has(data.messageId)) return;
      if (data.messageId) seen.add(data.messageId);
      this.dirty.add(data.channelId);
      return;
    }
    if (event.type !== 'messenger/channel_created' && event.type !== 'messenger/channel_joined') return;
    const data = event.data as ChannelDefinition | undefined;
    if (!data || typeof data.channelId !== 'string') return;
    if (!Array.isArray(data.participants) || !data.participants.includes(sessionId)) return;
    if (event.type === 'messenger/channel_created' && data.createdBy !== sessionId) return;
    const existing = this.channels.get(data.channelId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(data)) return;
    this.channels.set(data.channelId, structuredClone(data));
    this.dirty.add(data.channelId);
  }

  lock<T>(task: () => Promise<T>): Promise<T> {
    const result = this.serial.then(task);
    this.serial = result.catch(() => {});
    return result;
  }

  async restore(): Promise<void> {
    return this.lock(async () => {
      const logs: SessionLog[] = [];
      // Only sessions known to lack messenger records can be skipped: reading
      // the rest is a full-history pass for nothing. An unknown flag still reads.
      for (const peer of await this.host.catalog()) {
        if (peer.hasChannels === false) continue;
        try {
          logs.push(await this.host.read(peer.id));
        } catch (error) {
          this.host.report(new Error(`skipping unreadable session ${peer.id}: ${error}`));
        }
      }
      this.channels = definitions(logs);
      this.dirty = new Set(this.channels.keys());
    });
  }

  allowed(from: Peer, to: Peer): boolean {
    return this.config.allow.some((rule) => selectorMatches(rule.from, from) && selectorMatches(rule.to, to));
  }

  async requirePair(senderId: string, targetId: string): Promise<{ from: Peer; to: Peer }> {
    const from = await this.host.peer(senderId);
    const to = await this.host.peer(targetId);
    if (!this.allowed(from, to)) throw new Error('Messenger policy denies this sender/recipient pair');
    return { from, to };
  }

  channel(callerId: string, channelId: string): ChannelDefinition {
    const channel = this.channels.get(channelId);
    if (!channel || !channel.participants.includes(callerId)) throw new Error('Channel unavailable to this session');
    return channel;
  }

  async create(callerId: string, targetId: string): Promise<ChannelDefinition> {
    return this.lock(async () => {
      if (callerId === targetId) throw new Error('A channel requires two different sessions');
      await this.requirePair(callerId, targetId);
      const channel: ChannelDefinition = {
        version: 1,
        channelId: randomUUID(),
        participants: [callerId, targetId],
        createdBy: callerId,
        createdAt: new Date().toISOString(),
      };
      await this.host.append(callerId, 'messenger/channel_created', channel);
      this.dirty.add(channel.channelId);
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

  async join(sessionId: string, channel: ChannelDefinition): Promise<void> {
    const log = await this.host.read(sessionId);
    const exists = log.events.some(
      (event) =>
        ['messenger/channel_created', 'messenger/channel_joined'].includes(event.type) &&
        (event.data as { channelId?: string }).channelId === channel.channelId,
    );
    if (!exists) await this.host.append(sessionId, 'messenger/channel_joined', channel);
  }

  /** Record a message id we wrote ourselves so its delivery copy is not new work. */
  private rememberMessage(channelId: string, messageId: string): void {
    const seen = this.known.get(channelId) ?? new Set<string>();
    seen.add(messageId);
    this.known.set(channelId, seen);
  }

  async send(callerId: string, channelId: string, text: string, messageId: string = randomUUID()): Promise<SendResult> {
    const startedAt = Date.now();
    let lockedAt = startedAt;
    const result = await this.lock(async () => {
      lockedAt = Date.now();
      const channel = this.channel(callerId, channelId);
      if (typeof text !== 'string' || !text.trim()) throw new Error('Message text is empty');
      const recipients = channel.participants.filter((id) => id !== callerId);
      for (const id of recipients) await this.requirePair(callerId, id);
      const log = await this.host.read(callerId);
      const existing = log.events.find(
        (event) => event.type === 'messenger/message' && (event.data as MessengerMessage).messageId === messageId,
      );
      if (existing) {
        const record = existing.data as MessengerMessage;
        if (record.channelId !== channelId || record.text !== text || record.senderSessionId !== callerId)
          throw new Error('Message ID reused with different content');
      } else {
        const logs = await Promise.all(channel.participants.map((id) => this.host.read(id)));
        const sequence = 1 + Math.max(0, ...history(channel, logs).map((message) => message.sequence));
        await this.host.append(callerId, 'messenger/message', {
          version: 1,
          channelId,
          messageId,
          senderSessionId: callerId,
          sequence,
          text,
          sentAt: new Date().toISOString(),
        });
        this.rememberMessage(channelId, messageId);
        this.dirty.add(channelId);
      }
      return { channelId, messageId, status: 'queued' as const };
    });
    const finishedAt = Date.now();
    // Persistence of the sender's outbox is the send boundary, not receiver work.
    this.kick();
    // One diagnostic record per send, written off the lock and never fatal:
    // queueWaitMs is the shared messenger chain, workMs is this send's own I/O.
    try {
      void this.host
        .append(callerId, 'messenger/send_timing', {
          version: 1,
          channelId,
          messageId,
          queueWaitMs: lockedAt - startedAt,
          workMs: finishedAt - lockedAt,
        })
        .catch(() => {});
    } catch {
      /* timing is diagnostic only */
    }
    return result;
  }

  kick(): void {
    if (this.disposed) return;
    if (this.draining) {
      this.redrain = true;
      return;
    }
    // Run the sweep off the send chain: queueing it behind `serial` made every
    // send wait for a full-history drain of every channel.
    const run = this.delivery.then(() => this.drain());
    this.delivery = run.catch(() => {});
    this.draining = run
      .catch((error) => {
        this.host.report(error);
      })
      .finally(() => {
        this.draining = undefined;
        if (this.redrain) {
          this.redrain = false;
          this.kick();
        }
      });
  }

  async settle(): Promise<void> {
    do {
      await this.serial;
      await this.delivery;
      await this.draining;
    } while (this.draining || this.redrain);
  }

  async drain(): Promise<void> {
    // Only channels with an unseen message event need a sweep. Any other channel has
    // nothing new since its last confirmed delivery, so reading its logs is waste.
    const pending = [...this.dirty];
    this.dirty.clear();
    for (const channelId of pending) {
      const channel = this.channels.get(channelId);
      if (!channel) continue;
      let complete = true;
      let logs: SessionLog[];
      try {
        logs = await Promise.all(
          channel.participants.map((id) => withTimeout(this.host.read(id), DELIVERY_STEP_TIMEOUT_MS, `reading ${id}`)),
        );
      } catch (error) {
        this.host.report(error);
        this.dirty.add(channelId);
        continue;
      }
      for (const message of history(channel, logs)) {
        for (const id of channel.participants.filter((id) => id !== message.senderSessionId)) {
          const key = `${message.messageId}:${id}`;
          try {
            await withTimeout(this.deliver(message, channel, id), DELIVERY_STEP_TIMEOUT_MS, `delivering to ${id}`);
            this.errors.delete(key);
          } catch (error) {
            complete = false;
            this.errors.set(key, String(error));
            this.host.report(error);
            // A dropped delivery must stay diagnosable: the in-memory error map
            // dies with the process, and logger.warn is not persisted anywhere.
            await this.host
              .append(message.senderSessionId, 'messenger/delivery_failed', {
                version: 1,
                channelId: channel.channelId,
                messageId: message.messageId,
                recipientSessionId: id,
                error: String(error),
                failedAt: new Date().toISOString(),
              })
              .catch(() => {});
          }
        }
      }
      if (!complete) this.dirty.add(channelId);
    }
  }

  async deliver(message: MessengerMessage, channel: ChannelDefinition, id: string): Promise<void> {
    await this.requirePair(message.senderSessionId, id);
    let target = await this.host.read(id);
    if (nativeAccepted(target, message.messageId)) return;
    await this.join(id, channel);
    if (
      !target.events.some(
        (event) =>
          event.type === 'messenger/message' && (event.data as MessengerMessage).messageId === message.messageId,
      )
    ) {
      await this.host.append(id, 'messenger/message', message);
    }
    // Stable native message identity bridges crashes between record, steer,
    // native inbox flush, and receipt. No model response is awaited.
    await this.host.steer(id, message);
    target = await this.host.read(id);
    if (!nativeAccepted(target, message.messageId)) throw new Error('Native inbox did not accept the message');
    await this.host.append(
      id,
      'messenger/message_delivered',
      {
        version: 1,
        channelId: channel.channelId,
        messageId: message.messageId,
        recipientSessionId: id,
        deliveredAt: new Date().toISOString(),
      },
      'bookkeeping',
    );
  }

  async read(callerId: string, channelId: string, query = ''): Promise<ReadMessage[]> {
    const channel = this.channel(callerId, channelId);
    const logs = await Promise.all(channel.participants.map((id) => this.host.read(id)));
    return history(channel, logs)
      .filter((message) => message.text.toLowerCase().includes(query.toLowerCase()))
      .map((message) => ({
        ...message,
        recipients: channel.participants
          .filter((id) => id !== message.senderSessionId)
          .map((id) => ({
            sessionId: id,
            status: status(
              logs.find((log) => log.header.id === id)!,
              message.messageId,
            ),
            ...(this.errors.has(`${message.messageId}:${id}`)
              ? { error: this.errors.get(`${message.messageId}:${id}`) }
              : {}),
          })),
      }));
  }

  async list(callerId: string, query = ''): Promise<ChannelSummary[]> {
    const channels: ChannelSummary[] = [];
    for (const channel of this.channels.values()) {
      if (!channel.participants.includes(callerId)) continue;
      const messages = await this.read(callerId, channel.channelId);
      if (
        query &&
        !messages
          .map((message) => message.text)
          .join('\n')
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        continue;
      channels.push({
        ...structuredClone(channel),
        messageCount: messages.length,
        participants: await Promise.all(channel.participants.map((id) => this.host.peer(id))),
        ...(this.errors.has(channel.channelId) ? { error: this.errors.get(channel.channelId) } : {}),
      });
    }
    return channels;
  }

  async sessions(callerId: string, query = ''): Promise<Peer[]> {
    const caller = await this.host.peer(callerId);
    const supervisor = this.config.supervisors.some((selector) => selectorMatches(selector, caller));
    const ownPeers = new Set([callerId]);
    for (const channel of this.channels.values()) {
      if (channel.participants.includes(callerId)) channel.participants.forEach((id) => ownPeers.add(id));
    }
    const matchingPeers = new Set<string>();
    if (query) {
      for (const channel of await this.list(callerId, query)) {
        channel.participants.forEach((peer) => matchingPeers.add(peer.id));
      }
    }
    return (await this.host.catalog())
      .filter((peer) => peer.id === callerId || (this.allowed(caller, peer) && (supervisor || ownPeers.has(peer.id))))
      .filter(
        (peer) =>
          matchingPeers.has(peer.id) ||
          `${peer.id} ${peer.preset ?? ''} ${peer.title ?? ''}`.toLowerCase().includes(query.toLowerCase()),
      );
  }

  async newSession(callerId: string, preset: string): Promise<ChannelSnapshot> {
    const caller = await this.host.peer(callerId);
    if (!this.allowed(caller, { id: '', preset })) throw new Error('Messenger policy denies this preset');
    const peer = await this.host.create(preset);
    const channel = await this.create(callerId, peer.id);
    return { session: peer, channel };
  }

  async inspect(callerId: string, targetId: string): Promise<SessionLog> {
    const { from, to } = await this.requirePair(callerId, targetId);
    if (!this.config.supervisors.some((selector) => selectorMatches(selector, from)))
      throw new Error('Session inspection requires supervision permission');
    return this.host.inspect ? this.host.inspect(to.id) : this.host.read(to.id);
  }

  async close(): Promise<void> {
    this.disposed = true;
    await this.settle();
  }
}
