# dsh-vision-dafeiyu — 大肥鱼识图 + 小云雀（独立插件）

从 `dsh-remote-dafeiyu`（大肥鱼本体）里拆出来的两件事：

| 能力 | 宿主侧 | 设置页 | 工具 |
|---|---|---|---|
| **肥鱼识图**（外挂视觉模型） | `/api/dsh-remote-dafeiyu/vision/{config,recognize,models}` | 「肥鱼识图」tab（order 40） | `recognize_image` + `dafeiyu:vision` 提示词段 |
| **小云雀**（CLI 生图/生视频） | `/api/dsh-remote-dafeiyu/xyq/*`（八条） | 「小云雀」tab（order 50） | `generate_image` / `generate_video` / `xyq_balance` / `xyq_models` + `dafeiyu:xyq` 提示段 |

**路由前缀与存储目录与大肥鱼本体完全一致（零迁移）**：手机协议、本体其它代码、
用户已经配好的 key 都指着这些路径，拆包不是改名的机会。

- 存储：`<DSH_HOME>/storages/dsh-remote-dafeiyu/vision.json`、`xyq.json`、`xyq-output/`
- 设置页 tab 通过本体的**房间注册表**接入（`window.__dafeiyuRooms`，见 `src/client/rooms.ts`）

---

## 一、仓库结构（每个文件从哪来）

来源仓：`dsh-remote-src`（本体 `0.9.0-dafeiyu.89` + 未提交的界面美化）。
下面「来源」一列写的是**源仓里的原路径**；标 `—` 的是本包新建的（拆包必须有的胶水）。

### 宿主侧（`tsconfig.json` 面）

| 本包路径 | 来源 | 说明 |
|---|---|---|
| `src/index.ts` | 本体 `src/index.ts:1589-1597 / 1620-1628 / 1698-1723` 的启动块 | 两段 `try/catch` 软挂载 + `stop()`，一字未改 |
| `src/paths.ts` | 本体 `src/memory/service.ts:39-45` | `resolveDshHome`（唯一一份派生规则） |
| `src/http/guards.ts` | 本体 `src/pill/routes.ts:196-305` | 回环守卫 / CORS / 预检四个导出（逐字照抄） |
| `src/vision/config.ts` | 本体 `src/vision/config.ts` | 配置归一、key 打码、协议猜测 |
| `src/vision/protocols.ts` | 本体 `src/vision/protocols.ts` | 四家协议的请求体与取文本 |
| `src/vision/service.ts` | 本体 `src/vision/service.ts` | 配置落盘 + 识图调用 + 模型列表 |
| `src/vision/routes.ts` | 本体 `src/vision/routes.ts` | 三条回环路由（**只改了一行 import**，见下） |
| `src/vision/start.ts` | 本体 `src/vision/start.ts` | 软挂载 + `recognize_image` 工具 + 提示词段 |
| `src/xyq/cli.ts` | 本体 `src/xyq/cli.ts` | 找/跑官方 `pippit-tool-cli` |
| `src/xyq/config.ts` | 本体 `src/xyq/config.ts` | 配置归一与脱敏（**只改了一行 import**） |
| `src/xyq/guidance.ts` | 本体 `src/xyq/guidance.ts` | 使用提示（唯一一份） |
| `src/xyq/routes.ts` | 本体 `src/xyq/routes.ts` | 八条回环路由（**只改了一行 import**） |
| `src/xyq/service.ts` | 本体 `src/xyq/service.ts` | 生成 / 轮询 / 预算 |
| `src/xyq/start.ts` | 本体 `src/xyq/start.ts` | 软挂载 + 四个工具 + 提示段 |
| `src/xyq/tools.ts` | 本体 `src/xyq/tools.ts` | 四个工具定义 |

> 三处 import 改动是**唯一**的代码改动（独立包不能引本体代码）：
> `vision/routes.ts` 与 `xyq/routes.ts` 的 `../pill/routes.js` → `../http/guards.js`；
> `xyq/config.ts` 的 `../memory/service.js` → `../paths.js`。被 import 的函数**逐字照抄**。

