'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  connect: p => ipcRenderer.invoke('connect', p),
  chooseVault: () => ipcRenderer.invoke('choose-vault'),
  snapshot: () => ipcRenderer.invoke('snapshot'),
  act: (name, ...args) => ipcRenderer.invoke('act', name, ...args),
  copy: text => ipcRenderer.invoke('copy', text),
  open: url => ipcRenderer.invoke('open', url),
  openNote: rel => ipcRenderer.invoke('open-note', rel),
  revealExtension: () => ipcRenderer.invoke('reveal-extension'),
  loginItem: on => ipcRenderer.invoke('login-item', on),
  gitStatus: () => ipcRenderer.invoke('git-status'),
  onChanged: fn => ipcRenderer.on('changed', () => fn()),
  onGit: fn => ipcRenderer.on('git', (_e, s) => fn(s)),
});
