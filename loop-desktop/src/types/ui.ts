export type ActivityKind = 'user' | 'assistant' | 'thought' | 'status' | 'tool' | 'error' | 'lifecycle' | 'thread';
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export type ToolPhase = 'start' | 'result';

export interface ToolActivityMeta {
  callId?: string;
  name: string;
  phase: ToolPhase;
  success?: boolean;
  resultSummary?: string;
  error?: string;
  command?: string;
  payload?: Record<string, unknown> | null;
}

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  title: string;
  body?: string;
  timestamp: number;
  streaming?: boolean;
  tool?: ToolActivityMeta;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  rootPath: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  isThread: boolean;
  updatedAt: string;
}
