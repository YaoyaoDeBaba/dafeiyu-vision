/**
 * xyq/guidance —— 生成工具的使用提示（唯一一份：注入与推送共用）。
 *
 * 产品名：**大肥鱼-鲸鱼做梦**（2026-11-25 从小云雀改名而来——它同时覆盖云雀与即梦两条通道）。
 * 底下两条通道：小云雀（xyq，默认）/ 即梦（jimeng）。提示词必须先把「怎么选通道」讲清，
 * 否则模型会拿云雀的模型名去调即梦、或者反过来。
 */
export function xyqGuidance(freedom: string): string {
  const lines = [
    '## 大肥鱼-鲸鱼做梦（图片 / 视频生成）',
    '这个能力叫「大肥鱼-鲸鱼做梦」，下设两条通道，用工具参数 `channel` 选：`channel=xyq`（默认，小云雀）/ `channel=jimeng`（即梦）。',
    '工具：`generate_image`、`generate_video`、`xyq_balance`（两条通道各一段额度）、`xyq_models`（先定通道再查模型）、`xyq_guide`（本指南兜底）。',
    '- 小云雀（xyq）：营销成片、短剧 agent 全流程、Canvas 画布工程化。Access Key 在「大肥鱼 → 鲸鱼做梦」里填，积分计费。',
    '- 即梦（jimeng）：即梦画布与短剧创作（画布 CLI `dreamina-canvas` + 短剧 CLI `jimeng-novel`），画布/分镜/导演台类需求。积分计费，登录走**浏览器授权**（不需要 Key）。',
    '选择口径：用户点名「即梦 / Dreamina」→ jimeng；点名「小云雀 / xyq」→ xyq；没点名 → 默认 xyq，只有明确提出即梦画布、即梦短剧、Dreamina 时才切 jimeng。',
    '使用顺序：`xyq_models` 查模型（两条通道模型名不通用）→ `xyq_balance` 看额度 → 生成 → 把工具返回的**本地文件绝对路径**告诉用户。',
    '安装与登录（两条通道不一样，别混）：',
    '| | 小云雀（xyq） | 即梦（jimeng） |',
    '| 安装 | `npx @pippit-dev/cli@latest install`（一次装好 CLI + 通用创作 Skill + 短剧 Skill；超时 180s） | Windows 官方脚本：画布 `irm https://jimeng.jianying.com/canvas-cli/install.ps1 \| iex`，短剧从 `https://jimeng.jianying.com/novel-cli` 里解出内嵌 PowerShell 安装器（超时 120s） |',
    '| 登录 | 小云雀官网 ⚡CLI/API → API → 管理 Access Key，填进设置页或 `xyq.json` 的 accessKey | `jimeng-novel login --non-interactive`，把返回的链接给用户点（浏览器授权，不用 Key） |',
    '| 查额度 | `xyq_balance` 的云雀段（`get-credit-balance`） | `xyq_balance` 的即梦段（`jimeng-novel credit get`） |',
    '调用前自愈：工具会先自检——CLI 在不在（**自动安装默认关**，只有显式 `autoInstall:true` 才装）、授权在不在（缺就发一次浏览器授权链接）。装了没装、登了没登都会留一行中文日志。',
    '自愈开关：`autoInstall` 默认 false（在用户机器上跑远端脚本必须显式授权）、`autoLogin` 默认 true；传 false 只报告不动手。同一会话里失败的安装会退避，别指望连点几次装好。',
    '出错怎么读：缺 CLI / 没登录时工具返回中文原因 + **下一步该跑的命令（含绝对路径）**；授权链路一旦被判过期（40014 / nextAction=restart）会自动用 `--restart` 重开并给**新链接**，把最新那条转给用户，别复述旧链接。',
  ]
  if (freedom === 'explicit') lines.push('调用约束：**只有用户明确要求生成图片/视频时才能调用**；不要为了“省事”自行生成。')
  else if (freedom === 'budgeted') lines.push('调用约束：开发任务需要素材时可以自行调用，但必须受设置里的额度与时长上限约束；用完就停，不要重复生成。')
  else lines.push('调用约束：额度已放开，自行判断是否生成；仍然不要重复生成同一个素材。')
  lines.push('云雀 Access Key 过期/无效时工具会报错，把原文转告用户，让他去小云雀官网 ⚡CLI/API → API 更新。')
  return lines.join('\n')
}
