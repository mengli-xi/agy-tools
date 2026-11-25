import type { RuntimeMessage, UsageBridgeMessage, UsageFramePostMessage, UsageSnapshot } from './types';
import { parseUsageDocumentText, parseUsageGraphQL } from './usage-parser';

/**
 * Runs in ISOLATED world on https://gemini.google.com/usage* (both top-level and hidden iframe).
 * Prefers structured GraphQL payloads from usage-bridge.ts and falls back to rendered DOM text.
 */
(() => {
  let emittedSource: 'graphql' | 'dom' | null = null;
  let domTimer: number | null = null;

  const publish = (snapshot: UsageSnapshot): void => {
    if (emittedSource === 'graphql' && snapshot.source === 'dom') return;
    emittedSource = snapshot.source;

    if (domTimer !== null) {
      window.clearTimeout(domTimer);
      domTimer = null;
    }

    try {
      const runtimeMsg: RuntimeMessage = {
        type: 'GWH_USAGE_UPDATE',
        snapshot
      };
      chrome.runtime.sendMessage(runtimeMsg);
    } catch {
      // Extension context may be invalidated on reload
    }

    if (window.parent && window.parent !== window) {
      const frameMsg: UsageFramePostMessage = {
        source: 'gwh-usage-frame',
        type: 'snapshot',
        snapshot
      };
      window.parent.postMessage(frameMsg, window.location.origin);
    }
  };

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return;
    const data = event.data as Partial<UsageBridgeMessage> | null;
    if (!data || data.source !== 'gwh-usage-bridge' || data.type !== 'graphql') return;
    if (typeof data.payload !== 'string') return;

    const snapshot = parseUsageGraphQL(data.payload);
    if (snapshot) {
      publish(snapshot);
    }
  });

  const tryParseDom = (attempt: number): void => {
    if (emittedSource === 'graphql') return;

    const text = document.body?.innerText ?? '';
    const snapshot = parseUsageDocumentText(text);
    if (snapshot) {
      publish(snapshot);
      return;
    }

    if (attempt < 16) {
      domTimer = window.setTimeout(() => tryParseDom(attempt + 1), 500);
    } else if (window.parent && window.parent !== window && !emittedSource) {
      const emptyMsg: UsageFramePostMessage = {
        source: 'gwh-usage-frame',
        type: 'empty'
      };
      window.parent.postMessage(emptyMsg, window.location.origin);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      domTimer = window.setTimeout(() => tryParseDom(0), 600);
    });
  } else {
    domTimer = window.setTimeout(() => tryParseDom(0), 600);
  }
})();
