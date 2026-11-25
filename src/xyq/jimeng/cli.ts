/**
 * xyq/jimeng/cli —— 找即梦的两条 CLI（`jimeng-novel` / `dreamina-canvas`）并给出**绝对路径**。
 *
 * 为什么要自己找、不能赌 PATH（2026-11-25 实测）：
 *   - 短剧 CLI 装在这里：`<home>/.local/share/jimeng-novel/releases/<版本>/jimeng-novel.exe`
 *     （官方 `novel-cli` 安装脚本自己 dedupe 版本，目录名带版本号与校验后缀）；
 *   - 画布 CLI 装在这里：`<home>/bin/dreamina-canvas.exe`（install.ps1 的默认落点）。
 * 两个都不会进 PATH（安装器只临时拼 PATH 跑完 --version），所以插件必须按路径 spawn。
 * 搜索顺序固定：环境变量（给测试与排障留口子）→ 官方默认落点 → PATH 兜底。
 *
 * 本文件**不执行任何东西**，只回答「在哪」。执行在 service.ts。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface JimengCliPaths {
  /** 短剧/画布一体化 CLI：generate-image / generate-video / credit / login 都在它上面。 */
  novel?: string
  /** 全能画布 CLI（画布、节点、导演台）；当前通道的实现没用到，留给「画布类」调用。 */
  canvas?: string
}

export interface LocateDeps {
  env?: Record<string, string | undefined>
  home?: string
  platform?: NodeJS.Platform
  /** 判断某个路径是不是存在的文件（测试注入假实现）。 */
  exists?: (file: string) => boolean
  /** 列目录（测试注入假实现）。 */
  listDir?: (dir: string) => string[]
}

function exeName(base: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${base}.exe` : base
}

/** `jimeng-novel-1.0.11-windows-amd64-xxxx` → 1.0.11（取不到就当 0）。 */
export function releaseVersion(dirName: string): number[] {
  const match = dirName.match(/jimeng-novel-(\d+\.\d+\.\d+)/)
  if (!match || match[1] === undefined) return [0, 0, 0]
  return match[1].split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function compareVersion(a: string, b: string): number {
  const left = releaseVersion(a)
  const right = releaseVersion(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** PATH 里能命中的可执行文件（只做存在性检查，不递归、不解析 shebang）。 */
function fromPath(pathValue: string | undefined, fileName: string, platform: NodeJS.Platform, exists: (file: string) => boolean): string[] {
  if (pathValue === undefined || pathValue === '') return []
  const found: string[] = []
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir.trim() === '') continue
    const candidate = path.join(dir, fileName)
    if (exists(candidate)) found.push(candidate)
    // Windows 上 PATH 里偶尔只有无扩展名的 shim（git-bash 之类），补一次
    if (platform === 'win32' && !fileName.toLowerCase().endsWith('.exe') && exists(`${candidate}.exe`)) found.push(`${candidate}.exe`)
  }
  return found
}

function firstExisting(candidates: Array<string | undefined>, exists: (file: string) => boolean): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== '' && exists(candidate)) return candidate
  }
  return undefined
}

export function locateJimengCli(deps: LocateDeps = {}): JimengCliPaths {
  const env = deps.env ?? process.env
  const home = deps.home ?? os.homedir()
  const platform = deps.platform ?? process.platform
  const exists =
    deps.exists ??
    ((file: string): boolean => {
      try {
        return fs.statSync(file).isFile()
      } catch {
        return false
      }
    })
  const listDir =
    deps.listDir ??
    ((dir: string): string[] => {
      try {
        return fs.readdirSync(dir)
      } catch {
        return []
      }
    })

  // ---- 短剧 / 一体化 CLI ----
  const novelName = exeName('jimeng-novel', platform)
  const releasesRoot = path.join(home, '.local', 'share', 'jimeng-novel', 'releases')
  const releases = listDir(releasesRoot)
    .filter((name) => name.startsWith('jimeng-novel-'))
    .sort(compareVersion)
    .reverse()
  const novelCandidates: Array<string | undefined> = [
    env.JIMENG_NOVEL_CLI,
    ...releases.map((name) => path.join(releasesRoot, name, novelName)),
    path.join(home, '.local', 'bin', novelName),
    ...fromPath(env.PATH, novelName, platform, exists),
  ]

  // ---- 全能画布 CLI ----
  const canvasName = exeName('dreamina-canvas', platform)
  const canvasCandidates: Array<string | undefined> = [
    env.DREAMINA_CANVAS_CLI,
    path.join(home, 'bin', canvasName),
    path.join(home, '.local', 'bin', canvasName),
    ...fromPath(env.PATH, canvasName, platform, exists),
  ]

  const novel = firstExisting(novelCandidates, exists)
  const canvas = firstExisting(canvasCandidates, exists)
  return {
    ...(novel === undefined ? {} : { novel }),
    ...(canvas === undefined ? {} : { canvas }),
  }
}

/** 装即梦短剧 CLI 的命令（不可用时原样转给用户）。 */
export const JIMENG_INSTALL_HINT = 'curl.exe -s https://jimeng.jianying.com/novel-cli | bash（Windows 上没有 bash：官方脚本内嵌了 PowerShell 安装器，见 SKILL 的安装段）'
