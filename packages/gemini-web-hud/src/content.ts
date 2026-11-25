import { detectDarkTheme } from './dom-utils';
import { TocController } from './toc';
import { UsageBarController } from './usage-bar';

(() => {
  const GUARD_KEY = '__gwhContentMounted';
  const win = window as unknown as Record<string, unknown>;
  if (win[GUARD_KEY]) return;
  win[GUARD_KEY] = true;

  // Never mount chat HUD inside /usage page or subframes
  if (window.top !== window || window.location.pathname.startsWith('/usage')) {
    return;
  }

  const toc = new TocController();
  const usageBar = new UsageBarController();

  const syncTheme = (): void => {
    const isDark = detectDarkTheme();
    toc.setTheme(isDark);
    usageBar.setTheme(isDark);
  };

  const boot = (): void => {
    toc.mount();
    usageBar.mount();
    syncTheme();

    // Watch body/html class changes for Gemini light/dark theme toggle
    const themeObserver = new MutationObserver(() => syncTheme());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    });
    if (document.body) {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style']
      });
    }

    // Watch SPA route changes on gemini.google.com/app/*
    let lastHref = window.location.href;
    window.setInterval(() => {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href;
        toc.onRouteChange();
        usageBar.onRouteChange();
      }
    }, 450);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
