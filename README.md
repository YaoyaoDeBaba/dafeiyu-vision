# dsh-vision-dafeiyu — 大肥鱼识图 + 鲸鱼做梦（独立插件）

从 `dsh-remote-dafeiyu`（大肥鱼本体）里拆出来的两件事：

| 能力 | 宿主侧 | 设置页 | 工具 |
|---|---|---|---|
| **肥鱼识图**（外挂视觉模型） | `/api/dsh-remote-dafeiyu/vision/{config,recognize,models}` | 「肥鱼识图」tab（order 40） | `recognize_image` + `dafeiyu:vision` 提示词段 |
| **鲸鱼做梦**（CLI 生图/生视频：小云雀 `xyq` / 即梦 `jimeng` 两条通道） | `/api/dsh-remote-dafeiyu/xyq/*`（八条） | 「鲸鱼做梦」tab（order 50） | `generate_image` / `generate_video` / `xyq_balance` / `xyq_models` + `dafeiyu:xyq` 提示段 |

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
npm test            # 构建 + 122 条判据
npm run check       # 产物是否与源码同步（CI 用）
```

## 四、房间（设置页 tab）怎么接的

本体在 client `apply` 的最前面把注册表挂出来（`window.__dafeiyuRooms`）并派发
`dafeiyu:rooms-ready`。本包 `rooms.ts` 的做法：

1. `waitForRooms(1500)`：拿不到（宿主版本旧 / 没有 window）就**静默返回 undefined**，
   不 `console.error`（降级不是故障）；
2. `register({ id:'vision', label:'肥鱼识图', order:40, mount })` 与
   `register({ id:'xyq', label:'鲸鱼做梦', order:50, mount })`，**两间互不牵连**：
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
6. **本体里那份「肥鱼识图」「鲸鱼做梦」两栏与本包是两套**：本包只负责"能独立装上、
   自己注册两间房"；本体把这两个分栏撤掉、改成本包注册，是下一步的事（本仓库不动本体仓）。

## 六、判据（`npm test`）

- `tests/vision.test.ts`：配置归一 / key 打码 / 四家协议请求体与取文本 / 配置落盘往返 /
  未开启与无 key 的报错 / 桩 fetch 的识图与模型列表 / 三条路由的 403·400·502 / `startVision` 接线。
- `tests/xyq.test.ts`：配置夹取与脱敏 / 缺 key 与鉴权过期的中文提示 / 提交→轮询→拿文件 /
  预算拦截 / 时长被上限截断 / 状态·余额·模型解析。
- `tests/rooms.test.ts`：两间房都注册且 id/label/order 正确 / 拿不到宿主时静默放弃（无 error 无 warn）/
  切走 tab 时清理函数被调用且幂等。
- `tests/web-vision.test.ts`（0.1.3 新增）：网页版协议被接受且不吃 key / 等回答预算有下限 /
  临时图按 mime 落盘 / 未登录 ⇒ 401 且提示去登录 / 上传→打字→回车→抽回答（假 CDP 客户端）/
  上传卡进度不无限等 / 上传入口消失时报"前端可能改版" / 两条新路由在浏览器面与宿主面逐字一致。

## 七、网页版识图（免 key，0.1.3 新增）

不想配 API key 时，可以直接**借本机浏览器里已登录的网页版**去识图：
`protocol` 选 `web-doubao` / `web-gemini`，不需要 `apiKey`、也不需要 `apiBase`。

### 7.1 为什么必须"登录一次"

实测（2026-11-17）：

| 站点 | 上传入口 | 未登录表现 |
|---|---|---|
| 豆包 | `[data-testid="upload_file_button"]` 点开后才出现隐藏 `input[type=file]` | 发送后被踢回 `?from_logout=1`，对话清空 |
| Gemini | `button[aria-label="上传和工具"]` → 菜单 → `input[accept="image/*"]` | 图片卡在「正在上传图片：50%」，菜单写「登录即可体验工具」 |

也就是说两个站点**都没有匿名看图通道**。所以设计成：

1. 用户点设置页「网页版（免 key）」卡里的「登录 豆包/Gemini」→ 宿主弹一个**有头**浏览器窗口
   （`POST /api/dsh-remote-dafeiyu/vision/web/login`，最多等 150 秒）；
2. 用户在里面登一次；cookie 落到本机 profile；
3. 之后识图全走**无头**复用这份 profile，不用再登。

### 7.2 profile 在哪

```
<DSH_HOME>/storages/dsh-remote-dafeiyu/webvision/doubao/
<DSH_HOME>/storages/dsh-remote-dafeiyu/webvision/gemini/
```

与 `vision.json` 同域；**卸载插件不删**（重新登录很烦）。要清除登录态 = 删掉对应目录。

### 7.3 一次识图发生了什么（`src/vision/web/`）

```
driver.ts  起 Edge（持久 profile、CDP、整棵树 kill、父进程看门狗）
sites.ts   站点适配器：点上传 → setFileInputFiles → insertText → Enter → 抽最后一条回答
index.ts   生命周期：一个站点一个浏览器、请求串行、空闲 5 分钟自关、请求间最小间隔 5 秒
```

完成判定不看固定时长：**回答文本连续 1.2 秒不变 + 没有"停止生成"按钮**才算答完；
超时则返回已生成的部分并标注截断。

### 7.4 六个真机踩出来的坑（0.1.3 落地时踩的，别重踩）

1. **无头 UA 会被豆包风控认出来**：`--headless=new` 的 UA 里带 `HeadlessChrome/`，
   带着它发一次图，服务端直接把登录态作废——下一次打开就是未登录，**cookie 明明还在磁盘上**
   （`Cookies` 里 `sessionid` / `sid_tt` / `uid_tt` 全是 persistent）。修法：
   `driver.ts` 连上 CDP 后立刻 `Network.setUserAgentOverride`，把 `HeadlessChrome` 换回
   `Chrome`（版本号取浏览器自己的，不硬编码）。换掉之后同一台机器匿名都能拿到正确答案。
2. **关浏览器必须优雅**：`taskkill /F` 关掉的窗口，刚落的登录 cookie 会丢（用户白登一次）。
   `driver.close()` 先 `Browser.close`、等进程自己退（最多 4 秒），退不掉才杀树。
3. **抽回答别抽整个消息节点**：`[data-testid="receive_message"]` 里混着时间戳（`今天 11:36`）
   和"你可能想问"的追问建议。真正干净的是 `[data-testid="message_text_content"]`
   （class 是 `md-box-root`）——0.1.3 起它是第一顺位候选。
4. **打字别用 `Input.insertText`**：字符进得去，但 Quill（Gemini）的内部模型不更新——
   `ql-blank` 类摘不掉、发送按钮逻辑上还是"空"，点发送**毫无反应**。
   改用 `document.execCommand('insertText')`（走编辑管线、会派发 `beforeinput`/`input`）。
5. **清空输入框要放在塞图之前**：Gemini 的附件挂在 `rich-textarea` 里，
   `execCommand('delete')` 会把刚上传的图一起删掉。
6. **Edge 首启动会弹 `edge://sync-confirmation-dialog`**：那个内部页也是 `type:'page'`，
   会抢走 CDP 的第一个 target（连上去对着"同步浏览数据"对话框执行脚本）。
   修法：优先挑 http(s) 页面 + `--disable-sync --no-service-autorun`。
