declare module '@deepseek-ai/dsh-llm' {
  export type MessageId = string;
  export type ToolCallId = string;
  export declare function ToolCallId(id: string): ToolCallId;

  export interface TextContent {
    type: 'text';
    text: string;
  }

  export type ContentBlock = TextContent;

  export interface UserMessageSource {
    kind: 'user';
  }

  export interface MessengerMessageSource {
    kind: 'dsh-messenger';
    channelId: string;
    messageId: string;
    senderSessionId: string;
    sentAt: string;
  }

  export interface MessageSourceMap {
    user: UserMessageSource;
    'dsh-messenger': MessengerMessageSource;
  }

  export type MessageSource = MessageSourceMap[keyof MessageSourceMap];

  export interface UserMessage {
    readonly id: MessageId;
    readonly role: 'user';
    readonly content: readonly ContentBlock[];
    readonly source: MessageSource;
  }

  export type Message = UserMessage;

  export interface GenerateOptions {
    readonly provider?: string;
    readonly model?: string;
    readonly messages: readonly UserMessage[];
    readonly sessionId?: import('@deepseek-ai/dsh-session').SessionId;
    readonly signal?: AbortSignal;
  }

  export type StreamChunk =
    | { type: 'block-start'; index: number; blockType: 'text' }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'block-end'; index: number; block: ContentBlock }
    | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
    | { type: 'finish'; reason: { kind: string } };

  export declare function createUserMessage(input: {
    content: readonly ContentBlock[];
    source: MessageSource;
  }): UserMessage;

  export declare abstract class LlmAdapter {
    abstract stream(request: GenerateOptions): AsyncIterable<StreamChunk>;
  }

  export declare class LlmRuntime {
    constructor(ctx: import('@deepseek-ai/cordis').Context, config?: unknown);
    registerAdapter(routes: readonly string[], adapter: LlmAdapter): void;
  }

  export default LlmRuntime;
}
