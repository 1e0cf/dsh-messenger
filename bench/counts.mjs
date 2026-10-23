// Call-count benchmark for the messenger/host hot paths.
//
// Timing on a fake storage is meaningless, but the NUMBER of storage round-trips per
// operation is not: each `stat` is a full scan of the sessions corpus, each `flush`
// a disk write, each `open/read` a decompress of the whole log. Those counts are what
// this script measures, so a stage can be compared against the previous one.
//
// It needs a real DSH runtime on disk (the server, not a dev laptop):
//   BENCH_SRC=/home/nikita/Projects/dsh-messenger/src node bench/counts.mjs
// or against a TypeScript checkout:
//   BENCH_SRC=/tmp/dsh-messenger/src BENCH_TS=1 bun bench/counts.mjs

const SRC = process.env.BENCH_SRC;
if (!SRC) throw new Error('BENCH_SRC must point at a src/ directory');

const suffix = process.env.BENCH_TS === '1' ? 'ts' : 'js';
const { DshHost } = await import(`${SRC}/host.${suffix}`);
const { Messenger } = await import(`${SRC}/messenger.${suffix}`);
const { Session, SessionId, appendPluginRecord } = await import('@deepseek-ai/dsh-session');

const CHANNEL = 'channel-live';
const A = 'session-a';
const B = 'session-b';

const channelData = (participants, channelId = CHANNEL) => ({
  version: 1,
  channelId,
  participants,
  createdBy: participants[0],
  createdAt: '2026-01-01T00:00:00.000Z',
});

const messageData = (index, senderSessionId = A, channelId = CHANNEL) => ({
  version: 1,
  channelId,
  messageId: `m${index}`,
  senderSessionId,
  sequence: index + 1,
  text: `message ${index}`,
  sentAt: '2026-01-01T00:00:00.000Z',
});

/** Build a real Session carrying messenger + filler history. */
function buildSession(id, { channelId, partner, messages = 0, filler = 0, createdBySelf = true }) {
  const session = Session.create(SessionId(id));
  if (channelId) {
    const participants = createdBySelf ? [id, partner] : [partner, id];
    const data = channelData(participants, channelId);
    if (createdBySelf) appendPluginRecord(session, 'plugin:messenger/channel_created', data);
    appendPluginRecord(session, 'plugin:messenger/channel_joined', data);
  }
  for (let i = 0; i < messages; i++) appendPluginRecord(session, 'plugin:messenger/message', messageData(i));
  for (let i = 0; i < filler; i++) appendPluginRecord(session, 'plugin:bench/filler', { index: i });
  return session;
}

function makeWorld({ coldSessions = 115, withChannels = 40, liveFiller = 1200, messages = 20 } = {}) {
  const counts = { stat: 0, open: 0, readHandle: 0, flush: 0, list: 0, resume: 0, steer: 0, get: 0 };
  const sessions = new Map();
  const live = new Map();

  // Two messenger participants: A is live, B is stored and idle.
  sessions.set(A, buildSession(A, { channelId: CHANNEL, partner: B, messages, filler: liveFiller }));
  sessions.set(B, buildSession(B, { channelId: CHANNEL, partner: A, createdBySelf: false }));
  live.set(A, sessions.get(A));

  // Background corpus: the rest of the machine's sessions.
  for (let i = 0; i < coldSessions; i++) {
    const id = `cold-${i}`;
    sessions.set(
      id,
      i < withChannels
        ? buildSession(id, { channelId: `cold-channel-${i}`, partner: `${id}-peer`, filler: 200 })
        : buildSession(id, { filler: 50 }),
    );
  }

  const agents = new Map();
  const agentFor = (id) => {
    if (!agents.has(id)) {
      agents.set(id, {
        id,
        session: sessions.get(id),
        status: 'idle',
        inbox: { nextTurn: [], nextStep: [] },
        steer: () => {
          counts.steer += 1;
        },
        cancel: () => {},
        whenIdle: async () => {},
      });
    }
    return agents.get(id);
  };

  const ctx = {
    sessions: {
      get: (id) => {
        counts.get += 1;
        return live.get(String(id));
      },
      flush: async () => {
        counts.flush += 1;
        return true;
      },
      list: () => [...live.values()],
    },
    sessionPersistence: {
      stat: async (id) => {
        counts.stat += 1;
        const session = sessions.get(String(id));
        if (!session) return undefined;
        return { header: session.header, revision: `rev-${String(id)}`, sizeBytes: session.snapshotEvents().length };
      },
      list: async () => {
        counts.list += 1;
        return [...sessions].map(([id, session]) => ({
          header: session.header,
          sizeBytes: session.snapshotEvents().length,
        }));
      },
      open: async (id) => {
        counts.open += 1;
        const session = sessions.get(String(id));
        if (!session) throw new Error(`no such session ${String(id)}`);
        return {
          header: session.header,
          read: async () => {
            counts.readHandle += 1;
            return { events: session.snapshotEvents() };
          },
          close: async () => {},
        };
      },
    },
    agents: {
      get: (id) => (live.has(String(id)) ? agentFor(String(id)) : undefined),
      resume: async (options) => {
        counts.resume += 1;
        const id = String(options?.resumeSessionId ?? A);
        return { agent: agentFor(id), dispose: async () => {} };
      },
      create: async (options) => {
        counts.resume += 1;
        return { agent: agentFor(String(options?.sessionId ?? A)), dispose: async () => {} };
      },
    },
    get: () => ({ list: () => [], composedPreset: () => undefined }),
    on: () => {},
    effect: () => {},
    logger: { warn: () => {}, info: () => {} },
  };

  return { ctx, counts };
}

