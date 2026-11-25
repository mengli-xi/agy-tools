import type { UsageBridgeMessage } from './types';

/**
 * Runs in MAIN world on https://gemini.google.com/usage* at document_start.
 * Passively clones GraphQL/usage responses without modifying page traffic.
 */
(() => {
  const GUARD_KEY = '__gwhUsageBridgeInstalled';
  const win = window as unknown as Record<string, unknown>;
  if (win[GUARD_KEY]) return;
  win[GUARD_KEY] = true;

  const isUsageUrl = (url: string): boolean => {
    return (
      url.includes('GEMINI_WEB_GRAPHQL') ||
      url.includes('executeQuery') ||
      url.includes('GetUsageInfo') ||
      url.includes('getUsageInfo') ||
      url.includes('UsagePageQuery')
    );
  };

  const looksLikeUsagePayload = (text: string): boolean => {
    return (
      text.includes('getUsageInfo') ||
      text.includes('GXU_FIVE_HOURLY') ||
      text.includes('GXU_WEEKLY') ||
      text.includes('percentageUsed')
    );
  };

  const emitPayload = (payload: string): void => {
    if (!looksLikeUsagePayload(payload)) return;
    const msg: UsageBridgeMessage = {
      source: 'gwh-usage-bridge',
      type: 'graphql',
      payload
    };
    window.postMessage(msg, window.location.origin);
  };

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const response = await origFetch(...args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : req instanceof Request ? req.url : String(req);
      if (isUsageUrl(url)) {
        response
          .clone()
          .text()
          .then(emitPayload)
          .catch(() => {});
      }
    } catch {
      // Never interfere with page fetch
    }
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const xhrUrlMap = new WeakMap<XMLHttpRequest, string>();

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    try {
      xhrUrlMap.set(this, typeof url === 'string' ? url : url.toString());
    } catch {
      // ignore
    }
    return origOpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    try {
      const url = xhrUrlMap.get(this) ?? '';
      if (isUsageUrl(url)) {
        this.addEventListener('load', () => {
          try {
            if (typeof this.responseText === 'string') {
              emitPayload(this.responseText);
            }
          } catch {
            // ignore
          }
        });
      }
    } catch {
      // ignore
    }
    return origSend.call(this, body);
  };
})();