7. **Gemini 的 file input 是 `accept="image/*,video/*"`**（不是 `image/*`）：
   精确属性匹配一个都找不到，必须用子串匹配 `input[accept*="image/"]`。

### 7.5 在指定「项目」里发起会话（0.1.4）

豆包有「项目」功能（侧栏 → 项目 → 你的项目名）。网页版识图支持把会话**归到指定项目**，
不污染「最近」列表：配置里填 `webProject`（设置页「项目」那一栏）。

实现路径（`sites.ts` 的 `selectProject`，2026-11-17 实测）：

1. 点输入框第二行那颗 **「项目」chip**；
2. 弹层里点项目名（同名元素可能有多处——侧栏也有一个，取**最靠下**那个，弹层贴着输入框）；
3. 确认 chip 文本变成项目名，否则报「切不到项目」；
4. 之后的发图/提问照旧 → 新会话就落在这个项目下（侧栏「项目」分组里能看到）。

细节：这两步都得用**真鼠标事件**（`Input.dispatchMouseEvent`），`el.click()` 点不动那个 chip。
Gemini 没有项目能力，配了 `webProject` 会被忽略并记一条日志，不报错。

### 7.6 「白嫖豆包」与识图模式（0.1.5 的显式交互）

设置页「肥鱼识图」里现在是三个显式开关，不再靠"选一个诡异的协议值"来隐式切换：

