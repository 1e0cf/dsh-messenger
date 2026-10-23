declare module '@deepseek-ai/dsh-tools' {
  import type { Agent } from '@deepseek-ai/dsh-agent';
  import type { ToolCallId } from '@deepseek-ai/dsh-llm';

  export interface ParameterProperty {
    type: 'string' | 'number' | 'boolean';
    description?: string;
    required?: boolean;
    enum?: readonly string[];
  }

  export type ParameterSchemaSpec = Record<string, ParameterProperty>;

  export type InferArgs<S extends ParameterSchemaSpec> = {
    [K in keyof S as S[K] extends { required: true } ? K : never]: S[K] extends { type: 'string' } ? string : unknown;
  } & {
    [K in keyof S as S[K] extends { required: true } ? never : K]?: S[K] extends { type: 'string' } ? string : unknown;
  };

  export interface ToolRunContext {
    agent?: Agent;
  }

  export interface ToolOutput<O> {
    schema: O;
    render(args: unknown, value: unknown): unknown[];
  }

  export interface CompiledParameters {
    type: 'object';
    properties: Record<string, ParameterProperty>;
  }

  export interface ToolDefinition {
    name: string;
    description: string;
    parameters: CompiledParameters;
    output: ToolOutput<unknown>;
  }

  export interface DefineToolOptions<S extends ParameterSchemaSpec, O> {
    name: string;
    description: string;
    parameters: S;
    output?: ToolOutput<O>;
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<unknown>;
  }

  export declare function defineTool<const S extends ParameterSchemaSpec, const O = unknown>(
    options: DefineToolOptions<S, O>,
  ): ToolDefinition;

  export interface ToolExecutionInput {
    callId: ToolCallId;
    name: string;
    arguments: unknown;
    agent?: Agent;
    signal?: AbortSignal;
  }

  export interface ToolExecutionResult {
    isError: boolean;
    value: unknown;
  }

  export declare class ToolRuntime {
    constructor(ctx: import('@deepseek-ai/cordis').Context, config?: unknown);
    register(definition: ToolDefinition): () => void;
    get(name: string, scope?: unknown): ToolDefinition | undefined;
    execute(input: ToolExecutionInput): Promise<ToolExecutionResult>;
  }

  export default ToolRuntime;
}
