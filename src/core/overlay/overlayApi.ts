import type { OverlayEventName, OverlayHandler } from "./events";

/**
 * Minimal OverlayPlugin client: subscribes to events, calls handlers (with or without a reply), and
 * reports where the connection stands (ConnectionState) for the UI to show.
 *
 * - Embedded (inside an ACT overlay): requests go through the injected `window.OverlayPluginApi`
 *   and events arrive via `window.__OverlayCallback`.
 * - WebSocket: when the URL has `OVERLAY_WS=ws://127.0.0.1:10501/ws` (query string or after
 *   `#/...?`), connect to OverlayPlugin's WebSocket server. Used from a normal browser.
 */

interface OverlayPluginApi {
  ready: boolean;
  /**
   * Bound through CefSharp, which rejects any call that omits a declared parameter: the callback
   * MUST always be passed, or every request fails ("Missing Parameters").
   */
  callHandler(msg: string, cb: ((result: string) => void) | undefined): unknown;
}

declare global {
  interface Window {
    OverlayPluginApi?: OverlayPluginApi;
    __OverlayCallback?: (msg: { type: string }) => void;
  }
}

/** How this page talks to OverlayPlugin: decided by the URL, known from the start. */
export type ConnectionMode = "embedded" | "websocket";

/**
 * Where the connection stands. It starts "connecting": inside ACT, OverlayPlugin injects its API
 * some time after the page has loaded (when ACT itself is still starting, well after), so the
 * page cannot tell at load time whether it is inside an overlay. It becomes "disconnected" when
 * nothing has connected after CONNECT_GRACE_MS, or the WebSocket closed; the client keeps trying.
 */
export type ConnectionState = "connecting" | "connected" | "disconnected";

const CONNECT_GRACE_MS = 5000;

type AnyHandler = (event: never) => void;
const subscribers = new Map<string, Set<AnyHandler>>();
/**
 * OverlayPlugin replays its cached value of these events only when an event is first subscribed.
 * A handler added later (another page of this app, after an in-app route change) would never see
 * it, so the last value is kept here and handed to late handlers.
 */
const CACHED_EVENTS: ReadonlySet<string> = new Set(["PartyChanged", "ChangePrimaryPlayer", "ChangeZone"]);
const lastCached = new Map<string, { type: string }>();
let ws: WebSocket | null = null;
let initialized = false;
/** Until connected, subscriptions are only recorded; connecting subscribes them all at once. */
let state: ConnectionState = "connecting";
const stateListeners = new Set<(state: ConnectionState) => void>();

function setState(next: ConnectionState): void {
  if (next === state) return;
  state = next;
  for (const listener of stateListeners) listener(next);
}

const isConnected = () => state === "connected";

function overlayWsUrl(): string | null {
  const fromSearch = new URLSearchParams(window.location.search).get("OVERLAY_WS");
  if (fromSearch) return fromSearch;
  const hashQuery = window.location.hash.split("?")[1];
  return hashQuery ? new URLSearchParams(hashQuery).get("OVERLAY_WS") : null;
}

export function getConnectionMode(): ConnectionMode {
  return overlayWsUrl() ? "websocket" : "embedded";
}

export function connectionState(): ConnectionState {
  return state;
}

/** Calls `listener` on every change of the connection state (and starts connecting); returns the unsubscribe. */
export function onConnectionState(listener: (state: ConnectionState) => void): () => void {
  stateListeners.add(listener);
  ensureInitialized();
  return () => stateListeners.delete(listener);
}

type HandlerCall = { call: string; [key: string]: unknown };

function send(msg: HandlerCall): void {
  const text = JSON.stringify(msg);
  if (ws) {
    ws.send(text);
    return;
  }
  const result = window.OverlayPluginApi?.callHandler(text, () => {}) as
    | { catch?: (onRejected: (err: unknown) => void) => unknown }
    | undefined;
  // Thenable check rather than instanceof: the promise comes from CefSharp's binding layer.
  if (typeof result?.catch === "function") {
    result.catch((err) => console.error(`[overlay] ${msg.call} failed`, err));
  }
}

function subscribe(events: string[]): void {
  if (!isConnected() || events.length === 0) return;
  send({ call: "subscribe", events });
}

/**
 * Calls an OverlayPlugin handler whose reply is not needed. Dropped while not connected: these
 * are momentary effects (speech), not state that must arrive later.
 */
export function callOverlayHandler(msg: HandlerCall): void {
  if (isConnected()) send(msg);
}

