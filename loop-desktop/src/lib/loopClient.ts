import type {
  LoopActiveStreamRequest,
  LoopActiveStreamResponse,
  LoopApiRequest,
  LoopApiResponse,
  LoopStreamPacket,
  LoopStreamStartRequest,
} from '../electron';

export type HttpMethod = NonNullable<LoopApiRequest['method']>;

export interface ReplyStreamHandle {
  streamId: string;
  cancel: () => Promise<void>;
  dispose: () => void;
}

export async function getActiveReplyStream(
  payload: LoopActiveStreamRequest,
): Promise<LoopActiveStreamResponse> {
  if (window.loopDesktop?.isElectron) {
    return window.loopDesktop.getActiveReplyStream(payload);
  }

  return {
    ok: true,
    streamId: null,
    error: null,
  };
}

export function attachReplyStream(
  streamId: string,
  onPacket: (packet: LoopStreamPacket) => void,
): ReplyStreamHandle {
  if (!window.loopDesktop?.isElectron) {
    return {
      streamId,
      cancel: async () => {},
      dispose: () => {},
    };
  }

  const unsubscribe = window.loopDesktop.onStreamPacket((packet) => {
    if (packet.streamId !== streamId) {
      return;
    }
    onPacket(packet);
  });

  return {
    streamId,
    cancel: async () => {
      await window.loopDesktop?.cancelReplyStream({ streamId });
    },
    dispose: unsubscribe,
  };
}

export async function chooseFolder(): Promise<string | null> {
  if (window.loopDesktop?.isElectron) {
    return window.loopDesktop.chooseFolder();
  }
  return null;
}

export async function requestJson<T = unknown>(
  payload: LoopApiRequest,
): Promise<LoopApiResponse<T>> {
  if (window.loopDesktop?.isElectron) {
    return window.loopDesktop.apiRequest<T>(payload);
  }

  const base = payload.baseUrl.endsWith('/') ? payload.baseUrl : `${payload.baseUrl}/`;
  const url = new URL(payload.endpointPath.replace(/^\//, ''), base).toString();

  try {
    const response = await fetch(url, {
      method: payload.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      body: payload.body ? JSON.stringify(payload.body) : undefined,
    });

    let data: unknown;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      data = await response.text();
    }

    return {
      ok: response.ok,
      status: response.status,
      data: data as T,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null as T,
      error: error instanceof Error ? error.message : 'Network request failed.',
    };
  }
}

export async function openReplyStream(
  payload: LoopStreamStartRequest,
  onPacket: (packet: LoopStreamPacket) => void,
): Promise<ReplyStreamHandle> {
  if (window.loopDesktop?.isElectron) {
    const clientStreamId = payload.streamId ?? crypto.randomUUID();
    let currentStreamId = clientStreamId;
    const unsubscribe = window.loopDesktop.onStreamPacket((packet) => {
      if (packet.streamId !== currentStreamId) {
        return;
      }
      onPacket(packet);
    });

    const start = await window.loopDesktop.startReplyStream({
      ...payload,
      streamId: clientStreamId,
    });
    if (!start.ok || !start.streamId) {
      unsubscribe();
      throw new Error(start.error ?? 'Failed to start stream.');
    }

    currentStreamId = start.streamId;
    const streamId = start.streamId;
    return {
      streamId,
      cancel: async () => {
        await window.loopDesktop?.cancelReplyStream({ streamId });
      },
      dispose: unsubscribe,
    };
  }

  const streamId = payload.streamId ?? crypto.randomUUID();
  const controller = new AbortController();

  void (async () => {
    const base = payload.baseUrl.endsWith('/') ? payload.baseUrl : `${payload.baseUrl}/`;
    const url = new URL(
      `conversations/${payload.conversationId}/reply`,
      base,
    ).toString();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: payload.message,
          thinking_level: payload.thinkingLevel ?? 'medium',
          images: payload.images,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        onPacket({
          streamId,
          type: 'error',
          error: `Reply failed (${response.status}).`,
        });
        return;
      }

      if (!response.body) {
        onPacket({
          streamId,
          type: 'error',
          error: 'Stream body is missing.',
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split(/\r?\n\r?\n/);
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const parsed = parseSseBlock(chunk);
          if (parsed) {
            onPacket({
              streamId,
              type: 'event',
              eventName: parsed.eventName,
              data: parsed.data,
            });
          }
        }
      }

      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer);
        if (parsed) {
          onPacket({
            streamId,
            type: 'event',
            eventName: parsed.eventName,
            data: parsed.data,
          });
        }
      }

      onPacket({ streamId, type: 'done' });
    } catch (error) {
      onPacket({
        streamId,
        type: controller.signal.aborted ? 'aborted' : 'error',
        error: error instanceof Error ? error.message : 'Stream failed.',
      });
    }
  })();

  return {
    streamId,
    cancel: async () => {
      controller.abort();
    },
    dispose: () => {},
  };
}

function parseSseBlock(block: string): { eventName: string; data: unknown } | null {
  const lines = block.split(/\r?\n/);
  let eventName = 'message';
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const dataRaw = dataLines.join('\n');
  try {
    return { eventName, data: JSON.parse(dataRaw) as unknown };
  } catch {
    return { eventName, data: dataRaw };
  }
}
