// The README's screenshots (screenshots/*.png), from the fixtures in headless Chrome as the smoke test runs the built
// app: moments with many mitigations up. P1, P2… are the fixtures' anonymised players. Run: pnpm screenshots
//
// - monitor: 格莱杨拉波尔 played up to 无尽狂奔 at 04:09, under 节制 and the party's mitigations
// - review: that hit in 受伤明细, its detail open
// - timeline: the same moment
// - death-replay: 护锁刃龙's P5 at 03:56, killed by 龙光扩散 through three mitigations
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "../..");
const base = pathToFileURL(join(root, "dist/index.html")).href;
const out = join(root, "screenshots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- fixtures → OverlayPlugin messages (as the smoke test) ----------
const fixture = (name) =>
  gunzipSync(readFileSync(join(root, "tests/fixtures", name)))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("|"));
const hunt = fixture("hunt-8p.log.gz");
const trial = fixture("trial-phases.log.gz");
const combatants = new Map(hunt.filter((l) => l[0] === "03").map((l) => [l[2], l]));
const partyIds = hunt.find((l) => l[0] === "11").slice(3, 11);
const self = hunt.find((l) => l[0] === "02");
const partyChanged = {
  type: "PartyChanged",
  party: partyIds.map((id) => {
    const c = combatants.get(id);
    return { id, name: c?.[3] ?? "", worldId: 0, job: Number.parseInt(c?.[4] ?? "0", 16), level: 100, inParty: true };
  }),
};
const primaryPlayer = { type: "ChangePrimaryPlayer", charID: Number.parseInt(self[2], 16), charName: self[3] };
/** getCombatants reply: the player first, then the party (fields as OverlayPlugin names them). */
const mockCombatants = [self[2], ...partyIds.filter((id) => id !== self[2])].map((id) => {
  const c = combatants.get(id);
  return { ID: Number.parseInt(id, 16), OwnerID: 0, Type: 1, PartyType: 1, Job: Number.parseInt(c?.[4] ?? "0", 16), Level: 100, Name: c?.[3] ?? "" };
});
const MOCK_API = `(() => {
  const subs = new Set();
  window.OverlayPluginApi = {
    ready: true,
    callHandler: function (msg, cb) {
      const m = JSON.parse(msg);
      if (m.call === 'subscribe') m.events.forEach((e) => subs.add(e));
      if (m.call === 'getCombatants') setTimeout(() => cb(JSON.stringify({ combatants: ${JSON.stringify(mockCombatants)} })), 50);
      return Promise.resolve(null);
    },
  };
  window.__mockPush = (msg) => { if (subs.has(msg.type)) window.__OverlayCallback(msg); };
})();`;

// ---------- browser ----------
const profileDir = mkdtempSync(join(tmpdir(), "cdp-"));
const chrome = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const proc = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "about:blank"]);
let port;
for (let i = 0; i < 100 && !port; i++) {
  await sleep(100);
  const file = join(profileDir, "DevToolsActivePort");
  if (existsSync(file)) port = Number(readFileSync(file, "utf8").split("\n")[0]) || undefined;
}
if (!port) throw new Error("Chrome did not report its DevTools port");

async function openTab(url, w, h, injectScript = "") {
  let t;
  for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); } catch {} }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id) pending.get(m.id)?.(m); });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  if (injectScript) await send("Page.addScriptToEvaluateOnNewDocument", { source: injectScript });
  await send("Page.navigate", { url });
  await sleep(500);
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const screenshot = async (name) => {
    await send("Page.bringToFront");
    await sleep(300);
    writeFileSync(join(out, `${name}.png`), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
    console.log(`screenshots/${name}.png`);
  };
  return { evaluate, screenshot };
}

/** Killing `proc` is not enough on Windows: chrome.exe hands off to a separate browser process. */
async function stopChrome() {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = new WebSocket(webSocketDebuggerUrl);
    await new Promise((r) => browser.addEventListener("open", r));
    browser.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await new Promise((r) => { browser.addEventListener("close", r); setTimeout(r, 2000); });
  } catch {
    proc.kill();
  }
}

