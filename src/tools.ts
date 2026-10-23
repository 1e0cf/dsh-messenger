import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ParameterSchemaSpec, ToolRunContext } from '@deepseek-ai/dsh-tools';
import { discoverAgents, listChannels, newChannel } from './discovery.ts';
import type { Messenger } from './messenger.ts';
import type { NewChannelArgs } from './types.ts';

function string(description: string): { type: 'string'; description: string };
function string(description: string, required: true): { type: 'string'; description: string; required: true };
function string(description: string, required = false): { type: 'string'; description: string; required?: boolean } {
  return { type: 'string', description, ...(required ? { required: true } : {}) };
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown): { type: 'text'; text: string }[] => [
    { type: 'text', text: JSON.stringify(value, null, 2) },
  ],
};

function caller(exec: ToolRunContext): string {
  if (!exec.agent) throw new Error('Messenger tools require an agent session');
  return exec.agent.id;
}

interface ToolSpec {
  name: string;
  description: string;
  parameters: ParameterSchemaSpec;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}

export function registerTools(ctx: Context, messenger: Messenger): void {
  const definitions: ToolSpec[] = [
    {
      name: 'messenger_discover_agents',
      description:
        'Discover agents you may communicate with. can_create_session permits creating a new independent session and channel using preset; can_open_channel permits connecting a channel to an existing allowed session using target_session_id. These are different permissions. Each row has preset name, agent_preset ID, description and up to five recent permitted sessions with status, title and ISO activity. Metadata only, not private history. Use exact preset names for creation.',
      parameters: {},
      execute: async (_args, exec) => ({ agents: await discoverAgents(messenger, caller(exec)) }),
    },
    {
      name: 'messenger_channels_new',
      description:
        'Specify exactly one of target_session_id or preset. target_session_id opens only a channel to an existing allowed session; it creates no session and does not rename it. preset creates a new independent session plus a channel, requiring can_create_session from discovery. Use the exact preset name from discovery. Channels have no title; optional title names only a newly created session.',
      parameters: {
        target_session_id: string('Existing recipient session ID'),
        preset: string('Preset name for a new independent session'),
        title: string(
          'Optional title for the newly created session; only with preset. Channels have no title. Omit with target_session_id.',
        ),
      },
      execute: async (args: NewChannelArgs, exec) => newChannel(messenger, caller(exec), args),
    },
    {
      name: 'messenger_channels_list',
      description:
        'List only channels belonging to your current session. Each has channel_id, ISO last_activity_at, and agents_participants for every member including you: agent_preset ID, preset_name, session_id, session title, running/idle/inactive status and ISO activity. Channels have no title. Does not expose private session transcripts.',
      parameters: {},
      execute: async (_args, exec) => ({ channels: await listChannels(messenger, caller(exec)) }),
    },
    {
      name: 'messenger_channel_read',
      description:
        'Read messages exchanged in an explicit channel you belong to, including sender, ISO datetime and delivery/read status. Never returns private thinking, tool calls or conversations outside this channel.',
      parameters: { channel_id: string('Channel ID', true) },
      execute: async (args: { channel_id: string }, exec) => ({
        messages: await messenger.read(caller(exec), args.channel_id),
      }),
    },
    {
      name: 'messenger_send_message',
      description:
        'Send text to an explicit channel_id. Generates and returns message_id after storing the outgoing message. Delivery steers the recipient asynchronously; does not wait for its response. Replies must also be sent explicitly to a channel.',
      parameters: { channel_id: string('Destination channel ID', true), text: string('Message body', true) },
      execute: async (args: { channel_id: string; text: string }, exec) => {
        const sent = await messenger.send(caller(exec), args.channel_id, args.text);
        return { channel_id: sent.channelId, message_id: sent.messageId, status: sent.status };
      },
    },
  ];
  for (const definition of definitions) ctx.tools.register(defineTool({ ...definition, output }));
  // Search and session diagnostics remain in legacy-tools.ts and the core,
  // but are deliberately not registered, including for supervisors.
}
