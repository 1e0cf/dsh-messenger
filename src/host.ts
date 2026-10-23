import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, MessengerMessageSource, UserMessage } from '@deepseek-ai/dsh-llm';
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent';
import { appendPluginRecord, pluginRecordOf, Session, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { CatalogCache } from './catalog-cache.ts';
import type { CatalogEntry } from './catalog-cache.ts';
import type { AgentPreset, Host, MessengerConfig, MessengerMessage, Peer, SessionHeader, SessionLog } from './types.ts';

// Messenger state is stored as upstream plugin records: appendPluginRecord writes an
// `ignorable` event in the `plugin:` namespace, which older readers skip and the
// model-visible surface never folds. Records written before the 0.2.1 migration use
// the legacy `messenger/...` vocabulary, so reads normalize both shapes.
const PLUGIN_PREFIX = 'plugin:';
const LEGACY_PREFIX = 'messenger/';
const PLUGIN_LEGACY_PREFIX = `${PLUGIN_PREFIX}${LEGACY_PREFIX}`;
const CATALOG_READ_CONCURRENCY = 8;

interface CachedLog {
  header: SessionHeader;
  count: number;
  revision?: string;
  lastActivityAt: string;
  events: SessionEvent[];
}

interface PeerMeta {
  title?: string;
  lastActivityAt?: string;
  hasChannels?: boolean;
}

interface RequestHeaderData {
  header: { config?: AgentOptions };
}

interface MessageSourceData {
  source?: { kind: string };
}

interface InboxMessage {
  source?: { kind: string };
}

interface InboxSplicedData {
  inserted: InboxMessage[];
}

interface PresetSelectedData {
  agentPreset?: string;
}

interface TitleData {
  title?: string;
}

function legacyType(type: string): string {
  return type.startsWith(PLUGIN_LEGACY_PREFIX) ? type.slice(PLUGIN_PREFIX.length) : type;
}

function legacyEvent(event: SessionEvent): SessionEvent {
  const type = legacyType(event.type);
  return type === event.type ? event : { ...event, type };
}

export class DshHost implements Host {
  ctx: Context;
  config: MessengerConfig;
  owned: Map<string, AgentHandle>;
  loading: Map<string, Promise<Agent>>;
  cache: Map<string, CachedLog>;
  catalogCache: CatalogCache;
  catalogReady: Promise<unknown>;
  catalogPending?: Promise<Peer[]>;

  constructor(ctx: Context, config: MessengerConfig) {
    const probe = Session.create(SessionId(`messenger-patch-probe-${randomUUID()}`));
    const probeSeq = appendPluginRecord(probe, `${PLUGIN_PREFIX}${LEGACY_PREFIX}probe`, {});
    if (pluginRecordOf(probe.snapshotEvents()[probeSeq]) === undefined) {
      throw new Error('dsh-messenger requires the plugin-record Session API');
    }
    this.ctx = ctx;
    this.config = config;
    this.owned = new Map();
    this.loading = new Map();
    this.cache = new Map();
    this.catalogCache = new CatalogCache(config.catalogCacheDir);
    this.catalogReady = this.catalogCache.load().catch((error) => this.report(error));
    ctx.on('session/event', (session, event) => {
      const cached = this.cache.get(session.id);
      if (!cached) return;
      if (event.seq !== cached.count) {
        this.cache.delete(session.id);
        return;
      }
      cached.count++;
      cached.lastActivityAt = new Date(event.time).toISOString();
      const projected = this.project(event);
      if (projected) cached.events.push(projected);
    });
  }

  report(error: unknown): void {
    this.ctx.logger.warn(`dsh-messenger: ${String(error)}`);
  }

  project(event: SessionEvent): SessionEvent | undefined {
    const normalized = legacyEvent(event);
    const type = normalized.type;
    if (type.startsWith(LEGACY_PREFIX) || type === 'agent-preset/selected' || type === 'session/title')
      return normalized;
    if (type === 'request/header')
      return {
        ...normalized,
        data: { header: { config: (normalized.data as RequestHeaderData).header.config } },
      };
    if (type === 'user/message' && (normalized.data as MessageSourceData).source?.kind === 'dsh-messenger')
      return normalized;
    if (type === 'agent/inbox/spliced') {
      return {
        ...normalized,
        data: {
          inserted: (normalized.data as InboxSplicedData).inserted.filter(
            (message) => message.source?.kind === 'dsh-messenger',
          ),
        },
      };
    }
  }

  async read(id: string): Promise<SessionLog> {
    const sessionId = SessionId(id);
    const live = this.ctx.sessions.get(sessionId);
    // A live session is the freshest possible source and the only one that needs no
    // disk: its newest events exist in memory until the persistence writer drains them.
    // Reading storage here forced a durability barrier (flush) plus a corpus-wide stat
    // on every messenger call, so the live path never touches storage at all.
    if (live) return this.readLive(id, live);
    const revision = (await this.ctx.sessionPersistence.stat(sessionId))?.revision;
    const cached = this.cache.get(id);
    if (cached && cached.revision === revision) {
      return this.exportLog(cached);
    }
    const log = await this.inspect(id);
    return this.exportLog(this.rememberLog(id, log.header, log.events, revision));
  }

  /** Serve a live session from memory, projecting only events the cache has not seen. */
  private readLive(id: string, live: Session): SessionLog {
    const cached = this.cache.get(id);
    if (cached && cached.count === live.seq) return this.exportLog(cached);
    if (cached && cached.count < live.seq && cached.header.id === live.header.id) {
      const appended = live
        .snapshotEvents(cached.count)
        .map((event) => this.project(event))
        .filter((event): event is SessionEvent => !!event);
      cached.events.push(...appended);
      cached.count = live.seq;
      if (appended.length) cached.lastActivityAt = new Date(appended.at(-1)!.time).toISOString();
      return this.exportLog(cached);
    }
    return this.exportLog(this.rememberLog(id, live.header, live.snapshotEvents(), cached?.revision));
  }

  /** Store one projected log in the cache and return the entry. */
  private rememberLog(
    id: string,
    header: SessionHeader,
    events: readonly SessionEvent[],
    revision?: string,
  ): CachedLog {
    const entry: CachedLog = {
      header,
      count: events.length,
      revision,
      lastActivityAt: new Date(events.at(-1)?.time ?? header.createdAt).toISOString(),
      events: events.map((event) => this.project(event)).filter((event): event is SessionEvent => !!event),
    };
    this.cache.set(id, entry);
    return entry;
  }

  /** Hand out a detached list so callers cannot mutate the cache. */
  private exportLog(entry: CachedLog): SessionLog {
    return { header: entry.header, events: [...entry.events], lastActivityAt: entry.lastActivityAt };
  }

  async inspect(id: string): Promise<SessionLog> {
    const sessionId = SessionId(id);
    const live = this.ctx.sessions.get(sessionId);
    if (live) {
      const flushed = await this.ctx.sessions.flush(live);
      if (!flushed) throw new Error(`Session ${id} has no persistence writer`);
    }
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read');
    try {
      const result = await handle.read();
      return { header: handle.header, events: result.events.map(legacyEvent) };
    } finally {
      await handle.close();
    }
  }

  recordedPreset(log: SessionLog): string | undefined {
    const selected = [...log.events].reverse().find((event) => event.type === 'agent-preset/selected');
    return (selected?.data as PresetSelectedData | undefined)?.agentPreset ?? log.header.agentPreset;
  }

  describe(header: SessionHeader, recordedPreset: string | undefined, meta: PeerMeta | undefined): Peer {
    const agent = this.ctx.agents.get(header.id);
    const presets = this.ctx.get('agentPresets');
    const preset = (agent && presets?.composedPreset(agent.ctx)) || recordedPreset || header.agentPreset;
    return {
      id: header.id,
      ...(preset ? { preset } : {}),
      status: agent?.status ?? 'inactive',
      title: meta?.title ?? '',
      lastActivityAt: meta?.lastActivityAt ?? new Date(header.createdAt).toISOString(),
      hasChannels: meta?.hasChannels === true,
      ...(header.cwd ? { cwd: header.cwd } : {}),
    };
  }

  /** Catalog metadata derived from one parsed log. */
  metaOf(log: SessionLog): { title: string; lastActivityAt: string | undefined; hasChannels: boolean } {
    return {
      title:
        (log.events.findLast((event) => event.type === 'session/title')?.data as TitleData | undefined)?.title ?? '',
      lastActivityAt: log.lastActivityAt,
      hasChannels: log.events.some(
        (event) => event.type === 'messenger/channel_created' || event.type === 'messenger/channel_joined',
      ),
    };
  }

  async catalog(): Promise<Peer[]> {
    // Discovery, channel listing and restore ask for the catalog concurrently;
    // one build serves them all instead of parsing the same logs twice.
    this.catalogPending ??= this.buildCatalog().finally(() => {
      this.catalogPending = undefined;
    });
    return this.catalogPending;
  }

  async buildCatalog(): Promise<Peer[]> {
    await this.catalogReady;
    const rows = new Map((await this.ctx.sessionPersistence.list()).map((row) => [row.header.id, row] as const));
    for (const session of this.ctx.sessions.list()) rows.set(session.id, { header: session.header });
    // A stored log keeps one revision until its bytes change, and the catalog
    // only needs a few fields from it. Reuse the cached fields for untouched
    // sessions instead of parsing every log on every discovery call.
    const entries = [...rows.values()];
    const peers = new Array<Peer>(entries.length);
    let cursor = 0;
    // Reads are bounded: parsing every log at once saturates the box on the
    // first catalog after a restart.
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const index = cursor++;
        peers[index] = await this.describeStored(entries[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CATALOG_READ_CONCURRENCY, entries.length) }, worker));
    void this.catalogCache.flush();
    return peers;
  }

  async describeStored(row: { header: SessionHeader; sizeBytes?: number }): Promise<Peer> {
    const header = row.header;
    const cached = row.sizeBytes === undefined ? undefined : this.catalogCache.get(header.id);
    if (cached !== undefined && cached.size === row.sizeBytes) return this.describe(header, cached.preset, cached);
    try {
      const log = await this.read(header.id);
      // Cache the size that exists after the read: reading may migrate an
      // older log and rewrite it, so the pre-read size may already be stale.
      const size = (await this.ctx.sessionPersistence.stat(SessionId(header.id)))?.sizeBytes ?? row.sizeBytes;
      const meta: CatalogEntry = { size, preset: this.recordedPreset(log) ?? '', ...this.metaOf(log) };
      if (size !== undefined) this.catalogCache.set(header.id, meta);
      return this.describe(header, meta.preset, meta);
    } catch (error) {
      this.report(new Error(`unreadable session ${header.id}: ${error}`));
      return this.describe(header, header.agentPreset, undefined);
    }
  }

  async peer(id: string): Promise<Peer> {
    const log = await this.read(id);
    return this.describe(log.header, this.recordedPreset(log), this.metaOf(log));
  }

  async presets(): Promise<AgentPreset[]> {
    const presets = this.ctx.get('agentPresets');
    return presets ? presets.list() : [];
  }

  async mount(agentCtx: Context, preset: string | undefined): Promise<void> {
    if (!preset) return;
    const presets = this.ctx.get('agentPresets');
    if (!presets) throw new Error(`Cannot compose preset ${preset}: agentPresets service absent`);
    await presets.mount(agentCtx, preset);
  }

  async ensure(id: string): Promise<Agent> {
    const live = this.ctx.agents.get(SessionId(id));
    if (live) return live;
    if (this.loading.has(id)) return this.loading.get(id)!;
    const task = (async () => {
      const log = await this.read(id);
      const preset = this.recordedPreset(log);
      const profile = this.config.peers[preset as string];
      // Resume must retain identity and composition, rather than accidentally
      // launching a blank/default-prompt agent. Require an explicit peer profile.
      if (!profile) throw new Error(`No resume profile configured for preset ${preset ?? '(none)'}`);
      const latest = [...log.events].reverse().find((event) => event.type === 'request/header');
      // The peer profile owns the model route: a config change in
      // cordis.patch.yml must reach sessions that are already open, otherwise
      // they stay pinned to a route recorded months ago. Fall back to the
      // recorded route only for a peer with no agentOptions of its own.
      const route = profile.agentOptions ?? (latest?.data as RequestHeaderData | undefined)?.header.config;
      const handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(id),
        agentOptions: route,
        setup: (agentCtx) => this.mount(agentCtx, preset),
      });
      this.owned.set(id, handle);
      return handle.agent;
    })();
    this.loading.set(id, task);
    try {
      return await task;
    } finally {
      this.loading.delete(id);
    }
  }

  async create(preset: string, title?: string): Promise<Peer> {
    const profile = this.config.peers[preset];
    if (!profile) throw new Error(`Peer preset is not configured: ${preset}`);
    const titles = title === undefined ? undefined : this.ctx.get('sessionTitle');
    if (title !== undefined && !titles) throw new Error('Session title service is required to name a new peer session');
    const id = SessionId(randomUUID());
    const handle = await this.ctx.agents.create({
      sessionId: id,
      agentOptions: profile.agentOptions,
      meta: { agentPreset: preset, ...(profile.cwd ? { cwd: profile.cwd } : {}) },
      // No parentAgent: this is an independent root, not a subagent.
      setup: (agentCtx) => this.mount(agentCtx, preset),
    });
    this.owned.set(id, handle);
    if (title !== undefined) {
      titles!.rename(handle.agent.session, title);
      if (!(await this.ctx.sessions.flush(handle.agent.session)))
        throw new Error('Session title requires a persistence writer');
    }
    return this.peer(id);
  }

  async append(id: string, type: string, data: unknown): Promise<unknown> {
    const agent = await this.ensure(id);
    const recordType = type.startsWith(PLUGIN_PREFIX) ? type : `${PLUGIN_PREFIX}${type}`;
    const seq = appendPluginRecord(agent.session, recordType, data);
    const record = pluginRecordOf(agent.session.snapshotEvents()[seq]);
    if (record === undefined) throw new Error('dsh-messenger requires the plugin-record Session API');
    const flushed = await this.ctx.sessions.flush(agent.session);
    if (!flushed) throw new Error('Messenger events require a persistence writer');
    return { ...record, type: legacyType(record.type) };
  }

  async steer(id: string, message: MessengerMessage): Promise<void> {
    const agent = await this.ensure(id);
    const native = createUserMessage({
      content: [
        {
          type: 'text',
          text: `[Channel ${message.channelId}; from ${message.senderSessionId}; ${message.sentAt}]\n${message.text}`,
        },
      ],
      source: {
        kind: 'dsh-messenger',
        channelId: message.channelId,
        messageId: message.messageId,
        senderSessionId: message.senderSessionId,
        sentAt: message.sentAt,
      },
    });
    // Keep native identity stable across retry/restart; the native source and
    // content are created through the standard user-message constructor.
    agent.steer(Object.freeze({ ...native, id: message.messageId }));
    await this.ctx.sessions.flush(agent.session);
  }

  async markRead(request: GenerateOptions): Promise<void> {
    if (!request.sessionId) return;
    const inputs: UserMessage[] = request.messages.filter((message) => message.source?.kind === 'dsh-messenger');
    if (!inputs.length) return;
    const log = await this.read(request.sessionId);
    for (const message of inputs) {
      const source = message.source as MessengerMessageSource;
      if (
        log.events.some(
          (event) =>
            event.type === 'messenger/message_read' &&
            (event.data as { messageId?: string }).messageId === source.messageId,
        )
      )
        continue;
      await this.append(request.sessionId, 'messenger/message_read', {
        version: 1,
        channelId: source.channelId,
        messageId: source.messageId,
        recipientSessionId: request.sessionId,
        readAt: new Date().toISOString(),
      });
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.loading.values());
    for (const handle of this.owned.values()) await handle.dispose();
    this.owned.clear();
    this.cache.clear();
    await this.catalogCache.flush();
  }
}
