/**
 * vision/skill —— 把「识图使用指南」落成 DSH skill（**单一真源**）。
 *
 * 形态照 dev-kit `sprite/skill.ts`（那一份是踩出来的结论）：
 * - 放文件系统根目录 `<dshHome>/skills/<name>/`，走官方 `dsh-skill-filesystem` 的扫描契约，
 *   不碰 `ctx.skills.registerProvider` 那种内核内部 API；
 * - 幂等判据是**内容指纹**（不是版本号）：改个错别字不用发版；
 * - 重铺是整份替换，避免"SKILL.md 是新的、references 还是旧的"；
 * - 铺完自检逐文件比字节——半份 skill 会让模型照着残缺指南干活，现场表现为
 *   "它去找一个不存在的文件"，没人能想到是铺漏了。
 *
 * 真源：`assets/skills/dafeiyu-vision/SKILL.md`。
 * `vision_guide` 工具与这里的安装器读同一份，不会再出现"指南一套、代码一套"。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const VISION_SKILL_NAME = 'dafeiyu-vision'
/** 记录"这份 skill 是从哪个插件版本铺过来的"（只用于事后核对，不作幂等判据）。 */
export const SKILL_VERSION_FILE = '.dafeiyu-skill-version'

/** 读不到 SKILL.md 时的兜底正文（**只写最必要的**，别在这儿再养一套文档）。 */
export const VISION_GUIDE_FALLBACK = [
  '# 大肥鱼识图',
  '',
  '调 `recognize_image({ image_path, prompt? })` 把本地图片交给外挂视觉模型（或本机已登录的网页版豆包/Gemini），',
  '拿回文本描述后基于描述回答；不要声称自己看到了原图。',
  '',
  '- `vision_web_status` 查网页版登录态；`vision_web_login` 弹窗让用户登录（需要人在电脑前）。',
  '- 报错原文照转给用户，别自己猜原因；完整指南见 skill `dafeiyu-vision`。',
].join('\n')

export interface SkillInstallResult {
  ok: boolean
  installed: string[]
  reason?: string
}

export interface SkillSelfCheck {
  ok: boolean
  problems: string[]
}

/** 目录指纹：`<相对路径>:<字节数>` 的有序拼接（只 stat 不读内容，够发现增删改）。 */
export function fingerprintDir(dir: string): string {
  const walk = (rel: string): string[] => {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = readdirSync(path.join(dir, rel), { withFileTypes: true })
    } catch {
      return []
    }
    const out: string[] = []
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) out.push(...walk(childRel))
      else {
        try {
          out.push(`${childRel}:${statSync(path.join(dir, childRel)).size}`)
        } catch {
          out.push(`${childRel}:?`)
        }
      }
    }
    return out
  }
  return walk('').filter((line) => !line.startsWith(SKILL_VERSION_FILE)).join('|')
}

/** 递归列出目录里的文件相对路径（`/` 分隔、已排序）；目录不存在返回空数组。 */
export function listSkillFiles(base: string, rel = ''): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = readdirSync(path.join(base, rel), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) out.push(...listSkillFiles(base, childRel))
    else out.push(childRel)
  }
  return out
}

/** 装完自检：文件在 + 内容逐字节一致。 */
export function verifySkillInstall(deps: { assetsRoot: string; targetDir: string }): SkillSelfCheck {
  const problems: string[] = []
  const files = listSkillFiles(deps.assetsRoot)
  if (!files.includes('SKILL.md')) problems.push('包内没有 SKILL.md')
  for (const rel of files) {
    const target = path.join(deps.targetDir, rel)
    if (!existsSync(target)) {
      problems.push(`没铺到：${rel}`)
      continue
    }
    try {
      if (!readFileSync(path.join(deps.assetsRoot, rel)).equals(readFileSync(target))) problems.push(`内容不一致：${rel}`)
    } catch (error) {
      problems.push(`读不出来：${rel}（${String((error as Error)?.message ?? error).slice(0, 60)}）`)
    }
  }
  return { ok: problems.length === 0, problems }
}

export interface InstallSkillsDeps {
  /** `~/.dsh`（宿主配置根），skill 落在 `<dshHome>/skills/<name>/`。 */
  dshHome: string
  /** 插件包里 `assets/skills` 的绝对路径。 */
  assetsRoot: string
  /** 插件版本（只写进标记，供事后核对）。 */
  version: string
  log: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

/**
 * 把 `assets/skills/<name>/SKILL.md` 下的所有 skill 铺到用户目录。
 *
 * 认一个约定：**有 SKILL.md 的目录就是一份 skill**。以后这个包里加第二份指南不用再写安装逻辑。
 */
export function installBundledSkills(deps: InstallSkillsDeps): SkillInstallResult {
  let entries: Array<{ name: string; dir: string }>
  try {
    entries = readdirSync(deps.assetsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, dir: path.join(deps.assetsRoot, entry.name) }))
      .filter((entry) => existsSync(path.join(entry.dir, 'SKILL.md')))
  } catch (error) {
    return { ok: false, installed: [], reason: `missing-asset: ${String((error as Error)?.message ?? error).slice(0, 80)}` }
  }
  if (entries.length === 0) return { ok: false, installed: [], reason: `no-skill-under: ${deps.assetsRoot}` }

  const installed: string[] = []
  for (const entry of entries) {
    const target = path.join(deps.dshHome, 'skills', entry.name)
    const stamp = path.join(target, SKILL_VERSION_FILE)
    try {
      if (existsSync(stamp) && fingerprintDir(entry.dir) === fingerprintDir(target)) continue
      mkdirSync(path.dirname(target), { recursive: true })
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      cpSync(entry.dir, target, { recursive: true })
      writeFileSync(stamp, `${deps.version}\n`, 'utf8')
      installed.push(entry.name)
      const check = verifySkillInstall({ assetsRoot: entry.dir, targetDir: target })
      if (!check.ok) {
        deps.log(`内置 skill「${entry.name}」铺完自检没通过（工具本身照常可用，指南可能是残缺的）`, {
          problems: check.problems.slice(0, 5).join('；'),
        })
        return { ok: false, installed, reason: `verify-failed: ${entry.name}（${check.problems[0] ?? '未知'}）` }
      }
    } catch (error) {
      deps.log('铺 skill 失败（不影响工具本身）', {
        skill: entry.name,
        message: String((error as Error)?.message ?? error).slice(0, 120),
      })
      return { ok: installed.length > 0, installed, reason: `copy-failed: ${entry.name}` }
    }
  }
  if (installed.length > 0) deps.log('内置 skill 已铺开', { skills: installed.join(','), version: deps.version })
  return { ok: true, installed }
}

/** 去掉 YAML frontmatter（那是给 skill 目录用的，模型看正文时不该看到）。 */
export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

let cachedBody: string | undefined

/** 读一次缓存的 SKILL.md 正文；读不到退回内置短版。 */
export function readVisionSkillBody(assetsRoot: string): string {
  if (cachedBody !== undefined) return cachedBody
  try {
    cachedBody = stripFrontmatter(readFileSync(path.join(assetsRoot, 'SKILL.md'), 'utf8'))
  } catch {
    cachedBody = VISION_GUIDE_FALLBACK
  }
  return cachedBody
}

/** 仅供测试：清掉正文缓存。 */
export function resetVisionSkillCache(): void {
  cachedBody = undefined
}
