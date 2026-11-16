/**
 * http/guards — 回环守卫 + CORS + 预检（**逐字照抄本体 `src/pill/routes.ts:196-305`**）。
 *
 * 拆包说明（2026-11-16）：`vision/routes.ts` 与 `xyq/routes.ts` 原本都写
 * `import { applyCors, preflight, hostIsLoopback, originIsLoopbackOrAbsent } from '../pill/routes.js'`。
 * 独立包不能引本体代码，所以把这一小块搬到本包；**判据与常量一个字都没改**：
 *   - 只认 `localhost / 127.0.0.1 / ::1 / [::1]` 的 Host；
 *   - Origin 缺席合法（同源 GET 常常不带，宿主转发时还会删掉）；
 *   - Origin 存在时必须是环回的 http(s)，或白名单里的宿主自定义 scheme（`dsh-app:`）；
 *   - CORS 只回声给"像这台宿主自己"的 Origin，且写不了 setHeader 的夹具安静跳过。
 *
 * 为什么不在本包里"改进"它：路由行为是被手机协议、本体其它代码与用户已配好的
 * key 一起依赖的（拆包要求"零迁移"），守卫松一格就是一条能被任意网页借道的口子。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * 宿主自己的自定义 scheme——**白名单**，不是"非 http(s) 一律放过"。
 *
 * 原来那条写的是 `url.protocol !== 'http:' && url.protocol !== 'https:'` 就放行，
 * 于是 `chrome-extension://<别的扩展>`、`file://`、甚至任何自造 scheme 都算"宿主自己"
 * （2026-10-06 修）。写路由靠 `x-drc-pair` 那个自定义头挡跨站，而装了扩展的浏览器里
 * 扩展页面本来就发得出自定义头——Origin 这道就剩白名单这一层必须准。
 */
const HOST_ORIGIN_SCHEMES = new Set(['dsh-app:'])

/** 去掉端口与 IPv6 方括号，只留主机名。 */
function hostnameOf(host: string): string {
  const trimmed = host.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return trimmed
    const rest = trimmed.slice(end + 1)
    if (rest !== '' && !/^:\d+$/.test(rest)) return trimmed
    return trimmed.slice(0, end + 1)
  }
  const colon = trimmed.lastIndexOf(':')
  if (colon !== -1 && !trimmed.slice(0, colon).includes(':') && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon)
  }
  return trimmed
}

export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOf(host))
}

/** 只读路由用：Origin 缺席是合法的（同源 GET 常常不带，宿主转发时还会删掉）。 */
export function originIsLoopbackOrAbsent(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  return originLooksLikeTheHostItself(origin)
}

/**
 * Origin 存在时它必须像"这台宿主自己"：环回的 http(s)，或**白名单里**那个宿主自定义 scheme。
 * `dsh-app://app` 这类只有宿主自己能产生；`null`（file:// 文档开的页）与别的扩展 scheme 都不算。
 */
function originLooksLikeTheHostItself(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (HOST_ORIGIN_SCHEMES.has(url.protocol)) return true
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

/**
 * 跨源应答（2026-10-20，DSH 0.2.1 桌面版）。
 *
 * 桌面页面在自定义 scheme `dsh-app://` 上，而路由在宿主 HTTP origin 上 ⇒ **每一个请求都是跨源**：
 *  - `fetch(url, {headers:{'x-drc-pair':...}})` 带自定义头 ⇒ 浏览器先发 `OPTIONS` 预检；
 *    原来没有预检分支，回 405 ⇒ 预检失败 ⇒ `fetch` 直接 reject（用户看到的「请求失败」）；
 *  - 即使预检过了，响应缺 `Access-Control-Allow-Origin` 也会被浏览器挡在 JS 之外。
 *
 * **只对"像这台宿主自己"的 Origin 回声**（环回 http(s) 与 `dsh-app:` 白名单，与写路由
 * 同一套判据）：这不让任意网页借道——它们过不了那条 Origin 判据，写路由还有 `x-drc-pair`。
 */
export function applyCors(request: IncomingMessage, response: ServerResponse): void {
  const origin = request?.headers?.origin
  if (origin === undefined || origin.trim() === '' || !originLooksLikeTheHostItself(origin)) return
  // 夹具里的 response 可能只有 `writeHead/end`（真 ServerResponse 才一定有 `setHeader`）：
  // CORS 是增强项，缺这个能力就安静跳过，不许把"路由本身能应答"变成 500。
  if (typeof response.setHeader !== 'function') return
  try {
    response.setHeader('Access-Control-Allow-Origin', origin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'content-type, x-drc-pair')
    response.setHeader('Access-Control-Max-Age', '600')
  } catch {
    /* 同上：CORS 头写不进去不影响业务应答 */
  }
}

/**
 * 浏览器跨源预检：带 JSON content-type 的 POST 会先发 OPTIONS。
 * 路由只处理 POST 时会回 405（就算带了 CORS 头），预检失败浏览器直接
 * 报 `Failed to fetch`。这里统一把 OPTIONS 正常结束掉。
 */
export function preflight(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'OPTIONS') return false
  applyCors(request, response)
  response.writeHead(204, { 'Access-Control-Max-Age': '600', 'Content-Length': '0' })
  response.end()
  return true
}
