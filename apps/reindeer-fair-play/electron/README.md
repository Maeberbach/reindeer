# Reindeer FairPlay — Desktop Electron App

This directory contains the Electron wrapper that packages **Reindeer: FairPlay** into standalone desktop applications for **Windows (.exe installer)** and **macOS (.dmg)**.

---

## 🏗️ Architecture

- **Main Process (`electron/main.ts`)**:
  - Boots the Express backend server (`dist/index.cjs` in production, or `server/index.ts` via `tsx` in dev).
  - Enforces a single instance lock so only one estate session runs at a time.
  - Displays a splash loading screen while polling `http://localhost:5000/api/state`.
  - Creates the native application window once the server is ready.
  - Automatically terminates the server process on app exit.

- **Preload Script (`electron/preload.ts`)**:
  - Exposes local network configuration to the window via `window.electronAPI`.
  - Injects a floating Shadow DOM banner and QR Code overlay so family members on the same local WiFi network can easily scan and connect from their mobile phones.

- **Builder Config (`electron-builder.json`)**:
  - Bundles Vite frontend assets, Express backend, and runtime `node_modules`.
  - Targets Windows NSIS installer (`.exe`) and macOS Disk Image (`.dmg`).

---

## 🚀 Development

To run the desktop application in development mode with hot-reloading backend & frontend:

```bash
npm run electron:dev
```

This command will:
1. Compile `electron/main.ts` and `electron/preload.ts` to CommonJS (`electron/main.js`, `electron/preload.js`).
2. Concurrently boot the Express/Vite development server and launch Electron.

---

## 📦 Packaging & Building Installers

### Windows (.exe Installer)
To build the Windows NSIS installer:
```bash
npm run electron:build:win
```
The resulting `.exe` installer will be located in the `dist-electron/` folder.

### macOS (.dmg Installer)
To build the macOS DMG disk image:
```bash
npm run electron:build:mac
```
The resulting `.dmg` installer will be located in the `dist-electron/` folder.

---

## 🎨 Icon Customization

Application icons belong in the `resources/` directory:
- `resources/icon.ico` — Windows application icon (256x256 ICO format)
- `resources/icon.icns` — macOS application icon (1024x1024 ICNS format)
- `resources/icon.png` — General PNG fallback (512x512 PNG format)

---

## 📱 WiFi Family Connectivity

When running the application, a **Family WiFi Connect** badge appears in the bottom-right corner of the window.
- Shows the local network IP address (e.g., `http://192.168.1.50:5000`).
- Generates a QR code for mobile devices.
- Family members connected to the same home WiFi can scan the QR code to participate in the estate selection session from their phones.