| 控件 | 取值 | 含义 |
|---|---|---|
| 开启 | 开/关 | 总开关（关掉就不注册工具、不注提示词） |
| **白嫖豆包** | 开/关 + 站点（豆包 / Gemini） | 开：识图走本机浏览器已登录的网页版，**不要 API key**；关：只走外挂模型 |
| **识图模式** | 单一 / 复合 | 单一：只跑一路；复合：网页 + API **并行各跑一遍**，结果合并 |

配置字段：`freeDoubao: boolean`、`webSite: 'doubao'|'gemini'`、`mode: 'single'|'composite'`。
`protocol` 只管 API 那一路（`web-*` 不再是合法取值——旧配置会被自动迁移成
`freeDoubao: true` + 对应 `webSite`，`protocol` 回到 `auto`）。

**复合模式怎么合并**（`composeRecognition`）：

```
【网页版豆包】
<网页版描述>

【外挂模型（gpt-4o-mini）】
<API 描述>
```

- 两路都成 → 按上面的形状带来源标注拼起来；
- 只有一路成 → 直接用那一路，末尾附一句 `（另一路没成，已忽略：<原因>）`；
- 两路都失败 → 抛错，错误里同时带两边的原因（分清"没登录"还是"key 错了"）。

**并行**不是随便写的：网页版要 8~20 秒、API 几秒，串行等于白等；两路各自 try/catch，
网页版挂了不影响 API 出结果。

### 7.7 现状：豆包已通，Gemini 待复测

| 站点 | 端到端 | 证据 |
|---|---|---|
| 豆包 | ✅ 通 | 同一张测试图连续两次拿到正确描述（`RED CIRCLE` / `WORD: BANANA-4271` / "红色圆形"），单次 10.7s、8.9s |
| Gemini | ⚠️ 代码就绪，未跑通 | 上传成功（"图片已上传"）、打字成功，但**发送后站点自己回「出了点问题」**，无回答。2026-11-17 当天该账号网页版手动也不正常，判断是站点/账号侧问题，不是选择器问题 |

Gemini 那侧要复测的入口：`protocol: 'web-gemini'` + 设置页登录 → 跑一次识图，
若仍报错先用手动窗口确认网页版本身能不能正常问答。

### 7.8 已知限制（别指望它替代 API）

- 一次只能跑一张图，单次 8~20 秒（要等流式结束）；
- 选择器随前端改版失效——选择器集中在 `sites.ts` 顶部，失败会报"前端可能改版"，不会回空串；
- 偶发验证码需要人在弹出的窗口里点一下（`webHeadless=false` 或点一次「登录」）；
- 拿个人账号跑自动化有风控风险，工具只做"像真人一样发一条消息"，请求之间默认隔 5 秒。

## 八、给 agent 的接口与使用指南（0.1.6）

界面只是**配置台**；真正发起识图的是 agent 调工具。四个工具（`src/vision/tools.ts`）：

| 工具 | 参数 | 超时 | 用途 |
|---|---|---|---|
| `recognize_image` | `image_path`（必填）、`prompt`（可选，本次指令） | 120s | 识图主入口：一张本地图 → 文本描述（含逐字转录） |
| `vision_guide` | 无 | 15s | 返回使用指南正文（与 skill **同一份真源**） |
| `vision_web_status` | `site?: doubao \| gemini \| both` | 90s | 查网页版登录态 |
| `vision_web_login` | `site: doubao \| gemini` | 240s | 弹有头窗口让用户登录（需人在电脑前） |

三条纪律（照 `dafeiyu-plugin-dev` 契约）：

1. **工具常注册**：0.1.5 之前只在启动时 `enabled` 才注册，导致"设置页打开开关后还得重启"。
   现在四个工具一直注册，开关由**调用时**实时判断（`recognize_image` 直接报"识图未开启"）；
2. **`tools` 是晚到服务**：`apply` 期间可能取不到，`start.ts` 每 500ms 轮询一次、最多 30 秒，
   拿到就注册（probe 写 `registered(4)`）；30 秒还没有就写 `no-tools（等了 30 秒）` 并记日志；
3. **参数显形**：认不出的参数键会附在结果末尾（`（忽略未知参数：x）`），不静默吞掉。

### 8.1 内置 skill（指南唯一真源）

```
assets/skills/dafeiyu-vision/
├── SKILL.md                       # 正文：什么时候调、四个工具、模式差别、报错怎么读
└── references/
    ├── web-mode.md                # 网页版怎么驱动、为什么必须登录、profile 在哪
    └── troubleshooting.md         # 按报错原文排障
```

启动时铺到 `<DSH_HOME>/skills/dafeiyu-vision/`（`src/vision/skill.ts`）：

