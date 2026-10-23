import type { Messenger } from './messenger.ts';
import type {
  AgentPreset,
  ChannelListRow,
  ChannelParticipantSummary,
  DiscoveredAgent,
  NewChannelArgs,
  Peer,
  SessionInfo,
} from './types.ts';

function presetName(preset: Pick<AgentPreset, 'id' | 'name'>): string {
  return preset.name || preset.id;
}

export function sessionInfo(peer: Peer, presets: AgentPreset[]): SessionInfo {
  return {
    session_id: peer.id,
    preset: presetName(presets.find((preset) => preset.id === peer.preset) || { id: peer.preset ?? '' }),
    status: peer.status ?? 'inactive',
    title: peer.title ?? '',
    last_activity_at: peer.lastActivityAt ?? null,
  };
}

export async function availablePresets(messenger: Messenger, callerId: string): Promise<AgentPreset[]> {
  const caller = await messenger.host.peer(callerId);
  return (await messenger.host.presets()).filter(
    (preset) =>
      !preset.broken && messenger.config.peers[preset.id] && messenger.allowed(caller, { id: '', preset: preset.id }),
  );
}

export async function discoverAgents(messenger: Messenger, callerId: string): Promise<DiscoveredAgent[]> {
  const caller = await messenger.host.peer(callerId);
  const presets = await messenger.host.presets();
  const peers = await messenger.host.catalog();
  return presets
    .map((preset) => {
      const permitted = peers.filter(
        (peer) => peer.id !== callerId && peer.preset === preset.id && messenger.allowed(caller, peer),
      );
      const allowedPreset = messenger.allowed(caller, { id: '', preset: preset.id });
      return {
        preset: presetName(preset),
        agent_preset: preset.id,
        description: preset.description ?? '',
        can_create_session: Boolean(!preset.broken && messenger.config.peers[preset.id] && allowedPreset),
        can_open_channel: permitted.length > 0 || allowedPreset,
        sessions: permitted
          .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.id.localeCompare(b.id))
          .slice(0, 5)
          .map((peer) => sessionInfo(peer, presets)),
      };
    })
    .filter((row) => row.can_open_channel || row.can_create_session);
}

export async function newChannel(
  messenger: Messenger,
  callerId: string,
  args: NewChannelArgs,
): Promise<{ channel_id: string; session: SessionInfo }> {
  if (Boolean(args.target_session_id) === Boolean(args.preset)) {
    throw new Error('Specify exactly one of target_session_id or preset');
  }
  let peer: Peer;
  if (args.preset) {
    if (args.title !== undefined && !args.title.trim())
      throw new Error('Session title must contain visible characters');
    const matches = (await availablePresets(messenger, callerId)).filter(
      (preset) => presetName(preset) === args.preset,
    );
    if (matches.length !== 1) throw new Error('Preset name unavailable or ambiguous; use messenger_discover_agents');
    peer = await messenger.host.create(matches[0].id, args.title);
  } else {
    if (args.title !== undefined)
      throw new Error('title applies only to a newly created session; omit it with target_session_id');
    await messenger.requirePair(callerId, args.target_session_id!);
    peer = await messenger.host.peer(args.target_session_id!);
  }
  const channel = await messenger.create(callerId, peer.id);
  return { channel_id: channel.channelId, session: sessionInfo(peer, await messenger.host.presets()) };
}

export async function listChannels(messenger: Messenger, callerId: string): Promise<ChannelListRow[]> {
  const presets = await messenger.host.presets();
  const channels: ChannelListRow[] = [];
  for (const channel of messenger.channels.values()) {
    if (!channel.participants.includes(callerId)) continue;
    const messages = await messenger.read(callerId, channel.channelId);
    const peers = await Promise.all(channel.participants.map((id) => messenger.host.peer(id)));
    channels.push({
      channel_id: channel.channelId,
      last_activity_at: messages.at(-1)?.sentAt ?? channel.createdAt,
      agents_participants: peers.map((peer): ChannelParticipantSummary => {
        const { preset, ...session } = sessionInfo(peer, presets);
        return { agent_preset: peer.preset ?? '', preset_name: preset, ...session };
      }),
      ...(messenger.errors.has(channel.channelId) ? { error: messenger.errors.get(channel.channelId) } : {}),
    });
  }
  return channels.sort(
    (a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || a.channel_id.localeCompare(b.channel_id),
  );
}
