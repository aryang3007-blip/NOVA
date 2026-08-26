/**
 * AURA :: Dev Notifications
 * -------------------------
 * Top-center notification toasts for debug info, warnings, and errors.
 * Clickable for detailed traces. No side panel.
 *
 * @module ui/dev-notify
 */

import { bus, EV } from '../core/bus.js';

const CONTAINER_ID = 'dev-notify-container';
const TOAST_CLASS = 'dev-notify-toast';
const AUTO_DISMISS_MS = 4000;

/**
 * Initialize the dev notification system.
 * Call once during boot.
 */
export function initDevNotifications() {
  if (document.getElementById(CONTAINER_ID)) return;

  const container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.innerHTML = `
    <style>
      #dev-notify-container {
        position: fixed;
        top: 20px; left: 50%; transform: translateX(-50%);
        z-index: 9999;
        pointer-events: none;
      }
      .dev-notify-toast {
        pointer-events: auto;
        background: rgba(25, 25, 30, 0.98);
        border: 1px solid rgba(79, 214, 255, 0.5);
        border-radius: 8px;
        padding: 10px 16px;
        margin-bottom: 6px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        color: #e0e7ff;
        backdrop-filter: blur(12px);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        max-width: 420px;
        animation: slideDown 0.25s ease;
        cursor: pointer;
        transition: all 0.15s;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .dev-notify-toast:hover {
        border-color: rgba(79, 214, 255, 0.8);
        background: rgba(35, 35, 40, 0.99);
        box-shadow: 0 6px 24px rgba(79, 214, 255, 0.2);
      }
      .dev-notify-toast.error {
        border-color: rgba(255, 107, 129, 0.7);
      }
      .dev-notify-toast.error:hover {
        border-color: rgba(255, 107, 129, 1);
        background: rgba(50, 20, 25, 0.99);
        box-shadow: 0 6px 24px rgba(255, 107, 129, 0.2);
      }
      .dev-notify-toast.warn {
        border-color: rgba(255, 196, 107, 0.7);
      }
      .dev-notify-toast.warn:hover {
        border-color: rgba(255, 196, 107, 1);
        box-shadow: 0 6px 24px rgba(255, 196, 107, 0.2);
      }
      .dev-notify-toast.success {
        border-color: rgba(78, 242, 167, 0.7);
      }
      .dev-notify-toast.success:hover {
        border-color: rgba(78, 242, 167, 1);
        box-shadow: 0 6px 24px rgba(78, 242, 167, 0.2);
      }
      .dev-notify-icon {
        font-size: 14px;
        min-width: 16px;
        text-align: center;
      }
      .dev-notify-content {
        flex: 1;
        min-width: 0;
      }
      .dev-notify-title {
        font-weight: 600;
        color: #fff;
        margin-bottom: 2px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .dev-notify-msg {
        font-size: 12px;
        color: #c0cbda;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dev-notify-popup {
        position: fixed;
        top: 80px; left: 50%; transform: translateX(-50%);
        background: rgba(20, 20, 25, 0.99);
        border: 1px solid rgba(79, 214, 255, 0.4);
        border-radius: 8px;
        padding: 12px 16px;
        max-width: 500px;
        max-height: 60vh;
        overflow-y: auto;
        z-index: 10000;
        backdrop-filter: blur(12px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        animation: popupIn 0.25s ease;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        color: #a0adbc;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.4;
      }
      .dev-notify-popup.error {
        border-color: rgba(255, 107, 129, 0.4);
      }
      .dev-notify-popup.warn {
        border-color: rgba(255, 196, 107, 0.4);
      }
      .dev-notify-popup.success {
        border-color: rgba(78, 242, 167, 0.4);
      }
      .dev-notify-popup::-webkit-scrollbar {
        width: 6px;
      }
      .dev-notify-popup::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.05);
      }
      .dev-notify-popup::-webkit-scrollbar-thumb {
        background: rgba(79, 214, 255, 0.3);
        border-radius: 3px;
      }
      .dev-notify-popup::-webkit-scrollbar-thumb:hover {
        background: rgba(79, 214, 255, 0.5);
      }
      @keyframes slideDown {
        from { transform: translateX(-50%) translateY(-10px); opacity: 0; }
        to { transform: translateX(-50%) translateY(0); opacity: 1; }
      }
      @keyframes popupIn {
        from { transform: translateX(-50%) scale(0.95); opacity: 0; }
        to { transform: translateX(-50%) scale(1); opacity: 1; }
      }
      @keyframes slideUp {
        from { transform: translateX(-50%) translateY(0); opacity: 1; }
        to { transform: translateX(-50%) translateY(-10px); opacity: 0; }
      }
      .dev-notify-toast.removing {
        animation: slideUp 0.2s ease;
      }
    </style>
  `;
  document.body.appendChild(container);
}