- 幂等判据是**内容指纹**（`<相对路径>:<字节数>`），不是版本号 ⇒ 改个错别字不用发版；
- 重铺是整份替换，避免"SKILL.md 新的、references 旧的"；
- 铺完**逐文件比字节**自检，半份 skill 会写清哪个文件没铺到（否则模型照着残缺指南干活）；
- `vision_guide` 工具读的就是这份 `SKILL.md`（去掉 frontmatter），读不到才退回内置短版
  —— 两份文案必漂，所以只有一份真源。

`package.json` 的 `files` 已加 `assets`：**别把它删了**，删了装到用户机器上就没有指南了。

### 7.9 登录窗口"拉不起来"的三个原因（0.1.7 修）

用户反馈「点登录什么都没弹出来」，查下来是三个叠加的问题：

1. **每个 page target 都干等 12.5 秒**：驱动只认 `http(s)` 页面，而我们自己传的启动页是
   `about:blank`——它永远不算数，于是一路等到"超时的一半"才兜底连接。
   表现：窗口开了但**先白屏十几秒**才出页面（用户以为坏了）。
   修法：`about:blank` 立刻认，`edge://` / `chrome://` 内部页仍然不认。
   **实测 launch 从 13.7s 降到 1.5s。**
2. **没有置顶**：有头窗口默认开在 DSH 主窗口后面，用户根本看不见。
   修法：进站点后 `Page.bringToFront()` + `window.focus()`，登录成功后再顶一次。
3. **profile 被上次的无头实例占着**：同一个 `--user-data-dir` 只能有一个实例，
   新进程会把请求交给已有实例然后自己退出 —— 于是"点登录，一个窗口都不出现"，CDP 也永远等不到页面。
   修法：起浏览器前先清掉"命令行里含这个 profile"的 msedge/chrome 进程
   （`killBrowsersUsingProfile`，PowerShell `Get-CimInstance`，约 0.8 秒；只杀这个 profile 的，不碰用户自己的 Edge）。

另外顺手关掉了 Edge 的「上次没有正常关闭」气泡（`--disable-session-crashed-bubble`
`--hide-crash-restore-bubble` `--disable-restore-session-state`），避免强杀后启动变慢。

真机验收（`lab/e2e-login.mjs`：先故意起一个无头实例占住 profile，再调登录）：

```
[login] 清掉了占着 profile 的浏览器进程 {"killed":9}
[login] 登录窗口已弹出并置顶 {"site":"doubao"}
⇒ 结果 {"loggedIn":true,"waitedMs":1379}  用时 8.8s
```

### 7.10 0.1.8：为什么"我明明登录了却显示未登录"

用户报「豆包显示未登录，但我登录着」＋「点登录没窗口」。查下来是三件事，前两件是**认知问题**，
第三件是真 bug：

1. **插件用的是自己的浏览器身份**：`<DSH_HOME>/storages/dsh-remote-dafeiyu/webvision/doubao` 是一个**独立 profile**，
   跟你日常 Edge 的登录态**完全不共享**。你在自己 Edge 里登过豆包，这里照样是未登录。
   → 现在卡片里明写这句，并显示 profile 路径。
2. **状态探测自己会把窗口挡住**：探测要起无头浏览器，而它**一直占着 profile**（旧版是空闲 5 分钟才关）。
   用户紧接着点「登录」→ 有头窗口把请求交给那个无头实例后自己退出 → **一个窗口都不出现**。
   → 0.1.8：探测完**立刻关**（只关探测用的无头实例，有头登录窗口不动）。
3. **登录判定会假阳**：页面刚 open 那一瞬豆包的「登录」按钮还没渲出来，"没有登录按钮"被判成"已登录"
   （实测 0.49 秒就返回 `loggedIn:true`，而该 profile 明明未登录）。
   → 先等输入框渲染出来，再要求**连续两次**探针为真（约 4 秒）才算登录成功。

顺带一条 0.1.7 遗留：`ensureBrowser` 以前在"无头/有头不一致"时会**重开**浏览器，
于是"登录窗口开着时刷新一次登录态，窗口就被关掉了"。现在**有实例就复用**，绝不因为模式不一致重开。

### 7.11 0.1.9：登录判据换成 cookie（DOM 判据会假阳）

0.1.8 之后仍然偶发"判成已登录但其实没有"。根因在 DOM 判据本身：

