import { readFile } from 'node:fs/promises';
import { Context } from '@deepseek-ai/cordis';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl';
const ctx = new Context();
try {
  await ctx.plugin(Sessions);
  await ctx.plugin(Jsonl, { root: '/home/nikita/.dsh/sessions', compression: 'zstd' });
  const plan = JSON.parse(await readFile('/tmp/dsh-nix-assistant-rename-report.json', 'utf8'));
  const ids = [...new Set<string>(plan.logs.map((row: { session_id: string }) => row.session_id))];
  for (const id of ids) {
    const handle = await ctx.sessionPersistence.open(SessionId(id), 'read');
    try {
      const log = await handle.read();
      if (handle.header.agentPreset === 'standard') throw new Error('Unmigrated header');
      if (
        log.events.some(
          (event) =>
            event.type === 'agent-preset/selected' &&
            (event.data as { agentPreset?: string }).agentPreset === 'standard',
        )
      )
        throw new Error('Unmigrated selection');
    } finally {
      await handle.close();
    }
  }
  console.log(`PASS: native DSH persistence read ${ids.length} migrated sessions.`);
} finally {
  await ctx.fiber.dispose();
}