### 浏览器侧（`tsconfig.client.json` 面）

| 本包路径 | 来源 | 说明 |
|---|---|---|
| `src/client/main.ts` | — | 入口：`export const name` = 包名；挂两间房 + 两颗悬浮按钮 |
| `src/client/rooms.ts` | — | `waitForRooms(1500)` + 两间房（`vision` 40 / `xyq` 50） |
| `src/client/react.ts` | — | 向装载器要 `react` / `react-dom/client`（模块名走变量，防构建期静态解析） |
| `src/client/host-url.ts` | 本体 `src/client/host-url.ts` | 绝对地址解析（桌面 `dsh-app://` 那一层） |
| `src/client/host-api.ts` | 本体 `src/client/host-api.ts` | 只留 `VISION_BASE` / `VISION_RECOGNIZE_ROUTE` / `callJson` |
| `src/client/panel-kit.ts` | 本体 `src/client/panel-kit.ts` | 卡片/标签/按钮工厂（**有意的重复**，见文件头） |
| `src/client/vision-panel.ts` | 本体 `src/client/vision-panel.ts` | 识图配置块 + 聊天页鲸鱼按钮（FAB） |
| `src/client/vision-tab.ts` | 本体 `src/client/vision-tab.ts` | 「肥鱼识图」整栏 |
| `src/client/xyq-panel.ts` | 本体 `src/client/xyq-panel.ts` | 「小云雀」整栏 |
| `src/client/xyq-quick.ts` | 本体 `src/client/xyq-quick.ts` | 小云雀快捷面板（一字未改） |
| `src/client/draggable.ts` | 本体 `src/client/draggable.ts` | 悬浮面板拖动（FAB / 快捷面板共用） |
| `src/client/xyq-fab.ts` | — | **新增**：快捷面板的入口按钮（原因见下） |

### 测试

| 本包路径 | 来源 |
|---|---|
| `tests/vision.test.ts` | 本体 `tests/vision.test.ts`（逐字） |
| `tests/xyq.test.ts` | 本体 `tests/xyq.test.ts`（逐字） |
| `tests/rooms.test.ts` | **新增 3 条**：两间房都注册 / 拿不到宿主不抛不刷 error / 切走 tab 时清理函数被调用 |

### 打包与工程

`package.json`（照 `dsh-avatar-dafeiyu` 的形态）、`cordis.patch.yml`、`.gitignore`
（`/dist/*` + `!/dist/bundle/`）、`.gitattributes`（产物强制 LF）、`tsconfig.json`、
`tsconfig.client.json`、`.bin-build.mjs`、`.check-dist.mjs`、`.github/workflows/ci.yml`
—— 后三个都照形象包同名文件搬，`.bin-build.mjs` 额外多一条判据：
**`client.cjs` 里必须出现 `__dafeiyuRooms`**（房间注册代码没进产物就是"文件都在、
客户端就是不挂载"）。

---

## 二、三处名字必须一致（写错的表现：文件都在、不报错、就是不工作）

```jsonc
// package.json
"name": "dsh-vision-dafeiyu"
```
```yaml
# cordis.patch.yml
- insert:
    - id: vision-dafeiyu
      name: 'dsh-vision-dafeiyu'
```
```ts
// src/client/main.ts
export const name = 'dsh-vision-dafeiyu'
```

`@deepseek-ai/dsh-client-modules` 按 loader entry 名索引浏览器半，名字对不上就**静默不挂载**。

## 三、为什么产物必须入库

市场 / `git+` 安装**不跑构建**，装的是仓库里的 `dist/bundle/`。
所以 `.gitignore` 是 `/dist/*` + `!/dist/bundle/`，且 `.check-dist.mjs` 会在 CI 里
重新构建一次再 `git diff --quiet -- dist/bundle`——源码改了却没提交产物 ⇒ 变红。

```bash
npm install
npm run typecheck   # 宿主面 + 浏览器面各一遍
npm run build       # tsc → dist/ + dist/bundle/{index.js,client.cjs}
npm test            # 构建 + 20 条判据
npm run check       # 产物是否与源码同步（CI 用）
```