const scenarios = {};

function reset(counts) {
  for (const key of Object.keys(counts)) counts[key] = 0;
}

function record(name, counts, ms) {
  const values = Object.fromEntries(Object.entries(counts).filter(([, value]) => value > 0));
  scenarios[name] = { ...values, ms };
}

const anyProfile = new Proxy({}, { get: () => ({ agentOptions: { provider: 'bench', model: 'bench' } }) });
const benchConfig = { peers: anyProfile, allow: [{ from: '*', to: '*' }], supervisors: ['*'] };

async function withWorld(options, run) {
  const world = makeWorld(options);
  const host = new DshHost(world.ctx, benchConfig);
  const messenger = new Messenger(host, benchConfig);
  try {
    await run({ host, messenger, counts: world.counts });
  } finally {
    await messenger.close().catch(() => {});
    await host.close().catch(() => {});
  }
}

// 1. Cold start: restore() rebuilds every channel from stored logs.
await withWorld({}, async ({ host, messenger, counts }) => {
  const started = Date.now();
  await messenger.restore();
  record('cold-restore', counts, Date.now() - started);
  await host.close();
});

// 2. Discovery: two catalog builds in a row (a tool call plus a peer listing).
await withWorld({}, async ({ host, messenger, counts }) => {
  await messenger.restore();
  reset(counts);
  const started = Date.now();
  await host.catalog();
  await host.catalog();
  record('catalog-x2', counts, Date.now() - started);
  await host.close();
});

// 3. One live agent step: mark the incoming message read, then read the channel.
await withWorld({}, async ({ host, messenger, counts }) => {
  await messenger.restore();
  reset(counts);
  const started = Date.now();
  await host.markRead({
    sessionId: A,
    messages: [
      {
        role: 'user',
        source: { kind: 'dsh-messenger', channelId: CHANNEL, messageId: 'm0', senderSessionId: B },
      },
    ],
  });
  record('live-markRead', counts, Date.now() - started);
  reset(counts);
  const readStarted = Date.now();
  await messenger.read(A, CHANNEL);
  record('live-channel-read', counts, Date.now() - readStarted);
  await host.close();
});

// 4. Send one message into a two-member channel, then drain the delivery sweep.
await withWorld({ messages: 1 }, async ({ host, messenger, counts }) => {
  await messenger.restore();
  reset(counts);
  const started = Date.now();
  await messenger.send(A, CHANNEL, 'hello');
  await messenger.settle();
  record('send+drain', counts, Date.now() - started);
  await host.close();
});

console.log(JSON.stringify({ source: SRC, format: suffix, scenarios }, null, 2));
