declare module '@deepseek-ai/dsh-session' {
  export type SessionId = string;
  export declare function SessionId(id: string): SessionId;
  export type SessionSeq = number;

  export interface SessionEvent {
    seq: number;
    time: number;
    type: string;
    data: unknown;
    ignorable?: boolean;
  }

  export interface SessionHeader {
    id: SessionId;
    createdAt: number;
    agentPreset?: string;
    cwd?: string;
  }

  export interface PluginRecord {
    type: string;
    seq: SessionSeq;
    time: number;
    data: unknown;
  }

  export declare class Session {
    static create(id?: SessionId): Session;
    readonly id: SessionId;
    readonly header: SessionHeader;
    readonly seq: number;
    snapshotEvents(): readonly SessionEvent[];
  }

  export declare function appendPluginRecord(session: Session, type: string, data: unknown): SessionSeq;
  export declare function pluginRecordOf(event: SessionEvent): PluginRecord | undefined;

  export declare class SessionStore {
    get(id: SessionId): Session | undefined;
    flush(session: Session): Promise<boolean>;
    list(): Session[];
  }

  export default SessionStore;
}

declare module '@deepseek-ai/dsh-session-persistence' {
  import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';

  export interface SessionPersistenceSnapshot {
    header: SessionHeader;
    revision?: string;
    sizeBytes?: number;
  }

  export interface SessionPersistenceHandle {
    header: SessionHeader;
    read(): Promise<{ events: SessionEvent[] }>;
    close(): Promise<void>;
  }

  export declare class SessionPersistence {
    stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined>;
    open(id: SessionId, access: 'read' | 'write'): Promise<SessionPersistenceHandle>;
    list(): Promise<readonly SessionPersistenceSnapshot[]>;
  }
}

declare module '@deepseek-ai/dsh-session-title' {
  import type { Session } from '@deepseek-ai/dsh-session';

  export interface SessionTitleService {
    rename(session: Session, title: string): void;
  }
}
