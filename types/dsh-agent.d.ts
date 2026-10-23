declare module '@deepseek-ai/dsh-agent' {
  import type { Context } from '@deepseek-ai/cordis';
  import type { UserMessage } from '@deepseek-ai/dsh-llm';
  import type { Session, SessionId } from '@deepseek-ai/dsh-session';

  export interface AgentOptions {
    provider: string;
    model: string;
    reasoningEffort?: string;
  }

  export interface Agent {
    readonly id: SessionId;
    readonly session: Session;
    readonly status: string;
    readonly ctx: Context;
    steer(message: UserMessage): void;
    followup(message: UserMessage): void;
    whenIdle(): Promise<void>;
  }

  export interface AgentHandle {
    agent: Agent;
    dispose(): Promise<void>;
  }

  export interface CreateAgentOptions {
    sessionId: SessionId;
    agentOptions?: AgentOptions;
    meta?: { agentPreset?: string; cwd?: string };
    setup?(ctx: Context): unknown;
  }

  export interface ResumeAgentOptions {
    resumeSessionId: SessionId;
    agentOptions?: AgentOptions;
    setup?(ctx: Context): unknown;
  }

  export declare class AgentRegistry {
    constructor(ctx: Context, config?: unknown);
    get(id: SessionId): Agent | undefined;
    list(): Agent[];
    roots(): Agent[];
    isOwnedBy(id: SessionId, owner: Agent): boolean;
    create(options: CreateAgentOptions): Promise<AgentHandle>;
    resume(options: ResumeAgentOptions): Promise<AgentHandle>;
  }

  export default AgentRegistry;
}
