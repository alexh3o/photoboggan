// Window chrome: first display of the window, title bar buttons and immersive mode (F11).
// What needs the state of main.js stays there and is injected: the chain of confirmations before closing, and the toolbar menu entry that calls
// the immersive toggle.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { t, onLanguageChange } from './i18n.js';

// `confirmClose()`: async, resolves to true when the window may close (main.js asks about running tasks, unsaved smart album filters and
// pending metadata edits, in this order).
// `exposeImmersiveToggle(toggle)`: called once the DOM is ready, with the function that enters / leaves immersive mode (used by the toolbar menu).
export function initTitleBar({ confirmClose, exposeImmersiveToggle }) {
  // WINDOW DISPLAY: created hidden (tauri.conf.json) so that the raw HTML is never shown. The app has already applied theme, language and styles
  // at DOMContentLoaded, so we wait for two frames (first styled render painted) before showing it. A safety net exists on the Rust side (main.rs).
  window.addEventListener('DOMContentLoaded', () => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      getCurrentWindow().show().catch(err => console.error("Window show failed:", err));
    }));
  });

  // TITLE BAR
  window.addEventListener('DOMContentLoaded', () => {
    const appWindow = getCurrentWindow();
    console.log("Tauri window initialized for the title bar");

    document.getElementById('titlebar-minimize')?.addEventListener('click', () => {
      console.log("Clic sur Minimiser");
      appWindow.minimize().catch(err => console.error("Window minimize failed:", err));
    });

    document.getElementById('titlebar-maximize')?.addEventListener('click', async () => {
      console.log("Clic sur Maximiser");
      try {
        const isMax = await appWindow.isMaximized();
        if (isMax) {
          await appWindow.unmaximize();
        } else {
          await appWindow.maximize();
        }
        await syncWindowState();
      } catch (err) {
        console.error("Window maximize/unmaximize failed:", err);
      }
    });

    document.getElementById('titlebar-close')?.addEventListener('click', () => {
      console.log("Clic sur Fermer");
      appWindow.close().catch(err => console.error("Window close failed:", err));
    });

    // Closing by any means (button, Alt+F4, system menu): unwritten keywords, titles or descriptions, or a write in progress, ask for confirmation
    // (see metadata-writes.js). Without preventDefault, the API closes the window afterwards (permission core:window:allow-destroy).
    appWindow.onCloseRequested(async event => {
      if (!(await confirmClose())) event.preventDefault();
    }).catch(err => console.error("Close-request handler failed:", err));

    // Icon of the Maximize / Restore button from the real state of the window (it also changes outside the button: double-click on the bar, Windows shortcuts).
    const maximizeButton = document.getElementById('titlebar-maximize');
    const MAXIMIZE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>';
    const RESTORE_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor"/><rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor"/></svg>';
    let windowMaximized = false;

    function renderMaximizeButton() {
      if (!maximizeButton) return;
      const label = t(windowMaximized ? 'Restore down' : 'Maximize');
      maximizeButton.innerHTML = windowMaximized ? RESTORE_ICON : MAXIMIZE_ICON;
      maximizeButton.title = label;
      maximizeButton.setAttribute('aria-label', label);
    }

    // Reads the state of the window: Maximize / Restore icon, and title bar hidden in immersive mode (window full screen).
    async function syncWindowState() {
      try {
        const [maximized, fullscreen] = await Promise.all([appWindow.isMaximized(), appWindow.isFullscreen()]);
        windowMaximized = maximized;
        renderMaximizeButton();
        document.body.classList.toggle('immersive', fullscreen);
      } catch (err) {
        console.error("Window state read failed:", err);
      }
    }

    let windowStateSyncScheduled = false;
    appWindow.onResized(() => {
      if (windowStateSyncScheduled) return;
      windowStateSyncScheduled = true;
      requestAnimationFrame(() => {
        windowStateSyncScheduled = false;
        syncWindowState();
      });
    }).catch(err => console.error("Resize tracking failed:", err));
    onLanguageChange(renderMaximizeButton);
    renderMaximizeButton();
    syncWindowState();

    // IMMERSIVE MODE (F11): window in full screen, over the taskbar, without title bar.
    // F11 enters and leaves it.
    // Not to be confused with the full screen of a photo (key F, double-click).
    let immersiveToggleRunning = false;
    let maximizedBeforeImmersive = false;
    async function toggleImmersiveMode() {
      if (immersiveToggleRunning) return;
      immersiveToggleRunning = true;
      try {
        if (await appWindow.isFullscreen()) {
          await appWindow.setFullscreen(false);
          if (maximizedBeforeImmersive) await appWindow.maximize();
          maximizedBeforeImmersive = false;
        } else {
          // Undecorated maximized window: full screen does not resize the web area (it keeps the size of the work area, without the taskbar).
          // So the window is restored first, then maximized again when leaving immersive mode.
          maximizedBeforeImmersive = await appWindow.isMaximized();
          if (maximizedBeforeImmersive) await appWindow.unmaximize();
          await appWindow.setFullscreen(true);
        }
        await syncWindowState();
      } catch (err) {
        console.error("Immersive mode failed:", err);
      } finally {
        immersiveToggleRunning = false;
      }
    }

    exposeImmersiveToggle(toggleImmersiveMode);

    // This shortcut stays active even when an input field has the focus (the main key handler ignores them).
    window.addEventListener('keydown', event => {
      if (event.key !== 'F11') return;
      event.preventDefault();
      if (!event.repeat) toggleImmersiveMode();
    });
  });
}