> 豆包首屏是**输入框先渲染、顶栏后渲染**。`to_login_button` 还没出现的那两三秒里，
> "没看到登录按钮"被当成"已登录"—— 0.1.7 实测报过 `loggedIn:true @0.49s`，而那条 profile 明明未登录。

现在的主判据是 **cookie**（`Network.getCookies`，httpOnly 也能读到）：

| 站点 | 域 | 认哪些 cookie |
|---|---|---|
| 豆包 | `https://www.doubao.com` | `sessionid` / `sessionid_ss` |
| Gemini | `https://gemini.google.com` | `__Secure-1PSID` / `SID` / `__Secure-3PSID` |

`isLoggedIn()` 先用 cookie，拿不到 cookies 数组（老内核/桩）才退回 DOM 探针。
`askSite` / `probeLogin` / 登录会话 / 设置卡片全部走同一个判据，不会再出现"卡片说未登录、识图却能跑"或反过来。

真机验收（0.1.9，真实 profile `C:\Users\htsd\.dsh\...\webvision\doubao`）：

```
cookie: sessionid(len=32, httpOnly) / sessionid_ss / sid_tt …  → 判定：已登录 ✔
webStatus → {"loggedIn":true}
识图 → 24.6s，"RED CIRCLE / WORD: BANANA-4271"，会话归到项目「甲鱼乙豆」
```

## 九、白嫖豆包生图（0.2.0）

识图之外的第二个网页版能力：**用网页版豆包画图，并把图下载回本地**。

### 9.1 怎么用（agent）

```
web_image_gen({ prompt: '一只戴红帽的蓝色小鲸鱼，扁平插画风，纯白背景，不要文字', count: 1 })
→ 1. C:\Users\…\.dsh\storages\dsh-remote-dafeiyu\webvision-images\web-image-1794…-1.png
```

- 需要**网页版豆包已登录**（比识图更依赖登录）；
- 单次 20~90 秒，`count` 最多 4；
- 出的图落在 `<DSH_HOME>/storages/dsh-remote-dafeiyu/webvision-images/`，**不会自动清理**。

### 9.2 实现要点（`src/vision/web/image.ts`）

1. **必须切「图像生成」技能**：默认「对话」模式只会回"我没办法直接生成图片，给你提示词"。
   宽窗口下输入框下面有 `图像生成` chip；窄窗口下技能**折叠进「技能」菜单**，两条路都试
   （`switchToImageSkill` 返回 `chip` / `menu` / 空）。
2. **认出图**：`[data-testid="receive_message"] img` 等候选里取 `naturalWidth ≥ 200` 的（滤头像图标），
   按 src 去重；**数量稳定 8 秒**不动算生成完（`settleMs` 可调，测试用 30ms）。
3. **下载**：页面内 `fetch(url, {credentials:'include'})` 拿 `arrayBuffer` → base64 → Node 落盘
   （带 cookie、绕 CORS；图片是签名 CDN，Node 侧直接 fetch 会 403）。
4. 提示词要走 `execCommand('insertText')`（同识图）；豆包没有「发送」按钮，用回车。

### 9.3 判据（`tests/vision-image.test.ts`，7 条）

切技能→打字→发送→认出图→下载落盘（字节一致）/ 窄窗口走菜单 / 找不到入口报错 /
一张没出报错（带页面尾部）/ 出图但下载全失败报错 / 空提示词拒 / 落盘目录固定。

## 十、双通道：小云雀 / 即梦（0.3.0；产品名「鲸鱼做梦」）

`generate_image` / `generate_video` / `xyq_models` 都多了 `channel` 参数：

| channel | 后端 | 登录 | 适合 |
|---|---|---|---|
| `xyq`（**默认**） | `pippit-tool-cli` | 官网取 Access Key 填设置页 | 营销成片、短剧 agent 全流程 |
| `jimeng` | `jimeng-novel`（一次性命令）/ `dreamina-canvas`（画布） | **浏览器 OAuth**（不需要 Key） | 即梦画布、分镜/导演台、即梦短剧 |

老调用一个字都不用改：不传 `channel` ≡ `channel=xyq`，走的还是原来那段代码。

### 10.1 即梦侧怎么接的

- **二进制按绝对路径 spawn**（安装器不进 PATH）：`<home>/.local/share/jimeng-novel/releases/<版本>/jimeng-novel.exe`、
  `<home>/bin/dreamina-canvas.exe`；`JIMENG_NOVEL_CLI` / `DREAMINA_CANVAS_CLI` 可覆盖（排障口子）。
