/**
 * xyq/canvas/service —— 即梦**画布**通道（只读起步，2026-11-25 起）。
 *
 * 与 `jimeng-novel` 那条（一次性生图/生视频）是两回事：画布是**工程化**入口，
 * 管的是「画布 / 节点 / 导演台」，一次调用只读现状、不下发写操作。
 *
 * 这一版只读（0.6.0 的口径）：
 *   status   → `auth status`（登录态 + 过期时间）
 *   canvases → `canvas ls`（画布列表：projectId / name / 时间 / webUrl）
 *   current  → `canvas current`（当前画布，可能为 null）
 *   nodes    → `node ls`（节点定位摘要，可带 --project-id / --type / --query / 分页）
 *   login    → `auth login` + **同一次调用内** `auth wait`（device flow 必须有人轮询才落凭证）
 *
 * 实测形状（真机，2026-11-25）：
 *   auth status → {ok:true,data:{loggedIn,expiresAt,profile,region,authMode,version}}
 *   canvas ls   → {ok:true,data:{items:[],hasMore:false}}
 *   canvas current → {ok:true,data:{currentCanvas:null,checkedAt}}
 * 命令名是 `node ls`（不是 node list）；flag 是 `--format json`（不是 -j）——见 cli.ts 的说明。
 */
import type { CanvasCallResult, CanvasCli } from './cli.js'

export interface CanvasNodeSummary {
  nodeId: string
  type: string
  title: string
  status: string
  tags?: string[]
}

export interface CanvasSummary {
  projectId: string
  name: string
  createdAt?: string
  updatedAt?: string
  webUrl?: string
}

export interface CanvasStatus {
  loggedIn: boolean
  expiresAt?: string
  profile?: string
  region?: string
  version?: string
}

