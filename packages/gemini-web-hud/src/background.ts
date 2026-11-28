import {
  STORAGE_KEY_USAGE,
  type RuntimeMessage,
  type UsageSnapshot
} from './types';

function storageKeyForAccount(accountKey?: string): string {
  const clean = accountKey && /^u\d+$/.test(accountKey) ? accountKey : 'u0';
  return clean === 'u0' ? STORAGE_KEY_USAGE : `${STORAGE_KEY_USAGE}_${clean}`;
}

chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
  const message = rawMessage as Partial<RuntimeMessage> | null;
  if (!message || typeof message.type !== 'string') return;

  if (message.type === 'GWH_USAGE_UPDATE' && message.snapshot) {
    const accountKey = message.accountKey ?? message.snapshot.accountKey ?? 'u0';
    const snapshot: UsageSnapshot = { ...message.snapshot, accountKey };
    const key = storageKeyForAccount(accountKey);
    chrome.storage.local.set({ [key]: snapshot }, () => {
      // Broadcast to all open Gemini chat tabs so tabs of the same account update immediately
      chrome.tabs.query({ url: 'https://gemini.google.com/*' }, (tabs) => {
        for (const tab of tabs) {
          if (typeof tab.id === 'number') {
            chrome.tabs.sendMessage(
              tab.id,
              { type: 'GWH_USAGE_UPDATE', accountKey, snapshot },
              () => {
                void chrome.runtime.lastError;
              }
            );
          }
        }
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'GWH_GET_USAGE') {
    const key = storageKeyForAccount(message.accountKey);
    chrome.storage.local.get(key, (items) => {
      sendResponse({ snapshot: (items[key] as UsageSnapshot | undefined) ?? null });
    });
    return true;
  }
});