try {
  mkdirSync(out, { recursive: true });
  const monitor = await openTab(`${base}#/`, 475, 400, MOCK_API);
  await sleep(600);
  await monitor.evaluate(`window.__mockPush(${JSON.stringify(primaryPlayer)}); window.__mockPush(${JSON.stringify(partyChanged)}); true`);
  const push = async (lines) => {
    for (let i = 0; i < lines.length; i += 1500) {
      await monitor.evaluate(`for (const line of ${JSON.stringify(lines.slice(i, i + 1500))}) window.__mockPush({ type: 'LogLine', line, rawLine: line.join('|') }); true`);
    }
    await sleep(600);
  };
  await push(hunt);
  // 无尽狂奔 lands on everyone at 21:52:51.5 (04:09); a moment more for its 37 lines. A running pull's clock is the
  // wall clock's, as in ACT where the lines come live: the pull is moved so that its last line is now.
  const stop = trial.findIndex((l) => l[1] > "2026-09-28T21:52:53");
  const at = (time) => Date.parse(`${time.slice(0, 23)}${time.slice(-6)}`);
  const shift = Date.now() - at(trial[stop - 1][1]);
  for (const l of trial) l[1] = `${new Date(at(l[1]) + shift + 8 * 3600_000).toISOString().slice(0, 23)}0000+08:00`;
  await push(trial.slice(0, stop));
  await monitor.screenshot("monitor");
  await push(trial.slice(stop));
  // The writer flushes every 10 s; wait one round so both pulls are stored whole.
  await sleep(11000);

  const review = await openTab(`${base}#/review`, 1320, 820);
  await sleep(1500);
  // 受伤明细 of the newest pull (格莱杨拉波尔): of the hits by 无尽狂奔 at 04:09, the one with the most statuses.
  const picked = await review.evaluate(`(async () => {
    const body = document.querySelector('.table .body');
    let best;
    for (let top = 0; top < body.scrollHeight; top += body.clientHeight) {
      body.scrollTop = top;
      await new Promise((r) => setTimeout(r, 50));
      for (const row of document.querySelectorAll('.table .row')) {
        if (row.querySelector('.c-time')?.textContent.trim() !== '04:09' || !row.textContent.includes('无尽狂奔')) continue;
        const n = row.querySelectorAll('.chip').length;
        if (!best || n > best.n) best = { n, top, text: row.textContent };
      }
    }
    if (!best) return '';
    body.scrollTop = best.top;
    await new Promise((r) => setTimeout(r, 100));
    [...document.querySelectorAll('.table .row')].find((r) => r.textContent === best.text).click();
    await new Promise((r) => setTimeout(r, 400));
    return location.hash;
  })()`);
  if (!picked.includes("row=")) throw new Error(`no 无尽狂奔 hit at 04:09 to open (${picked})`);
  await review.screenshot("review");
  // 时间轴, scrolled to that hit, the detail closed.
  await review.evaluate(`location.hash = ${JSON.stringify(picked.replace("tab=damage", "tab=timeline"))}; true`);
  await sleep(1500);
  await review.evaluate("document.querySelector('.detail .close')?.click(); true");
  await sleep(500);
  await review.screenshot("timeline");
  // 死亡回放 of 护锁刃龙: P5 at 03:56, the killing blow's detail open.
  await review.evaluate("[...document.querySelectorAll('.encounters .session .head')].find((h) => h.textContent.includes('护锁刃龙')).click(); true");
  await sleep(1500);
  await review.evaluate("document.querySelector('.tab[data-tab=deaths]').click(); true");
  await sleep(600);
  const death = await review.evaluate("(() => { const li = [...document.querySelectorAll('.death-list li')].find((l) => l.textContent.includes('03:56') && l.textContent.includes('P5')); li?.click(); return !!li; })()");
  if (!death) throw new Error("no death of P5 at 03:56");
  await sleep(600);
  await review.evaluate("document.querySelector('.events .line.fatal').click(); true");
  await sleep(500);
  await review.screenshot("death-replay");
} finally {
  await stopChrome();
}
process.exit(0);