export interface CanvasServiceResult<T> {
  ok: boolean
  data?: T
  message?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function pickArray(value: unknown, keys: string[]): Array<Record<string, unknown>> {
  const record = asRecord(value)
  for (const key of keys) {
    const candidate = record?.[key]
    if (Array.isArray(candidate)) return candidate.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
  }
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []
}

export interface CanvasServiceDeps {
  cli: CanvasCli
  /** 登录等待上限（毫秒）。默认 120 秒——一次工具调用挂太久会把别的活饿死。 */
  loginWaitMs?: number
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

export function createCanvasService(deps: CanvasServiceDeps) {
  const waitMs = deps.loginWaitMs ?? 120_000

  return {
    available(): boolean {
      return deps.cli.path() !== undefined
    },

    async status(): Promise<CanvasServiceResult<CanvasStatus>> {
      const answered: CanvasCallResult = await deps.cli.call(['auth', 'status'], 30_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = asRecord(answered.envelope?.data)
      return {
        ok: true,
        data: {
          loggedIn: data?.loggedIn === true,
          ...(str(data?.expiresAt) === '' ? {} : { expiresAt: str(data?.expiresAt) }),
          ...(str(data?.profile) === '' ? {} : { profile: str(data?.profile) }),
          ...(str(data?.region) === '' ? {} : { region: str(data?.region) }),
          ...(str(data?.version) === '' ? {} : { version: str(data?.version) }),
        },
      }
    },

    async canvases(): Promise<CanvasServiceResult<{ items: CanvasSummary[]; hasMore: boolean }>> {
      const answered = await deps.cli.call(['canvas', 'ls'], 60_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = asRecord(answered.envelope?.data)
      const items = pickArray(answered.envelope?.data, ['items']).map((item) => ({
        projectId: str(item.projectId) || str(item.id),
        name: str(item.name) || str(item.title) || '(未命名画布)',
        ...(str(item.createdAt) === '' ? {} : { createdAt: str(item.createdAt) }),
        ...(str(item.updatedAt) === '' ? {} : { updatedAt: str(item.updatedAt) }),
        ...(str(item.webUrl) === '' ? {} : { webUrl: str(item.webUrl) }),
      }))
      return { ok: true, data: { items, hasMore: data?.hasMore === true } }
    },

    async current(): Promise<CanvasServiceResult<{ projectId?: string; name?: string } | null>> {
      const answered = await deps.cli.call(['canvas', 'current'], 30_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = asRecord(answered.envelope?.data)
      const current = asRecord(data?.currentCanvas)
      if (current === undefined) return { ok: true, data: null }
      const projectId = str(current.projectId) || str(current.id)
      const name = str(current.name) || str(current.title)
      return { ok: true, data: { ...(projectId === '' ? {} : { projectId }), ...(name === '' ? {} : { name }) } }
    },

    async nodes(input: {
      canvasId?: string
      type?: string
      status?: string
      query?: string
      limit?: number
      offset?: number
    } = {}): Promise<CanvasServiceResult<{ items: CanvasNodeSummary[]; hasMore: boolean; offset: number; limit: number }>> {
      const args = ['node', 'ls']
      if (typeof input.canvasId === 'string' && input.canvasId !== '') args.push('--project-id', input.canvasId)
      if (typeof input.type === 'string' && input.type !== '') args.push('--type', input.type)
      if (typeof input.status === 'string' && input.status !== '') args.push('--status', input.status)
      if (typeof input.query === 'string' && input.query !== '') args.push('--query', input.query)
      const limit = Math.min(Math.max(Math.round(input.limit ?? 20), 1), 50)
      const offset = Math.min(Math.max(Math.round(input.offset ?? 0), 0), 1000)
      args.push('--limit', String(limit), '--offset', String(offset))
      const answered = await deps.cli.call(args, 60_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = asRecord(answered.envelope?.data)
      const items = pickArray(answered.envelope?.data, ['items']).map((item) => ({
        nodeId: str(item.nodeId) || str(item.id),
        type: str(item.type),
        title: str(item.title) || str(item.name),
        status: str(item.status),
        ...(Array.isArray(item.tags) ? { tags: item.tags.filter((tag): tag is string => typeof tag === 'string') } : {}),
      }))
      return { ok: true, data: { items, hasMore: data?.hasMore === true, offset, limit } }
    },

    /**
     * 登录：`auth login` 拿设备码 → **同一次调用内** `auth wait`。
     *
     * 为什么必须同一个调用里 wait（总管 2026-11-25 实测）：画布的 device flow
     * 只在 CLI 侧轮询时才会把凭证落盘——用户点了浏览器、但没人跑 `auth wait`，
     * 状态会一直是 `loggedIn:false`。所以这里等满 `loginWaitMs`（默认 120 秒），
     * 超时就如实回「点完再调一次」，不假装已登录。**不自动开浏览器**（--no-browser），
     * 把链接给用户自己点。
     */
    async login(): Promise<{
      ok: boolean
      loggedIn: boolean
      link?: string
      message?: string
    }> {
      const started = await deps.cli.call(['auth', 'login', '--no-browser'], 60_000)
      if (started.message !== undefined) return { ok: false, loggedIn: false, message: started.message }
      const data = asRecord(started.envelope?.data)
      const deviceCode = str(data?.deviceCode) || str(data?.device_code)
      const link = str(data?.verificationUriComplete) || str(data?.verificationUri) || str(data?.url)
      if (deviceCode === '') {
        // 有的版本直接返回 logged_in
        if (data?.loggedIn === true || data?.status === 'logged_in') return { ok: true, loggedIn: true }
        return {
          ok: false,
          loggedIn: false,
          message: `即梦画布登录没有拿到设备码：${JSON.stringify(started.envelope?.data ?? {}).slice(0, 200)}。手工：在终端跑 dreamina-canvas auth login`,
        }
      }

      deps.log?.('即梦画布：已发起授权，等用户点链接（同一次调用内 wait）', { waitMs })
      const waited = await deps.cli.call(['auth', 'wait', '--device-code', deviceCode, '--timeout', `${Math.round(waitMs / 1000)}s`], waitMs + 30_000)
      if (waited.message !== undefined) {
        return {
          ok: false,
          loggedIn: false,
          ...(link === '' ? {} : { link }),
          message: `即梦画布授权还没完成（${waited.message}）。${link === '' ? '' : `点这个链接授权：${link}`}点完再调一次 action=login（或 action=status 看结果）。`,
        }
      }
      const waitData = asRecord(waited.envelope?.data)
      const loggedIn = waitData?.loggedIn === true || waitData?.status === 'logged_in' || String(waitData?.status ?? '') === 'success'
      return {
        ok: loggedIn,
        loggedIn,
        ...(link === '' ? {} : { link }),
        ...(loggedIn ? {} : { message: '授权等待结束但没检出登录态：点链接后可能超时了，再调一次 action=login。' }),
      }
    },
  }
}

export type CanvasService = ReturnType<typeof createCanvasService>
