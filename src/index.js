import z from '@deepseek-ai/schemastery';
import { Service } from '@deepseek-ai/cordis';
import { DshHost } from './host.js';
import { Messenger } from './messenger.js';
import { registerTools } from './tools.js';

export const name = 'messenger';
export const inject = ['agents', 'sessions', 'sessionPersistence', 'tools', 'llm'];
export const Config = z.object({
  allow: z.array(z.object({ from: z.string().required(), to: z.string().required() })).default([]),
  supervisors: z.array(z.string()).default([]),
  peers: z.dict(z.object({
    cwd: z.string(),
    agentOptions: z.object({
      provider: z.string().required(), model: z.string().required(), reasoningEffort: z.string(),
    }).required(),
  })).default({}),
});

/** Presets can inject `messenger` to wait for restored channels and registered tools. */
export class MessengerService extends Service {
  constructor(ctx, api) {
    super(ctx, 'messenger');
    this.api = api;
  }
}

export async function apply(ctx, config) {
  await start(ctx, config);
}

/** Programmatic entry point for hosts and integration tests. */
export async function start(ctx, config) {
  const host = new DshHost(ctx, config);
  const messenger = new Messenger(host, config);
  // Startup must fail visibly if any required log cannot be reconstructed.
  await messenger.restore();
  registerTools(ctx, messenger);
  ctx.effect(() => async () => { await messenger.close(); await host.close(); });
  ctx.on('agent/created', () => {
    // Session events cannot be appended reentrantly during their publication.
    queueMicrotask(() => messenger.restore().then(() => messenger.kick()).catch(error => host.report(error)));
  });
  ctx.on('llm/stream', async function* (request, next) {
    let marked = false;
    for await (const chunk of next()) {
      // The first response chunk proves dispatch got past request preparation.
      // Merely claiming the inbox does not mark a message as read.
      if (!marked) {
        marked = true;
        try { await host.markRead(request); }
        catch (error) { host.report(error); }
      }
      yield chunk;
    }
  });
  new MessengerService(ctx, messenger);
  messenger.kick();
  return messenger;
}