let nextRseq = 1;
const replies = new Map<number, (value: unknown) => void>();

/**
 * Calls an OverlayPlugin handler and resolves with its reply, or undefined if the call fails or no
 * reply arrives within `timeoutMs` (waiting for the connection counts). Embedded, CefSharp hands
 * the reply to the callback as a JSON string; over WebSocket the reply carries the request's `rseq`.
 */
export function requestOverlayHandler<T>(msg: HandlerCall, timeoutMs = 5000): Promise<T | undefined> {
  ensureInitialized();
  return new Promise((resolve) => {
    let done = false;
    const timer = window.setTimeout(() => finish(undefined), timeoutMs);
    function finish(value: unknown): void {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve(value as T | undefined);
    }
    const attempt = () => {
      if (done) return;
      if (!isConnected()) {
        window.setTimeout(attempt, 300);
        return;
      }
      if (ws) {
        const rseq = nextRseq++;
        replies.set(rseq, (value) => {
          replies.delete(rseq);
          finish(value);
        });
        ws.send(JSON.stringify({ ...msg, rseq }));
        return;
      }
      try {
        const result = window.OverlayPluginApi?.callHandler(JSON.stringify(msg), (raw) => {
          try {
            finish(typeof raw === "string" ? JSON.parse(raw) : raw);
          } catch {
            finish(undefined);
          }
        }) as { catch?: (onRejected: (err: unknown) => void) => unknown } | undefined;
        if (typeof result?.catch === "function") result.catch(() => finish(undefined));
      } catch {
        finish(undefined);
      }
    };
    attempt();
  });
}

/** Speaks through ACT's text-to-speech (OverlayPlugin `say` → ActGlobals.oFormActMain.TTS). */
export function say(text: string): void {
  if (text) callOverlayHandler({ call: "say", text });
}

function dispatch(msg: { type: string }): void {
  if (CACHED_EVENTS.has(msg.type)) lastCached.set(msg.type, msg);
  const handlers = subscribers.get(msg.type);
  if (!handlers) return;
  for (const h of handlers) {
    try {
      (h as (e: unknown) => void)(msg);
    } catch (err) {
      console.error(`[overlay] handler for ${msg.type} failed`, err);
    }
  }
}

function onConnected(): void {
  setState("connected");
  subscribe([...subscribers.keys()]);
}

function connectWebSocket(url: string): void {
  ws = new WebSocket(url);
  ws.addEventListener("open", onConnected);
  ws.addEventListener("message", (e) => {
    try {
      const data = JSON.parse(String(e.data)) as { type?: string; rseq?: number };
      if (typeof data.rseq === "number" && replies.has(data.rseq)) replies.get(data.rseq)!(data);
      else if (data.type) dispatch(data as { type: string });
    } catch (err) {
      console.error("[overlay] bad websocket message", err);
    }
  });
  ws.addEventListener("close", () => {
    setState("disconnected");
    window.setTimeout(() => connectWebSocket(url), 1000);
  });
}

/** Polls for the API OverlayPlugin injects; gives the "disconnected" verdict after the grace time, keeps polling. */
function waitForEmbeddedApi(since: number): void {
  if (!window.OverlayPluginApi?.ready) {
    if (Date.now() - since >= CONNECT_GRACE_MS) setState("disconnected");
    window.setTimeout(() => waitForEmbeddedApi(since), 300);
    return;
  }
  window.__OverlayCallback = dispatch;
  onConnected();
}

export function addOverlayListener<E extends OverlayEventName>(event: E, handler: OverlayHandler<E>): void {
  let set = subscribers.get(event);
  if (!set) {
    set = new Set();
    subscribers.set(event, set);
    subscribe([event]); // no-op until connected
  } else {
    const last = lastCached.get(event);
    const handlers = set;
    // Asynchronous, like OverlayPlugin's own replay; skipped if the handler was removed meanwhile.
    if (last) window.setTimeout(() => handlers.has(handler as AnyHandler) && handler(last as never), 0);
  }
  set.add(handler as AnyHandler);
  ensureInitialized();
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  const url = overlayWsUrl();
  if (url) connectWebSocket(url);
  else waitForEmbeddedApi(Date.now());
}

/** Detaches a handler (a page being unmounted). The OverlayPlugin subscription itself stays. */
export function removeOverlayListener<E extends OverlayEventName>(event: E, handler: OverlayHandler<E>): void {
  subscribers.get(event)?.delete(handler as AnyHandler);
}