let popupOpen = null;

/**
 * Show a dev notification.
 * @param {Object} opts
 * @param {string} opts.type - 'info' | 'success' | 'warn' | 'error'
 * @param {string} opts.title - Short label
 * @param {string} opts.message - Main message
 * @param {*} opts.trace - Additional trace data, shown in popup on click
 * @param {number} opts.duration - Auto-dismiss after ms (0 = no auto-dismiss)
 */
export function notify(opts) {
  const {
    type = 'info',
    title = 'Info',
    message = '',
    trace = null,
    duration = AUTO_DISMISS_MS,
  } = opts || {};

  const container = document.getElementById(CONTAINER_ID);
  if (!container) {
    console.warn('[dev-notify] not initialized');
    return;
  }

  const icons = { info: 'ℹ', error: '✕', warn: '⚠', success: '✓' };

  const toast = document.createElement('div');
  toast.className = `${TOAST_CLASS} ${type}`;
  toast.innerHTML = `
    <div class="dev-notify-icon">${icons[type] || 'ℹ'}</div>
    <div class="dev-notify-content">
      <div class="dev-notify-title">${escapeHtml(title)}</div>
      <div class="dev-notify-msg">${escapeHtml(message)}</div>
    </div>
  `;

  if (trace) {
    toast.style.cursor = 'pointer';
    toast.addEventListener('click', () => showPopup(type, title, trace));
  }

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismiss(toast), duration);
  }

  return toast;
}

function showPopup(type, title, trace) {
  if (popupOpen) popupOpen.remove();

  const traceStr = typeof trace === 'string' ? trace : JSON.stringify(trace, null, 2);
  const popup = document.createElement('div');
  popup.className = `dev-notify-popup ${type}`;
  popup.textContent = traceStr;
  popup.style.cursor = 'auto';

  popup.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(popup);

  popupOpen = popup;

  setTimeout(() => {
    document.addEventListener('click', () => {
      if (popupOpen === popup && popup.parentElement) {
        popup.remove();
        if (popupOpen === popup) popupOpen = null;
      }
    }, { once: true });
  }, 0);
}

function dismiss(toast) {
  if (!toast.parentElement) return;
  toast.classList.add('removing');
  setTimeout(() => {
    if (toast.parentElement) toast.parentElement.removeChild(toast);
  }, 200);
}

function escapeHtml(str) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return String(str).replace(/[&<>"']/g, (c) => map[c]);
}

/**
 * Hook into the event bus to auto-notify on certain events.
 */
export function hookBusEvents() {
  // Lower layers (js/ai, js/core) surface user-visible notifications through
  // this event instead of importing this module directly (layer discipline).
  bus.on('ui:notify', (opts) => { try { notify(opts); } catch {} });
  bus.on(EV.ERROR, (err) => {
    const message = err?.message || String(err);
    const trace = err?.stack || JSON.stringify(err, null, 2);
    notify({
      type: 'error',
      title: 'Error',
      message: message.slice(0, 60),
      trace,
      duration: 6000,
    });
  });

  bus.on(EV.AI_ERROR, (err) => {
    notify({
      type: 'error',
      title: 'AI Error',
      message: (err?.message || 'Model failed').slice(0, 50),
      trace: err?.details || err?.message,
      duration: 5000,
    });
  });
}

export default { initDevNotifications, notify, hookBusEvents };
