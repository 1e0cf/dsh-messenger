import type { ChannelDefinition, MessengerMessage, MessageStatus, Peer, SessionLog } from './types.ts';

export const PREFIX = 'messenger/';

interface ChannelEventData {
  version: unknown;
  channelId: unknown;
  participants: unknown;
  createdBy: unknown;
  createdAt: unknown;
}

interface MessageEventData {
  version: unknown;
  channelId: unknown;
  messageId: unknown;
  senderSessionId: unknown;
  sequence: unknown;
  text: unknown;
  sentAt: unknown;
}

interface InboxSplicedData {
  inserted: { id: string }[];
}

interface NativeMessageData {
  id: string;
}

interface MessageReadData {
  messageId: unknown;
}

export function definitions(logs: SessionLog[]): Map<string, ChannelDefinition> {
  const channels = new Map<string, ChannelDefinition>();
  for (const log of logs) {
    for (const event of log.events) {
      if (!['messenger/channel_created', 'messenger/channel_joined'].includes(event.type)) continue;
      const data = event.data as ChannelEventData;
      if (data.version !== 1) throw new Error('Unsupported messenger channel version');
      if (
        typeof data.channelId !== 'string' ||
        !Array.isArray(data.participants) ||
        data.participants.length < 2 ||
        new Set(data.participants).size !== data.participants.length ||
        !data.participants.every((id) => typeof id === 'string' && id.length > 0) ||
        !data.participants.includes(data.createdBy) ||
        !Number.isFinite(Date.parse(data.createdAt as string))
      ) {
        throw new Error('Invalid messenger channel definition');
      }
      if (!data.participants.includes(log.header.id)) continue;
      if (event.type === 'messenger/channel_created' && log.header.id !== data.createdBy) {
        throw new Error('Channel creation attributed to the wrong session');
      }
      const old = channels.get(data.channelId);
      if (old && JSON.stringify(old) !== JSON.stringify(data)) {
        throw new Error(`Conflicting channel definition: ${data.channelId}`);
      }
      channels.set(data.channelId, structuredClone(data) as unknown as ChannelDefinition);
    }
  }
  return channels;
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

// Only channel events enter this projection. Session tools/thinking never do.
export function history(channel: ChannelDefinition, logs: SessionLog[]): MessengerMessage[] {
  const messages = new Map<string, MessengerMessage>();
  for (const log of logs) {
    for (const event of log.events) {
      const data = event.data as MessageEventData;
      if (event.type !== 'messenger/message' || data.channelId !== channel.channelId) continue;
      if (
        data.version !== 1 ||
        typeof data.messageId !== 'string' ||
        typeof data.text !== 'string' ||
        !Number.isFinite(Date.parse(data.sentAt as string)) ||
        !isSafeInteger(data.sequence) ||
        data.sequence < 1
      ) {
        throw new Error('Invalid messenger message');
      }
      if (!channel.participants.includes(data.senderSessionId as string)) throw new Error('Invalid message sender');
      const old = messages.get(data.messageId);
      if (old && JSON.stringify(old) !== JSON.stringify(data)) throw new Error('Conflicting message copies');
      messages.set(data.messageId, structuredClone(data) as unknown as MessengerMessage);
    }
  }
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence || a.messageId.localeCompare(b.messageId));
}

export function nativeAccepted(log: SessionLog, messageId: string): boolean {
  return log.events.some(
    (event) =>
      (event.type === 'agent/inbox/spliced' &&
        (event.data as InboxSplicedData).inserted.some((message) => message.id === messageId)) ||
      (event.type === 'user/message' && (event.data as NativeMessageData).id === messageId),
  );
}

export function status(log: SessionLog, messageId: string): MessageStatus {
  if (
    log.events.some(
      (event) => event.type === 'messenger/message_read' && (event.data as MessageReadData).messageId === messageId,
    )
  )
    return 'read';
  return nativeAccepted(log, messageId) ? 'delivered' : 'queued';
}

export function selectorMatches(selector: string, peer: Pick<Peer, 'id' | 'preset'>): boolean {
  const candidates = [`session:${peer.id}`, ...(peer.preset ? [`preset:${peer.preset}`] : [])];
  return candidates.some(
    (value) =>
      selector === '*' || (selector.endsWith('*') ? value.startsWith(selector.slice(0, -1)) : value === selector),
  );
}
