/**
 * web/image —— 网页版豆包生图：切到「图像生成」技能 → 发提示词 → 等出图 → 下载回本地。
 *
 * 为什么走 UI 而不是接口：网页版的生图接口带签名（msToken/a_bogus 那套），
 * 跟着前端一改就废；点它的技能 chip 让页面自己去签名，稳得多。
 *
 * 实测要点（2026-11-19）：
 * - **默认「对话」模式不会出图**，只会回"我没办法直接生成图片，给你提示词"——必须先切「图像生成」；
 * - 窗口窄的时候技能 chip 会折叠进「技能」菜单，所以两条路都要走（先找 chip，找不到就开菜单）；
 * - 下载用**页面内 fetch**（带 cookie、绕 CORS），拿 base64 再落盘。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { CdpClient } from './driver.js'
import { VisionError } from '../protocols.js'
import { clearEditor, clickElement, clickExpression, pollTrue, pressEnter, typeInto, type WebSiteSpec } from './sites.js'

export interface ImageGenOptions {
  prompt: string
  /** 想要几张（默认 1，上限 4；站点一次通常出一张，多张靠多次点击） */
  count?: number
  timeoutMs?: number
  /** 图片数量稳定多久算「生成完了」（默认 8 秒；测试调小） */
  settleMs?: number
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

export interface ImageGenResult {
  /** 落盘的绝对路径 */
  files: string[]
  /** 生成耗时 */
  elapsedMs: number
  /** 用的是哪条路切到的「图像生成」（chip / 菜单） */
  via: string
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 生成图片存这里：`<dshHome>/storages/dsh-remote-dafeiyu/webvision-images/`。 */
export function imageOutDir(dshHome: string): string {
  return path.join(dshHome, 'storages', 'dsh-remote-dafeiyu', 'webvision-images')
}

/** 切到图像生成技能；返回走了哪条路（空串 = 没切到）。 */
export async function switchToImageSkill(client: CdpClient, site: WebSiteSpec): Promise<string> {
  const chipText = site.imageSkillChip
  if (!chipText) return ''

  // ① 输入框下面直接有那颗 chip（宽窗口）
  const direct = await clickExpression(client, `Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === ${JSON.stringify(chipText)})`)
  if (direct) {
    await wait(1_200)
    return 'chip'
  }

  // ② 窄窗口下技能都收进「技能」菜单：点开再找
  const menu = await clickExpression(client, `Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === '技能')`)
  if (!menu) return ''
  await wait(1_200)
  const item = await clickExpression(client, `Array.from(document.querySelectorAll('div, button, li, [role="menuitem"], [role="option"]'))
    .filter((el) => (el.innerText || '').trim() === ${JSON.stringify(chipText)})
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]`)
  if (!item) return ''
  await wait(1_200)
  return 'menu'
}

/** 页面上已生成的图（去重、过滤头像小图）。 */
async function readGeneratedImages(client: CdpClient, site: WebSiteSpec): Promise<Array<{ src: string; w: number; h: number }>> {
  const selectors = (site.imageSelectors ?? ['[data-testid="receive_message"] img']).join(', ')
  const raw = await client
    .evaluate<Array<{ src: string; w: number; h: number }>>(`(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selectors)}));
      const seen = new Set();
      const out = [];
      for (const img of nodes) {
        const src = img.currentSrc || img.src || '';
        if (!src || seen.has(src)) continue;
        const w = img.naturalWidth || 0;
        const h = img.naturalHeight || 0;
        if (w < 200 || h < 200) continue;   // 头像/图标
        seen.add(src);
        out.push({ src, w, h });
      }
      return out;
    })()`)
    .catch(() => [])
  return Array.isArray(raw) ? raw : []
}

/** 页面内取图（带 cookie）→ base64。失败返回空串。 */
async function fetchImageAsBase64(client: CdpClient, src: string): Promise<string> {
  return client
    .evaluate<string>(`(async () => {
      const url = ${JSON.stringify(src)};
      if (url.startsWith('data:')) return url.split(',')[1] || '';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return '';
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    })()`)
    .catch(() => '')
}

function extOf(buf: Buffer): string {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.length > 12 && buf.slice(8, 12).toString() === 'WEBP') return 'webp'
  return 'bin'
}

