import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { fork, spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import QRCode from 'qrcode';

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[Main] Another instance of Reindeer FairPlay is already running. Exiting.');
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
const SERVER_PORT = process.env.PORT || '5000';
const SERVER_HOST = process.env.HOST || '0.0.0.0';
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const HEALTH_CHECK_URL = `${SERVER_URL}/api/state`;

/**
 * Get primary local IPv4 address
 */
function getLocalIpAddress(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Get network connection details and QR code data URL
 */
async function getNetworkInfo() {
  const ip = getLocalIpAddress();
  const port = parseInt(SERVER_PORT, 10);
  const connectUrl = `http://${ip}:${port}`;
  let qrCodeUrl = '';

  try {
    qrCodeUrl = await QRCode.toDataURL(connectUrl, {
      margin: 1,
      width: 128,
      color: {
        dark: '#000000',
        light: '#ffffff',
      },
    });
  } catch (err) {
    console.error('[Main] Failed to generate QR code:', err);
  }

  return { ip, port, connectUrl, qrCodeUrl };
}

/**
 * Start the Express backend server
 */
function startServer() {
  const appPath = app.getAppPath();
  const serverDistPath = path.join(appPath, 'dist', 'index.cjs');
  const serverTsPath = path.join(appPath, 'server', 'index.ts');

  const env = {
    ...process.env,
    NODE_ENV: app.isPackaged ? 'production' : (process.env.NODE_ENV || 'development'),
    PORT: SERVER_PORT,
    HOST: SERVER_HOST,
    ELECTRON_RUN_AS_NODE: '1',
  };

  if (fs.existsSync(serverDistPath)) {
    console.log(`[Main] Booting production server from ${serverDistPath}...`);
    serverProcess = fork(serverDistPath, [], { env, stdio: 'pipe' });
  } else if (fs.existsSync(serverTsPath)) {
    console.log(`[Main] Booting development server from ${serverTsPath}...`);
    const tsxCmd = process.platform === 'win32' ? 'tsx.cmd' : 'tsx';
    const localTsx = path.join(appPath, 'node_modules', '.bin', tsxCmd);

    if (fs.existsSync(localTsx)) {
      serverProcess = spawn(localTsx, ['server/index.ts'], { cwd: appPath, env, stdio: 'pipe' });
    } else {
      serverProcess = spawn('npx', ['tsx', 'server/index.ts'], { cwd: appPath, env, stdio: 'pipe', shell: true });
    }
  } else {
    console.error('[Main] Server entry point not found!');
    return;
  }

  if (serverProcess.stdout) {
    serverProcess.stdout.on('data', (data) => console.log(`[Server]: ${data.toString().trim()}`));
  }
  if (serverProcess.stderr) {
    serverProcess.stderr.on('data', (data) => console.error(`[Server Error]: ${data.toString().trim()}`));
  }

  serverProcess.on('exit', (code, signal) => {
    console.log(`[Main] Server process exited (code: ${code}, signal: ${signal})`);
    serverProcess = null;
  });
}

/**
 * Stop server child process
 */
function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    console.log('[Main] Stopping server process...');
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', serverProcess.pid!.toString(), '/f', '/t']);
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch (err) {
      console.error('[Main] Error stopping server process:', err);
    }
    serverProcess = null;
  }
}

/**
 * Poll server until /api/state returns HTTP 200/2xx
 */
async function waitForServerReady(timeoutMs = 30000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const isReady = await new Promise<boolean>((resolve) => {
        const req = http.get(HEALTH_CHECK_URL, (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
      });

      if (isReady) {
        console.log('[Main] Server is ready!');
        return true;
      }
    } catch {
      // Keep polling
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

/**
 * HTML content for the loading screen while server boots
 */
function getLoadingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Reindeer FairPlay - Starting...</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0f172a;
      color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 24px;
    }
    .container {
      background: #1e293b;
      padding: 40px;
      border-radius: 16px;
      box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.3);
      border: 1px solid #334155;
      max-width: 420px;
      width: 100%;
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #38bdf8;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }
    .subtitle {
      font-size: 14px;
      color: #94a3b8;
      margin-bottom: 28px;
    }
    .spinner {
      width: 44px;
      height: 44px;
      border: 4px solid #334155;
      border-top-color: #38bdf8;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 24px auto;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .status {
      font-size: 13px;
      color: #cbd5e1;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">Reindeer: FairPlay</div>
    <div class="subtitle">Estate Division & Asset Allocation</div>
    <div class="spinner"></div>
    <div class="status">Starting local estate server...</div>
  </div>
</body>
</html>`;
}

/**
 * Create BrowserWindow
 */
async function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: 'Reindeer: FairPlay',
    backgroundColor: '#0f172a',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Setup IPC handlers
  ipcMain.handle('get-network-info', async () => getNetworkInfo());
  ipcMain.handle('get-local-ip', async () => getLocalIpAddress());
  ipcMain.handle('get-port', async () => parseInt(SERVER_PORT, 10));

  // Load loading screen
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getLoadingHtml())}`);
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Check if server is already running, or start it
  const alreadyRunning = await waitForServerReady(1000);
  if (!alreadyRunning) {
    startServer();
  }

  // Wait for server readiness
  const ready = await waitForServerReady(35000);
  if (ready) {
    console.log(`[Main] Loading app URL ${SERVER_URL}...`);
    mainWindow.loadURL(SERVER_URL);
  } else {
    console.error('[Main] Server failed to start within timeout.');
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <body style="background:#0f172a;color:#f87171;font-family:sans-serif;padding:40px;text-align:center;">
        <h2>Failed to connect to estate server</h2>
        <p style="color:#94a3b8;margin-top:10px;">Please restart the application.</p>
      </body>
    `)}`);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  stopServer();
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