- 走的是一次性命令，与云雀的"提交→轮询→下载"同形，工具层不用写第二套轮询：
  `generate-image --model … --prompt … --wait N --out <dir>/ -j`、`generate-video …`、`credit get -j`、`model list --type … -j`。
- 产物落 `<DSH_HOME>/storages/dsh-remote-dafeiyu/jimeng-output/`（与云雀同层）。
- **登录不进自动流程**：`AUTH_FAILED` 会翻成"在终端跑 `<绝对路径> login --non-interactive`，把授权链接给用户"——
  工具只给下一步，不替人登录。
- **不可用只影响这一条通道**：`probe()` 写 `probe.jimeng = available:<path> / unavailable:<原因>`，
  并留一行中文日志；云雀那条照常注册、照常出片。

### 10.2 工具与指南

- 工具从 4 个变 5 个：`generate_image` / `generate_video` / `xyq_balance`（两条通道各一段）/ `xyq_models` / **`xyq_guide`**。
- `xyq_guide` 读的就是 `assets/skills/dafeiyu-xyq/SKILL.md`（启动时由 `installBundledSkills` 铺到 `<dshHome>/skills/`），
  与注入的提示段同一口径：**什么时候选即梦（画布/短剧）、什么时候选云雀（营销/全流程）**、两条通道的计费与登录差异。

### 10.3 判据（`tests/xyq-channel.test.ts`，15 条）

不传 channel 参数不变且绝不碰即梦 / 显式 xyq ≡ 不传 / jimeng 走绝对路径且参数拼装正确 /
没装只标该通道 unavailable（probe+日志，云雀照常）/ 缺参数与传错 channel 给中文不抛栈 /
余额两条各一段 / 即梦未登录给可照抄的命令（含绝对路径）/ 定位优先级与版本挑选 /
工具五个且六个键齐全 / guide 正文与兜底 / 多余参数显形（ignored）。

### 10.4 现状与已知

- **即梦已装未登录**：`credit get` 返回 `AUTH_FAILED`（实测），工具会给出 login 命令；登录后第一次真实出图要复核
  `data` 里产物字段名（当前是防御式解析：扫 JSON 里带媒体后缀的字符串）。
- **设置页 / `/xyq/*` 路由还没有通道开关**：这一版只让 agent 侧能选 channel，手机与面板仍走云雀（下一版再开）。

### 10.5 默认通道开关（0.5.0）

设置页「鲸鱼做梦」多了一栏 **默认通道**（`xyq` / `jimeng`），落在 `xyq.json` 的 `defaultChannel`：

- 调用方（工具、`/xyq/generate`、`/xyq/models`、`/xyq/balance`）**没传 `channel` 时**用它；默认 `xyq`，老行为一字不变；
- 传了显式 `channel` 仍以参数为准；传了不认识的值 ⇒ 工具抛中文、路由回 400（不静默回落）；
- 路由侧：`/xyq/generate` 走即梦时**同步**返回（它的一次性命令自带 `--wait`），回包多带 `mode:'sync'` 与 `files`；云雀那条仍是 threadId 两段式；
- `/xyq/models|balance` 支持 `?channel=`，模型列表按通道各查各的（两条通道模型名不通用）。

## 十一、即梦**画布**通道（0.6.0，只读起步）

`generate_image`/`generate_video` 走的是**短剧 CLI**（`jimeng-novel`）的一次性命令；
**画布**（`dreamina-canvas`）是另一条 CLI、另一套信封，这里单独一个工具：

```
xyq_canvas({ action: 'status' | 'canvases' | 'current' | 'nodes' | 'login', canvasId?, type?, status?, query?, limit?, offset? })
```

| action | 调什么 | 返回 |
|---|---|---|
| `status` | `auth status` | 已登录/未登录 + 到期时间 + CLI 版本 |
| `canvases` | `canvas ls` | 画布列表（projectId / name / webUrl / 时间） |
| `current` | `canvas current` | 当前画布（没选就是 null） |
| `nodes` | `node ls` | 节点定位摘要（nodeId / type / title / status / tags），单页 ≤50 |
| `login` | `auth login` + 同一次调用内 `auth wait` | 链接 + 是否登录成功 |

### 11.1 三条与短剧 CLI 不同的硬事实（都是真机踩出来的）

1. **flag 是 `--format json`，不是 `-j`**：`auth status -j` 会返回 `code 2 The command contains an unrecognized option`；
   适配器统一补 `--format json`，调用方只写子命令。
