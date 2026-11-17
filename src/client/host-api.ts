/**
 * host-api — 浏览器半侧调宿主回环路由的最小封装（0.9.x）。
 *
 * 只用 GET / POST；所有请求带超时（宿主卡住时不挂页面）；响应统一解析成
 * `{ ok, ... }`，非 JSON 响应也转成一个带 HTTP 状态的可读错误。
 *
 * 拆包说明（2026-11-16）：这份文件从本体 `src/client/host-api.ts` 搬来，
 * **只留识图/小云雀用得上的**：
 *   - `VISION_BASE` / `VISION_RECOGNIZE_ROUTE` / `callJson` 原样搬走；
 *   - `MEMORY_BASE`（长期记忆）与 `PERSONA_STATUS`（人设包）**没有搬**——
 *     它们属于本体，本包不碰记忆也不碰人设。
 * 原始文件里本来就没有 `XYQ_*` 常量：小云雀那两个面板各自带一行
 * `const BASE = '/api/dsh-remote-dafeiyu/xyq'` 字面量（照搬时保持原样，不做合并）。
 */
import { resolveHostUrl } from './host-url.js'

export const VISION_BASE = '/api/dsh-remote-dafeiyu/vision'
/**
 * 识图那条 POST（`{ imageBase64, mime }` → `{ ok, text }`）。
 *
 * 与宿主侧 `src/vision/routes.ts` 的 `VISION_RECOGNIZE_ROUTE` **必须逐字一致**：
 * 这条是浏览器半个字面量（浏览器面不能 import 宿主侧那支路由表，它连着 node:http），
 * 由 `tests/vision.test.ts`（宿主那侧）与这里的字符串两侧钉住。
 *
 * ⚠️ 刻意写成**整串**而不是 `${VISION_BASE}/recognize`：拼出来的写法在压缩后会变成
 * 常量拼接，判据就没法在产物里逐字找到这条路由。
 */
export const VISION_RECOGNIZE_ROUTE = '/api/dsh-remote-dafeiyu/vision/recognize'
/**
 * 网页版（免 key）两条例路。同样**逐字**与宿主侧 `src/vision/routes.ts` 对齐：
 * - status：`GET ?site=doubao|gemini|both[&fresh=1]` → `{ ok, sites:[{ site, loggedIn, … }] }`
 * - login：`POST { site, waitMs? }` → 弹有头窗口等用户登录 → `{ ok, loggedIn }`
 */
export const VISION_WEB_STATUS_ROUTE = '/api/dsh-remote-dafeiyu/vision/web/status'
export const VISION_WEB_LOGIN_ROUTE = '/api/dsh-remote-dafeiyu/vision/web/login'

export async function callJson(path: string, body: unknown | undefined, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const init: RequestInit =
    body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  if (typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal) init.signal = AbortSignal.timeout(timeoutMs)
  const response = await fetch(resolveHostUrl(path), init)
  const text = await response.text()
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return { ok: false, error: `宿主返回了非 JSON（HTTP ${response.status}）` }
  }
}
