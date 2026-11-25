/**
 * xyq/skill —— 「生成通道」使用指南的**单一真源**读取器。
 *
 * 真源是 `assets/skills/dafeiyu-xyq/SKILL.md`（启动时由 vision 那侧的
 * `installBundledSkills` 一并铺到 `<dshHome>/skills/`）。这里只负责：
 * - 读正文（去掉 YAML frontmatter，模型看正文时不该看到它）；
 * - 读不到就退回内置短版——**别在这里再养第二份长文档**，两份必漂。
 *
 * 为什么要有：契约要求每个域留一个 `<域>_guide` 工具当兜底（`vision_guide` 同款）。
 * 模型在上下文里没有这份 skill 时，一次工具调用就能拿到同口径的指南。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

export const XYQ_SKILL_NAME = 'dafeiyu-xyq'

/** 读不到 SKILL.md 时的兜底（只写最必要的判断，不复制正文）。 */
export const XYQ_GUIDE_FALLBACK = [
  '# 生成通道：小云雀 vs 即梦',
  '',
  '`generate_image` / `generate_video` / `xyq_models` 都有 `channel` 参数：',
  '- `channel=xyq`（默认）：小云雀，要 Access Key，营销成片/短剧全流程；',
  '- `channel=jimeng`：即梦，浏览器 OAuth 登录（不用 Key），画布/分镜/即梦短剧。',
  '不传就是 xyq；用户没点名别自作主张切通道。模型名两条通道不通用，先 `xyq_models` 再生成。',
  '即梦没装/没登录时工具会返回中文原因 + 下一步命令（含绝对路径），照抄给用户。',
].join('\n')

/** 去掉 YAML frontmatter。 */
export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

let cachedBody: string | undefined

/** 读一次缓存的 SKILL.md 正文；读不到退回内置短版。 */
export function readXyqSkillBody(assetsRoot: string): string {
  if (cachedBody !== undefined) return cachedBody
  try {
    cachedBody = stripFrontmatter(readFileSync(path.join(assetsRoot, 'SKILL.md'), 'utf8'))
  } catch {
    cachedBody = XYQ_GUIDE_FALLBACK
  }
  return cachedBody
}

/** 仅供测试：清掉正文缓存。 */
export function resetXyqSkillCache(): void {
  cachedBody = undefined
}
