// preload.js  — runs in an isolated context before the renderer page loads
// If you already have a preload.js, MERGE this into it (don't replace the whole file).

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // Pass receipt HTML so main.js can build a dedicated print window
    printReceipt: (html) => ipcRenderer.send('print-receipt', html),
    onPrintDone:  (cb)   => {
        ipcRenderer.removeAllListeners('print-done');
        ipcRenderer.once('print-done', cb);
    },
    openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),

    openRestore: () => ipcRenderer.invoke('open-restore-window'),

});