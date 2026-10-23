import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const VERSION = 1;

export interface CatalogEntry {
  size?: number;
  preset?: string;
  title?: string;
  lastActivityAt?: string;
  hasChannels?: boolean;
}

function dshHome(): string {
  const configured = process.env.DSH_HOME || join(homedir(), '.dsh');
  if (configured === '~') return homedir();
  if (configured.startsWith('~/')) return join(homedir(), configured.slice(2));
  return resolve(configured);
}

/**
 * Durable per-session catalog metadata: title, recorded preset, last activity
 * and whether the log carries messenger channels.
 *
 * The catalog is derived from session logs, and a log may be megabytes. Session
 * logs only ever grow, so the stored byte size identifies a log version: cached
 * metadata stays valid while the size is unchanged and only touched logs are
 * parsed again. The persistence revision cannot be used here because for logs
 * in an older on-disk format it folds in a whole-corpus hash that changes on
 * every restart, invalidating every entry at once.
 */
export class CatalogCache {
  directory: string;
  entries: Map<string, CatalogEntry>;
  dirty: boolean;
  writing: Promise<void>;

  constructor(directory?: string) {
    this.directory = directory ?? join(dshHome(), 'messenger-catalog');
    this.entries = new Map();
    this.dirty = false;
    this.writing = Promise.resolve();
  }

  async load(): Promise<Map<string, CatalogEntry>> {
    try {
      const data = JSON.parse(await readFile(join(this.directory, 'catalog.json'), 'utf8')) as {
        version?: unknown;
        sessions?: Record<string, CatalogEntry> | null;
      };
      if (data.version !== VERSION || typeof data.sessions !== 'object' || data.sessions === null) return this.entries;
      for (const [id, entry] of Object.entries(data.sessions)) {
        if (typeof entry?.size !== 'number' || typeof entry.title !== 'string') continue;
        this.entries.set(id, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this.entries;
  }

  get(id: string): CatalogEntry | undefined {
    return this.entries.get(id);
  }

  set(id: string, entry: CatalogEntry): void {
    this.entries.set(id, entry);
    this.dirty = true;
  }

  /** Persist only when something changed; concurrent callers share one write. */
  flush(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.dirty = false;
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        const snapshot = JSON.stringify({ version: VERSION, sessions: Object.fromEntries(this.entries) });
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const target = join(this.directory, 'catalog.json');
        const temp = `${target}.${randomUUID()}.tmp`;
        await writeFile(temp, snapshot, { mode: 0o600 });
        await rename(temp, target);
      })
      .catch(() => {});
    return this.writing;
  }
}
