const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const { createTunnel, destroyTunnel, getTunnelStatus, tunnelEvents } = require('./ssh-tunnel.cjs');

/** @type {Map<string, AbortController>} */
const streamControllers = new Map();
/** @type {Map<string, { baseUrl: string, conversationId: string, startedAt: number }>} */
const streamMetaById = new Map();
/** @type {Map<string, string>} */
const streamIdByConversationKey = new Map();

function shortId(id) {
  if (!id || typeof id !== 'string') {
    return '';
  }
  return id.length <= 8 ? id : id.slice(0, 8);
}

function streamLog(message, details) {
  if (details !== undefined) {
    console.log(`[loop-stream] ${message}`, details);
    return;
  }
  console.log(`[loop-stream] ${message}`);
}

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
    backgroundColor: '#101010',
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

async function streamReplyToRenderer(
  streamId,
  baseUrl,
  conversationId,
  message,
  model,
  thinkingLevel,
  images,
  retryMessageId,
  editMessageId,
) {
  const endpoint = buildAbsoluteUrl(baseUrl, `/conversations/${conversationId}/reply`);
  const controller = new AbortController();
  const convKey = conversationKey(baseUrl, conversationId);
  const startedAt = Date.now();
  let packetCount = 0;
  /** @type {Record<string, number>} */
  const eventCounts = {};
  let streamResult = 'unknown';
  streamControllers.set(streamId, controller);
  streamMetaById.set(streamId, { baseUrl, conversationId, startedAt: Date.now() });
  streamIdByConversationKey.set(convKey, streamId);
  const mode = retryMessageId ? 'retry' : (editMessageId ? 'edit' : 'reply');
  streamLog(`start stream=${shortId(streamId)} conv=${shortId(conversationId)} mode=${mode} model=${model || 'gemini-3.1-pro-preview'} thinking=${thinkingLevel || 'medium'} chars=${String(message || '').length} images=${Array.isArray(images) ? images.length : 0}`);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        retry_message_id: retryMessageId,
        edit_message_id: editMessageId,
        model,
        thinking_level: thinkingLevel || 'medium',
        images,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await parseResponseBody(response);
      streamResult = `http_${response.status}`;
      streamLog(`http error stream=${shortId(streamId)} conv=${shortId(conversationId)} status=${response.status}`);
      broadcastStreamPacket({
        streamId,
        type: 'error',
        error: `Reply failed (${response.status}): ${typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody)}`,
      });
      return;
    }

    if (!response.body) {
      streamResult = 'missing_body';
      streamLog(`missing body stream=${shortId(streamId)} conv=${shortId(conversationId)}`);
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
        packetCount += 1;
        eventCounts[parsed.eventName] = (eventCounts[parsed.eventName] || 0) + 1;
        if (packetCount === 1 || packetCount % 50 === 0) {
          streamLog(`packet stream=${shortId(streamId)} conv=${shortId(conversationId)} count=${packetCount} event=${parsed.eventName}`);
        }
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
        packetCount += 1;
        eventCounts[parsed.eventName] = (eventCounts[parsed.eventName] || 0) + 1;
      }
    }

    broadcastStreamPacket({
      streamId,
      type: 'done',
    });
    streamResult = 'done';
  } catch (error) {
    const aborted = controller.signal.aborted;
    streamResult = aborted ? 'aborted' : 'error';
    streamLog(`${streamResult} stream=${shortId(streamId)} conv=${shortId(conversationId)} reason=${error instanceof Error ? error.message : 'unknown'}`);
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
    streamLog(`end stream=${shortId(streamId)} conv=${shortId(conversationId)} result=${streamResult} duration_ms=${Date.now() - startedAt} packets=${packetCount} events=${JSON.stringify(eventCounts)}`);
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
  const {
    baseUrl,
    conversationId,
    message,
    retryMessageId,
    editMessageId,
    model,
    images,
    streamId: clientStreamId,
    thinkingLevel,
  } = payload || {};

  const hasMessage = typeof message === 'string' && message.trim().length > 0;
  const hasImages = Array.isArray(images) && images.length > 0;
  const hasBranchInstruction =
    (typeof retryMessageId === 'string' && retryMessageId.trim().length > 0) ||
    (typeof editMessageId === 'string' && editMessageId.trim().length > 0);
  if (!baseUrl || !conversationId || (!hasMessage && !hasImages && !hasBranchInstruction)) {
    return {
      ok: false,
      streamId: null,
      error: 'Missing baseUrl, conversationId, and message/images/branch operation.',
    };
  }

  const convKey = conversationKey(baseUrl, conversationId);
  const existingStreamId = streamIdByConversationKey.get(convKey);
  if (existingStreamId && streamControllers.has(existingStreamId)) {
    streamLog(`reuse active stream=${shortId(existingStreamId)} conv=${shortId(conversationId)}`);
    return {
      ok: true,
      streamId: existingStreamId,
      error: null,
    };
  }

  const streamId = clientStreamId || crypto.randomUUID();
  void streamReplyToRenderer(
    streamId,
    baseUrl,
    conversationId,
    message || '',
    model,
    thinkingLevel,
    images,
    typeof retryMessageId === 'string' ? retryMessageId.trim() : '',
    typeof editMessageId === 'string' ? editMessageId.trim() : '',
  );

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
  streamLog(`cancel requested stream=${shortId(streamId)}`);
  return { ok: true };
});

tunnelEvents.on('status-change', (status) => {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('ssh-tunnel:status-change', status);
    }
  }
});

ipcMain.handle('ssh-tunnel:connect', async (_event, config) => {
  return await createTunnel(config);
});

ipcMain.handle('ssh-tunnel:disconnect', async () => {
  await destroyTunnel();
  return { ok: true };
});

ipcMain.handle('ssh-tunnel:status', async () => {
  return getTunnelStatus();
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
