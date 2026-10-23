export interface PolicyRule {
  from: string;
  to: string;
}

export interface PeerAgentOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface PeerProfile {
  cwd?: string;
  agentOptions?: PeerAgentOptions;
}

export interface MessengerConfig {
  allow: PolicyRule[];
  supervisors: string[];
  peers: Record<string, PeerProfile | undefined>;
  catalogCacheDir?: string;
}

export interface AgentPreset {
  id: string;
  name?: string;
  description?: string;
  broken?: unknown;
}

export interface Peer {
  id: string;
  preset?: string;
  status?: string;
  title?: string;
  lastActivityAt?: string;
  hasChannels?: boolean;
  cwd?: string;
}

export interface SessionHeader {
  id: string;
  createdAt: number;
  agentPreset?: string;
  cwd?: string;
}

export interface SessionLogEvent {
  seq: number;
  time: number;
  type: string;
  data: unknown;
  ignorable?: boolean;
}

export interface SessionLog {
  header: SessionHeader;
  events: SessionLogEvent[];
  lastActivityAt?: string;
}

export interface ChannelDefinition {
  version: 1;
  channelId: string;
  participants: string[];
  createdBy: string;
  createdAt: string;
}

export interface MessengerMessage {
  version: 1;
  channelId: string;
  messageId: string;
  senderSessionId: string;
  sequence: number;
  text: string;
  sentAt: string;
}

export type MessageStatus = 'queued' | 'delivered' | 'read';

export interface MessageRecipient {
  sessionId: string;
  status: MessageStatus;
  error?: string;
}

export interface ReadMessage extends MessengerMessage {
  recipients: MessageRecipient[];
}

export interface SessionInfo {
  session_id: string;
  preset: string;
  status: string;
  title: string;
  last_activity_at: string | null;
}

export interface DiscoveredAgent {
  preset: string;
  agent_preset: string;
  description: string;
  can_create_session: boolean;
  can_open_channel: boolean;
  sessions: SessionInfo[];
}

export interface ChannelParticipantSummary {
  agent_preset: string;
  preset_name: string;
  session_id: string;
  status: string;
  title: string;
  last_activity_at: string | null;
}

export interface ChannelListRow {
  channel_id: string;
  last_activity_at: string;
  agents_participants: ChannelParticipantSummary[];
  error?: string;
}

export interface ChannelSummary {
  version: 1;
  channelId: string;
  createdBy: string;
  createdAt: string;
  messageCount: number;
  participants: Peer[];
  error?: string;
}

export interface NewChannelArgs {
  target_session_id?: string;
  preset?: string;
  title?: string;
}

export interface Host {
  catalog(): Promise<Peer[]>;
  peer(id: string): Promise<Peer>;
  read(id: string): Promise<SessionLog>;
  append(id: string, type: string, data: unknown): Promise<unknown>;
  steer(id: string, message: MessengerMessage): void | Promise<void>;
  report(error: unknown): void;
  create(preset: string, title?: string): Promise<Peer>;
  presets(): Promise<AgentPreset[]>;
  inspect?(id: string): Promise<SessionLog>;
}
