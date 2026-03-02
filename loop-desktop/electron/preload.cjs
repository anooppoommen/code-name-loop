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

  sshTunnel: {
    connect: (config) => ipcRenderer.invoke('ssh-tunnel:connect', config),
    disconnect: () => ipcRenderer.invoke('ssh-tunnel:disconnect'),
    status: () => ipcRenderer.invoke('ssh-tunnel:status'),
    onStatusChange: (handler) => {
      const listener = (_event, status) => handler(status);
      ipcRenderer.on('ssh-tunnel:status-change', listener);
      return () => {
        ipcRenderer.removeListener('ssh-tunnel:status-change', listener);
      };
    },
  },
});
