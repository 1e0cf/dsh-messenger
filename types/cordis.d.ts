declare module '@deepseek-ai/cordis' {
  export interface Fiber extends PromiseLike<void> {
    dispose(): Promise<void>;
  }

  export interface Logger {
    warn(message: string): void;
  }

  export interface Loader {
    builtins: { group?: unknown };
  }

  export interface Events {
    'session/event'(
      session: import('@deepseek-ai/dsh-session').Session,
      event: import('@deepseek-ai/dsh-session').SessionEvent,
    ): void;
    'agent/created'(payload: { agent: import('@deepseek-ai/dsh-agent').Agent; signal?: AbortSignal }): void;
    'llm/stream'(
      request: import('@deepseek-ai/dsh-llm').GenerateOptions,
      next: () => AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>,
    ): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>;
  }

  export interface PluginObject<T = unknown> {
    name?: string;
    Config?: unknown;
    inject?: readonly string[];
    apply(ctx: Context, config: T): unknown;
  }

  export type Plugin<T = unknown> =
    ((ctx: Context, config: T) => unknown) | (new (ctx: Context, config: T) => object) | PluginObject<T>;

  export type PluginNamespace = { readonly default: Plugin<never> };

  export declare class Context {
    constructor();
    readonly fiber: Fiber;
    readonly loader: Loader;
    logger: Logger;
    sessions: import('@deepseek-ai/dsh-session').SessionStore;
    sessionPersistence: import('@deepseek-ai/dsh-session-persistence').SessionPersistence;
    agents: import('@deepseek-ai/dsh-agent').AgentRegistry;
    tools: import('@deepseek-ai/dsh-tools').ToolRuntime;
    llm: import('@deepseek-ai/dsh-llm').LlmRuntime;
    agentPresets: import('@deepseek-ai/dsh-agent-preset-registry').AgentPresetRegistry;
    effect(execute: () => void | (() => void | Promise<void>)): () => void;
    on<K extends keyof Events>(event: K, listener: Events[K]): () => void;
    get(name: 'agentPresets'): import('@deepseek-ai/dsh-agent-preset-registry').AgentPresetRegistry | undefined;
    get(name: 'sessionTitle'): import('@deepseek-ai/dsh-session-title').SessionTitleService | undefined;
    plugin(plugin: Plugin | PluginNamespace, config?: unknown): Fiber;
  }

  export declare abstract class Service {
    protected ctx: Context;
    name: string;
    constructor(ctx: Context, name: string);
  }
}
