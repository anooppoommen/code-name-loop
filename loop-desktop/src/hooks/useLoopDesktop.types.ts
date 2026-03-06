import type { Dispatch, RefObject, SetStateAction } from 'react';
import type {
  ActivityEvent,
  CheckpointSummary,
  ComposerModel,
  ConversationSummary,
  ThinkingLevel,
  WorkspaceSummary,
} from '../types/ui';

export interface SshTunnelConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  remotePort: number;
}

export type SshTunnelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface StreamHandle {
  streamId: string;
  conversationId: string;
  cancel: () => Promise<void>;
  dispose: () => void;
}

export interface ConversationLiveState {
  draftAssistantId: string | null;
  draftThoughtId: string | null;
  lastStatus: string;
  openToolEventIDs: Record<string, string>;
  retryStatusEventID: string | null;
}

export type CommandApprovalDecision = 'deny' | 'allow_once' | 'allow_session';

export interface PendingCommandApproval {
  id: string;
  conversationId: string;
  toolName: string;
  command: string;
  workdir: string;
}

export type NoticeTone = 'success' | 'error' | 'info';

export interface QueuedMessage {
  id: string;
  text: string;
  images: ComposerImage[];
}

export interface ComposerImage {
  id: string;
  data: string;
  mimeType: string;
  dataUrl: string;
}

export interface NoticeToast {
  id: string;
  tone: NoticeTone;
  message: string;
}

export interface LoopDesktopController {
  backendUrl: string;
  setBackendUrl: (value: string) => void;

  sshTunnelConfig: SshTunnelConfig;
  setSshTunnelConfig: Dispatch<SetStateAction<SshTunnelConfig>>;
  sshTunnelStatus: SshTunnelStatus;
  sshTunnelError: string | null;
  connectTunnel: (config: SshTunnelConfig) => Promise<void>;
  disconnectTunnel: () => Promise<void>;

  workspaces: WorkspaceSummary[];
  selectedWorkspaceId: string;
  selectedWorkspace: WorkspaceSummary | null;
  workspacePath: string;
  setWorkspacePath: (value: string) => void;
  workspaceName: string;
  setWorkspaceName: (value: string) => void;
  isLoadingWorkspaces: boolean;

  conversations: ConversationSummary[];
  conversationsByWorkspace: Record<string, ConversationSummary[]>;
  hasMoreConversationsByWorkspace: Record<string, boolean>;
  selectedConversationId: string;
  selectedConversation: ConversationSummary | null;
  checkpoints: CheckpointSummary[];

  activities: ActivityEvent[];
  feedScrollRef: RefObject<HTMLDivElement | null>;

  queuedMessages: QueuedMessage[];
  queueMessage: () => void;
  removeQueuedMessage: (id: string) => void;
  reorderQueuedMessage: (id: string, direction: 'up' | 'down') => void;
  steerQueuedMessage: (id: string) => Promise<void>;
  messageInput: string;
  setMessageInput: (value: string) => void;
  composerImages: ComposerImage[];
  setComposerImages: Dispatch<SetStateAction<ComposerImage[]>>;
  canCompose: boolean;
  isSending: boolean;
  sendingConversations: Record<string, boolean>;
  notices: NoticeToast[];
  pendingCommandApproval: PendingCommandApproval | null;
  pendingCommandApprovalCount: number;
  isResolvingCommandApproval: boolean;
  isRestoringCheckpoint: boolean;
  hideLifecycle: boolean;
  setHideLifecycle: (value: boolean) => void;
  showMascot: boolean;
  setShowMascot: (value: boolean) => void;
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (value: ThinkingLevel) => void;
  composerModel: ComposerModel;
  setComposerModel: (value: ComposerModel) => void;
  currentStatus: string;
  setCurrentStatus: (value: string) => void;

  dismissNotice: (id: string) => void;
  resolveCommandApproval: (decision: CommandApprovalDecision, message?: string) => Promise<void>;

  refreshWorkspaces: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  refreshCheckpoints: () => Promise<void>;
  pickFolder: () => Promise<void>;
  createWorkspace: () => Promise<void>;
  pickAndCreateWorkspace: () => Promise<void>;
  deleteWorkspace: (workspaceId: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => void;
  selectConversation: (conversationId: string) => void;
  loadMoreConversations: (workspaceId: string) => Promise<void>;
  newConversation: () => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;

  sendMessage: () => Promise<void>;
  cancelStream: () => Promise<void>;
  createCheckpoint: (label?: string) => Promise<void>;
  restoreCheckpoint: (checkpointId: string) => Promise<void>;
  undoLatestCheckpoint: () => Promise<void>;
  applyToolResponseSuggestion: (text: string) => void;
  sendToolResponseSuggestion: (text: string) => Promise<void>;
  retryFromMessage: (messageId: string) => Promise<void>;
  editMessageInComposer: (messageId: string, text: string, images: { mimeType: string; dataUrl: string }[]) => void;
}
