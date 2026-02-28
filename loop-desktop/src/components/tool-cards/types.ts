export interface ToolReplyActions {
  canCompose: boolean;
  isSending: boolean;
  onUseToolReply: (text: string) => void;
  onSendToolReply: (text: string) => Promise<void>;
}

export interface RequestUserInputOption {
  label: string;
  description: string;
}

export interface RequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: RequestUserInputOption[];
}

export interface RequestUserInputPayload {
  supported: boolean;
  reason: string;
  nextStep: string;
  questions: RequestUserInputQuestion[];
}

export interface UpdatePlanItem {
  step: string;
  status: string;
}

export interface UpdatePlanPayload {
  plan: UpdatePlanItem[];
}

export interface ParallelToolResult {
  name: string;
  success: boolean;
  error: string;
  response?: Record<string, unknown> | null;
  arguments?: Record<string, unknown> | null;
}

export interface ParallelToolPayload {
  successCount: number;
  failureCount: number;
  results: ParallelToolResult[];
}

export type CommandToolStatus = 'running' | 'success' | 'error';

export interface CommandToolPayload {
  shellLabel: string;
  command: string;
  output: string;
  status: CommandToolStatus;
  error: string;
  wallTime: string;
  exitCode: string;
  executedAt: string;
}
