import {
  resolveAccountScope,
  type RuntimeMessage,
  type UsageBridgeMessage,
  type UsageFailureReason,
  type UsageFramePostMessage,
  type UsageSnapshot
} from './types';
import {
  inspectUsageGraphQL,
  isUsagePathname,
  parseUsageDocumentText,
  parseUsageFromInlineScripts
} from './usage-parser';

/**
 * Runs in ISOLATED world on https://gemini.google.com/* (all_frames).
 * - On /usage or /u/<n>/usage (top-level or hidden iframe): extracts real quota via GraphQL, inline SSR scripts, or DOM.
 * - Inside a hidden iframe when Google redirects /usage -> /app: immediately reports the redirect reason to parent.
 */
(() => {
  const inIframe = Boolean(window.parent && window.parent !== window);
  if (!inIframe && !isUsagePathname(window.location.pathname)) {
    return;
  }

  let emittedSource: 'graphql' | 'dom' | null = null;
  let reportedEmpty = false;
  let domTimer: number | null = null;

  const postEmptyToParent = (reason: UsageFailureReason, detail?: string): void => {
    if (!inIframe || emittedSource || reportedEmpty) return;
    reportedEmpty = true;
    const emptyMsg: UsageFramePostMessage = {
      source: 'gwh-usage-frame',
      type: 'empty',
      reason,
      ...(detail ? { detail } : {})
    };
    window.parent.postMessage(emptyMsg, window.location.origin);
  };

  if (!isUsagePathname(window.location.pathname)) {
    // Subframe already landed on /app or another non-usage route (server redirect)
    window.setTimeout(() => {
      if (!isUsagePathname(window.location.pathname)) {
        postEmptyToParent('redirected_to_app', window.location.pathname);
      }
    }, 150);
    return;
  }

  const { accountKey } = resolveAccountScope(window.location.pathname);

  const publish = (rawSnapshot: UsageSnapshot): void => {
    if (emittedSource === 'graphql' && rawSnapshot.source === 'dom') return;
    emittedSource = rawSnapshot.source;
    const snapshot: UsageSnapshot = { ...rawSnapshot, accountKey };

    if (domTimer !== null) {
      window.clearTimeout(domTimer);
      domTimer = null;
    }

    try {
      const runtimeMsg: RuntimeMessage = {
        type: 'GWH_USAGE_UPDATE',
        accountKey,
        snapshot
      };
      chrome.runtime.sendMessage(runtimeMsg);
    } catch {
      // Extension context may be invalidated on reload
    }

    if (inIframe) {
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

    const inspected = inspectUsageGraphQL(data.payload);
    if (inspected.snapshot) {
      publish(inspected.snapshot);
    } else if (inspected.canSeeUsageLimits === false) {
      postEmptyToParent('feature_gate_disabled', 'canSeeUsageLimits=false');
    }
  });

  const tryExtractFromScripts = (): boolean => {
    if (emittedSource) return true;
    const scripts = Array.from(document.querySelectorAll('script')).map((s) => s.textContent || '');
    const snap = parseUsageFromInlineScripts(scripts);
    if (snap) {
      publish(snap);
      return true;
    }
    return false;
  };

  const tryParseDom = (attempt: number): void => {
    if (emittedSource === 'graphql') return;

    // Detect client-side SPA redirect away from /usage -> /app
    if (!isUsagePathname(window.location.pathname)) {
      postEmptyToParent('redirected_to_app', window.location.pathname);
      return;
    }

    if (tryExtractFromScripts()) {
      return;
    }

    const text = document.body?.innerText ?? '';
    if (/(sign\s*in\s*to\s*continue|登录以继续|请先登录)/i.test(text) && text.length < 600) {
      postEmptyToParent('login_required');
      return;
    }

    const snapshot = parseUsageDocumentText(text);
    if (snapshot) {
      publish(snapshot);
      return;
    }

    if (attempt < 16) {
      domTimer = window.setTimeout(() => tryParseDom(attempt + 1), 500);
    } else {
      postEmptyToParent('no_pools_in_page', window.location.pathname);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (!tryExtractFromScripts()) {
        domTimer = window.setTimeout(() => tryParseDom(0), 500);
      }
    });
  } else if (!tryExtractFromScripts()) {
    domTimer = window.setTimeout(() => tryParseDom(0), 500);
  }
})();
