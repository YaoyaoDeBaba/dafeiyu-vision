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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  /** 产物下载目录（绝对路径）；默认 ~/jimeng-output。 */
  outDir?: string
  /** 登录等待上限（毫秒）。默认 120 秒——一次工具调用挂太久会把别的活饿死。 */
  loginWaitMs?: number
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

export function createCanvasService(deps: CanvasServiceDeps) {
  const waitMs = deps.loginWaitMs ?? 120_000

  /** 下载画布资源到 outDir；回绝对路径（`resource download` 的 data.path）。 */
  async function downloadResources(canvasId: string, resourceIds: string[]): Promise<CanvasServiceResult<{ paths: string[] }>> {
    if (resourceIds.length === 0) return { ok: false, message: 'download 需要 resourceIds（来自 node-run / node-show）' }
    const dir = deps.outDir ?? path.join(os.homedir(), 'jimeng-output')
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* 建不出来就让 CLI 报 */
    }
    const paths: string[] = []
    for (const resourceId of resourceIds) {
      const args = ['resource', 'download', resourceId, '--output', dir]
      if (canvasId !== '') args.push('--project-id', canvasId)
      const answered = await deps.cli.call(args, 120_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message, ...(paths.length === 0 ? {} : { data: { paths } }) }
      const data = asRecord(answered.envelope?.data)
      const file = str(data?.path)
      if (file !== '') paths.push(file)
    }
    if (paths.length === 0) return { ok: false, message: '下载回包里没有 path 字段' }
    return { ok: true, data: { paths } }
  }

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
      // 真机：已登录时 `auth login` 直接回 `{status:"reused", state:{loggedIn:true, …}}`，不必再发起授权
      const reuseState = asRecord(data?.state)
      if (data?.status === 'reused' && reuseState?.loggedIn === true) return { ok: true, loggedIn: true }
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

    // ── 写操作（0.7.0）：一律 confirm → quote → confirm(credit ceiling) → run ──────

    /**
     * 建画布。**不花积分，但会在用户账号里留东西**，所以工具层要求 `confirm:true`。
     * 一次调用只建一个（不做批量循环）。
     */
    async createCanvas(name: string): Promise<CanvasServiceResult<{ projectId: string; name: string }>> {
      const trimmed = name.trim()
      if (trimmed === '') return { ok: false, message: '建画布需要 name（1~40 字，建议带日期便于事后清理）' }
      const answered = await deps.cli.call(['canvas', 'create', trimmed], 60_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = asRecord(answered.envelope?.data)
      // 真机：回包是 {data:{project:{projectId,name,…}}}（不是 data.projectId）
      const project = asRecord(data?.project)
      const projectId = str(project?.projectId) || str(data?.projectId) || str(data?.project_id) || str(data?.id)
      if (projectId === '') return { ok: false, message: `建画布的回包里没有 projectId：${JSON.stringify(answered.envelope?.data ?? {}).slice(0, 200)}` }
      return { ok: true, data: { projectId, name: trimmed } }
    },

    /** 建一个图片节点（**不运行**，不花积分）。返回 nodeId；运行要另走 quote → run。 */
    async createImageNode(input: {
      canvasId: string
      model: string
      prompt: string
      title?: string
      count?: number
      mode?: 't2i' | 'i2i'
    }): Promise<CanvasServiceResult<{ nodeId: string; model: string }>> {
      if (input.canvasId.trim() === '') return { ok: false, message: '建节点需要 canvasId（先用 action=canvases 拿 projectId）' }
      if (input.model.trim() === '') return { ok: false, message: '建节点需要 model（先用 xyq_models({type:"image", channel:"jimeng"}) 查 key）' }
      if (input.prompt.trim() === '') return { ok: false, message: '建节点需要 prompt' }
      // 真机：`node create image` **必须带 --title**（报错原文：title is required when creating an image node）
      const title = (input.title ?? input.prompt).trim().slice(0, 24) || '画布节点'
      const args = ['node', 'create', 'image', '--project-id', input.canvasId, '--title', title, '--model', input.model, '--prompt', input.prompt]
      if (typeof input.count === 'number' && input.count > 0) args.push('--count', String(Math.round(input.count)))
      args.push('--mode', input.mode ?? 't2i')
      const answered = await deps.cli.call(args, 90_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = asRecord(answered.envelope?.data)
      // 真机回包：{data:{node:{nodeId,projectId,type,title,status,…}}}（不是 data.nodeId）
      const nodeRecord = asRecord(data?.node)
      const nodeId = str(nodeRecord?.nodeId) || str(data?.nodeId) || str(data?.node_id) || firstNodeId(data)
      if (nodeId === '') return { ok: false, message: `建节点的回包里没有 nodeId：${JSON.stringify(data ?? {}).slice(0, 220)}` }
      return { ok: true, data: { nodeId, model: input.model } }
    },

    /** 报价：预计积分（不扣费）。 */
    async quote(input: { canvasId: string; nodeIds: string[] }): Promise<CanvasServiceResult<{ credits: number; raw: string }>> {
      if (input.nodeIds.length === 0) return { ok: false, message: '报价需要 nodeIds（至少一个）' }
      const args = ['node', 'quote']
      for (const id of input.nodeIds) args.push('--node-id', id)
      if (input.canvasId !== '') args.push('--project-id', input.canvasId)
      const answered = await deps.cli.call(args, 60_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const credits = pickCredits(answered.envelope?.data)
      if (credits === undefined) {
        return { ok: false, message: `报价回包里没有积分字段：${JSON.stringify(answered.envelope?.data ?? {}).slice(0, 220)}` }
      }
      return { ok: true, data: { credits, raw: JSON.stringify(answered.envelope?.data ?? {}).slice(0, 400) } }
    },

    /** 批准积分上限，换短期凭证（不扣费）。 */
    async confirm(input: { canvasId: string; nodeIds: string[]; ceiling: number }): Promise<CanvasServiceResult<{ token: string }>> {
      const args = ['node', 'confirm']
      for (const id of input.nodeIds) args.push('--node-id', id)
      if (input.canvasId !== '') args.push('--project-id', input.canvasId)
      args.push('--credit-ceiling', String(Math.max(0, Math.round(input.ceiling))))
      const answered = await deps.cli.call(args, 60_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      const data = asRecord(answered.envelope?.data)
      const token = str(data?.creditConfirmationToken) || str(data?.creditToken) || str(data?.token)
      if (token === '') return { ok: false, message: `批准回包里没有 creditConfirmationToken：${JSON.stringify(data ?? {}).slice(0, 220)}` }
      return { ok: true, data: { token } }
    },

    /**
     * 跑节点（**这一步才扣积分**）：`node run --credit-token … --wait`。
     * 产物路径从 `data` 里捞（与短剧同一套防御式提取），并把本次实扣积分带回（有就带）。
     */
    async run(input: {
      canvasId: string
      nodeIds: string[]
      token: string
      timeoutMs?: number
    }): Promise<CanvasServiceResult<{ artifacts: string[]; credits?: number }>> {
      const args = ['node', 'run']
      for (const id of input.nodeIds) args.push('--node-id', id)
      if (input.canvasId !== '') args.push('--project-id', input.canvasId)
      args.push('--credit-token', input.token, '--wait', '--timeout', '10m')
      const answered = await deps.cli.call(args, (input.timeoutMs ?? 600_000) + 60_000)
      if (answered.message !== undefined) return { ok: false, message: answered.message }
      /*
       * 真机（2026-11-25）：`node run` 的产物**不是路径也不是 URL**，而是
       * `data.items[].resources[]` 里的 `resourceId`（+ `creditsAmount` 实扣积分）；
       * 要内容必须再跑 `resource download <resourceId> -o <dir>`（回 `data.path`）。
       */
      const data = answered.envelope?.data
      const resources = collectResources(data)
      const credits = pickCredits(data)
      const artifacts: string[] = []
      for (const resource of resources) {
        const downloaded = await downloadResources(input.canvasId, [resource.resourceId])
        if (downloaded.ok === true && downloaded.data !== undefined) artifacts.push(...downloaded.data.paths)
      }
      if (artifacts.length === 0) {
        const ids = resources.map((item) => item.resourceId)
        return {
          ok: false,
          message:
            ids.length === 0
              ? `跑完了但没拿到产物：${JSON.stringify(data ?? {}).slice(0, 240)}`
              : `跑完了（实扣 ${credits ?? '未知'} 积分），但下载失败；产物 resourceId：${ids.join(', ')}。可稍后用 action:"node-download" 再下。`,
        }
      }
      return { ok: true, data: { artifacts, ...(credits === undefined ? {} : { credits }) } }
    },

    /** 单独下载画布产物（跑完没下到、或事后想再下）。 */
    download(input: { canvasId: string; resourceIds: string[] }): Promise<CanvasServiceResult<{ paths: string[] }>> {
      return downloadResources(input.canvasId, input.resourceIds)
    },
  }
}

/** 从 run/show 的回包里捞资源：`{items[].resources[]}` 或 `{nodes[].node.resources[]}`。 */
function collectResources(node: unknown, depth = 0): Array<{ resourceId: string; credits?: number }> {
  const out: Array<{ resourceId: string; credits?: number }> = []
  const walk = (value: unknown, d: number): void => {
    if (d > 8 || value === null || value === undefined) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, d + 1)
      return
    }
    if (typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const id = str(record.resourceId)
    if (id !== '') {
      const credits = typeof record.creditsAmount === 'number' ? record.creditsAmount : undefined
      out.push({ resourceId: id, ...(credits === undefined ? {} : { credits }) })
      return
    }
    for (const child of Object.values(record)) walk(child, d + 1)
  }
  walk(node, depth)
  return out
}
/** 从任意 JSON 里捞「像产物」的字符串（画布与短剧字段名不统一，别赌一个键）。 */
function collectMediaPaths(node: unknown, acc: string[] = [], depth = 0): string[] {
  const MEDIA = /\.(png|jpe?g|webp|gif|mp4|mov|webm|mp3|wav)$/i
  if (depth > 8 || node === null || node === undefined) return acc
  if (typeof node === 'string') {
    if (MEDIA.test(node) && !acc.includes(node)) acc.push(node)
    return acc
  }
  if (Array.isArray(node)) {
    for (const item of node) collectMediaPaths(item, acc, depth + 1)
    return acc
  }
  if (typeof node === 'object') for (const value of Object.values(node as Record<string, unknown>)) collectMediaPaths(value, acc, depth + 1)
  return acc
}

/** 积分字段名各命令不统一（credits / totalCredits / cost / price…），按现有名字逐个试。 */
function pickCredits(node: unknown, depth = 0): number | undefined {
  // 真机 node quote：{items:[{nodeId,maxCredits}],totalMaxCredits:4,confirmable:true}，所以 totalMaxCredits / maxCredits 必须认
  // 真机两种形状：quote 用 totalMaxCredits/maxCredits；run/show 用 resources[].creditsAmount
  const KEYS = ['totalMaxCredits', 'maxCredits', 'creditsAmount', 'credits', 'totalCredits', 'credit', 'cost', 'price', 'estimatedCredits', 'total']
  if (depth > 6 || node === null || node === undefined) return undefined
  if (typeof node === 'object' && !Array.isArray(node)) {
    const record = node as Record<string, unknown>
    for (const key of KEYS) {
      const value = record[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
    }
    for (const value of Object.values(record)) {
      const found = pickCredits(value, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickCredits(item, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function firstNodeId(data: Record<string, unknown> | undefined): string {
  if (data === undefined) return ''
  const nodes = data.nodes
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      const record = asRecord(node)
      const id = str(record?.nodeId) || str(record?.node_id) || str(record?.id)
      if (id !== '') return id
    }
  }
  return ''
}

export type CanvasService = ReturnType<typeof createCanvasService>