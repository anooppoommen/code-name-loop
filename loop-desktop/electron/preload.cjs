const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('loopDesktop', {
  isElectron: true,

  chooseFolder() {
    return ipcRenderer.invoke('dialog:choose-folder');
  },

  apiRequest(payload) {
    return ipcRenderer.invoke('loop-api:request', payload);
  },

  startReplyStream(payload) {
    return ipcRenderer.invoke('loop-api:start-stream', payload);
  },

  getActiveReplyStream(payload) {
    return ipcRenderer.invoke('loop-api:get-active-stream', payload);
  },

  cancelReplyStream(payload) {
    return ipcRenderer.invoke('loop-api:cancel-stream', payload);
  },

  onStreamPacket(handler) {
    const listener = (_event, packet) => handler(packet);
    ipcRenderer.on('loop-stream:packet', listener);

    return () => {
      ipcRenderer.removeListener('loop-stream:packet', listener);
    };
  },
});
