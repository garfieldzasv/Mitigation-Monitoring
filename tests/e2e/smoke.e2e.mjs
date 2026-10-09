// Smoke test of the built app (dist/, loaded from file:// like in ACT) in headless Chrome, with a
// strict mock of OverlayPlugin's injected API. Plays the hunt fixture into the monitor, then runs
// the runtime probe page including its popup. Run: pnpm e2e  (override Chrome with CHROME_PATH)
//
// Headless Chrome is not ACT's CEF: this proves the build, the file:// loading and the wiring; the
// probe page still has to be opened inside ACT for the real answers (docs/DESIGN.md 11.2).
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "../..");
// E2E_BASE runs the same checks against a served copy, e.g. http://localhost:4173/ (serve.cmd).
const base = process.env.E2E_BASE ?? pathToFileURL(join(root, "dist/index.html")).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
/** Printed as they happen, so a run that hangs shows how far it got. */
const check = (name, ok, detail = "") => {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`;
  results.push(line);
  console.log(line);
};

// ---------- fixture → OverlayPlugin messages ----------
/** E2E_MEASURE: the fixtures' P1, P2… as long as real names get (6 characters, some with a middle dot), for the column widths. */
const LONG_NAMES = ["祐天寺·喵梦", "温妮莎温妮莎", "晨星海岸之歌", "柚·青木果果", "念与光念与光", "大海原大海原", "李東赫李東赫", "雪月花莲雪月"];
const lengthen = (field) => (process.env.E2E_MEASURE && /^P\d+$/.test(field) ? LONG_NAMES[(Number(field.slice(1)) - 1) % LONG_NAMES.length] : field);
const fixture = (name) =>
  gunzipSync(readFileSync(join(root, "tests/fixtures", name)))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("|").map(lengthen));
const lines = fixture("hunt-8p.log.gz");
// Bosses hardly ever crit (this fixture has none): one boss hit made a crit (severity byte 0x20) for the crit marker.
const critLine = lines.find((l) => l[0] === "21" && l[2].startsWith("4") && l[6].startsWith("10") && /^[0-9A-F]{2,}0003$/.test(l[8]) && l[9] !== "0");
critLine[8] = `${critLine[8].slice(0, -4)}2003`;
/** A trial whose boss leaves five times (格莱杨拉波尔: six stretches 在场, five 离场) for the phase checks. */
const phaseLines = fixture("trial-phases.log.gz");
const combatants = new Map(lines.filter((l) => l[0] === "03").map((l) => [l[2], l]));
const partyIds = lines.find((l) => l[0] === "11").slice(3, 11);
const self = lines.find((l) => l[0] === "02");
const partyChanged = {
  type: "PartyChanged",
  party: partyIds.map((id) => {
    const c = combatants.get(id);
    return { id, name: c?.[3] ?? "", worldId: 0, job: Number.parseInt(c?.[4] ?? "0", 16), level: 100, inParty: true };
  }),
};
const primaryPlayer = { type: "ChangePrimaryPlayer", charID: Number.parseInt(self[2], 16), charName: self[3] };
/** getCombatants reply: the player first, then the party, then the boss (fields as OverlayPlugin names them). */
const mockCombatants = [self[2], ...partyIds.filter((id) => id !== self[2])].map((id) => {
  const c = combatants.get(id);
  return { ID: Number.parseInt(id, 16), OwnerID: 0, Type: 1, PartyType: 1, Job: Number.parseInt(c?.[4] ?? "0", 16), Level: 100, Name: c?.[3] ?? "" };
});
mockCombatants.push({ ID: 0x400117e3, OwnerID: 0, Type: 2, PartyType: 0, Job: 0, Level: 100, Name: "护锁刃龙" });

// ---------- browser ----------
// Port 0 lets Chrome pick a free port (written to DevToolsActivePort in its profile).
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

async function openTab(url, w, h, injectScript = "") {
  let t;
  for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json(); } catch {} }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id) pending.get(m.id)?.(m);
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send("Page.enable");
  if (injectScript) await send("Page.addScriptToEvaluateOnNewDocument", { source: injectScript });
  await send("Page.navigate", { url });
  await sleep(500);
  const evaluate = async (expression, userGesture = false) =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture })).result?.result?.value;
  /** A tab in the background gets no animation frames: the monitor renders on them (an overlay is always in view), and a screenshot waits for one. */
  const front = () => send("Page.bringToFront");
  const screenshot = async (path) => {
    await front();
    writeFileSync(path, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  };
  const resize = (width, height) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  /** What picking files in a file chooser does. */
  const setFiles = async (selector, files) => {
    const root = (await send("DOM.getDocument", {})).result.root;
    const { nodeId } = (await send("DOM.querySelector", { nodeId: root.nodeId, selector })).result;
    await send("DOM.setFileInputFiles", { nodeId, files });
  };
  return { evaluate, errors, screenshot, resize, front, setFiles };
}

/** OverlayPlugin's CefSharp binding rejects calls missing a declared parameter; `ready` flips late. */
const MOCK_API = `(() => {
  const subs = new Set();
  window.__mockSubs = subs;
  window.OverlayPluginApi = {
    ready: false,
    callHandler: function (msg, cb) {
      if (arguments.length < 2) return Promise.reject(new Error('Missing Parameters: 1'));
      const m = JSON.parse(msg);
      if (m.call === 'subscribe') m.events.forEach((e) => subs.add(e));
      if (m.call === 'getCombatants') setTimeout(() => cb(JSON.stringify({ combatants: ${JSON.stringify(mockCombatants)} })), 50);
      return Promise.resolve(null);
    },
  };
  setTimeout(() => { window.OverlayPluginApi.ready = true; }, 200);
  window.__mockPush = (msg) => { if (subs.has(msg.type)) window.__OverlayCallback(msg); };
})();`;

/** As ACT starting up: OverlayPlugin injects its API well after the page has loaded. */
const LATE_API = `setTimeout(() => { ${MOCK_API} }, 1500);`;

try {
  // ---------- connection ----------
  const starting = await openTab(`${base}#/`, 475, 360, LATE_API);
  const barText = () => starting.evaluate("document.querySelector('.bar')?.textContent ?? ''");
  const whileStarting = await barText();
  check("connection: says it is connecting while OverlayPlugin has not injected its API yet", whileStarting.includes("正在连接 ACT") && !whileStarting.includes("未连接"), whileStarting.trim());
  await sleep(2000);
  const onceStarted = await barText();
  check("connection: the notice goes away by itself once the API arrives (no overlay reload)", !onceStarted.includes("连接") && onceStarted.includes("等待战斗"), onceStarted.trim());

  // ---------- monitor ----------
  const monitor = await openTab(`${base}#/`, 475, 360, MOCK_API);
  await sleep(600);
  const subs = await monitor.evaluate("[...window.__mockSubs]");
  check("monitor subscribes to LogLine, PartyChanged, ChangePrimaryPlayer, CombatData",
    ["LogLine", "PartyChanged", "ChangePrimaryPlayer", "CombatData"].every((e) => subs?.includes(e)), String(subs));
  await monitor.evaluate(`window.__mockPush(${JSON.stringify(primaryPlayer)}); window.__mockPush(${JSON.stringify(partyChanged)}); true`);
  const pushLines = async (from, to) => {
    for (let i = from; i < to; i += 1500) {
      const chunk = lines.slice(i, Math.min(to, i + 1500));
      await monitor.evaluate(`for (const line of ${JSON.stringify(chunk)}) window.__mockPush({ type: 'LogLine', line, rawLine: line.join('|') }); true`);
    }
    await sleep(400);
  };
  const rendered = () => monitor.evaluate("document.querySelectorAll('.body .row').length");
  const counter = () => monitor.evaluate("document.querySelector('.bar .count')?.textContent ?? ''");
  const atTop = () => monitor.evaluate("document.querySelector('.body').scrollTop < 22");
  const topButton = () => monitor.evaluate("Boolean(document.querySelector('.to-top'))");
  /** Text of the row at a fixed point of the viewport, a few rows down. */
  const rowAtProbe = () =>
    monitor.evaluate("(() => { const b = document.querySelector('.body').getBoundingClientRect(); return document.elementFromPoint(120, b.top + 22 * 3 + 11)?.closest('.row')?.textContent.trim() ?? ''; })()");

  // Mid-encounter: scroll down, then let new rows arrive. The rows being read must not move.
  const half = Math.floor(lines.length * 0.6);
  await pushLines(0, half);
  check("mid-encounter: the view starts at the top with the newest row", await atTop());
  await monitor.evaluate("(() => { const b = document.querySelector('.body'); b.scrollTop = 22 * 10; b.dispatchEvent(new Event('scroll')); return true; })()");
  await sleep(200);
  const before = await rowAtProbe();
  check("scrolling down offers 返回顶部", !(await atTop()) && (await topButton()));
  await pushLines(half, lines.length);
  const after = await rowAtProbe();
  check("scrolled down, new rows arriving do not move the rows being read", before !== "" && before === after, `${before.slice(0, 24)} | ${after.slice(0, 24)}`);
  await monitor.evaluate("document.querySelector('.to-top').click(); true");
  await sleep(300);
  check("返回顶部 jumps back to the newest row", (await atTop()) && !(await topButton()));

  const bar = await monitor.evaluate("document.querySelector('.bar')?.textContent ?? ''");
  const barDeaths = await monitor.evaluate("document.querySelector('.bar .deaths')?.textContent.trim() ?? ''");
  check("toolbar shows the encounter, its duration and deaths", bar.includes("护锁刃龙狩猎战") && bar.includes("07:00") && barDeaths === "7", `${bar.replace(/\s+/g, " ")} · deaths ${barDeaths}`);
  const rows = await rendered();
  check("grid renders only the rows in view (virtualised)", rows > 10 && rows < 60, `${rows} rows rendered, counter ${await counter()}`);
  const header = await monitor.evaluate("[...document.querySelectorAll('.head > span')].map((s) => s.textContent.trim()).join(',')");
  check("header columns: 时间,职,来源,伤害,减伤,状态,判", header === "时间,职▾,来源 ▾,伤害,减伤,状态,判", header);
  const times = await monitor.evaluate("[...document.querySelectorAll('.row:not(.death) .c-time')].map((s) => s.textContent.trim())");
  check("time column reads mm:ss without fractions", times.length > 0 && times.every((t) => /^-?\d\d:\d\d$/.test(t)), times.slice(0, 3).join(" "));
  check("newest row first: times run downwards", times.every((t, i) => i === 0 || t <= times[i - 1]), times.slice(0, 4).join(" "));
  const mitigation = await monitor.evaluate("[...document.querySelectorAll('.row:not(.death) .c-mit')].map((s) => s.textContent.trim() + ' ' + s.style.color)");
  check("mitigation column: a coloured percentage for hits, — for DoT ticks", mitigation.length > 0 && mitigation.every((m) => /^-?\d+%\??\s+rgb|^—\s+var/.test(m)), mitigation.slice(0, 2).join(" | "));
  const icons = await monitor.evaluate("[...document.querySelectorAll('.body .row .c-job img')].map((img) => img.complete && img.naturalWidth > 0)");
  check("job column shows loaded job icons", icons.length > 0 && icons.every(Boolean), `${icons.filter(Boolean).length}/${icons.length} loaded`);
  const jobTitles = await monitor.evaluate("[...document.querySelectorAll('.body .row .c-job img')].map((img) => img.title)");
  check("job icon's hover names the player and the job", jobTitles.length > 0 && jobTitles.every((t) => /^P\d（.+）$/.test(t)), jobTitles.slice(0, 2).join(" | "));
  // Whole encounter, via the min-amount filter's opposite: scroll through and collect what the rows say.
  const mitigated = await monitor.evaluate(`(async () => {
    const b = document.querySelector('.body'); const seen = new Set(); let statusIcons = 0, loaded = 0;
    for (let y = 0; y < b.scrollHeight; y += b.clientHeight) {
      b.scrollTop = y; b.dispatchEvent(new Event('scroll')); await new Promise((r) => setTimeout(r, 30));
      for (const s of document.querySelectorAll('.row:not(.death) .c-mit')) if (/^[1-9]\\d*%/.test(s.textContent.trim())) seen.add(s.textContent.trim());
      for (const img of document.querySelectorAll('.chip img')) { statusIcons++; if (img.complete && img.naturalWidth > 0) loaded++; }
    }
    b.scrollTop = 0; b.dispatchEvent(new Event('scroll'));
    return { values: [...seen], statusIcons, loaded };
  })()`);
  check("some hits show a real mitigation percentage", mitigated.values.length > 0, mitigated.values.slice(0, 6).join(" "));
  check("status column shows loaded status icons", mitigated.statusIcons > 0 && mitigated.loaded === mitigated.statusIcons, `${mitigated.loaded}/${mitigated.statusIcons}`);
  check("DoT rows get their own class (background)", (await monitor.evaluate("document.querySelectorAll('.row.dot').length")) > 0);
  const width = await monitor.evaluate("document.documentElement.scrollWidth");
  check("no horizontal overflow at 475 px", width <= 475, `${width}px`);
  // E2E_SCREENSHOTS=<dir> saves what the monitor and its filter panels look like.
  const shot = (name) => (process.env.E2E_SCREENSHOTS ? monitor.screenshot(join(process.env.E2E_SCREENSHOTS, `${name}.png`)) : undefined);
  await shot("monitor");

  await monitor.resize(475, 600);
  await sleep(400);
  const taller = await rendered();
  check("a taller window shows more rows", taller > rows, `${rows} → ${taller}`);
  await monitor.resize(475, 360);
  await sleep(300);

  const total = await counter();
  await monitor.evaluate("document.querySelector('.head .c-name .trigger').click(); true");
  await sleep(200);
  await shot("filter-source");
  await monitor.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
  await monitor.evaluate("document.querySelector('.head .c-job .trigger').click(); true");
  await sleep(200);
  await shot("filter-member");
  await monitor.evaluate("document.querySelector('.popover-panel li .only').click(); true");
  await sleep(300);
  const onlyOne = await counter();
  const jobs = await monitor.evaluate("[...new Set([...document.querySelectorAll('.body .row .c-job img')].map((i) => i.getAttribute('src')))]");
  check("职▾ → 仅: one member's rows only", onlyOne !== total && jobs.length === 1, `${total} → ${onlyOne}`);
  await monitor.evaluate("[...document.querySelectorAll('.popover-panel button')].find((b) => b.textContent.includes('全部显示')).click(); true");
  await sleep(300);
  check("全部显示 restores every row", (await counter()) === total, await counter());
  await monitor.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");

  await monitor.evaluate("[...document.querySelectorAll('.bar .trigger')].at(-1).click(); true");
  await sleep(200);
  await shot("filter-more");
  await monitor.evaluate("(() => { const i = document.querySelector('.popover-panel input[type=number]'); i.value = '999999999'; i.dispatchEvent(new Event('change')); return true; })()");
  await sleep(400);
  const deathTexts = await monitor.evaluate("[...document.querySelectorAll('.body .row')].map((r) => (r.classList.contains('death') ? '' : 'NOT-DEATH ') + r.textContent.trim())");
  check("最小伤害 hides every hit but never a death", deathTexts.length === 7 && deathTexts.every((t) => !t.startsWith("NOT-DEATH")), `${deathTexts.length} rows`);
  check("death rows read 「…受到源自…的…伤害而死亡了」 or name the killer", deathTexts.every((t) => /受到源自「.+」的「.+」伤害而死亡了|受到持续伤害而死亡了|击倒/.test(t)), deathTexts[0]?.slice(0, 60));
  const saved = await monitor.evaluate("localStorage.getItem('mitigation-monitoring:monitor-filter')");
  check("the filter is saved", saved?.includes('"minAmount":999999999'), saved?.slice(0, 80));
  await monitor.evaluate("[...document.querySelectorAll('.popover-panel button')].find((b) => b.textContent.includes('清空全部过滤')).click(); true");
  await sleep(300);
  check("清空全部过滤 restores every row", (await counter()) === total, await counter());
  await monitor.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
  // One line per hit, also for hits the shield reports cannot tell apart (docs/DESIGN.md 7.1); a critical hit's damage
  // is red with a "!" after it.
  const lineCheck = await monitor.evaluate(`(async () => {
    const b = document.querySelector('.body'); const merged = new Set(); const crit = []; let critText = 0;
    for (let y = 0; y < b.scrollHeight; y += b.clientHeight) {
      b.scrollTop = y; b.dispatchEvent(new Event('scroll')); await new Promise((r) => setTimeout(r, 30));
      for (const s of document.querySelectorAll('.body .line.row .c-name')) if (/ ×\\d/.test(s.textContent)) merged.add(s.textContent.trim());
      for (const a of document.querySelectorAll('.body .line.row .c-amount')) {
        if (a.textContent.includes('暴')) critText++;
        const mark = a.querySelector('.crit-mark');
        if (mark) crit.push({ text: a.textContent.trim(), mark: getComputedStyle(mark).color, dim: a.classList.contains('dim'), amount: getComputedStyle(a).color });
      }
    }
    b.scrollTop = 0; b.dispatchEvent(new Event('scroll'));
    return { merged: [...merged], crit, critText };
  })()`);
  check("monitor: one line per hit, none merged (护龙威压 ×2)", lineCheck.merged.length === 0, JSON.stringify(lineCheck.merged.slice(0, 3)));
  const red = "rgb(229, 112, 92)";
  check(
    "monitor: a critical hit reads 12,345! in red, no 暴",
    lineCheck.crit.length > 0 && lineCheck.critText === 0 && lineCheck.crit.every((c) => c.text.endsWith("!") && c.mark === red && (c.dim || c.amount === red)),
    `${lineCheck.crit.length} crits, ${JSON.stringify(lineCheck.crit[0])}`,
  );
  check("monitor: no page errors", monitor.errors.length === 0, monitor.errors.join(" | ").slice(0, 200));

  // ---------- archive + review window ----------
  // The writer flushes every 10 s; wait one round so the tail after the last death is stored too.
  await sleep(11000);
  const review = await openTab(`${base}#/review`, 1320, 820);
  await sleep(1500);
  const listText = await review.evaluate("document.querySelector('.encounters ul')?.textContent ?? ''");
  check("review: the encounter is in the list as a 复盘 of 1 pull, cleared", listText.includes("护锁刃龙狩猎战") && listText.includes("1 场") && listText.includes("过本 1"), listText.replace(/\s+/g, " ").slice(0, 80));
  const reviewCount = await review.evaluate("[...document.querySelectorAll('.tabs .num')].map((s) => s.textContent.trim()).join('')");
  check("review: rebuilt from the archive, the same rows as the monitor", reviewCount === total, `${reviewCount} vs monitor ${total}`);
  // The table is virtualised and in time order; filter down to the deaths (which no damage filter hides).
  await review.evaluate("document.querySelector('.tabs .trigger').click(); true");
  await sleep(200);
  await review.evaluate("(() => { const i = document.querySelector('.popover-panel input[type=number]'); i.value = '999999999'; i.dispatchEvent(new Event('change')); return true; })()");
  await sleep(300);
  const deathRows = await review.evaluate("document.querySelectorAll('.table .row.death').length");
  check("review: its own filter (min damage) leaves the 7 deaths", deathRows === 7, `${deathRows}`);
  await review.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.querySelector('.table .row.death').click(); true");
  await sleep(300);
  const deathDetail = await review.evaluate("document.querySelector('.detail')?.textContent ?? ''");
  check("review: a death row opens its detail with the killing blow", /受到源自「.+」的「.+」伤害而死亡了/.test(deathDetail) && deathDetail.includes("死亡前最后"), deathDetail.replace(/\s+/g, " ").slice(0, 70));
  await review.evaluate("document.querySelector('.detail .link')?.click(); true");
  await sleep(300);
  const hitDetail = await review.evaluate("document.querySelector('.detail')?.textContent ?? ''");
  check("review: the killing blow's detail shows the breakdown and statuses", hitDetail.includes("减伤明细") && hitDetail.includes("受击者状态"), hitDetail.replace(/\s+/g, " ").slice(0, 70));
  // Category, remaining time and caster sit in fixed columns, the same in both status lists.
  const columns = await review.evaluate(
    "JSON.stringify(['.cat', '.rem', '.src'].map((c) => [...new Set([...document.querySelectorAll('.detail .statuses ' + c)].map((e) => Math.round(e.getBoundingClientRect().left)))]))",
  );
  const lefts = JSON.parse(columns);
  check("review: the detail's status columns line up across both lists", lefts.every((xs) => xs.length === 1), columns);
  // Unrelated statuses have their base icon too (docs/DESIGN.md 8.2), loaded.
  const statusIcons = JSON.parse(
    await review.evaluate(
      "JSON.stringify((() => { const lis = [...document.querySelectorAll('.detail .statuses li:not(.none)')]; return { statuses: lis.length, other: lis.filter((li) => li.classList.contains('other')).length, loaded: lis.filter((li) => li.querySelector('img')?.naturalWidth > 0).length }; })())",
    ),
  );
  check("review: every status in the detail has its icon, unrelated ones too", statusIcons.other > 0 && statusIcons.loaded === statusIcons.statuses, JSON.stringify(statusIcons));
  check("review: the hit's detail shows the unmitigated estimate", hitDetail.includes("未减伤估算"), hitDetail.slice(0, 80));
  // The party's mitigation skills at that moment, by member, each icon in effect, on cooldown or ready, inside the panel.
  const skills = JSON.parse(
    await review.evaluate(`JSON.stringify((() => {
      const panel = document.querySelector('.detail').getBoundingClientRect();
      const icons = [...document.querySelectorAll('.detail .party-skills .skill')];
      return {
        members: document.querySelectorAll('.detail .party-skills li').length,
        target: document.querySelectorAll('.detail .party-skills li.target').length,
        icons: icons.length,
        states: [...new Set(icons.map((e) => ['active', 'cooldown', 'ready'].find((c) => e.classList.contains(c))))].sort(),
        inside: icons.every((e) => { const r = e.getBoundingClientRect(); return r.left >= panel.left && r.right <= panel.right; }),
        titled: icons.every((e) => /：(生效中|冷却中|可用)/.test(e.title)),
      };
    })())`),
  );
  check("review: the hit's detail shows the party's mitigation skills by member, the hit player marked", hitDetail.includes("队伍减伤状态") && skills.members >= 4 && skills.target === 1 && skills.icons > skills.members, JSON.stringify(skills));
  check("review: each skill icon is in effect, on cooldown or ready, says so on hover, and fits the panel", skills.states.length > 0 && skills.states.every(Boolean) && skills.titled && skills.inside, JSON.stringify(skills));
  check("review: a death's detail shows the party's mitigation skills too", deathDetail.includes("队伍减伤状态"), deathDetail.replace(/s+/g, " ").slice(0, 60));
  // The legend sits behind the title's info icon.
  await review.evaluate("(() => { const tip = document.querySelector('.detail .party-skills .legend-tip'); tip.scrollIntoView({ block: 'end' }); tip.dispatchEvent(new MouseEvent('mouseenter')); return true; })()");
  await sleep(200);
  const legend = JSON.parse(
    await review.evaluate(
      "(() => { const p = document.querySelector('.info-tip-panel'); if (!p) return 'null'; const r = p.getBoundingClientRect(); return JSON.stringify({ text: p.textContent, inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }); })()",
    ),
  );
  check("review: the party skills' legend shows on hovering the info icon, inside the window", legend?.text.includes("金色数字") && legend.text.includes("冷却") && legend.inside, JSON.stringify(legend));
  if (process.env.E2E_SCREENSHOTS) await review.screenshot(join(process.env.E2E_SCREENSHOTS, "review-legend.png"));
  await review.evaluate("document.querySelector('.detail .party-skills .legend-tip').dispatchEvent(new MouseEvent('mouseleave')); true");
  await sleep(400);
  const reviewShot = (name) => (process.env.E2E_SCREENSHOTS ? review.screenshot(join(process.env.E2E_SCREENSHOTS, `${name}.png`)) : undefined);
  await reviewShot("review");
  // The notes on the calculations' limits: a tooltip on hover, inside the window, gone on leaving.
  await review.evaluate("document.querySelector('.calc-notes').dispatchEvent(new MouseEvent('mouseenter')); true");
  await sleep(200);
  const notes = JSON.parse(
    await review.evaluate("(() => { const p = document.querySelector('.calc-notes-panel'); if (!p) return 'null'; const r = p.getBoundingClientRect(); return JSON.stringify({ text: p.textContent, inside: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight }); })()"),
  );
  check("review: the notes icon says where each figure comes from and its error", !!notes && ["减伤率", "盾吸收", "未减伤估算", "未生效", "来源", "误差"].every((w) => notes.text.includes(w)) && notes.inside, notes ? `inside ${notes.inside}` : "no panel");
  await reviewShot("review-notes");
  await review.evaluate("document.querySelector('.calc-notes').dispatchEvent(new MouseEvent('mouseleave')); true");
  await sleep(400);
  check("review: the notes close when the pointer leaves", (await review.evaluate("document.querySelectorAll('.calc-notes-panel').length")) === 0);

  // AOE comparison: each player's shields at the hit, what was left, and what got through.
  await review.evaluate("document.querySelector('.detail .close')?.click(); document.querySelector('.tab[data-tab=aoe]').click(); true");
  await sleep(500);
  const aoeShields = JSON.parse(
    await review.evaluate(
      "JSON.stringify({ head: document.querySelector('.members .m.head')?.textContent ?? '', cells: [...document.querySelectorAll('.members .m:not(.head)')].map((m) => [...m.children].slice(3, 6).map((c) => c.textContent.trim())) })",
    ),
  );
  const shieldCells = aoeShields.cells.filter((c) => /\d/.test(c[0]));
  check(
    "aoe: every player's shields at the hit, what was left and what got through",
    ["盾量", "剩余", "穿盾"].every((w) => aoeShields.head.includes(w)) &&
      aoeShields.cells.length >= 4 &&
      aoeShields.cells.every((c) => c[0] === "无盾" || /^≈[\d,]+$/.test(c[0])) &&
      shieldCells.every((c) => (c[1] === "0" || /^≈[\d,]+$/.test(c[1])) && (c[2] === "未穿" || /^[\d,]+$/.test(c[2]))),
    JSON.stringify(aoeShields.cells.slice(0, 3)),
  );
  await reviewShot("aoe-shields");

  // Death replay: the deaths, the HP curve with hits and heals, the events newest first.
  await review.evaluate("document.querySelector('.detail .close')?.click(); document.querySelector('.tab[data-tab=deaths]').click(); true");
  await sleep(500);
  const deathItems = await review.evaluate("document.querySelectorAll('.death-list li:not(.empty)').length");
  check("death replay: lists the 7 deaths", deathItems === 7, `${deathItems}`);
  const replayHead = await review.evaluate("document.querySelector('.deaths-tab .main header')?.textContent ?? ''");
  check("death replay: names the killing blow", replayHead.includes("致命一击") && /死亡了/.test(replayHead), replayHead.replace(/\s+/g, " ").slice(0, 80));
  const chart = JSON.parse(
    await review.evaluate(
      "JSON.stringify({ hp: (document.querySelector('.chart .hp-line')?.getAttribute('d') ?? '').length, hits: document.querySelectorAll('.chart .bar.hit').length, heals: document.querySelectorAll('.chart .bar.heal').length, casts: document.querySelectorAll('.chart .cast').length })",
    ),
  );
  check("death replay: draws the HP curve with hit and heal marks", chart.hp > 20 && chart.hits > 0 && chart.heals > 0, JSON.stringify(chart));
  const badges = JSON.parse(await review.evaluate("JSON.stringify([...document.querySelectorAll('.events .line:not(.head) .badge')].map((b) => b.textContent.trim()))"));
  check("death replay: events newest first from the death, with heals and statuses", badges[0] === "死亡" && badges.some((b) => b.endsWith("治疗")) && badges.some((b) => b === "获得" || b === "失去"), badges.slice(0, 8).join(","));
  await review.evaluate("document.querySelector('.events .line.fatal').click(); true");
  await sleep(300);
  const fatalDetail = await review.evaluate("document.querySelector('.detail')?.textContent ?? ''");
  check("death replay: clicking the killing blow opens its detail", fatalDetail.includes("减伤明细"), fatalDetail.replace(/\s+/g, " ").slice(0, 60));
  await reviewShot("deaths");

  // The monitor opens the review window by name: once open, a ↗ only changes its URL. Choices made
  // inside the window are written to the URL, and the window follows URL changes.
  const selectedDeath = () => review.evaluate("[...document.querySelectorAll('.death-list li')].findIndex((li) => li.classList.contains('selected'))");
  await review.evaluate("document.querySelectorAll('.death-list li')[0].click(); true");
  await sleep(300);
  const firstDeathUrl = await review.evaluate("location.hash");
  await review.evaluate("document.querySelectorAll('.death-list li')[2].click(); true");
  await sleep(300);
  const thirdDeathUrl = await review.evaluate("location.hash");
  check("review: picking a death writes it to the URL", /tab=deaths/.test(thirdDeathUrl) && /row=\d+/.test(thirdDeathUrl) && thirdDeathUrl !== firstDeathUrl && (await selectedDeath()) === 2, thirdDeathUrl);
  await review.evaluate(`location.hash = ${JSON.stringify(firstDeathUrl)}; true`);
  await sleep(500);
  check("review: an open window follows a new URL (a second ↗)", (await selectedDeath()) === 0, `${await selectedDeath()}`);
  await review.evaluate("location.hash = '#/review?enc=e1&tab=deaths&row=3'; true");
  await sleep(500);
  const missingText = await review.evaluate("document.querySelector('.error')?.textContent ?? ''");
  const missingDeaths = await review.evaluate("document.querySelectorAll('.death-list li:not(.empty)').length");
  check("review: a link to an encounter without an archive says so instead of opening another one", missingText.includes("没有存档") && missingDeaths === 0, `${missingText} / ${missingDeaths}`);
  await review.evaluate(`location.hash = ${JSON.stringify(firstDeathUrl)}; true`);
  await sleep(800);

  // AOE comparison: casts that hit 4+, and each player of the selected one.
  await review.evaluate("document.querySelector('.tab[data-tab=aoe]').click(); true");
  await sleep(400);
  const aoe = JSON.parse(await review.evaluate("JSON.stringify({ groups: document.querySelectorAll('.groups .g:not(.head)').length, members: document.querySelectorAll('.members .m:not(.head)').length })"));
  check("AOE comparison: lists the casts and the players of the selected one", aoe.groups > 10 && aoe.members >= 4, JSON.stringify(aoe));
  await review.evaluate("document.querySelector('.groups .g:not(.head):nth-child(3)').click(); document.querySelector('.members .m:not(.head)').click(); true");
  await sleep(300);
  check("AOE comparison: a player opens the detail", (await review.evaluate("!!document.querySelector('.detail')")) === true);
  // Nothing wraps onto a second line: the encounter list title, the AOE table cells (全吸收 in 判定).
  const wrapped = await review.evaluate(
    "JSON.stringify({ title: document.querySelector('.encounters .title').getBoundingClientRect().height, cells: [...document.querySelectorAll('.members .m > span')].filter((s) => s.scrollHeight > 26).map((s) => s.textContent.trim()).slice(0, 5) })",
  );
  const { title: titleHeight, cells: tallCells } = JSON.parse(wrapped);
  check("review: list title and AOE cells stay on one line", titleHeight <= 34 && tallCells.length === 0, wrapped);
  await reviewShot("aoe");

  // Statistics, and a name leading to the damage table filtered to it.
  await review.evaluate("document.querySelector('.tab[data-tab=stats]').click(); true");
  await sleep(400);
  const stats = JSON.parse(await review.evaluate("JSON.stringify({ members: document.querySelectorAll('.mrow:not(.head)').length, abilities: document.querySelectorAll('.arow:not(.head)').length })"));
  check("statistics: one line per player and per ability", stats.members === 8 && stats.abilities > 10, JSON.stringify(stats));
  await reviewShot("stats");
  await review.evaluate("document.querySelector('.mrow:not(.head) .link').click(); true");
  await sleep(400);
  const afterStats = await review.evaluate("JSON.stringify({ tab: document.querySelector('.tab.on')?.dataset.tab, count: [...document.querySelectorAll('.tabs .num')].map((s) => s.textContent.trim()).join('') })");
  const { tab: landed, count: onlyCount } = JSON.parse(afterStats);
  check("statistics: a player's name shows only their rows in the damage table", landed === "damage" && onlyCount.endsWith(`/${total.split("/")[1]}`) && onlyCount !== total, afterStats);
  check("review: no page errors", review.errors.length === 0, review.errors.join(" | ").slice(0, 200));

  // The monitor's 复盘 opens the review window as a popup.
  await monitor.evaluate("document.querySelector('.bar .review').click(); true", true);
  await sleep(1500);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  check("monitor: 复盘 opens the review window on this encounter", targets.some((t) => /#\/review\?enc=e\d+/.test(t.url)), targets.map((t) => t.url.split("#")[1]).join(" | "));
  // A death row's [回放] opens that death's replay (deaths only, via the min-damage filter).
  await monitor.evaluate("[...document.querySelectorAll('.bar .trigger')].at(-1).click(); true");
  await sleep(200);
  await monitor.evaluate("(() => { const i = document.querySelector('.popover-panel input[type=number]'); i.value = '999999999'; i.dispatchEvent(new Event('change')); return true; })()");
  await sleep(300);
  const replayLink = await monitor.evaluate("document.querySelector('.body .row.death .open')?.textContent.trim() ?? ''");
  check("monitor: a death row links to its replay as [回放]", replayLink === "[回放]", replayLink);
  await monitor.evaluate("document.querySelector('.body .row.death .open').click(); true", true);
  await sleep(1500);
  const afterDeath = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  check("monitor: a death's [回放] opens its death replay", afterDeath.some((t) => /#\/review\?enc=e\d+&tab=deaths&row=\d+/.test(t.url)), afterDeath.map((t) => t.url.split("#")[1]).join(" | "));
  await monitor.evaluate("[...document.querySelectorAll('.popover-panel button')].find((b) => b.textContent.includes('清空全部过滤'))?.click(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
  await sleep(300);

  // ---------- settings ----------
  const settingsTab = await openTab(`${base}#/settings`, 500, 720);
  await sleep(800);
  const settingsText = await settingsTab.evaluate("document.body.textContent");
  check("settings: lists the archive and monitor options", settingsText.includes("不存档的区域") && settingsText.includes("保留复盘份数") && settingsText.includes("行高"), settingsText.replace(/\s+/g, " ").slice(0, 60));
  const treeLabels = () => settingsTab.evaluate("[...document.querySelectorAll('.zone-tree li .label')].map((l) => l.textContent.trim())");
  const roots = await treeLabels();
  check("settings: the zones to leave unsaved are a tree: 副本, 野外地图, 特殊场景", JSON.stringify(roots) === '["副本","野外地图","特殊场景"]', JSON.stringify(roots));
  const rootChecks = await settingsTab.evaluate("[...document.querySelectorAll('.zone-tree li input[type=checkbox]')].map((c) => c.checked)");
  check("settings: by default only the duties are saved (野外地图, 特殊场景 checked)", JSON.stringify(rootChecks) === "[false,true,true]", JSON.stringify(rootChecks));
  await settingsTab.evaluate("document.querySelector('.zone-tree li .twisty').click(); true");
  await sleep(200);
  const dutyTypes = (await treeLabels()).slice(1, 4);
  check("settings: 副本 opens on the game's duty types", JSON.stringify(dutyTypes) === '["迷宫挑战","讨伐歼灭战","大型任务"]', JSON.stringify(dutyTypes));
  const search = (text) => settingsTab.evaluate(`(() => { const i = document.querySelector('.zone-tree .tools input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); return true; })()`);
  await search("护锁刃龙");
  await sleep(200);
  const found = await treeLabels();
  check("settings: the search shows a duty with the nodes above it", found[0] === "副本" && found.includes("讨伐歼灭战") && found.includes("护锁刃龙狩猎战") && !found.includes("野外地图"), JSON.stringify(found));
  await search("");
  await sleep(200);
  const rowHeight = () => monitor.evaluate("getComputedStyle(document.querySelector('.grid')).getPropertyValue('--row-h').trim()");
  await settingsTab.evaluate("(() => { const s = document.querySelector('select'); s.value = '26'; s.dispatchEvent(new Event('change')); return true; })()");
  await sleep(500);
  const taller26 = await rowHeight();
  check("settings: the open monitor follows a new row height at once", taller26 === "26px", taller26);
  // Unchecking 野外地图: open-world fights are saved too; the duty on screen still is.
  await settingsTab.evaluate("[...document.querySelectorAll('.zone-tree li')].find((li) => li.textContent.includes('野外地图')).querySelector('input[type=checkbox]').click(); true");
  await sleep(300);
  const skipped = await settingsTab.evaluate("JSON.parse(localStorage.getItem('mitigation-monitoring:settings')).skipZones");
  const tagInDuty = await monitor.evaluate("!!document.querySelector('.bar .tag')");
  check("settings: unchecking 野外地图 saves the open world too, and the duty stays saved (no 不存档 tag)", JSON.stringify(skipped) === '["special"]' && tagInDuty === false, JSON.stringify(skipped));
  if (process.env.E2E_SCREENSHOTS) await settingsTab.screenshot(join(process.env.E2E_SCREENSHOTS, "settings.png"));
  await settingsTab.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent.includes('恢复默认')).click(); true");
  await sleep(500);
  const back22 = await rowHeight();
  const savedSettings = await settingsTab.evaluate("localStorage.getItem('mitigation-monitoring:settings')");
  check("settings: 恢复默认 restores the defaults", back22 === "22px" && savedSettings?.includes('"skipZones":["field","special"]'), `${back22} ${savedSettings}`);
  check("settings: no page errors", settingsTab.errors.length === 0, settingsTab.errors.join(" | ").slice(0, 200));

  // ---------- phases ----------
  // A second pull, with an intermission: the monitor marks the phases, the review lists and filters them.
  await monitor.front();
  for (let i = 0; i < phaseLines.length; i += 1500) {
    await monitor.evaluate(`for (const line of ${JSON.stringify(phaseLines.slice(i, i + 1500))}) window.__mockPush({ type: 'LogLine', line, rawLine: line.join('|') }); true`);
  }
  await sleep(600);
  // The pull ended 在场: the toolbar says 离场 only during a window.
  const phaseTag = await monitor.evaluate("document.querySelector('.bar .phase-tag')?.textContent?.trim() ?? ''");
  check("phases: the monitor's toolbar has no phase tag outside a 离场 window", phaseTag === "", phaseTag);
  const dividers = await monitor.evaluate(`(async () => {
    const b = document.querySelector('.body'); const seen = new Set();
    for (let y = 0; y < b.scrollHeight; y += b.clientHeight) {
      b.scrollTop = y; b.dispatchEvent(new Event('scroll')); await new Promise((r) => setTimeout(r, 30));
      for (const l of document.querySelectorAll('.body .line.phase')) seen.add(l.textContent.trim());
    }
    b.scrollTop = 0; b.dispatchEvent(new Event('scroll'));
    return [...seen];
  })()`);
  check("phases: the monitor's list has a line where each phase started, not numbered", dividers.length === 10 && dividers.some((d) => d.startsWith("在场 04:10 起")) && dividers.some((d) => d.startsWith("离场 00:47 起")) && !dividers.some((d) => /P\d/.test(d)), dividers.join(" | "));
  await sleep(1500); // the archive is written as the pull ends
  await review.front();
  await review.evaluate("location.hash = '#/review'; true"); // no encounter named: the newest, this pull
  await sleep(1500);
  const chips = await review.evaluate("[...document.querySelectorAll('.phases .phase-chip')].map((c) => c.textContent.trim().split(' ')[0])");
  check("phases: the review's filter chips list the stretches 在场 only, by time", JSON.stringify(chips) === JSON.stringify(["00:00–00:47", "00:52–01:56", "02:02–02:54", "03:00–03:13", "03:20–03:59", "04:10–06:45"]), JSON.stringify(chips));
  const phaseColumn = await review.evaluate("!!document.querySelector('.table .head .c-phase')");
  const allCount = await review.evaluate("[...document.querySelectorAll('.tabs .num')].map((s) => s.textContent.trim()).join('')");
  await review.evaluate("[...document.querySelectorAll('.phases .phase-chip')].at(-1).click(); true");
  await sleep(400);
  const p2Count = await review.evaluate("[...document.querySelectorAll('.tabs .num')].map((s) => s.textContent.trim()).join('')");
  const p2Labels = await review.evaluate("[...new Set([...document.querySelectorAll('.table .row .c-phase')].map((s) => s.textContent.trim()))]");
  check("phases: the damage table has a phase column, and a chip narrows it to that stretch (no 离场 rows)", phaseColumn && p2Count !== allCount && JSON.stringify(p2Labels) === '["04:10–06:45"]', `${allCount} → ${p2Count} ${JSON.stringify(p2Labels)}`);
  await review.evaluate("[...document.querySelectorAll('.phases .phase-chip')].at(-1).click(); true");
  await sleep(400);
  check("phases: the same chip again shows every phase", (await review.evaluate("[...document.querySelectorAll('.tabs .num')].map((s) => s.textContent.trim()).join('')")) === allCount);
  if (process.env.E2E_SCREENSHOTS) {
    await review.screenshot(join(process.env.E2E_SCREENSHOTS, "review-phases.png"));
    await monitor.screenshot(join(process.env.E2E_SCREENSHOTS, "monitor-phases.png"));
  }
  check("phases: no page errors", monitor.errors.length === 0 && review.errors.length === 0, [...monitor.errors, ...review.errors].join(" | ").slice(0, 200));

  // The timeline tab, on the same pull.
  await review.evaluate("document.querySelector('.tabs [data-tab=timeline]').click(); true");
  await sleep(800);
  const tl = await review.evaluate(`(() => {
    const n = (s) => document.querySelectorAll('.timeline-tab ' + s).length;
    return { url: location.hash, casters: n('.lane.caster'), hp: n('.lane.hp'), phases: n('.phases .block'), casts: n('.casts .bar'), bars: n('.lane.damage .bar'), autos: n('.lane.autos .bar'), spans: n('.spans .span'), icons: n('.spans .span img') };
  })()`);
  check("timeline: the tab opens with a lane group per player for mitigation and for HP", tl.url.includes("tab=timeline") && tl.casters === 8 && tl.hp === 8, JSON.stringify(tl));
  // This boss auto-attacks with an unnamed action the game data files as an ability (unknown_b25e): told by its use.
  check("timeline: phases, enemy casts, damage and auto-attack bars, status spans with icons are drawn", tl.phases >= 1 && tl.casts > 0 && tl.bars > 0 && tl.autos > 0 && tl.spans > 0 && tl.icons > 0, JSON.stringify(tl));
  if (process.env.E2E_SCREENSHOTS) await review.screenshot(join(process.env.E2E_SCREENSHOTS, "review-timeline.png"));
  // The hover column around the tallest bar (the bar itself is a few px wide; the column takes the mouse).
  const biggestBar = "[...document.querySelectorAll('.timeline-tab .lane.damage .hit')].sort((a, b) => b.querySelector('.bar').offsetHeight - a.querySelector('.bar').offsetHeight)[0]";
  const tlHover = await review.evaluate(`(async () => {
    const bar = ${biggestBar};
    const r = bar.getBoundingClientRect();
    document.querySelector('.timeline-tab .lanes').dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 2, clientY: r.top + 2, bubbles: true }));
    bar.dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((res) => setTimeout(res, 150));
    const out = { tip: document.querySelector('.timeline-tab .tip')?.textContent ?? '', dim: document.querySelectorAll('.timeline-tab .span.dim').length, all: document.querySelectorAll('.timeline-tab .span').length };
    bar.dispatchEvent(new MouseEvent('mouseleave'));
    return out;
  })()`);
  check("timeline: hovering a damage bar explains it and dims the statuses not covering it", tlHover.tip.includes("命中") && tlHover.dim > 0 && tlHover.dim < tlHover.all, `${tlHover.dim}/${tlHover.all} dimmed · ${tlHover.tip.slice(0, 60)}`);
  await review.evaluate(`${biggestBar}.click(); true`);
  await sleep(400);
  const tlPick = await review.evaluate("({ url: location.hash, detail: !!document.querySelector('.detail') })");
  check("timeline: clicking a damage bar opens its hardest hit in the detail panel", tlPick.detail && /row=\d+/.test(tlPick.url) && tlPick.url.includes("tab=timeline"), tlPick.url);
  const tlMove = await review.evaluate(`(async () => {
    const secs = () => [...document.querySelectorAll('.timeline-tab .tick-label')].map((t) => { const [m, s] = t.textContent.split(':').map(Number); return m * 60 + s; });
    const step = (l) => l[1] - l[0];
    const before = secs();
    const lanes = document.querySelector('.timeline-tab .lanes');
    const plot = document.querySelector('.timeline-tab .lane.damage .plot').getBoundingClientRect();
    document.querySelector('.timeline-tab .scroller').dispatchEvent(new WheelEvent('wheel', { deltaY: -400, ctrlKey: true, clientX: plot.left + 300, clientY: plot.top + 10, bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 100));
    const zoomed = secs();
    lanes.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: plot.left + 400, clientY: plot.top + 10, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: plot.left + 100, clientY: plot.top + 10 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: plot.left + 100, clientY: plot.top + 10 }));
    await new Promise((res) => setTimeout(res, 100));
    const panned = secs();
    return { before: step(before), zoomed: step(zoomed), from: zoomed[0], to: panned[0] };
  })()`);
  check("timeline: Ctrl+wheel zooms in, dragging pans", tlMove.zoomed < tlMove.before && tlMove.to > tlMove.from, JSON.stringify(tlMove));
  const tlOut = await review.evaluate(`(async () => {
    const plot = document.querySelector('.timeline-tab .lane.damage .plot').getBoundingClientRect();
    for (let i = 0; i < 6; i++) document.querySelector('.timeline-tab .scroller').dispatchEvent(new WheelEvent('wheel', { deltaY: 1000, ctrlKey: true, clientX: plot.left + 300, clientY: plot.top + 10, bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 100));
    const secs = [...document.querySelectorAll('.timeline-tab .tick-label')].map((t) => { const [m, s] = t.textContent.split(':').map(Number); return m * 60 + s; });
    return { first: secs[0], last: secs.at(-1), outDisabled: document.querySelector('.timeline-tab .toolbar button[title^="缩小"]').disabled };
  })()`);
  check("timeline: zooming out stops with the whole pull on screen", tlOut.first === 0 && tlOut.last >= 360 && tlOut.outDisabled, JSON.stringify(tlOut));
  const tlPin = await review.evaluate(`(async () => {
    const scroller = document.querySelector('.timeline-tab .scroller');
    const at = (sel) => document.querySelector('.timeline-tab ' + sel).getBoundingClientRect().top;
    scroller.scrollTop = 0;
    await new Promise((res) => setTimeout(res, 50));
    const before = { damage: at('.lane.damage'), casts: at('.lane.casts'), hp: at('.lane.hp') };
    scroller.scrollTop = 300;
    await new Promise((res) => setTimeout(res, 50));
    const after = { damage: at('.lane.damage'), casts: at('.lane.casts'), hp: at('.lane.hp') };
    scroller.scrollTop = 0;
    const narrowest = Math.min(...[...document.querySelectorAll('.timeline-tab .lane.damage .hit')].map((h) => h.offsetWidth));
    return { before, after, narrowest };
  })()`);
  check("timeline: casts and damage stay put while the players' lanes scroll", tlPin.after.damage === tlPin.before.damage && tlPin.after.casts === tlPin.before.casts && tlPin.after.hp < tlPin.before.hp - 200, JSON.stringify(tlPin));
  check("timeline: a damage bar takes the mouse in a column at least 9 px wide", tlPin.narrowest >= 9, String(tlPin.narrowest));
  if (process.env.E2E_SCREENSHOTS) {
    await review.evaluate("[...document.querySelectorAll('.timeline-tab .toolbar button')].find((b) => b.textContent.includes('适应全场')).click(); true");
    await sleep(300);
    await review.screenshot(join(process.env.E2E_SCREENSHOTS, "review-timeline-all.png"));
    await review.evaluate("(() => { const s = document.querySelector('.timeline-tab .scroller'); s.scrollTop = s.scrollHeight; return true; })()");
    await sleep(300);
    await review.screenshot(join(process.env.E2E_SCREENSHOTS, "review-timeline-hp.png"));
  }
  // A cast that did not take on someone (a weaker shield on a stronger one) is told in its span's hover, with no mark
  // of its own: the hunt has 14 of them, and no cast that took on nobody.
  await review.evaluate("[...document.querySelectorAll('.encounters .session .head')].find((h) => h.textContent.includes('护锁刃龙')).click(); true");
  await sleep(1500);
  await review.evaluate("[...document.querySelectorAll('.timeline-tab .toolbar button')].find((b) => b.textContent.includes('适应全场')).click(); document.querySelector('.timeline-tab .scroller').scrollTop = 0; true");
  await sleep(300);
  const refused = await review.evaluate(`(async () => {
    for (const s of document.querySelectorAll('.timeline-tab .lanes .span')) {
      if (s.closest('.compact')) continue;
      const r = s.getBoundingClientRect();
      document.querySelector('.timeline-tab .lanes').dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 4, clientY: r.top + 4, bubbles: true }));
      s.dispatchEvent(new MouseEvent('mouseenter'));
      await new Promise((res) => setTimeout(res, 20));
      const tip = document.querySelector('.timeline-tab .tip')?.textContent ?? '';
      if (tip.includes('未覆盖')) return { tip, marks: document.querySelectorAll('.timeline-tab .unapplied').length };
      s.dispatchEvent(new MouseEvent('mouseleave'));
    }
    return { tip: '', marks: document.querySelectorAll('.timeline-tab .unapplied').length };
  })()`);
  if (process.env.E2E_SCREENSHOTS) await review.screenshot(join(process.env.E2E_SCREENSHOTS, "review-timeline-refused.png"));
  check("timeline: who a cast did not take on is in its span's hover, with no mark of its own", refused.tip.includes("未覆盖") && refused.tip.includes("身上已有更强的同类效果") && refused.marks === 0, `${refused.marks} marks · ${refused.tip.slice(0, 80)}`);
  if (process.env.E2E_MEASURE) await measureColumns(review, monitor);
  check("timeline: no page errors", review.errors.length === 0, review.errors.join(" | ").slice(0, 200));

  // ---------- one 复盘, several pulls ----------
  // A 24-player duty: a trash pull, then the boss, in one visit to the zone (docs/DESIGN.md 6.2).
  await monitor.front();
  // Moved to after the pulls before it: time runs forward in a log.
  const allianceLines = fixture("alliance-24p.log.gz").map((l) => [l[0], l[1].replace("2026-09-20T", "2026-10-01T"), ...l.slice(2)]);
  for (let i = 0; i < allianceLines.length; i += 1500) {
    await monitor.evaluate(`for (const line of ${JSON.stringify(allianceLines.slice(i, i + 1500))}) window.__mockPush({ type: 'LogLine', line, rawLine: line.join('|') }); true`);
  }
  await sleep(1500);
  await review.front();
  // The fixture is older than the pulls before it: its 复盘 is further down the list.
  await review.evaluate("[...document.querySelectorAll('.encounters .session .head')].find((h) => h.textContent.includes('水晶塔')).click(); true");
  await sleep(1500);
  const pulls = () => review.evaluate("[...document.querySelectorAll('.encounters .session.selected .pulls li')].map((li) => ({ text: li.textContent.replace(/\\s+/g, ' ').trim(), on: li.classList.contains('selected') }))");
  const run = await review.evaluate("document.querySelector('.encounters .session.selected .head')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''");
  const listed = await pulls();
  check("复盘: a duty's pulls are one entry, its pulls listed under it, the latest open", run.includes("水晶塔") && run.includes("2 场") && listed.length === 2 && listed[1].on && listed[1].text.includes("始皇帝赞德"), `${run} | ${JSON.stringify(listed)}`);
  check("复盘: the header names the pull and where it is in the 复盘", (await review.evaluate("document.querySelector('.top .title').textContent")).includes("第 2 / 2 场"));
  await review.evaluate("document.querySelectorAll('.encounters .session.selected .pulls li')[0].click(); true");
  await sleep(800);
  const switched = await pulls();
  const switchedTitle = await review.evaluate("document.querySelector('.top .title').textContent");
  if (process.env.E2E_SCREENSHOTS) await review.screenshot(join(process.env.E2E_SCREENSHOTS, "review-session.png"));
  check("复盘: picking another pull of it opens that one", switched[0]?.on === true && switchedTitle.includes("第 1 / 2 场"), switchedTitle.replace(/\s+/g, " "));
  check("复盘: no page errors", review.errors.length === 0 && monitor.errors.length === 0, [...monitor.errors, ...review.errors].join(" | ").slice(0, 200));

  // ---------- the review window's buttons ----------
  const buttons = await review.evaluate(`(() => {
    const clear = document.querySelector('.encounters .clear-all');
    const gear = document.querySelector('.top-actions .gear');
    const before = clear.disabled;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
    return new Promise((res) => setTimeout(() => {
      const held = clear.disabled;
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }));
      setTimeout(() => res({ before, held, after: clear.disabled, importText: document.querySelector('.encounters .import').textContent.trim(), gearText: gear.textContent.trim(), gearIcon: gear.querySelector('svg')?.getBoundingClientRect().width ?? 0 }), 50);
    }, 50));
  })()`);
  check("review: 清空 is disabled until Ctrl is held, and again once let go", buttons.before && !buttons.held && buttons.after, JSON.stringify(buttons));
  check("review: 导入 and an icon-only settings button, its icon full size", buttons.importText === "导入" && buttons.gearText === "" && buttons.gearIcon >= 12, JSON.stringify(buttons));

  // ---------- importing a log file (docs/DESIGN.md 9.5) ----------
  // A Network log as ACT writes it: CRLF, a hash at the end of each line, lines the engine does not read. Another day's
  // pull, so it is not in the archive yet.
  const logPath = join(profileDir, "Network_30301_20261002.log");
  const logLines = phaseLines.map((l) => [l[0], l[1].replace("2026-09-28T", "2026-10-02T"), ...l.slice(2)]);
  writeFileSync(logPath, ["251|2026-10-02T21:00:00.0000000+08:00|debug line|0000000000000000", ...logLines.map((l) => `${l.join("|")}|0123456789abcdef`)].join("\r\n"));
  await review.evaluate("document.querySelector('.encounters .import').click(); true");
  await sleep(300);
  await review.setFiles(".dialog input[type=file]", [logPath]);
  for (let i = 0; i < 50 && !(await review.evaluate("!!document.querySelector('.dialog .pull')")); i++) await sleep(200);
  const foundPulls = await review.evaluate("[...document.querySelectorAll('.dialog .pull')].map((p) => p.textContent.replace(/\\s+/g, ' ').trim())");
  check("import: a log file lists its pulls, by zone visit, with boss, result and deaths", foundPulls.length === 1 && foundPulls[0].includes("格莱杨拉波尔") && foundPulls[0].includes("过本"), JSON.stringify(foundPulls));
  await review.evaluate("document.querySelector('.dialog .pull input').click(); true");
  const importLabel = await review.evaluate("[...document.querySelectorAll('.dialog footer button')].at(-1).textContent.trim()");
  check("import: choosing a pull counts it on the button", importLabel === "导入 1 场", importLabel);
  if (process.env.E2E_SCREENSHOTS) await review.screenshot(join(process.env.E2E_SCREENSHOTS, "review-import.png"));
  await review.evaluate("[...document.querySelectorAll('.dialog footer button')].at(-1).click(); true");
  for (let i = 0; i < 50 && (await review.evaluate("!!document.querySelector('.dialog')")); i++) await sleep(200);
  await sleep(1000);
  const importedHead = await review.evaluate("document.querySelector('.encounters .session.selected .head')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''");
  const importedTitle = await review.evaluate("document.querySelector('.top .title')?.textContent.replace(/\\s+/g, ' ').trim() ?? ''");
  check("import: the pull becomes a 复盘, marked imported and pinned, and opens", importedHead.includes("10-02") && importedHead.includes("导入") && (await review.evaluate("document.querySelector('.encounters .session.selected .icon.on') !== null")) && importedTitle.includes("格莱杨拉波尔"), `${importedHead} | ${importedTitle}`);
  await review.evaluate("document.querySelector('.tab[data-tab=damage]').click(); true");
  await sleep(500);
  // Shown / all rows: all of them, as the scan counted (the table's own filters may hide some).
  const importedRows = await review.evaluate("document.querySelector('.tabs .num')?.textContent.trim() ?? ''");
  check("import: its rows are rebuilt like any 复盘's, as many as the scan counted", importedRows.endsWith("/148"), importedRows);
  await review.evaluate("document.querySelector('.encounters .import').click(); true");
  await sleep(300);
  await review.setFiles(".dialog input[type=file]", [logPath]);
  for (let i = 0; i < 50 && !(await review.evaluate("!!document.querySelector('.dialog .pull')")); i++) await sleep(200);
  const again = await review.evaluate("(() => { const p = document.querySelector('.dialog .pull'); return { done: p.classList.contains('done'), disabled: p.querySelector('input').disabled, text: p.textContent }; })()");
  check("import: a pull already in the archive cannot be chosen again", again.done && again.disabled && again.text.includes("已在复盘里"), JSON.stringify(again));
  await review.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
  await sleep(200);
  check("import: Esc closes the dialog, no page errors", !(await review.evaluate("!!document.querySelector('.dialog')")) && review.errors.length === 0, review.errors.join(" | ").slice(0, 200));

  // Editing the overlay URL from #/ to #/probe can be an in-page route change: OverlayPlugin sends no
  // fresh cached events, yet the probe page must still see the party and the player (seen in ACT).
  await monitor.evaluate("location.hash = '#/probe'; true");
  await sleep(2500);
  const routed = await monitor.evaluate("document.body.textContent");
  check("route change: probe page reports it was not reloaded", routed.includes("应用内路由切换"));
  check("route change: probe page still gets the cached party", routed.includes("收到 1 次，8 人"), /PartyChanged（[^）]*）/.exec(routed)?.[0]);
  check("route change: probe page still gets the player", routed.includes(primaryPlayer.charName + " ("));

  // ---------- probe ----------
  const probe = await openTab(`${base}#/probe`, 900, 900, MOCK_API);
  await sleep(2500);
  const checks = await probe.evaluate("[...document.querySelectorAll('table')[1].rows].map((r) => [...r.cells].map((c) => c.textContent.trim()))");
  for (const [name, state, detail] of checks ?? []) check(`probe: ${name}`, state === "可用", detail);
  await probe.evaluate("document.querySelector('button').click(); true", true);
  await sleep(2500);
  const popupRows = await probe.evaluate("[...(document.querySelectorAll('table')[2]?.rows ?? [])].slice(1).map((r) => [...r.cells].map((c) => c.textContent.trim()))");
  const opened = await probe.evaluate("document.body.textContent.includes('window.open 返回了窗口')");
  check("probe: window.open opens the popup", opened);
  for (const row of popupRows ?? []) check(`probe popup via ${row[0]}: shares localStorage and IndexedDB`, row[4] === "同一份" && row[5] === "同一份", row.join(", "));
  check("probe: popup reported back", (popupRows?.length ?? 0) > 0, `${popupRows?.length ?? 0} reports`);
  const gc = await probe.evaluate("document.querySelector('table.combatants')?.textContent ?? ''");
  check("probe: getCombatants lists 8 players, the party marker and the player first",
    gc.includes("玩家（Type=1）8") && gc.includes('{"1":8}') && gc.includes(`第一个单位${primaryPlayer.charName} (Type=1`), gc.slice(0, 120));
  check("probe: no page errors", probe.errors.length === 0, probe.errors.join(" | ").slice(0, 200));
} finally {
  await stopChrome();
}

const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

// ---------- column widths (E2E_MEASURE=1): which cells cut their text, by column ----------
/** Every grid row on the page: per column, how many cells, how many cut their text, by how much at most. */
function measureScript() {
  return `(() => {
  const out = [];
  for (const row of document.querySelectorAll('*')) {
    const cs = getComputedStyle(row);
    if (cs.display !== 'grid' || row.offsetParent === null || row.children.length < 2) continue;
    const scope = ['.monitor', '.detail', '.deaths-tab', '.aoe-tab', '.stats-tab', '.encounters', '.dialog', '.table'].find((s) => row.closest(s)) ?? row.parentElement.className;
    [...row.children].forEach((cell, i) => {
      const text = cell.textContent.trim();
      if (!text) return;
      const key = scope + ' ' + (row.className.split(' ')[0] || row.tagName) + ' #' + i + ' ' + (cell.className.baseVal ?? cell.className).split(' ')[0];
      // The cell, or something inside it that cuts its own text (an ellipsis on a name inside a cell).
      let width = cell.clientWidth, content = cell.scrollWidth;
      for (const el of cell.querySelectorAll('*')) {
        if (!el.textContent.trim() || el.clientWidth === 0) continue;
        if (el.scrollWidth - el.clientWidth > content - width) { width = el.clientWidth; content = el.scrollWidth; }
      }
      out.push({ key, width, content, text: text.slice(0, 24) });
    });
  }
  return out;
})()`;
}

async function measureColumns(review, monitor) {
  const all = [];
  const take = async (page) => all.push(...(await page.evaluate(measureScript())));
  const scrollThrough = async (page, rowSel) => {
    for (const at of [0, 0.25, 0.5, 0.75, 1]) {
      await page.evaluate(`(() => { const r = document.querySelector('${rowSel}'); let s = r?.parentElement; while (s && s.scrollHeight <= s.clientHeight) s = s.parentElement; if (s) s.scrollTop = (s.scrollHeight - s.clientHeight) * ${at}; return true; })()`);
      await sleep(150);
      await take(page);
    }
  };
  const tab = (key) => review.evaluate(`document.querySelector('.tab[data-tab=${key}]').click(); true`).then(() => sleep(500));
  await tab("damage");
  await scrollThrough(review, ".table .row");
  await review.evaluate("document.querySelector('.table .row:not(.death)')?.click(); true");
  await sleep(400);
  await take(review);
  await review.evaluate("document.querySelector('.table .row.death')?.click(); true");
  await sleep(400);
  await take(review);
  await tab("deaths");
  for (let i = 0; i < 4; i++) {
    await review.evaluate(`document.querySelectorAll('.death-list li')[${i}]?.click(); true`);
    await sleep(300);
    await take(review);
  }
  // With the detail panel open (a hit picked in the replay): the middle narrows.
  await review.evaluate("[...document.querySelectorAll('.deaths-tab .line:not(.head)')].find((l) => /致命|受击/.test(l.textContent))?.click(); true");
  await sleep(400);
  await take(review);
  await tab("aoe");
  for (let i = 0; i < 4; i++) {
    await review.evaluate(`document.querySelectorAll('.list .g')[${i}]?.click(); true`);
    await sleep(300);
    await take(review);
  }
  await review.evaluate("document.querySelector('.aoe-tab .m:not(.head)')?.click(); true");
  await sleep(400);
  await take(review);
  await tab("stats");
  await take(review);
  await monitor.front();
  await scrollThrough(monitor, ".body .row");
  await review.front();
  const cols = new Map();
  for (const m of all) {
    const c = cols.get(m.key) ?? { n: 0, cut: 0, over: 0, width: m.width, widest: 0, worst: "" };
    c.n++;
    c.widest = Math.max(c.widest, m.content);
    if (m.content > m.width + 1) {
      c.cut++;
      if (m.content - m.width > c.over) {
        c.over = m.content - m.width;
        c.worst = m.text;
      }
    }
    cols.set(m.key, c);
  }
  console.log("\nCOLUMNS (key · cells · cut · width → widest content · worst cut)");
  for (const [k, c] of [...cols].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${k} · ${c.n} · ${c.cut} · ${c.width} → ${c.widest}${c.cut ? ` · +${c.over}px "${c.worst}"` : ""}`);
}
