---
name: dafeiyu-xyq
description: 大肥鱼-鲸鱼做梦：generate_image / generate_video / xyq_balance / xyq_models 底下有两条生成通道，另有 xyq_canvas 操作即梦画布（只读查画布/节点 + 需 confirm 的写操作与删除）——小云雀（channel=xyq，默认）与即梦（channel=jimeng）。这篇讲什么时候选即梦（画布/短剧）、什么时候选云雀（营销成片/短剧 agent 全流程）、两条通道的安装与登录命令、计费差异、调用前自愈怎么读结果。用户要把图/视频交给小云雀或即梦生成、或问「用哪个通道 / 为什么没反应 / 怎么装」时读它。
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
| 画布/节点 | — | **`xyq_canvas`**（`dreamina-canvas`）：status/canvases/current/nodes 只读；create-canvas/node-create/node-run/node-delete 需 `confirm:true` |

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

## 即梦**画布**：`xyq_canvas`（和一次性出图是两回事）

`generate_image` / `generate_video` 的 `channel=jimeng` 走的是**短剧 CLI**（`jimeng-novel`）的一次性命令：
给个 prompt、出一张图/一段片。**画布**（`dreamina-canvas`）是另一条链路，管的是"画布 + 节点"这种工程化产物——
要做多集短剧、分镜/导演台、反复改同一张图时用它。

### 只读（随时可调，不花积分）

| action | 干什么 |
|---|---|
| `status` | 画布登录态（已登录/未登录 + 到期时间 + CLI 版本）；装机自检就用它 |
| `canvases` | 列画布（projectId / name / webUrl） |
| `current` | 当前画布（没选就是 null） |
| `nodes` | 列节点摘要（nodeId / type / title / status / tags），可带 `canvasId`、`type`、`status`、`query`、`limit`(≤50)、`offset` |

### 写操作：**一律要 `confirm:true`**，而且分两步看结果

| action | 代价 | 说明 |
|---|---|---|
| `create-canvas {name, confirm}` | 免费 | 在你账号里建一个画布（一次调用只建 1 个）；建完把 projectId 记下来 |
| `node-create {canvasId, model, prompt, confirm, count?, mode?}` | 免费 | 只建节点**不跑**（不带 `--run`），所以不扣积分；真机 `--title` 必需，插件会自动用 prompt 前 24 字补 |
| `node-quote {canvasId, nodeIds}` | 免费 | 回「预计消耗 N 积分（本次上限 M）」 |
| `node-run {canvasId, nodeIds, confirm:true}` | **扣积分** | 内部：先 quote → **超过设置上限就一次判死、直接报错**（不会再问第二次，也不会再调 confirm/run）→ `node confirm` 拿凭证 → `node run --wait` → 自动 `resource download` 落到 `<DSH_HOME>/storages/dsh-remote-dafeiyu/jimeng-output/` |
| `node-download {canvasId, resourceIds}` | 免费 | 跑完没下到、或事后想再下 |
| `node-delete {canvasId, nodeIds, confirm}` | 免费 | **不带 confirm**：只回「将要删除 N 个节点：标题｜类型｜nodeId（子节点数）」+ 合计，**一条删除请求都不发**；带 `confirm:true` 才真删（不可逆） |
| `canvas-delete {canvasId, confirm}` | 免费 | **CLI 没有删画布的命令**——会如实回「删不了 + 该画布的网页地址」，让用户自己去网页删；`force` 参数保留但不改变结果 |

### 画布的几条硬事实（踩过，别赌）

- 产物**不是路径也不是 URL**：`node run/show` 只给 `resources[].resourceId`（+ `creditsAmount` 实扣积分），
  要内容必须 `resource download <resourceId> -o <dir>`；
- 已登录时 `auth login` 回 `{"status":"reused"}`——按"已登录"处理，别当成"没拿到设备码"；
- `node delete` 的清单（`deletionConfirmation`）在**信封顶层**，不在 `data` 里；
- 画布 CLI 用 `--format json`（**不是 `-j`**），而且**错误信封可能写到 stderr**——所以插件两边都解析；
- 产物带「AI 生成」水印，做头像/图标要裁缩。

## 事前报价 `xyq_estimate`（0.10.0）

跑之前先问价，别事后看余额：

```
xyq_estimate({ type: 'image' | 'video', model: '<key>', duration?: 秒, channel?: 'jimeng' })
→ 预计消耗：N 积分（按 X <unit> 计）｜通道 jimeng（即梦）｜模型 <key>
```

- 即梦短剧通道包 `jimeng-novel credit estimate`；画布节点价传 `canvasId`+`nodeIds`（走 `node quote`）；
- **小云雀通道没有事前报价接口**，工具会如实说，让你改用 `xyq_balance` 看余额；
- 真机参考价（2026-11-25）：**`seedream_5.5` 图片 = 4 积分/张**；**`Seedance_2.5_flash` 视频 4 秒 = 76 积分**。
  **视频动辄几十积分**，生成视频前必须先调 `xyq_estimate`，超预算就换成 `Seedance_2.5_draft` 或缩短秒数。

### 视频模型 key（照抄，别自己猜）

`Seedance_2.5_flash` / `Seedance_2.5_draft` / `Seedance_2.5` / `seedance2.0_fast_vision` / `seedance2.0_vision` /
`Seedance_2.0_mini` / `wan3.0` / `happyhorse-1.1`

⚠️ **`seedance_2.0` 不是有效 key**（会吃 `unknown or disabled model`）。图片侧常见 key：`seedream_5.5` / `seedream_5.0_pro` /
`nova_pro` / `gpt_image_2_5_sunburst` / `qwen_image_3.0_pro` / `ali_midjourney_8_2`。

### 云雀花钱没有报价：先读余额，跑完再读一次

同一个 `智能图片V2.5 Fast` 实测出现 **0 / 8 / 10 分**三种成本（0 分那笔事后对账确认是真没扣，4 张那笔 10 分≈2.5/张）。
**别用面板价目估预算**（它写 2 分/张，是参考值）；云雀也没有报价接口（`xyq_estimate` 对 `channel=xyq` 会拒绝）。
要花钱就用 `xyq_balance` 前后各读一次，把差值报给用户——这是目前唯一可信的口径。
