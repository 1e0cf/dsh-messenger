export const PREFIX = 'messenger/';

export function definitions(logs) {
  const channels = new Map();
  for (const log of logs) {
    for (const event of log.events) {
      if (!['messenger/channel_created', 'messenger/channel_joined'].includes(event.type)) continue;
      const data = event.data;
      if (data.version !== 1) throw new Error('Unsupported messenger channel version');
      if (typeof data.channelId !== 'string' || !Array.isArray(data.participants)
        || data.participants.length < 2 || new Set(data.participants).size !== data.participants.length
        || !data.participants.every(id => typeof id === 'string' && id.length > 0)
        || !data.participants.includes(data.createdBy) || !Number.isFinite(Date.parse(data.createdAt))) {
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
      channels.set(data.channelId, structuredClone(data));
    }
  }
  return channels;
}

// Only channel events enter this projection. Session tools/thinking never do.
export function history(channel, logs) {
  const messages = new Map();
  for (const log of logs) {
    for (const event of log.events) {
      const data = event.data;
      if (event.type !== 'messenger/message' || data.channelId !== channel.channelId) continue;
      if (data.version !== 1 || typeof data.messageId !== 'string' || typeof data.text !== 'string'
        || !Number.isFinite(Date.parse(data.sentAt)) || !Number.isSafeInteger(data.sequence) || data.sequence < 1) {
        throw new Error('Invalid messenger message');
      }
      if (!channel.participants.includes(data.senderSessionId)) throw new Error('Invalid message sender');
      const old = messages.get(data.messageId);
      if (old && JSON.stringify(old) !== JSON.stringify(data)) throw new Error('Conflicting message copies');
      messages.set(data.messageId, structuredClone(data));
    }
  }
  return [...messages.values()].sort((a, b) => a.sequence - b.sequence || a.messageId.localeCompare(b.messageId));
}

export function nativeAccepted(log, messageId) {
  return log.events.some(event =>
    (event.type === 'agent/inbox/spliced' && event.data.inserted.some(message => message.id === messageId))
    || (event.type === 'user/message' && event.data.id === messageId));
}

export function status(log, messageId) {
  if (log.events.some(event => event.type === 'messenger/message_read' && event.data.messageId === messageId)) return 'read';
  return nativeAccepted(log, messageId) ? 'delivered' : 'queued';
}

export function selectorMatches(selector, peer) {
  const candidates = [`session:${peer.id}`, ...(peer.preset ? [`preset:${peer.preset}`] : [])];
  return candidates.some(value => selector === '*' || (selector.endsWith('*')
    ? value.startsWith(selector.slice(0, -1)) : value === selector));
}
