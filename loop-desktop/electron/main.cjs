const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');

/** @type {Map<string, AbortController>} */
const streamControllers = new Map();
/** @type {Map<string, { baseUrl: string, conversationId: string, startedAt: number }>} */
const streamMetaById = new Map();
/** @type {Map<string, string>} */
const streamIdByConversationKey = new Map();

function conversationKey(baseUrl, conversationId) {
  return `${String(baseUrl).replace(/\/+$/, '')}::${conversationId}`;
}

function broadcastStreamPacket(packet) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('loop-stream:packet', packet);
    }
  }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 1080,
    minHeight: 760,
    backgroundColor: '#0b1310',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    return;
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function buildAbsoluteUrl(baseUrl, endpointPath) {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(endpointPath.replace(/^\//, ''), base).toString();
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  let eventName = 'message';
  const dataLines = [];

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
  let data = dataRaw;
  try {
    data = JSON.parse(dataRaw);
  } catch {
    // Keep raw text when payload isn't JSON.
  }

  return { eventName, data };
}

async function streamReplyToRenderer(streamId, baseUrl, conversationId, message, thinkingLevel) {
  const endpoint = buildAbsoluteUrl(baseUrl, `/conversations/${conversationId}/reply`);
  const controller = new AbortController();
  const convKey = conversationKey(baseUrl, conversationId);
  streamControllers.set(streamId, controller);
  streamMetaById.set(streamId, { baseUrl, conversationId, startedAt: Date.now() });
  streamIdByConversationKey.set(convKey, streamId);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        thinking_level: thinkingLevel || 'medium',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await parseResponseBody(response);
      broadcastStreamPacket({
        streamId,
        type: 'error',
        error: `Reply failed (${response.status}): ${typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody)}`,
      });
      return;
    }

    if (!response.body) {
      broadcastStreamPacket({
        streamId,
        type: 'error',
        error: 'Reply stream is unavailable from server.',
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
        if (!parsed) {
          continue;
        }

        broadcastStreamPacket({
          streamId,
          type: 'event',
          eventName: parsed.eventName,
          data: parsed.data,
        });
      }
    }

    if (buffer.trim()) {
      const parsed = parseSseBlock(buffer);
      if (parsed) {
        broadcastStreamPacket({
          streamId,
          type: 'event',
          eventName: parsed.eventName,
          data: parsed.data,
        });
      }
    }

    broadcastStreamPacket({
      streamId,
      type: 'done',
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    broadcastStreamPacket({
      streamId,
      type: aborted ? 'aborted' : 'error',
      error: aborted
        ? 'Reply stream canceled.'
        : error instanceof Error
          ? error.message
          : 'Unknown stream error',
    });
  } finally {
    streamControllers.delete(streamId);
    streamMetaById.delete(streamId);
    if (streamIdByConversationKey.get(convKey) === streamId) {
      streamIdByConversationKey.delete(convKey);
    }
  }
}

ipcMain.handle('dialog:choose-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle('loop-api:request', async (_event, request) => {
  const { baseUrl, endpointPath, method = 'GET', body } = request || {};

  if (!baseUrl || !endpointPath) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: 'Missing baseUrl or endpointPath.',
    };
  }

  const url = buildAbsoluteUrl(baseUrl, endpointPath);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await parseResponseBody(response);
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : 'Network request failed.',
    };
  }
});

ipcMain.handle('loop-api:start-stream', async (event, payload) => {
  const { baseUrl, conversationId, message, streamId: clientStreamId, thinkingLevel } = payload || {};

  if (!baseUrl || !conversationId || !message) {
    return {
      ok: false,
      streamId: null,
      error: 'Missing baseUrl, conversationId, or message.',
    };
  }

  const convKey = conversationKey(baseUrl, conversationId);
  const existingStreamId = streamIdByConversationKey.get(convKey);
  if (existingStreamId && streamControllers.has(existingStreamId)) {
    return {
      ok: true,
      streamId: existingStreamId,
      error: null,
    };
  }

  const streamId = clientStreamId || crypto.randomUUID();
  void streamReplyToRenderer(streamId, baseUrl, conversationId, message, thinkingLevel);

  return {
    ok: true,
    streamId,
    error: null,
  };
});

ipcMain.handle('loop-api:get-active-stream', async (_event, payload) => {
  const { baseUrl, conversationId } = payload || {};
  if (!baseUrl || !conversationId) {
    return { ok: false, streamId: null, error: 'Missing baseUrl or conversationId.' };
  }

  const convKey = conversationKey(baseUrl, conversationId);
  const streamId = streamIdByConversationKey.get(convKey);
  if (!streamId || !streamControllers.has(streamId)) {
    return { ok: true, streamId: null, error: null };
  }

  return { ok: true, streamId, error: null };
});

ipcMain.handle('loop-api:cancel-stream', async (_event, payload) => {
  const streamId = payload?.streamId;
  if (!streamId || !streamControllers.has(streamId)) {
    return { ok: false };
  }

  streamControllers.get(streamId)?.abort();
  streamControllers.delete(streamId);
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
