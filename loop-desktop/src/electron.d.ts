export interface LoopApiRequest {
  baseUrl: string;
  endpointPath: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export interface LoopApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  error: string | null;
}

export interface LoopStreamStartRequest {
  streamId?: string;
  baseUrl: string;
  conversationId: string;
  message: string;
}

export interface LoopStreamStartResponse {
  ok: boolean;
  streamId: string | null;
  error: string | null;
}

export interface LoopActiveStreamRequest {
  baseUrl: string;
  conversationId: string;
}

export interface LoopActiveStreamResponse {
  ok: boolean;
  streamId: string | null;
  error: string | null;
}

export interface LoopStreamPacket {
  streamId: string;
  type: 'event' | 'done' | 'error' | 'aborted';
  eventName?: string;
  data?: unknown;
  error?: string;
}

interface LoopDesktopBridge {
  isElectron: boolean;
  chooseFolder: () => Promise<string | null>;
  apiRequest: <T = unknown>(payload: LoopApiRequest) => Promise<LoopApiResponse<T>>;
  startReplyStream: (payload: LoopStreamStartRequest) => Promise<LoopStreamStartResponse>;
  getActiveReplyStream: (payload: LoopActiveStreamRequest) => Promise<LoopActiveStreamResponse>;
  cancelReplyStream: (payload: { streamId: string }) => Promise<{ ok: boolean }>;
  onStreamPacket: (handler: (packet: LoopStreamPacket) => void) => () => void;
}

declare global {
  interface Window {
    loopDesktop?: LoopDesktopBridge;
  }
}
