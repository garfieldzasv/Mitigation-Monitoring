import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression test for the ACT failure: OverlayPlugin's `callHandler` is a CefSharp binding that
 * rejects any call missing a declared parameter, so every subscribe failed and nothing rendered.
 */
interface StrictApi {
  ready: boolean;
  calls: { msg: Record<string, unknown>; argCount: number }[];
  callHandler: (...args: unknown[]) => Promise<null>;
}

function strictApi(): StrictApi {
  const api: StrictApi = {
    ready: false,
    calls: [],
    callHandler(...args: unknown[]) {
      api.calls.push({ msg: JSON.parse(String(args[0])), argCount: args.length });
      if (args.length < 2) return Promise.reject(new Error("Missing Parameters: 1"));
      return Promise.resolve(null);
    },
  };
  return api;
}

let api: StrictApi;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  api = strictApi();
  vi.stubGlobal("window", {
    OverlayPluginApi: api,
    location: { search: "", hash: "#/" },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("overlayApi (embedded / CefSharp)", () => {
  it("always passes the callback and subscribes once all early listeners are known", async () => {
    const { addOverlayListener } = await import("@/core/overlay/overlayApi");
    addOverlayListener("PartyChanged", () => {});
    addOverlayListener("LogLine", () => {});
    expect(api.calls).toHaveLength(0); // API not ready yet: queued

    api.ready = true;
    vi.advanceTimersByTime(300);
    expect(api.calls).toEqual([{ msg: { call: "subscribe", events: ["PartyChanged", "LogLine"] }, argCount: 2 }]);

    addOverlayListener("ChangeZone", () => {});
    expect(api.calls.at(-1)).toEqual({ msg: { call: "subscribe", events: ["ChangeZone"] }, argCount: 2 });
  });

  it("delivers events from __OverlayCallback to listeners", async () => {
    const { addOverlayListener } = await import("@/core/overlay/overlayApi");
    const seen: unknown[] = [];
    api.ready = true;
    addOverlayListener("ChangeZone", (e) => seen.push(e.zoneID));
    (window as unknown as { __OverlayCallback: (m: unknown) => void }).__OverlayCallback({ type: "ChangeZone", zoneID: 7 });
    expect(seen).toEqual([7]);
  });

  it("a handler added after the first subscription still gets the last cached event (in-app route change)", async () => {
    const { addOverlayListener, removeOverlayListener } = await import("@/core/overlay/overlayApi");
    const callback = () => (window as unknown as { __OverlayCallback: (m: unknown) => void }).__OverlayCallback;
    api.ready = true;
    addOverlayListener("PartyChanged", () => {});
    addOverlayListener("LogLine", () => {});
    vi.advanceTimersByTime(300);
    callback()({ type: "PartyChanged", party: [{ id: "10000001" }] });
    callback()({ type: "LogLine", line: ["21"] });
    const subscribeCalls = api.calls.length;

    const party: unknown[] = [];
    const logs: unknown[] = [];
    const late = (e: { party: unknown[] }) => party.push(e.party.length);
    addOverlayListener("PartyChanged", late);
    addOverlayListener("LogLine", (e) => logs.push(e.line));
    expect(party).toEqual([]); // replayed asynchronously
    vi.advanceTimersByTime(0);
    expect(party).toEqual([1]);
    expect(logs).toEqual([]); // LogLine is a stream, never replayed
    expect(api.calls).toHaveLength(subscribeCalls); // no second subscribe

    removeOverlayListener("PartyChanged", late);
    callback()({ type: "PartyChanged", party: [] });
    expect(party).toEqual([1]);
  });

  it("requestOverlayHandler: waits for the API, passes a callback, parses the JSON reply", async () => {
    const { requestOverlayHandler } = await import("@/core/overlay/overlayApi");
    api.callHandler = (...args: unknown[]) => {
      api.calls.push({ msg: JSON.parse(String(args[0])), argCount: args.length });
      (args[1] as (raw: string) => void)(JSON.stringify({ combatants: [{ ID: 268_500_000, Name: "P1" }] }));
      return Promise.resolve(null);
    };
    const reply = requestOverlayHandler<{ combatants: { Name: string }[] }>({ call: "getCombatants" });
    expect(api.calls).toHaveLength(0); // not ready yet
    api.ready = true;
    vi.advanceTimersByTime(300);
    await expect(reply).resolves.toEqual({ combatants: [{ ID: 268_500_000, Name: "P1" }] });
    expect(api.calls.find((c) => c.msg.call === "getCombatants")?.argCount).toBe(2);
  });

  it("requestOverlayHandler: resolves undefined when nothing answers in time", async () => {
    const { requestOverlayHandler } = await import("@/core/overlay/overlayApi");
    const reply = requestOverlayHandler({ call: "getCombatants" }, 1000);
    vi.advanceTimersByTime(1000);
    await expect(reply).resolves.toBeUndefined();
  });

  it("connection state: connecting until OverlayPlugin injects its API after the page loaded (ACT starting up)", async () => {
    const w = window as unknown as { OverlayPluginApi?: StrictApi };
    delete w.OverlayPluginApi;
    const { connectionState, onConnectionState } = await import("@/core/overlay/overlayApi");
    const seen: string[] = [];
    onConnectionState((s) => seen.push(s));
    expect(connectionState()).toBe("connecting");
    vi.advanceTimersByTime(3000);
    expect(connectionState()).toBe("connecting"); // still within the grace time
    w.OverlayPluginApi = api;
    api.ready = true;
    vi.advanceTimersByTime(300);
    expect(connectionState()).toBe("connected");
    expect(seen).toEqual(["connected"]);
  });

  it("connection state: disconnected after 5 s without an API, connected as soon as it shows up", async () => {
    const w = window as unknown as { OverlayPluginApi?: StrictApi };
    delete w.OverlayPluginApi;
    const { connectionState, onConnectionState } = await import("@/core/overlay/overlayApi");
    const seen: string[] = [];
    onConnectionState((s) => seen.push(s));
    vi.advanceTimersByTime(5100);
    expect(connectionState()).toBe("disconnected");
    w.OverlayPluginApi = api;
    api.ready = true;
    vi.advanceTimersByTime(300);
    expect(seen).toEqual(["disconnected", "connected"]);
  });

  it("say: calls the handler with the callback, only once connected", async () => {
    const { addOverlayListener, say } = await import("@/core/overlay/overlayApi");
    addOverlayListener("LogLine", () => {});
    say("雪仇"); // not connected yet: dropped, not queued
    api.ready = true;
    vi.advanceTimersByTime(300);
    say("雪仇");
    say("");
    expect(api.calls.filter((c) => c.msg.call === "say")).toEqual([{ msg: { call: "say", text: "雪仇" }, argCount: 2 }]);
  });
});
