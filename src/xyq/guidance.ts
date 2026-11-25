/**
 * xyq/guidance —— 生成工具的使用提示（唯一一份：注入与推送共用）。
 *
 * 2026-11-25 起底下有**两条通道**（云雀 / 即梦），提示词必须先把「怎么选通道」讲清，
 * 否则模型会拿云雀的模型名去调即梦、或者反过来。
 */
export function xyqGuidance(freedom: string): string {
  const lines = [
    '## 生成通道（图片 / 视频）',
    '本机接入了两条生成通道，用工具参数 `channel` 选：`channel=xyq`（默认，小云雀）/ `channel=jimeng`（即梦）。',
    '工具：`generate_image`、`generate_video`、`xyq_balance`（两条通道各一段额度）、`xyq_models`（先定通道再查模型）。',
    '- 小云雀（xyq）：营销成片、短剧 agent 全流程、Canvas 画布工程化。Access Key 在「大肥鱼 → 小云雀」里填，积分计费。',
    '- 即梦（jimeng）：即梦画布与短剧创作（画布 CLI `dreamina-canvas` + 短剧 CLI `jimeng-novel`），画布/分镜/导演台类需求。积分计费，登录走**浏览器授权**（不需要 Key）。',
    '选择口径：用户点名「即梦 / Dreamina」→ jimeng；点名「小云雀 / xyq」→ xyq；没点名 → 默认 xyq，只有明确提出即梦画布、即梦短剧、Dreamina 时才切 jimeng。',
    '使用顺序：`xyq_models` 查模型（两条通道模型名不通用）→ `xyq_balance` 看额度 → 生成 → 把工具返回的**本地文件绝对路径**告诉用户。',
    '成本：云雀视频按时长计费（Seedance 2.0 Mini 体验版约 4 积分/秒）、图片按张；即梦按积分计费，`credit estimate` 才是准数（工具不替用户报价）。',
    '调用前自愈：工具会先补环境——**没登录就发起一次浏览器授权并把链接给用户**（默认开）；**缺 CLI 不会自动装**（默认关，避免一句"画张图"顺带在你机器上执行远端安装脚本），缺了就报错并告诉用户「再调一次并传 `autoInstall:true`」，或手工装。装了没装、登了没登都会留一行中文日志。',
    '自愈开关：`autoLogin:false` 只报告不发起授权；`autoInstall:true` 才允许自动下载安装（仅 Windows，约 2 分钟，超时/失败会退避，不会反复下载）。',
    '出错怎么读：即梦通道没装 / 没登录时，工具会返回中文原因 + **下一步该跑的命令（含绝对路径）**；把这句话原样转给用户，让他去终端跑，别自己反复重试登录。',
  ]
  if (freedom === 'explicit') lines.push('调用约束：**只有用户明确要求生成图片/视频时才能调用**；不要为了“省事”自行生成。')
  else if (freedom === 'budgeted') lines.push('调用约束：开发任务需要素材时可以自行调用，但必须受设置里的额度与时长上限约束；用完就停，不要重复生成。')
  else lines.push('调用约束：额度已放开，自行判断是否生成；仍然不要重复生成同一个素材。')
  lines.push('云雀 Access Key 过期/无效时工具会报错，把原文转告用户，让他去小云雀官网 ⚡CLI/API → API 更新。')
  return lines.join('\n')
}
