"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var import_electron = require("electron");
var import_node_path = __toESM(require("node:path"), 1);
var import_node_http = __toESM(require("node:http"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var import_node_child_process = require("node:child_process");
var import_node_fs = __toESM(require("node:fs"), 1);
var import_qrcode = __toESM(require("qrcode"), 1);
const gotTheLock = import_electron.app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log("[Main] Another instance of Reindeer FairPlay is already running. Exiting.");
  import_electron.app.quit();
  process.exit(0);
}
let mainWindow = null;
let serverProcess = null;
const SERVER_PORT = process.env.PORT || "5000";
const SERVER_HOST = process.env.HOST || "0.0.0.0";
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const HEALTH_CHECK_URL = `${SERVER_URL}/api/state`;
function getLocalIpAddress() {
  const interfaces = import_node_os.default.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}
async function getNetworkInfo() {
  const ip = getLocalIpAddress();
  const port = parseInt(SERVER_PORT, 10);
  const connectUrl = `http://${ip}:${port}`;
  let qrCodeUrl = "";
  try {
    qrCodeUrl = await import_qrcode.default.toDataURL(connectUrl, {
      margin: 1,
      width: 128,
      color: {
        dark: "#000000",
        light: "#ffffff"
      }
    });
  } catch (err) {
    console.error("[Main] Failed to generate QR code:", err);
  }
  return { ip, port, connectUrl, qrCodeUrl };
}
function startServer() {
  const appPath = import_electron.app.getAppPath();
  const serverDistPath = import_node_path.default.join(appPath, "dist", "index.cjs");
  const serverTsPath = import_node_path.default.join(appPath, "server", "index.ts");
  const env = {
    ...process.env,
    NODE_ENV: import_electron.app.isPackaged ? "production" : process.env.NODE_ENV || "development",
    PORT: SERVER_PORT,
    HOST: SERVER_HOST,
    ELECTRON_RUN_AS_NODE: "1"
  };
  if (import_node_fs.default.existsSync(serverDistPath)) {
    console.log(`[Main] Booting production server from ${serverDistPath}...`);
    serverProcess = (0, import_node_child_process.fork)(serverDistPath, [], { env, stdio: "pipe" });
  } else if (import_node_fs.default.existsSync(serverTsPath)) {
    console.log(`[Main] Booting development server from ${serverTsPath}...`);
    const tsxCmd = process.platform === "win32" ? "tsx.cmd" : "tsx";
    const localTsx = import_node_path.default.join(appPath, "node_modules", ".bin", tsxCmd);
    if (import_node_fs.default.existsSync(localTsx)) {
      serverProcess = (0, import_node_child_process.spawn)(localTsx, ["server/index.ts"], { cwd: appPath, env, stdio: "pipe" });
    } else {
      serverProcess = (0, import_node_child_process.spawn)("npx", ["tsx", "server/index.ts"], { cwd: appPath, env, stdio: "pipe", shell: true });
    }
  } else {
    console.error("[Main] Server entry point not found!");
    return;
  }
  if (serverProcess.stdout) {
    serverProcess.stdout.on("data", (data) => console.log(`[Server]: ${data.toString().trim()}`));
  }
  if (serverProcess.stderr) {
    serverProcess.stderr.on("data", (data) => console.error(`[Server Error]: ${data.toString().trim()}`));
  }
  serverProcess.on("exit", (code, signal) => {
    console.log(`[Main] Server process exited (code: ${code}, signal: ${signal})`);
    serverProcess = null;
  });
}
function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    console.log("[Main] Stopping server process...");
    try {
      if (process.platform === "win32") {
        (0, import_node_child_process.spawn)("taskkill", ["/pid", serverProcess.pid.toString(), "/f", "/t"]);
      } else {
        serverProcess.kill("SIGTERM");
      }
    } catch (err) {
      console.error("[Main] Error stopping server process:", err);
    }
    serverProcess = null;
  }
}
async function waitForServerReady(timeoutMs = 3e4) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const isReady = await new Promise((resolve) => {
        const req = import_node_http.default.get(HEALTH_CHECK_URL, (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
        req.on("error", () => resolve(false));
        req.setTimeout(1e3, () => {
          req.destroy();
          resolve(false);
        });
      });
      if (isReady) {
        console.log("[Main] Server is ready!");
        return true;
      }
    } catch {
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}
function getLoadingHtml() {
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
async function createWindow() {
  const preloadPath = import_node_path.default.join(__dirname, "preload.js");
  mainWindow = new import_electron.BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 600,
    title: "Reindeer: FairPlay",
    backgroundColor: "#0f172a",
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  import_electron.ipcMain.handle("get-network-info", async () => getNetworkInfo());
  import_electron.ipcMain.handle("get-local-ip", async () => getLocalIpAddress());
  import_electron.ipcMain.handle("get-port", async () => parseInt(SERVER_PORT, 10));
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getLoadingHtml())}`);
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });
  const alreadyRunning = await waitForServerReady(1e3);
  if (!alreadyRunning) {
    startServer();
  }
  const ready = await waitForServerReady(35e3);
  if (ready) {
    console.log(`[Main] Loading app URL ${SERVER_URL}...`);
    mainWindow.loadURL(SERVER_URL);
  } else {
    console.error("[Main] Server failed to start within timeout.");
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <body style="background:#0f172a;color:#f87171;font-family:sans-serif;padding:40px;text-align:center;">
        <h2>Failed to connect to estate server</h2>
        <p style="color:#94a3b8;margin-top:10px;">Please restart the application.</p>
      </body>
    `)}`);
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}
import_electron.app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
import_electron.app.whenReady().then(createWindow);
import_electron.app.on("before-quit", () => {
  stopServer();
});
import_electron.app.on("window-all-closed", () => {
  stopServer();
  if (process.platform !== "darwin") {
    import_electron.app.quit();
  }
});
import_electron.app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});
