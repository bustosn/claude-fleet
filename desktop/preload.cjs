// The one thing the page can ask of the app: recolour the window buttons to match Fleet's theme.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fleetDesktop', {
  setTitleBar: (color, symbolColor) => ipcRenderer.send('fleet:titlebar', color, symbolColor),
});