2. **信封是 `{schemaVersion, ok, data, error:{code,message,diagnostics}}`**，不是短剧那套 `{status,data,error}`；
   而且**错误信封可能写在 stderr**（`No project ID was provided` 那条就是），所以 stdout/stderr 都要解析。
3. **命令名是 `node ls`**（不是 `node list`）。

### 11.2 登录：device flow 必须有人轮询

画布的授权**只在 CLI 侧 `auth wait` 时才会把凭证落盘**——用户点了浏览器、但没人跑 `auth wait`，
`auth status` 会一直 `loggedIn:false`。所以 `action:'login'` 在**同一次调用里**等到 `loginWaitMs`
（默认 **120 秒**，可配）：超时就如实回「点完再调一次」，并带上链接，绝不假装已登录。
（上限不设 10 分钟：一次工具调用挂太久会把别的活饿死。）

### 11.3 现状

真机实测（2026-11-25）：`status` → 已登录、到期 2026-11-26T03:55、CLI 1.4.2；
`canvases` → 0 个；`current` → null；`nodes` 未传 canvasId → 回「还没选中画布…」。
写操作（create / run / director）**不在这一版**，等只读链路用稳再开。

## 十二、画布**写操作**：quote → 确认 → run（0.7.0）

`xyq_canvas` 的 action 从 5 个扩到 10 个：

| action | 说明 | 扣积分 |
|---|---|---|
| `status` / `canvases` / `current` / `nodes` / `login` | 只读（0.6.0） | 否 |
| `create-canvas` | 建画布（**需 `confirm:true`**，一次只建 1 个） | 否 |
| `node-create` | 建图片节点（需 `confirm:true`；**不带 --run**，所以不扣） | 否 |
| `node-quote` | 报价：`预计消耗 N 积分（本次上限 M）` | 否 |
| `node-run` | **要 `confirm:true`**：内部 quote → 超上限**一次判死** → confirm(credit-ceiling=M) → run --wait → 下载产物 | **是** |
| `node-download` | 单独下载已生成的资源（`resourceIds`） | 否 |

积分闸（用户 2026-11-25 定的口径）：
- **报价超过设置里的上限 ⇒ 直接拒绝**，不再问第二次（工具层只做一次判断，没有模糊地带）；
- 上限在设置页「画布积分上限」里配（`xyq.json` 的 `canvasMaxCredits`，默认 50）；
- 建画布/建节点/跑节点**都要显式 `confirm:true`**——默认一次 CLI 都不跑；
- 写操作返回**产物的绝对路径 + 本次实扣积分**。

### 12.1 即梦两条 CLI 的输出去向（备忘，别再踩）

> **短剧 `jimeng-novel`**：信封走 **stdout**，flag 是 `-j`。
> **画布 `dreamina-canvas`**：flag 是 **`--format json`**（`-j` 会报 unrecognized option）；
> **错误信封可能写在 stderr**（例：`No project ID was provided`），解析必须 **stdout → stderr 都看**，
> 否则会退化成"没有返回可解析的 JSON"。
> **两条 CLI 的 flag 不通用**，别照抄。

### 12.2 真机实测链路（2026-11-25，花了 4 积分）

```
canvas create "鲸鱼做梦自检-20261125"      → data.project.projectId
node create image --title … --model seedream_5.5 --prompt … → data.node.nodeId
node quote --node-id …                     → {"items":[{"maxCredits":4}],"totalMaxCredits":4,"confirmable":true}
node confirm --credit-ceiling 50           → creditConfirmationToken
node run --credit-token … --wait           → items[].resources[{resourceId, creditsAmount:4, status:success}]
resource download <resourceId> -o <dir>    → {"data":{"path":"…png","size":2162625}}
```
产物 1536×1536 PNG、**带「AI 生成」水印**——拿去做头像/图标要裁缩（群头像 128²、≤12KB data URL）。

### 12.3 字段名踩坑（写适配器时别再赌一个键）

- `canvas create` → `data.project.projectId`（不是 `data.projectId`）；
- `node create` → `data.node.nodeId`（不是 `data.nodeId`），**且 `--title` 必填**；
- `node quote` → `totalMaxCredits` / `items[].maxCredits`；
- `node run` / `node show` → `items[].resources[].resourceId` + `resources[].creditsAmount`（**没有 URL**，要内容必须 `resource download`）。

## 十三、删除动作（0.8.0）：先列清单，再 confirm

写操作能建不能删会攒垃圾，0.8.0 补两个动作：