## 四、房间（设置页 tab）怎么接的

本体在 client `apply` 的最前面把注册表挂出来（`window.__dafeiyuRooms`）并派发
`dafeiyu:rooms-ready`。本包 `rooms.ts` 的做法：

1. `waitForRooms(1500)`：拿不到（宿主版本旧 / 没有 window）就**静默返回 undefined**，
   不 `console.error`（降级不是故障）；
2. `register({ id:'vision', label:'肥鱼识图', order:40, mount })` 与
   `register({ id:'xyq', label:'小云雀', order:50, mount })`，**两间互不牵连**：
   一间 `register` 抛了，另一间照旧；
3. `mount(container)` 里用 `createRoot` 渲染搬过来的那一栏，**返回的清理函数**
   做 `root.unmount()` + 清空容器子节点（切走 tab / 卸载插件都走它，且幂等）；
4. 宿主没给 React 时，那一格写一行中文说明（与本体 `dafeiyu-page.ts` 的降级行逐字一致），
   不留空白格、不抛。

## 五、和本体的边界（拆包之后本体还需要什么）

1. **`panel-kit.ts` 两边各留一份**（有意的重复）：本体还有「人设（长期记忆）」「Agent 团队」
   两栏在用，本包的两栏也要用。内容逐字一致，以后改动要**两边同步**——
   不同步的表现只是"两个 tab 的卡片长得不一样"，不会有功能性故障。
2. **`host-api.ts` 的常量**：本体那份还有 `MEMORY_BASE` / `PERSONA_STATUS`（记忆与人设包），
   本包只搬了 `VISION_BASE` / `VISION_RECOGNIZE_ROUTE` / `callJson`。
   源文件里本来**没有** `XYQ_*` 常量——小云雀那两个面板各自带一行
   `const BASE = '/api/dsh-remote-dafeiyu/xyq'` 字面量，照搬时保持原样。
3. **`http/guards.ts` 与 `paths.ts` 是同一份实现的第二份**：本体 `pill/routes.ts` /
   `memory/service.ts` 还在原处（本体自己要用）。守卫判据改一次要改两处。
4. **`recognize_image` 的会话注入通道没接**：本体里那颗鲸鱼按钮靠 `ctx.sessions` 把
   识别文本注入当前会话；跨包拿不到那个通道，FAB 按设计退化成"显示结果 + 复制"。
   要接回来需要本体把通道暴露成跨包可用的形状（例如注册表上再挂一个 `injectText`）。
5. **小云雀快捷面板的入口换了一颗按钮**：原入口是形象小窗的菜单项（`onMenuAction('xyq')`），
   那套菜单在 `dsh-avatar-dafeiyu` 里、且它的回调只在包内（没有跨包出口）。
   本包因此在鲸鱼按钮上面加了一颗 🎬 悬浮按钮（`xyq-fab.ts`）来 `open()` 面板，
   面板本身一个字都没改。
6. **本体里那份「肥鱼识图」「小云雀」两栏与本包是两套**：本包只负责"能独立装上、
   自己注册两间房"；本体把这两个分栏撤掉、改成本包注册，是下一步的事（本仓库不动本体仓）。

## 六、判据（`npm test`）

- `tests/vision.test.ts`：配置归一 / key 打码 / 四家协议请求体与取文本 / 配置落盘往返 /
  未开启与无 key 的报错 / 桩 fetch 的识图与模型列表 / 三条路由的 403·400·502 / `startVision` 接线。
- `tests/xyq.test.ts`：配置夹取与脱敏 / 缺 key 与鉴权过期的中文提示 / 提交→轮询→拿文件 /
  预算拦截 / 时长被上限截断 / 状态·余额·模型解析。
- `tests/rooms.test.ts`：两间房都注册且 id/label/order 正确 / 拿不到宿主时静默放弃（无 error 无 warn）/
  切走 tab 时清理函数被调用且幂等。
