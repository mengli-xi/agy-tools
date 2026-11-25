import { STORAGE_KEY_USAGE, type RuntimeMessage, type UsageSnapshot } from './types';

chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
  const message = rawMessage as Partial<RuntimeMessage> | null;
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'GWH_USAGE_UPDATE' && message.snapshot) {
    const snapshot: UsageSnapshot = message.snapshot;
    chrome.storage.local.set({ [STORAGE_KEY_USAGE]: snapshot }, () => {
      // Broadcast to all open Gemini chat tabs so they update immediately
      chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
        for (const tab of tabs) {
          if (typeof tab.id === 'number') {
            chrome.tabs.sendMessage(tab.id, { type: 'GWH_USAGE_UPDATE', snapshot }, () => {
              // Ignore tabs without active content script (e.g. /usage itself)
              void chrome.runtime.lastError;
            });
          }
        }
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'GWH_GET_USAGE') {
    chrome.storage.local.get(STORAGE_KEY_USAGE, (items) => {
      sendResponse({ snapshot: (items[STORAGE_KEY_USAGE] as UsageSnapshot | undefined) ?? null });
    });
    return true;
  }
});