| action | 行为 |
|---|---|
| `node-delete` | **不带 `confirm`**：只回「将要删除 N 个节点」清单（标题/类型/nodeId/子节点数 + 合计），一条删除请求都不发；带 `confirm:true`：清单 → `node delete confirm`（拿 `deleteConfirmationToken`）→ `node delete --delete-token` |
| `canvas-delete` | **CLI 没有删画布的命令**（`canvas` 只有 create/current/ls/use）→ 如实回「删不了」+ 该画布的网页地址，让用户自己删；没有 `confirm:true` 先拦下来 |

### 13.1 真机形状（node delete 是三步）

```
node delete --node-id … --yes                       → ok:false + **顶层** deletionConfirmation{nodes[{nodeId,title,childCount,…}], totals, updateId}
node delete confirm --node-id … --update-id <u> --yes → data.deleteConfirmationToken
node delete --node-id … --update-id <u> --delete-token <t> --yes → {nodeIds, savedDraftVersion}
```
要点：`deletionConfirmation` 在**信封顶层**（不在 `data` 里）；`confirm` 是 `node delete` 的**子命令**，位置要跟在 delete 后面；确认与执行必须复用同一个 `updateId`。

### 13.2 字段名速查（画布，全部真机验证过）

| 命令 | 取值 |
|---|---|
| `canvas create` | `data.project.projectId`（不是 `data.projectId`） |
| `canvas ls` | `data.items[].projectId/name/webUrl` |
| `canvas current` | `data.currentCanvas`（可能是 `null`） |
| `node create image` | `data.node.nodeId`；**`--title` 必填** |
| `node quote` | `totalMaxCredits` / `items[].maxCredits` |
| `node run` / `node show` | `items[].resources[].resourceId` + `resources[].creditsAmount`（**没有 URL**，要内容必须 `resource download`） |
| `resource download` | `data.path`（本地绝对路径）+ `size` / `sha256` |
| `auth login`（已登录时） | `{"status":"reused","state":{"loggedIn":true,…}}`——按"已登录"处理，别再发授权 |

## 十四、设置页的「即梦画布（只读）」面板（0.9.0）

设置页「鲸鱼做梦」多一张卡：**画布选择器 + 节点列表 + 刷新**，数据走一条只读路由：

```
GET /api/dsh-remote-dafeiyu/xyq/canvas?what=status|canvases|current|nodes[&canvasId=&type=&status=&query=&limit=&offset=]
```

- 只读：**写操作（建画布/建节点/跑/删）不在这条路由上开**，避免面板变成第二条收费入口；
- 没装 `dreamina-canvas` 时回 `{ok:false, unavailable:true, error:…}`（HTTP 200），面板显示"不可用"，其它功能不受影响；
- `what` 写错回 400 + 中文；非 GET 回 405；
- 面板里那颗「刷新」重拉 status + canvases + 当前画布的 nodes；换画布会按 `canvasId` 重查节点。

实测（挂真 CLI）：`status` 带 `loggedIn/expiresAt/version`；`canvases` 回 1 个（`鲸鱼做梦自检-20261125`）；`nodes` 回该画布 1 个节点（标题/类型/状态/nodeId）。

## 十五、事前报价 `xyq_estimate`（0.10.0）

```
xyq_estimate({ type: 'image'|'video', model: '<key>', duration?, channel?, canvasId?, nodeIds? })
→ 预计消耗：4 积分（按 1 image 计）｜通道 jimeng（即梦）｜模型 seedream_5.5
```

- 即梦短剧：包 `jimeng-novel credit estimate --type … --model … [--duration N]`，取 `data.estimatedCredits` /
  `billedAmount` / `billedUnit` / `modelId`；
- 画布：传 `nodeIds`（+`canvasId`）则复用 `node quote`（见 12 节）；
- 小云雀：**没有事前报价接口**，如实回「只有余额与预算上限」；
- 真机价（2026-11-25）：图片 `seedream_5.5` **4 积分/张**；视频 `Seedance_2.5_flash` **4 秒 76 积分**。
  视频贵一个量级，生成前先报价是硬要求（预算 60 的 agent 撞上 76 就是越界）。

### 15.1 视频模型 key（有效清单）

`Seedance_2.5_flash` / `Seedance_2.5_draft` / `Seedance_2.5` / `seedance2.0_fast_vision` / `seedance2.0_vision` /
`Seedance_2.0_mini` / `wan3.0` / `happyhorse-1.1`

**`seedance_2.0`（下划线+2.0）是无效 key**，会返回 `unknown or disabled model "seedance_2.0"; use model list`。
