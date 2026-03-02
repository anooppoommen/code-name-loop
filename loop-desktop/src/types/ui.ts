export type ActivityKind = 'user' | 'assistant' | 'thought' | 'status' | 'tool' | 'error' | 'lifecycle' | 'thread';
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type ComposerModel = 'gemini-3.1-pro-preview' | 'gemini-3-flash-preview' | 'gemini-3-pro-preview';

export type ToolPhase = 'start' | 'result';

export interface ToolActivityMeta {
  callId?: string;
  name: string;
  phase: ToolPhase;
  waitingApproval?: boolean;
  success?: boolean;
  resultSummary?: string;
  error?: string;
  command?: string;
  args?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  title: string;
  body?: string;
  userTurn?: {
    model?: string;
    thinkingLevel?: string;
  };
  checkpointId?: string;
  timestamp: number;
  streaming?: boolean;
  tool?: ToolActivityMeta;
  images?: { mimeType: string; dataUrl: string }[];
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

export interface CheckpointSummary {
  id: string;
  conversationId: string;
  workspaceId: string;
  label: string;
  commitId: string;
  parentCommitId: string;
  createdAt: string;
}
