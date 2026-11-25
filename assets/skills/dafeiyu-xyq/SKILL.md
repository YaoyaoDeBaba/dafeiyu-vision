---
name: dafeiyu-xyq
description: 大肥鱼-鲸鱼做梦：generate_image / generate_video / xyq_balance / xyq_models 底下有两条生成通道——小云雀（channel=xyq，默认）与即梦（channel=jimeng）。这篇讲什么时候选即梦（画布/短剧）、什么时候选云雀（营销成片/短剧 agent 全流程）、两条通道的安装与登录命令、计费差异、调用前自愈怎么读结果。用户要把图/视频交给小云雀或即梦生成、或问「用哪个通道 / 为什么没反应 / 怎么装」时读它。
---

# 大肥鱼-鲸鱼做梦：小云雀 vs 即梦

「大肥鱼-鲸鱼做梦」是这个能力的**名字**，底下两条**通道**：`channel=xyq`（小云雀，默认）与 `channel=jimeng`（即梦）。
不传 `channel` 就是小云雀——老调用一个字都不用改。

| | 小云雀（`channel=xyq`，默认） | 即梦（`channel=jimeng`） |
|---|---|---|
| 适合 | 营销成片、达人带货、短剧 agent 全流程、Canvas 画布工程化 | 即梦画布、分镜/导演台、即梦短剧（`jimeng-novel`）、画布节点编辑 |
| CLI | `pippit-tool-cli` | `jimeng-novel`（短剧/一次性生成）、`dreamina-canvas`（画布/节点/导演台） |
| 安装 | `npx @pippit-dev/cli@latest install`（一次装好 CLI + 通用创作 Skill + 短剧 Skill；插件侧超时 180s） | Windows：画布 `irm https://jimeng.jianying.com/canvas-cli/install.ps1 \| iex`；短剧 `https://jimeng.jianying.com/novel-cli` 是 sh，里面内嵌 PowerShell 安装器（插件侧超时 120s） |
| 登录 | 小云雀官网 ⚡CLI/API → API → 管理 Access Key，填进「大肥鱼 → 鲸鱼做梦」或 `xyq.json` 的 `accessKey`，或用环境变量 `XYQ_ACCESS_KEY` | **浏览器授权**（OAuth device code），不需要 Key：`jimeng-novel login --non-interactive` 拿链接给用户点 |
| 额度 | `xyq_balance` 云雀段（内部 `get-credit-balance`） | `xyq_balance` 即梦段（内部 `jimeng-novel credit get`） |
| 计费 | 积分：视频按时长（约 4 积分/秒）、图片按张 | 积分：视频按秒、图片按张，音频/超分另算；准数用 `jimeng-novel credit estimate` |
| 模型名 | `xyq_models`（通道 xyq） | `xyq_models`（通道 jimeng）或 `jimeng-novel model list --type image` |

## 什么时候选即梦

- 用户明确说「即梦 / Dreamina / 即梦短剧」；
- 要做**即梦画布上的工程**：节点、分组、连线、导演台、多轨草稿；
- 要做**多集短剧/漫剧**（剧本→角色卡→分镜→片段→成片），`compose` 本地合成本身不花积分。

## 什么时候选云雀

- 用户要**营销成片 / 带货视频**（小云雀公开营销 API 与 agent 全流程）；
- 用户已经配好小云雀 Access Key、只是要一张图/一条视频的快活儿；
- 用户没点名 —— **默认走云雀**，别自作主张切通道。

## 调用前自愈（插件自动做，但你要会读结果）

工具被调用时会按固定顺序自检，**你不需要自己装、自己登**：

1. **CLI 在不在**：缺了**默认只报错**（自动安装是在用户机器上跑远端脚本，必须显式 `autoInstall:true` 才允许）。云雀装 `npx @pippit-dev/cli@latest install`（180s）；即梦走官方 PowerShell 安装器（120s）。输出截断、失败给手工命令、失败退避 10 分钟。
2. **授权在不在**：即梦用 `jimeng-novel credit get -j` 的信封判（`error.code=AUTH_FAILED` / `details.auth.nextAction=login`），未登录就发一次浏览器授权，把链接原样给用户，并说「点链接授权后告诉我，我再继续」；**同一会话只发一次**。若返回 `authorization_expired` / `nextAction=restart`（真机码 40014），插件会清掉旧码用 `--restart` 重开并给**新链接**——这时要把最新链接给用户，别复述旧的死链接。
3. **云雀的凭据**：缺 Access Key 时说清三处填哪儿（设置页「大肥鱼 → 鲸鱼做梦」/ `xyq.json` 的 `accessKey` / 环境变量 `XYQ_ACCESS_KEY`）。

开关：`autoInstall`（默认 **false**）、`autoLogin`（默认 **true**），传 false 只报告不动手。
一条通道挂了**不许**悄悄换另一条顶上：把原因告诉用户，让他决定。

## 纪律

- 模型名两条通道不通用：切了通道先用 `xyq_models` 查那一边的模型名。
- 生成完把**本地文件绝对路径**给用户；即梦产物默认落 `<DSH_HOME>/storages/dsh-remote-dafeiyu/jimeng-output/`。
- 「大肥鱼-鲸鱼做梦」是能力名，「小云雀」「即梦」是通道名，别把两者混着叫。
