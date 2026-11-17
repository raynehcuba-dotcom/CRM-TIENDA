const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('gestorDesktop', {
  isDesktop: true,
  platform: process.platform,
});
