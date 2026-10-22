// A tapped notification, on the page's side (public/push-handler.js is the worker's;
// kept apart from agent-chat.js so it stays generic). The worker
// posts the address to an open window, because a standalone iOS window cannot always
// be navigated, and leaves it in a cache as well: an iPhone home-screen app reopened
// from the background, or started cold, can get neither the address nor the message.
// What an address opens is the product's: `fromMessage` and `fromCache` are given it.
import { PRODUCT } from './productConfig.js';

const INTENT_KEY = '/__intent';
// A tap older than this is not followed: an old tap must not pull the reader away later.
const INTENT_MAX_AGE_MS = 120000;
// Coming back to the front is when a tap that only raised the app shows up. iOS can
// wake the page before the worker has written the tap, and the worker's message to a
// page just waking can be lost: the tap then did nothing. So the page looks again for a few seconds after waking.
const WAKE_LOOKS_MS = [0, 400, 1200, 2500, 4000];

// fromMessage(url: URL): a tap posted by the worker, on this origin.
// fromCache(href: string): a tap left in the cache, looked at only when canOpen().
export function createNotificationOpener({ fromMessage, fromCache, canOpen = () => true, scope = globalThis, now = () => Date.now() }) {
  // When the newest tap the page has acted on was made. The worker leaves every tap in
  // the cache and also posts it; a tap the message already opened stayed there, and
  // the next time the app came to the front it pulled the reader back to that older
  // address, or won the race against a newer tap. A
  // tap no newer than this is done.
  let handledTapAt = 0;
  let looks = [];

  function onMessage(event) {
    const data = event?.data;
    if (!data || data.type !== 'open-url' || typeof data.url !== 'string') return undefined;
    let target;
    try { target = new URL(data.url, scope.location.origin); } catch { return undefined; }
    if (target.origin !== scope.location.origin) return undefined;
    // The worker wrote this tap to the cache before posting it: it is handled here.
    const at = Number.isFinite(data.at) ? data.at : now();
    if (at < handledTapAt) return undefined;
    handledTapAt = at;
    return fromMessage(target);
  }

  // Read once, then cleared, and ignored when stale or already handled.
  async function takeIntent() {
    try {
      const cache = await scope.caches.open(PRODUCT.intentCache);
      const stored = await cache.match(INTENT_KEY);
      if (!stored) return null;
      await cache.delete(INTENT_KEY);
      const intent = await stored.json();
      if (!intent || typeof intent.url !== 'string') return null;
      if (!Number.isFinite(intent.at) || now() - intent.at > INTENT_MAX_AGE_MS || intent.at <= handledTapAt) return null;
      handledTapAt = intent.at;
      return intent.url;
    } catch {
      return null;
    }
  }
  async function look() {
    if (!canOpen()) return;
    const url = await takeIntent();
    if (url) await fromCache(url);
  }

  function lookAfterWaking() {
    looks.forEach((timer) => scope.clearTimeout(timer));
    looks = WAKE_LOOKS_MS.map((ms) => scope.setTimeout(() => { if (scope.document?.visibilityState === 'visible') look(); }, ms));
  }
  const onVisible = () => { if (scope.document?.visibilityState !== 'hidden') lookAfterWaking(); };

  function start() {
    scope.navigator?.serviceWorker?.addEventListener?.('message', onMessage);
    scope.document?.addEventListener?.('visibilitychange', onVisible);
    // Some builds raise a backgrounded home-screen app with focus alone.
    scope.addEventListener?.('focus', lookAfterWaking);
  }
  function stop() {
    scope.navigator?.serviceWorker?.removeEventListener?.('message', onMessage);
    scope.document?.removeEventListener?.('visibilitychange', onVisible);
    scope.removeEventListener?.('focus', lookAfterWaking);
    looks.forEach((timer) => scope.clearTimeout(timer));
    looks = [];
  }
  return { start, stop, look, onMessage, lookAfterWaking };
}
