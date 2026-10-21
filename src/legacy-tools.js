// Disabled legacy search/session diagnostics. Not imported by the active plugin.
import { defineTool } from '@deepseek-ai/dsh-tools';
import { selectorMatches } from './projection.js';

const string = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) });
const result = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
};

function caller(exec) {
  if (!exec.agent) throw new Error('Messenger tools require an agent session');
  return exec.agent.id;
}

export function registerLegacyTools(ctx, messenger) {
  const enabled = new WeakSet();
  ctx.tools.register(defineTool({
    name: 'messenger_channels',
    description: 'Work with your own channels. List/search channels, read/search shared messages, or create a channel to an existing allowed peer session. Channel history contains only messages exchanged by its participants, never their private session traces.',
    parameters: {
      action: { ...string('Operation', true), enum: ['list', 'read', 'create'] },
      channel_id: string('Required for read'), target_session_id: string('Required for create'),
      query: string('Search channel messages'),
    },
    output: result,
    async execute(args, exec) {
      const id = caller(exec);
      if (args.action === 'list') return { channels: await messenger.list(id, args.query) };
      if (args.action === 'read') return { messages: await messenger.read(id, args.channel_id, args.query) };
      if (args.action === 'create') return { channel: await messenger.create(id, args.target_session_id) };
      throw new Error('Unknown channel action');
    },
  }));
  ctx.tools.register(defineTool({
    name: 'messenger_send',
    description: 'Send a message to an explicit channel_id. Returns after the outgoing message is stored; does not wait for the recipient or its answer. The recipient is steered at its next step, or woken if idle. Responses must be sent explicitly to a channel; no implicit reply-to-last routing exists.',
    parameters: {
      channel_id: string('Destination channel ID', true), text: string('Message body', true),
      message_id: string('Optional idempotency key. Reuse only for retrying exactly the same message.'),
    },
    output: result,
    async execute(args, exec) {
      return messenger.send(caller(exec), args.channel_id, args.text, args.message_id);
    },
  }));
  ctx.tools.register(defineTool({
    name: 'messenger_tools',
    description: 'Expose session discovery/creation tools for this agent only. Prefer channels for normal communication. Private session inspection is diagnostic and separately restricted to supervisors.',
    parameters: {}, output: result,
    async execute(_args, exec) {
      const id = caller(exec);
      if (!enabled.has(exec.agent)) {
        const peer = await messenger.host.peer(id);
        const supervisor = messenger.config.supervisors.some(selector => selectorMatches(selector, peer));
        exec.agent.ctx.tools.register(sessionTool(messenger, supervisor));
        enabled.add(exec.agent);
      }
      return { tools: ['messenger_sessions'] };
    },
  }));
}

function sessionTool(messenger, supervisor) {
  return defineTool({
    name: 'messenger_sessions',
    description: 'List/search peer sessions from your own channels, or create an independent peer session from a configured preset and open a channel to it. Search uses shared channel messages and metadata. Lists show running/idle/inactive. Session traces are diagnostics, not channel history.'
      + (supervisor ? ' As a supervisor you may inspect an allowed peer session.' : ''),
    parameters: {
      action: { ...string('Operation', true), enum: supervisor ? ['list', 'new', 'inspect'] : ['list', 'new'] },
      query: string('Search session identity/preset and shared channel history'), preset: string('Configured peer preset required for new'),
      session_id: string('Required for inspect'),
    },
    output: result,
    async execute(args, exec) {
      const id = caller(exec);
      if (args.action === 'list') return { sessions: await messenger.sessions(id, args.query) };
      if (args.action === 'new') return messenger.newSession(id, args.preset);
      if (args.action === 'inspect' && supervisor) return { session: await messenger.inspect(id, args.session_id) };
      throw new Error('Unavailable session action');
    },
  });
}
