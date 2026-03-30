export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | ContentPart[];
}

export interface ContentPart {
  type: 'text' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | ContentPart[];
  tool_use_id?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ProviderRequest {
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  model: string;
  stream: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResponse {
  content: ContentPart[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: TokenUsage;
}

export type StreamDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_delta'; id: string; name: string; input: string }
  | { type: 'message_stop'; stopReason: ProviderResponse['stopReason'] }
  | { type: 'error'; error: Error };

export type StreamHandler = (delta: StreamDelta) => void;

export interface LLMProvider {
  readonly name: string;
  readonly defaultModel: string;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
  stream(request: ProviderRequest, handler: StreamHandler): Promise<ProviderResponse>;
}
