declare module '@deepseek-ai/dsh-agent-preset-registry' {
  import type { Context } from '@deepseek-ai/cordis';

  export interface PresetDefinition {
    id: string;
    name?: string;
    description?: string;
    plugins?: readonly unknown[];
  }

  export interface AgentPreset {
    id: string;
    name?: string;
    description?: string;
    broken?: unknown;
  }

  export declare class AgentPresetRegistry {
    constructor(ctx: Context, config?: unknown);
    register(definition: PresetDefinition): Promise<() => Promise<void>>;
    list(): Promise<AgentPreset[]>;
    mount(ctx: Context, id?: string): Promise<AgentPreset>;
    composedPreset(ctx: Context): string | undefined;
  }

  export default AgentPresetRegistry;
}

declare module '@deepseek-ai/dsh-session-projection' {
  export default class SessionProjectionRegistry {
    constructor(ctx: import('@deepseek-ai/cordis').Context, config?: unknown);
  }
}

declare module '@deepseek-ai/dsh-system-prompt' {
  export default class SystemPrompt {
    constructor(ctx: import('@deepseek-ai/cordis').Context, config?: unknown);
  }
}

declare module '@deepseek-ai/dsh-agent-loop' {
  export default class AgentLoop {
    constructor(ctx: import('@deepseek-ai/cordis').Context, config?: unknown);
  }
}

declare module '@deepseek-ai/cordis-plugin-loader' {
  export default class Loader {
    constructor(ctx: import('@deepseek-ai/cordis').Context, config?: unknown);
  }
}

declare module '@deepseek-ai/cordis-plugin-group' {
  export default class Group {
    constructor(ctx: import('@deepseek-ai/cordis').Context, config?: unknown);
  }
}

declare module '@deepseek-ai/dsh-session-persistence-jsonl' {
  export interface JsonlConfig {
    root: string;
    compression?: string;
  }

  export declare const JsonlCompressionSchema: unknown;

  export default class JsonlSessionPersistence {
    constructor(ctx: import('@deepseek-ai/cordis').Context, config: JsonlConfig);
  }
}