/**
 * 生成 + 下载。**调用前必须已经在对话页且已登录**（登录检查在入口做）。
 */
export async function generateImages(
  client: CdpClient,
  site: WebSiteSpec,
  outDir: string,
  options: ImageGenOptions,
): Promise<ImageGenResult> {
  const startedAt = Date.now()
  const log = options.log ?? ((): void => undefined)
  const prompt = String(options.prompt ?? '').trim()
  if (prompt === '') throw new VisionError('生图需要提示词（prompt）', 0)

  const via = await switchToImageSkill(client, site)
  if (via === '') {
    throw new VisionError(
      `${site.label}找不到「图像生成」入口（技能 chip 和「技能」菜单里都没有）：前端可能改版，或这个账号没开生图能力`,
      0,
    )
  }
  log('已切到图像生成', { via })

  await clearEditor(client, site.editorSelector)
  if (!(await typeInto(client, site.editorSelector, prompt))) throw new VisionError(`${site.label}输入框拿不到焦点`, 0)

  const emptyProbe = `(() => { const el = document.querySelector(${JSON.stringify(site.editorSelector)}); return el ? (el.innerText || '').trim() === '' : false })()`
  let sent = false
  if (site.sendSelector) {
    sent = await clickElement(client, site.sendSelector).catch(() => false)
    if (sent) sent = await pollTrue(client, emptyProbe, 4_000)
  }
  // 没有发送按钮（豆包）或者点了没反应 ⇒ 用回车
  if (!sent) {
    await pressEnter(client)
    sent = await pollTrue(client, emptyProbe, 3_000)
  }
  if (!sent) throw new VisionError(`${site.label}生图请求没发出去（输入框里还留着字）`, 0)
  log('生图请求已发送，等出图', { prompt: prompt.slice(0, 40) })

  // 等图：数量稳定 8 秒不动就算出完
  const deadline = Date.now() + Math.max(options.timeoutMs ?? 180_000, 60_000)
  const want = Math.min(Math.max(options.count ?? 1, 1), 4)
  let images: Array<{ src: string; w: number; h: number }> = []
  let lastKey = ''
  let stableAt = 0
  while (Date.now() < deadline) {
    await wait(Math.max(200, Math.min(2_500, options.settleMs ?? 2_500)))
    images = await readGeneratedImages(client, site)
    const key = images.map((image) => image.src).join('|')
    if (key !== lastKey) {
      lastKey = key
      stableAt = Date.now()
      continue
    }
    if (images.length >= want && Date.now() - stableAt > (options.settleMs ?? 8_000)) break
  }
  if (images.length === 0) {
    const tail = await client.evaluate<string>('(document.body.innerText || "").trim().slice(-300)').catch(() => '')
    throw new VisionError(
      `${site.label}没有出图（等了 ${Math.round((Date.now() - startedAt) / 1000)} 秒）。页面尾部：${String(tail).replace(/\s+/g, ' ').slice(0, 200)}`,
      0,
    )
  }

  fs.mkdirSync(outDir, { recursive: true })
  const files: string[] = []
  let index = 0
  for (const image of images.slice(0, want)) {
    index += 1
    const base64 = await fetchImageAsBase64(client, image.src)
    if (base64 === '') {
      log('下载失败（可能是签名 URL 过期）', { index, src: image.src.slice(0, 80) })
      continue
    }
    const buf = Buffer.from(base64, 'base64')
    if (buf.length === 0) continue
    const file = path.join(outDir, `web-image-${Date.now()}-${index}.${extOf(buf)}`)
    fs.writeFileSync(file, buf)
    files.push(file)
    log('已保存生成图', { index, file, kb: Math.round(buf.length / 1024), w: image.w, h: image.h })
  }
  if (files.length === 0) {
    throw new VisionError(`${site.label}出了 ${images.length} 张图但一张都没下载下来（签名 URL 可能已过期），可重试一次`, 0)
  }
  return { files, elapsedMs: Date.now() - startedAt, via }
}
