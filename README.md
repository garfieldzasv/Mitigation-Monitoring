# Mitigation Monitoring · 小队受伤记录

FF14 的 ACT 悬浮窗：逐条记录小队每个人受到的每一次伤害，打本时实时看，打完在复盘窗口里细看。

开发中，设计见 [docs/DESIGN.md](docs/DESIGN.md)。

## 使用

- **监控窗口**：OverlayPlugin 里新建一个 MiniParse 悬浮窗，网址填 `dist/index.html` 的 `file://` 地址，宽约 475px，高 300~400px
- **复盘窗口**：监控窗口工具栏的 `复盘 ↗`，或死亡行右侧的 `↗`（直接打开这次死亡的回放）。要点击时先关掉悬浮窗的鼠标穿透。标签页：受伤明细、死亡回放、AOE 对比、统计、时间轴
- **导入日志**：复盘窗口左上角的 `导入日志`，选择或拖入 ACT 的网络日志（`%APPDATA%\Advanced Combat Tracker\FFXIVLogs\Network_*.log`），勾选其中的场次导入为复盘（自动收藏）
- 自己或小队进入战斗才开始记录；每场战斗的原始日志行自动存进 ACT 内置浏览器的 IndexedDB。一次进本（或进入一张地图）的全部战斗是一份复盘，比如 24 人本的几个 boss；默认保留最近 20 份，收藏（★）的不删。复盘时从原始行重新计算，所以以后修正的减伤数值、算法对旧记录同样生效
- **设置**：监控窗口工具栏的 `⚙` 或在窗口里点右键。可以设置不存档的区域（按副本类型、野外地图、特殊场景勾选，默认只存副本）、保留复盘份数、行高、字号、背景不透明度、是否高亮自己

## 开发

需要 Node.js 和 pnpm。

```bash
pnpm install
pnpm copy-icons  # 从本机图标解包目录复制职业和状态图标到 public/icons（不进 git；FFXIV_ICON_DIR 可覆盖路径）
pnpm test        # 单元测试（含真机日志夹具）
pnpm typecheck
pnpm e2e         # 构建，并用无头 Chrome 从 file:// 跑冒烟测试
pnpm dev         # 浏览器调试，URL 加 ?OVERLAY_WS=ws://127.0.0.1:10501/ws 连接 ACT
```

e2e 设置环境变量 `E2E_SCREENSHOTS=<目录>`（目录要先建好）会把监控页、过滤弹层、复盘页的截图存下来。

从 ACT 网络日志切测试夹具：

```bash
pnpm make-fixture <Network_*.log> --list
pnpm make-fixture <Network_*.log> --start 2026-09-20T00:25:23 --out tests/fixtures/<名字>.log.gz
```

用整份日志检查：

```bash
pnpm estimate-mitigation <Network_*.log>...       # 从伤害反推各状态的实际减伤，和数值表对照
pnpm death-attribution [--all] <Network_*.log>... # 死亡找到致命一击的比例，列出没找到的和疑似读条
```

## 在 ACT 里做运行环境实测

1. `pnpm build`
2. 在 OverlayPlugin 里新建一个 MiniParse 悬浮窗，关掉鼠标穿透，网址填 `dist/index.html` 的完整 `file://` 地址，末尾加 `#/probe`
3. 点“打开测试窗口”，再点“复制全部结果”
4. 关掉 ACT 重新打开，再看一次“上次写入”是否保留
5. 用 http 地址再测一遍：`pnpm preview` 后网址填 `http://localhost:4173/#/probe`。ACT 那台机器没有 Node 时，把 `scripts/serve/serve.cmd`、`serve.ps1` 放到构建产物旁边双击，效果一样（只用 Windows 自带的 PowerShell）
6. 想看 CombatData 名单，打一场战斗；ACT 的解析范围分别设成小队和全团各打一次
