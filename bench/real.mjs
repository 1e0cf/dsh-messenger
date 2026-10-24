// Real wall-clock benchmark: the plugin against the actual JSONL persistence over a
// copy of the sessions corpus. Server-only (needs the DSH runtime on disk).
//
//   BENCH_SRC=$PWD/src node bench/real.mjs /tmp/sessions-bench
//   BENCH_SRC=$PWD/src BENCH_TS=1 bun bench/real.mjs /tmp/sessions-bench
//
// Every number is milliseconds measured on this machine; the corpus copy is read-only
// for the plugin (persistence may migrate logs, hence a copy, never ~/.dsh).

const SRC = process.env.BENCH_SRC;
const ROOT = process.argv[2];
if (!SRC || !ROOT) throw new Error('usage: BENCH_SRC=<src dir> node bench/real.mjs <sessions copy>');

const suffix = process.env.BENCH_TS === '1' ? 'ts' : 'js';
const { DshHost } = await import(`${SRC}/host.${suffix}`);
const { Messenger } = await import(`${SRC}/messenger.${suffix}`);
const { Session, SessionId, appendPluginRecord } = await import('@deepseek-ai/dsh-session');
const { Context } = await import('@deepseek-ai/cordis');
const Jsonl = await import('@deepseek-ai/dsh-session-persistence-jsonl');

const ctx = new Context();
await ctx.plugin({ name: Jsonl.name, apply: Jsonl.apply, Config: Jsonl.Config }, { root: ROOT, compression: 'zstd' });
const persistence = ctx.sessionPersistence;

const timings = {};
function time(name, ms) {
  timings[name] = Math.round(ms * 10) / 10;
}

const rows = await persistence.list();
const ids = rows.map((row) => String(row.header.id));

// 1. The hot primitive on its own: one stat = one lookup of a session log.
{
  const runs = 3;
  const started = performance.now();
  let count = 0;
  for (let run = 0; run < runs; run++) {
    for (const id of ids.slice(0, 40)) {
      await persistence.stat(SessionId(id));
      count++;
    }
  }
  time('stat x120 (ms)', performance.now() - started);
  time('stat single (ms)', (performance.now() - started) / count);
}

// 2. Cold start of the real plugin: restore() reads every stored channel.
const world = () => {
  const live = new Map([[String(ids[0]), seedLive(String(ids[0]))]]);
  const agent = {
    id: String(ids[0]),
    session: live.get(String(ids[0])),
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    steer: () => {},
    cancel: () => {},
    whenIdle: async () => {},
  };
  const ctx2 = {
    sessions: {
      get: (id) => live.get(String(id)),
      flush: async () => true,
      list: () => [...live.values()],
    },
    sessionPersistence: persistence,
    agents: {
      get: () => undefined,
      resume: async () => ({ agent, dispose: async () => {} }),
      create: async () => ({ agent, dispose: async () => {} }),
    },
    get: () => ({ list: () => [], composedPreset: () => undefined }),
    on: () => {},
    effect: () => {},
    logger: { warn: () => {}, info: () => {} },
  };
  return { ctx: ctx2, live, agent };
};

function seedLive(id) {
  const session = Session.create(SessionId(id));
  appendPluginRecord(session, 'plugin:bench/filler', { index: 0 });
  return session;
}

const anyProfile = new Proxy({}, { get: () => ({ agentOptions: { provider: 'bench', model: 'bench' } }) });
const config = { peers: anyProfile, allow: [{ from: '*', to: '*' }], supervisors: ['*'] };

{
  const { ctx: hostCtx } = world();
  const started = performance.now();
  const host = new DshHost(hostCtx, config);
  const messenger = new Messenger(host, config);
  await messenger.restore();
  time('cold restore (ms)', performance.now() - started);
  await messenger.close();

  // 3. A live agent step: the read every messenger call performs on its own session.
  const startedRead = performance.now();
  for (let i = 0; i < 200; i++) await host.read(String(ids[0]));
  time('read live x200 (ms)', performance.now() - startedRead);

  // 4. Discovery: two catalog builds.
  const startedCatalog = performance.now();
  await host.catalog();
  await host.catalog();
  time('catalog x2 (ms)', performance.now() - startedCatalog);

  // 5. Cold read of one stored session (the path a delivery takes to an idle peer).
  const coldId = ids.find((id) => id !== String(ids[0]));
  const startedCold = performance.now();
  for (let i = 0; i < 20; i++) await host.read(String(coldId));
  time('read cold x20 (ms)', performance.now() - startedCold);

  await host.close();
  await messenger.close();
}

console.log(JSON.stringify({ source: SRC, format: suffix, sessions: ids.length, timings }, null, 2));
process.exit(0);
