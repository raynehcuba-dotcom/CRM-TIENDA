const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let mainWindow = null;
let embeddedServer = null;
let isQuitting = false;

function isDirWritable(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.gt-write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolvePortableDataDir() {
  if (!app.isPackaged) {
    return path.resolve(__dirname, '..');
  }

  const exeParent =
    process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const portableDataCandidate = path.join(exeParent, 'GestorTienda-Datos');
  if (isDirWritable(portableDataCandidate)) {
    return portableDataCandidate;
  }

  const fallbackDir = path.join(app.getPath('userData'), 'GestorTienda-Datos');
  fs.mkdirSync(fallbackDir, { recursive: true });
  return fallbackDir;
}

function resolveResourcesDir() {
  return app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, '..');
}

async function startEmbeddedBackend() {
  const dataDir = resolvePortableDataDir();
  const resourcesDir = resolveResourcesDir();
  const dbPath = path.join(dataDir, 'tienda_data.db');

  process.env.GESTOR_TIENDA_EMBEDDED = '1';
  process.env.GESTOR_TIENDA_PACKAGED = '1';
  process.env.APP_RESOURCES_DIR = resourcesDir;
  process.env.APP_DATA_DIR = dataDir;
  process.env.SQLITE_DB_PATH = dbPath;

  const serverBundlePath = path.join(__dirname, '..', 'dist-electron', 'server.cjs');
  const { startServer } = require(serverBundlePath);
  embeddedServer = await startServer({
    port: 3000,
    host: '127.0.0.1',
    allowPortFallback: true,
  });
  return embeddedServer;
}

function createMainWindow(port) {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'Gestor Tienda',
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`http://127.0.0.1:${port}`)) {
      return { action: 'allow' };
    }
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(`http://127.0.0.1:${port}/dashboard`);
}

async function shutdownCleanly() {
  if (embeddedServer) {
    const srv = embeddedServer;
    embeddedServer = null;
    try {
      await srv.close();
    } catch {
      // Ignore shutdown errors
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const started = await startEmbeddedBackend();
      createMainWindow(started.port);
    } catch (err) {
      dialog.showErrorBox(
        'Error al iniciar Gestor Tienda',
        `No se pudo iniciar el servidor local SQLite:\n\n${err && err.message ? err.message : String(err)}`
      );
      app.quit();
    }
  });

  app.on('before-quit', async (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    await shutdownCleanly();
    app.exit(0);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
