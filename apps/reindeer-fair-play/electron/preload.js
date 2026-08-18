"use strict";
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("electronAPI", {
  getNetworkInfo: () => import_electron.ipcRenderer.invoke("get-network-info"),
  getLocalIp: () => import_electron.ipcRenderer.invoke("get-local-ip"),
  getPort: () => import_electron.ipcRenderer.invoke("get-port")
});
window.addEventListener("DOMContentLoaded", async () => {
  try {
    let render2 = function() {
      wrapper.className = `wifi-badge ${isCollapsed ? "collapsed" : ""}`;
      wrapper.innerHTML = `
        <div class="header">
          <div class="title-group">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
              <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
              <line x1="12" y1="20" x2="12.01" y2="20"></line>
            </svg>
            <span>Family WiFi Connect</span>
          </div>
          <button class="toggle-btn" id="overlay-toggle" title="${isCollapsed ? "Expand" : "Collapse"}">
            ${isCollapsed ? "+" : "\u2212"}
          </button>
        </div>
        <div class="body">
          <div class="url-box">${info.connectUrl}</div>
          ${info.qrCodeUrl ? `
            <div class="qr-container">
              <img class="qr-img" src="${info.qrCodeUrl}" alt="Scan QR Code" />
              <div class="subtext">Scan with phone camera to join estate session on WiFi</div>
            </div>
          ` : ""}
        </div>
      `;
      const toggleBtn = wrapper.querySelector("#overlay-toggle");
      toggleBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        isCollapsed = !isCollapsed;
        render2();
      });
    };
    var render = render2;
    const info = await import_electron.ipcRenderer.invoke("get-network-info");
    if (!info || !info.connectUrl) return;
    const container = document.createElement("div");
    container.id = "legacy-wifi-overlay-container";
    const shadow = container.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .wifi-badge {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 999999;
        background: #0f172a;
        color: #f8fafc;
        border: 1px solid #334155;
        border-radius: 12px;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
        padding: 12px 16px;
        width: 260px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        line-height: 1.4;
        transition: all 0.2s ease-in-out;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-weight: 600;
        margin-bottom: 8px;
        color: #38bdf8;
      }
      .title-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .toggle-btn {
        background: transparent;
        border: none;
        color: #94a3b8;
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
        line-height: 1;
      }
      .toggle-btn:hover {
        color: #ffffff;
      }
      .url-box {
        background: #1e293b;
        padding: 6px 10px;
        border-radius: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 12px;
        color: #38bdf8;
        word-break: break-all;
        margin-bottom: 8px;
        border: 1px solid #334155;
        text-align: center;
        user-select: all;
      }
      .qr-container {
        display: flex;
        flex-direction: column;
        align-items: center;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid #334155;
      }
      .qr-img {
        width: 128px;
        height: 128px;
        border-radius: 8px;
        background: #ffffff;
        padding: 4px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      .subtext {
        font-size: 11px;
        color: #94a3b8;
        text-align: center;
        margin-top: 6px;
      }
      .collapsed .body {
        display: none;
      }
      .collapsed {
        width: auto;
        padding: 8px 12px;
      }
      .collapsed .header {
        margin-bottom: 0;
      }
    `;
    const wrapper = document.createElement("div");
    let isCollapsed = false;
    render2();
    shadow.appendChild(style);
    shadow.appendChild(wrapper);
    document.body.appendChild(container);
  } catch (err) {
    console.error("[Preload] Failed to inject family connect overlay:", err);
  }
});
