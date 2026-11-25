---
name: dafeiyu-xyq
description: 大肥鱼的「生成通道」选择手册：generate_image / generate_video / xyq_balance / xyq_models 底下的两条通道（channel=xyq 小云雀、channel=jimeng 即梦），什么时候选即梦（画布/短剧）、什么时候选云雀（营销成片/短剧 agent 全流程）、两条通道的计费与登录差异、不可用时怎么读错误。用户要把图/视频交给小云雀或即梦生成、或问「用哪个通道/为什么即梦没反应」时读这篇。
---

# 生成通道：小云雀 vs 即梦

同一批工具的 `channel` 参数决定活交给谁。**默认 `xyq`**——不传就是老行为。

| | 小云雀（`channel=xyq`，默认） | 即梦（`channel=jimeng`） |
|---|---|---|
| 适合 | 营销成片、达人带货、短剧 agent 全流程、Canvas 画布工程化 | 即梦画布、分镜/导演台、即梦短剧（jimeng-novel）、画布节点编辑 |
| CLI | `pippit-tool-cli`（插件会自动装） | `jimeng-novel`（短剧/一次性生成）、`dreamina-canvas`（画布/节点/导演台） |
| 登录 | 官网 ⚡CLI/API 取 **Access Key**，填进「大肥鱼 → 小云雀」 | **浏览器授权**（OAuth device code），不需要 Key；凭据由 CLI 自己存在本机 |
| 计费 | 积分（视频按时长，约 4 积分/秒；图片按张） | 积分（视频按秒、图片按张、音频/超分另算）；报价用 `jimeng-novel credit estimate` |
| 额度查询 | `xyq_balance` → 小云雀那段 | `xyq_balance` → 即梦那段（`jimeng-novel credit get`） |
| 模型名 | `xyq_models`（type=image/video，通道 xyq） | `xyq_models`（通道 jimeng）或 `jimeng-novel model list --type image` |

## 什么时候选即梦

- 用户明确说「即梦 / Dreamina / 即梦短剧」；
- 要做**即梦画布上的工程**：节点、分组、连线、导演台、多轨草稿；
- 要做**多集短剧/漫剧**（剧本→角色卡→分镜→片段→成片），即梦短剧 CLI 的 `compose` 本地合成本身不花积分。

## 什么时候选云雀

- 用户要的是**营销成片 / 带货视频**（小云雀的公开营销 API 与 agent 全流程）；
- 用户已经配好小云雀 Access Key、并且只是要一张图/一条视频的快活儿；
- 用户没点名 —— **默认就走云雀**，别自作主张切通道。

## 不可用时怎么读错误

两条通道的失败都**不会静默**，工具会返回中文原因。看到这些就照抄给用户，别自己重试：

- 「即梦通道不可用：没找到即梦 CLI（jimeng-novel）……」→ 机器上没装。安装（Windows 原生 PowerShell）：
  `irm https://jimeng.jianying.com/canvas-cli/install.ps1 | iex`（画布 CLI，落 `<home>/bin/dreamina-canvas.exe`）；
  短剧 CLI 的官方入口是 `curl.exe -s https://jimeng.jianying.com/novel-cli | bash`——**Windows 上没有 bash**，那个脚本内嵌了 PowerShell 安装器，按 skill `jimeng-drama` 的安装段走即可，装完在 `<home>/.local/share/jimeng-novel/releases/<版本>/jimeng-novel.exe`。
- 「即梦还没登录（或登录已过期）。在终端跑「\"<绝对路径>\" login --non-interactive」……」→ 让用户在浏览器里点开返回的链接确认，然后按返回的 `nextCommand` 续等；登录状态以 CLI 输出为准，不是以「链接打开过」为准。
- 云雀那段的「已过期或无效」→ 用户去小云雀官网更新 Access Key。

## 调用前自愈（插件自动做，但你要会读结果）

工具在被调用时会按固定顺序自检。**默认策略：自动授权开、自动安装关。**

1. **CLI 在不在**：缺了**默认不自动装**（避免一句"画张图"就在用户机器上执行远端安装脚本）。
   报错里会写「再调一次并传 `autoInstall:true`」，或给手工命令（画布 `install.ps1`；短剧从 `novel-cli` 里解出内嵌 PowerShell 安装器）。
   传了 `autoInstall:true` 才会自动装：仅 Windows、约 2 分钟、输出截断、失败不留半成品、失败后退避 10 分钟；非 Windows 只给手工说明。
2. **授权在不在**：用 `jimeng-novel credit get -j` 的信封判（`error.code=AUTH_FAILED` / `details.auth.nextAction=login`）；
   未登录就**自动发起一次**浏览器授权，把链接原样给用户，一句话说清「点链接授权后告诉我，我再继续」。同一会话只发一次，失败退避 5 分钟。
3. **云雀的凭据**：缺 Access Key 时直接说三处填哪儿（设置页「大肥鱼 → 小云雀」/ 配置文件的 `accessKey` / 环境变量 `XYQ_ACCESS_KEY`）。

想关掉：`autoLogin:false`（只报告不发起授权）；想开安装：`autoInstall:true`。
看到「自动安装失败」「不再重试」不要连点——那是退避期，把手工命令转给用户。
## 纪律

- 一条通道挂了**不许**悄悄换另一条顶上：把原因告诉用户，让他决定。
- 模型名两条通道不通用：切了通道先用 `xyq_models` 查那一边的模型名，别把云雀的 `Seedance_2.0_mini_lite` 传给即梦。
- 生成完把**本地文件绝对路径**给用户；即梦的产物默认落 `<DSH_HOME>/storages/dsh-remote-dafeiyu/jimeng-output/`。