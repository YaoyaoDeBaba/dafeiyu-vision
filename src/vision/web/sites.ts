/**
 * web/sites —— 两个站点的适配器：把「塞图 + 打字 + 回车 + 抽回答」讲成同一句话。
 *
 * 设计原则（改版时少挨打）：
 * 1. **选择器集中在本文件顶部的表里**，前端一改版只改这里，不散落在流程代码里；
 * 2. 抽取走「候选列表 + 兜底」，第一顺位失效不会直接空手而归；
 * 3. 每一步失败都报**带站点名的中文原因**，设置页/工具输出原样能看懂。
 *
 * 实测过的站点事实（2026-11-17，登录态下）：
 * - 豆包：上传按钮 `[data-testid="upload_file_button"]`，点开后才有隐藏 `input[type=file]`；
 *   输入框 `.ProseMirror`（tiptap）；未登录发送会被踢到 `?from_logout=1`。
 * - Gemini：工具按钮 `button[aria-label="上传和工具"]`，点开后出现 `input[accept="image/*"]`；
 *   输入框 `.ql-editor`；未登录上传会卡在「正在上传图片：50%」。
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { CdpClient } from './driver.js'
import { VisionError } from '../protocols.js'

export type WebSiteId = 'doubao' | 'gemini'

export interface WebSiteSpec {
  id: WebSiteId
  label: string
  /** 每个请求从这里进（= 新对话）。 */
  homeUrl: string
  /** 登录页（有头窗口用同一个地址，登录后自然落回对话页）。 */
  loginUrl: string
  editorSelector: string
  /** 判断已登录的表达式（返回布尔）。 */
  loginProbe: string
  /** 上传入口的点击步骤（在页面里执行，返回是否点到）。 */
  openUpload: string
  /** 上传用的 file input 选择器。 */
  fileInputSelector: string
  /** 回答的候选选择器（第一顺位优先）。 */
  answerSelectors: string[]
  /** 生成中提示（出现即说明还没答完）。 */
  busySelectors: string[]
  /**
   * 登录判据（**首选**）：`cookieUrl` 域下出现这些 cookie 名之一，才算登录。
   *
   * 为什么不用 DOM：0.1.7 及以前靠"没有登录按钮就算登录"，而豆包首屏是**输入框先渲染、
   * 顶栏后渲染**——按钮还没出来那两三秒就会被判成"已登录"（2026-11-19 实测：
   * 一条明明未登录的 profile 被判成 loggedIn:true，用户以为插件坏了）。
   * cookie 是服务端认的证据，没法提前"没出现"。
   */
  authCookies?: { url: string; names: string[] }
  /** 生图技能 chip 的文案（有它才支持网页版生图；豆包是「图像生成」）。 */
  imageSkillChip?: string
  /** 生成结果图的候选选择器（只取 naturalWidth ≥ 200 的，滤掉头像图标）。 */
  imageSelectors?: string[]
  /**
   * 可选：进站后先点一次「新对话」。
   *
   * 为什么需要：Gemini 的 `/app` 会**恢复上次那个对话**（URL 变成 `/app/<id>`），
   * 于是"抽最后一条回答"抽到的是**上一轮跟我无关的长篇**（2026-11-17 实测：
   * 拿到的是一份火焰射线技术方案，跟我们发的图片毫无关系）。
   */
  newChat?: string
  /** 可选：判断"当前对话是空的"（新对话点完后等它干净）。 */
  emptyProbe?: string
  /**
   * 可选：点这颗按钮发送（比自己造回车稳）。
   *
   * 为什么：Gemini 的 Quill 输入框对合成 Enter（`Input.dispatchKeyEvent`）不买账——
   * 2026-11-17 实测：图挂上了、字也打进去了，回车下去**就是不发**，消息一直躺在输入框里。
   * 点它自己的「发送」按钮则一次成功。
   */
  sendSelector?: string
  /**
   * 可选：输入框里那颗「项目」chip 的文案。给了它才支持「在指定项目里发起会话」
   * （2026-11-17 实测豆包：点 chip → 弹层选项目 → chip 变成项目名 → 之后发的消息自动归到该项目）。
   */
  projectChip?: string
}

export const DOUBAO: WebSiteSpec = {
  id: 'doubao',
  label: '豆包',
  homeUrl: 'https://www.doubao.com/chat/',
  loginUrl: 'https://www.doubao.com/chat/',
  editorSelector: '.ProseMirror',
  authCookies: { url: 'https://www.doubao.com', names: ['sessionid', 'sessionid_ss'] },
  imageSkillChip: '图像生成',
  imageSelectors: [
    '[data-testid="receive_message"] img',
    '.flow-markdown-body img',
    '[data-testid="image_generated"] img',
    'img[src*="flow-doubao"]',
  ],
  loginProbe: `(() => {
    if (document.querySelector('[data-testid="to_login_button"]')) return false;
    if (location.search.includes('from_logout')) return false;
    return true;
  })()`,
  openUpload: `(() => {
    const btn = document.querySelector('[data-testid="upload_file_button"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  fileInputSelector: 'input[type=file]',
  projectChip: '项目',
  answerSelectors: [
    '[data-testid="message_text_content"]',
    '[data-testid="receive_message"] [data-testid*="text"]',
    '[data-testid="receive_message"]',
    '.flow-markdown-body',
  ],
  busySelectors: ['[data-testid="stop_generation_button"]', '[aria-label*="停止生成"]'],
}

export const GEMINI: WebSiteSpec = {
  id: 'gemini',
  label: 'Gemini',
  homeUrl: 'https://gemini.google.com/app',
  loginUrl: 'https://gemini.google.com/app',
  editorSelector: '.ql-editor',
  authCookies: { url: 'https://gemini.google.com', names: ['__Secure-1PSID', 'SID', '__Secure-3PSID'] },
  loginProbe: `(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    if (buttons.some((b) => (b.getAttribute('aria-label') || '').trim() === '登录')) return false;
    if (document.querySelector('a[href*="accounts.google.com/ServiceLogin"]')) return false;
    return !!document.querySelector('.ql-editor');
  })()`,
  openUpload: `(() => {
    const btn = document.querySelector('button[aria-label="上传和工具"]')
      || Array.from(document.querySelectorAll('button')).find((b) => /上传和工具|Upload and tools/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  /**
   * ⚠️ 别写 `input[accept="image/*"]`（精确匹配）：登录后 Gemini 给的是
   * `accept="image/*,video/*"`，精确匹配会**一个都找不到**，表现是"点了上传却等不到输入框"。
   * 用子串匹配（`*=`）才稳。
   */
  fileInputSelector: 'input[accept*="image/"]',
  answerSelectors: ['model-response .markdown', 'model-response message-content', 'response-container', 'model-response'],
  busySelectors: ['[aria-label*="停止"]', '[aria-label*="Stop"]'],
  newChat: `(() => {
    const hit = Array.from(document.querySelectorAll('button, a')).find((el) => {
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '');
      return /发起新对话|New chat/i.test(label);
    });
    if (!hit) return false;
    hit.click();
    return true;
  })()`,
  emptyProbe: `document.querySelectorAll('model-response').length === 0`,
  sendSelector: 'button[aria-label="发送"], button[aria-label*="Send"], button[aria-label*="发送"]',
}

export const SITES: Record<WebSiteId, WebSiteSpec> = { doubao: DOUBAO, gemini: GEMINI }

export function isWebSiteId(value: unknown): value is WebSiteId {
  return value === 'doubao' || value === 'gemini'
}

/**
 * 这个窗口**到底登录没登录**。
 *
 * 首选 cookie（服务端认的证据）；cookie 拿不到（老内核 / Network 域不可用）才退回 DOM 探针——
 * DOM 探针有个天然缺陷：页面还没渲染完时"看不到登录按钮"会被当成"已登录"。
 */
export async function isLoggedIn(client: CdpClient, site: WebSiteSpec): Promise<boolean> {
  let cookieVerdict: boolean | undefined
  if (site.authCookies) {
    try {
      const result = await client.call<{ cookies?: Array<{ name?: string; value?: string }> }>(
        'Network.getCookies',
        { urls: [site.authCookies.url] },
        10_000,
      )
      if (Array.isArray(result?.cookies)) {
        cookieVerdict = site.authCookies.names.some((name) =>
          (result.cookies ?? []).some((cookie) => cookie?.name === name && (cookie?.value ?? '') !== ''),
        )
      }
    } catch {
      /* 拿不到 cookie 就只信 DOM */
    }
  }

  // cookie 没有 ⇒ 一定没登录（没有任何服务端凭据）
  if (cookieVerdict === false) return false

  /*
   * cookie 有（或者拿不到）时，**必须再用渲染好的页面确认一次**：
   * 2026-11-19 实测：cookie 还在磁盘上，但服务端已经把会话作废了——页面顶部是「登录」，
   * 只看 cookie 会误报"已登录"。反过来，页面刚 open 时按钮还没渲出来，
   * 只看 DOM 会误报"已登录"。两者一起看才准：cookie 是必要条件，DOM 是确认。
   */
  const settled = await pollTrue(client, `!!document.querySelector(${JSON.stringify(site.editorSelector)})`, 8_000)
  if (!settled) return cookieVerdict === true
  const first = await client.evaluate<boolean>(site.loginProbe).catch(() => cookieVerdict === true)
  if (first) return true
  // 抖一下再看一次（首屏切换/路由跳转时按钮会短暂出现）
  await wait(1_500)
  return client.evaluate<boolean>(site.loginProbe).catch(() => false)
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 轮询直到表达式为真；超时返回 false（不抛，调用方决定怎么说）。 */
export async function pollTrue(client: CdpClient, expression: string, timeoutMs: number, stepMs = 300): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await client.evaluate<boolean>(expression).catch(() => false)
    if (ok) return true
    await wait(stepMs)
  }
  return false
}

/** 把 base64 图落成临时文件（CDP 只能塞文件路径）。 */
export function writeTempImage(base64: string, mime: string): string {
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'png'
  const file = path.join(os.tmpdir(), `dafeiyu-webvision-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
  fs.writeFileSync(file, Buffer.from(base64, 'base64'))
  return file
}

/** 把文件塞进指定 file input（用 objectId，绕开"元素不可见"。 */
export async function setFileInput(client: CdpClient, selector: string, file: string): Promise<boolean> {
  const handle = await client
    .call<{ result?: { objectId?: string } }>('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    })
    .catch(() => undefined)
  const objectId = handle?.result?.objectId
  if (!objectId) return false
  await client.call('DOM.setFileInputFiles', { files: [file], objectId }, 20_000)
  return true
}

/**
 * 打字。
 *
 * ⚠️ 别用 CDP 的 `Input.insertText`：字符是进去了，但**框架的模型没更新**——
 * Gemini（Quill）那边 `ql-blank` 类摘不掉、发送按钮的逻辑状态还是空，点发送毫无反应，
 * 消息永远躺在输入框里（2026-11-17 实测，来回踩了三次）。
 * `document.execCommand('insertText')` 走的是编辑管线，会派发 `beforeinput`/`input`，
 * Quill 与 ProseMirror 都认。
 */
export async function typeInto(client: CdpClient, selector: string, text: string): Promise<boolean> {
  return client
    .evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
      return ok !== false;
    })()`)
    .catch(() => false)
}

/** 回车发送（ProseMirror / Quill 都认原生 keydown）。 */
export async function pressEnter(client: CdpClient): Promise<void> {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await client.call('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    })
  }
}

/**
 * 清空输入框。
 *
 * 为什么必须有这一步：Quill 会把上一轮**没发出去**的文字留在框里（`ql-blank` 类都不摘），
 * 我们再 `insertText` 就变成"同一句话打两遍"（2026-11-17 实测 Gemini 上踩到）。
 */
export async function clearEditor(client: CdpClient, selector: string): Promise<boolean> {
  return client
    .evaluate<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('delete');
      return true;
    })()`)
    .catch(() => false)
}

/** 输入框是不是空的（发送成功的最强信号）。 */
function editorEmptyExpression(selector: string): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || '').trim() === '' : false })()`
}

/**
 * 用**真鼠标事件**点一个元素（CDP `Input.dispatchMouseEvent`，走浏览器输入管线，
 * `event.isTrusted === true`）。
 *
 * 为什么不用 `el.click()`：Angular/Material 那套「发送」按钮对合成 click 可能不响应
 * （2026-11-17 实测 Gemini：`button[aria-label="发送"].click()` 一点反应没有，
 * 消息一直躺在框里）。改发真鼠标事件后一次成功。
 */
export async function clickElement(client: CdpClient, selector: string): Promise<boolean> {
  return clickExpression(client, `document.querySelector(${JSON.stringify(selector)})`)
}

/** 点「某个表达式算出来的元素」（选择器表达不了的：按文本找按钮之类）。 */
export async function clickExpression(client: CdpClient, expression: string): Promise<boolean> {
  const box = await client
    .evaluate<{ x: number; y: number } | null>(`(() => {
      const el = ${expression};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`)
    .catch(() => null)
  if (!box) return false
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.call('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
  }
  return true
}

/**
 * 最后一次回答的文本（候选选择器依次试，返回第一个非空的最后一个节点）。
 *
 * `exclude` 用来排掉**我们自己那条提问**：豆包的对话区里用户消息和助手消息共用一部分
 * class，抽错时最典型的表现就是"回答 == 我发的那句话"（2026-11-17 实测踩到过）。
 */
export async function readAnswer(
  client: CdpClient,
  selectors: string[],
  exclude = '',
): Promise<{ text: string; selector: string }> {
  const list = JSON.stringify(selectors)
  const result = await client
    .evaluate<{ text: string; selector: string }>(`(() => {
      const skip = ${JSON.stringify(exclude.trim())};
      for (const sel of ${list}) {
        const nodes = Array.from(document.querySelectorAll(sel));
        if (nodes.length === 0) continue;
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          const text = ((nodes[i].innerText || nodes[i].textContent || '') + '').trim();
          if (text === '' || text === skip) continue;
          return { text, selector: sel };
        }
      }
      return { text: '', selector: '' };
    })()`)
    .catch(() => ({ text: '', selector: '' }))
  return result ?? { text: '', selector: '' }
}

async function stillBusy(client: CdpClient, selectors: string[]): Promise<boolean> {
  if (selectors.length === 0) return false
  const list = JSON.stringify(selectors)
  return client.evaluate<boolean>(`(() => ${list}.some((sel) => !!document.querySelector(sel)))()`).catch(() => false)
}

export interface AskOptions {
  /** 图片 base64（不含 data: 前缀）。 */
  base64: string
  mime: string
  prompt: string
  /** 整体超时（含上传与生成）。 */
  timeoutMs: number
  /** 可选：在哪个「项目」里发起会话（只有支持 projectChip 的站点有效）。 */
  project?: string
  log?: (message: string, fields?: Record<string, string | number | boolean | undefined>) => void
}

export interface AskResult {
  text: string
  /** 生成没结束就超时了（文本可能被截断）。 */
  truncated: boolean
  elapsedMs: number
}

const NOT_LOGGED_IN_HINT = (label: string): string =>
  `${label}没有登录：先在「肥鱼识图」设置里点「登录 ${label}」，在弹出的窗口里登一次（cookie 会留在本机 profile 里，之后长期有效）`

/** 等回答的总预算：配置的超时太小（比如 10 秒）也要给到 15 秒，否则永远来不及。 */
export function answerBudgetMs(timeoutMs: number): number {
  return Math.max(Number.isFinite(timeoutMs) ? timeoutMs : 0, 15_000)
}

/**
 * 一次完整提问。返回模型给的文本；任何环节失败都抛 `VisionError`（带站点名与下一步）。
 */
export async function askSite(client: CdpClient, site: WebSiteSpec, options: AskOptions): Promise<AskResult> {
  const log = options.log ?? ((): void => undefined)

  await client.goto(site.homeUrl)
  const ready = await pollTrue(client, `!!document.querySelector(${JSON.stringify(site.editorSelector)})`, 25_000)
  if (!ready) throw new VisionError(`${site.label}页面没加载出来（找不到输入框 ${site.editorSelector}）：检查网络，或先在设置里登录一次`, 0)

  const loggedIn = await isLoggedIn(client, site)
  if (!loggedIn) throw new VisionError(NOT_LOGGED_IN_HINT(site.label), 401)

  // ⓪ 新对话：有的站点（Gemini）会把上次那个对话恢复出来，必须先回到空白对话
  if (site.newChat) {
    const clicked = await client.evaluate<boolean>(site.newChat).catch(() => false)
    if (clicked && site.emptyProbe) {
      const clean = await pollTrue(client, site.emptyProbe, 10_000)
      if (!clean) log('新对话没清干净，继续（可能抽到旧回答）', { site: site.id })
    }
  }

  // ⓪2 指定项目：把这次会话归到项目里（豆包支持；Gemini 没这能力，忽略）
  if (options.project && options.project.trim() !== '') {
    if (!site.projectChip) {
      log('该站点不支持「项目」，忽略 webProject', { site: site.id })
    } else {
      const moved = await selectProject(client, site, options.project.trim())
      if (!moved) {
        throw new VisionError(
          `${site.label}切不到项目「${options.project.trim()}」：确认侧栏「项目」下确实有这个名字（拼写/空格敏感），或该站点不支持项目`,
          0,
        )
      }
      log('已切到项目', { site: site.id, project: options.project.trim() })
    }
  }

  return askOnCurrentPage(client, site, options)
}

/**
 * 在**当前页面**上提一次问（不导航、不点新对话）。
 *
 * 单独抽出来是为了「在指定项目里发起会话」这种场景：项目页有自己的路由与对话列表，
 * 一 `goto` 就回不到项目里了（2026-11-17 加）。
 */
export async function askOnCurrentPage(client: CdpClient, site: WebSiteSpec, options: AskOptions): Promise<AskResult> {
  const startedAt = Date.now()
  const log = options.log ?? ((): void => undefined)

  // ⓪5 先清空输入框——**必须在塞图之前**：Gemini 的附件是挂在 rich-textarea 里的，
  // 清空编辑器时 `execCommand('delete')` 会把刚上传的图一起删掉（2026-11-17 实测）。
  await clearEditor(client, site.editorSelector)

  // ① 上传：点开上传入口 → 等 file input 出现 → 塞文件
  const opened = await client.evaluate<boolean>(site.openUpload).catch(() => false)
  if (!opened) throw new VisionError(`${site.label}页面上找不到上传入口（前端可能改版了）`, 0)
  const inputReady = await pollTrue(client, `!!document.querySelector(${JSON.stringify(site.fileInputSelector)})`, 8_000)
  if (!inputReady) throw new VisionError(`${site.label}点了上传但没出现文件输入框（前端可能改版了）`, 0)

  const imageFile = writeTempImage(options.base64, options.mime)
  try {
    const attached = await setFileInput(client, site.fileInputSelector, imageFile).catch(() => false)
    if (!attached) throw new VisionError(`${site.label}塞图失败（file input 拿不到句柄）`, 0)

    // ② 等附件落地：缩略图 / 附件块 / 站点自己的"已上传"文案，哪个先到算哪个
    const attachProbe = `(() => {
      const nodes = document.querySelectorAll('rich-textarea img, [class*="attachment" i], [class*="file-preview" i], [class*="preview" i] img');
      const text = document.body.innerText || '';
      const uploading = /正在上传|上传中|Uploading/.test(text);
      const hinted = /解释图片|图片已上传|Image attached/.test(text);
      return { uploading, count: nodes.length + (hinted ? 1 : 0) };
    })()`
    const uploadDeadline = Date.now() + 30_000
    let attachSeen = false
    while (Date.now() < uploadDeadline) {
      const state = await client
        .evaluate<{ uploading: boolean; count: number }>(attachProbe)
        .catch(() => ({ uploading: false, count: 0 }))
      if (state.count > 0) attachSeen = true
      if (!state.uploading && attachSeen) break
      await wait(400)
    }
    if (!attachSeen) log('没看到附件落地迹象，继续（交给回答判据说话）', { site: site.id })

    // ③ 打字 → 发送（能点「发送」按钮就别造回车，见 sendSelector 的说明）
    const typed = await typeInto(client, site.editorSelector, options.prompt)
    if (!typed) throw new VisionError(`${site.label}输入框拿不到焦点`, 0)
    const emptyProbe = editorEmptyExpression(site.editorSelector)
    let sent = false
    if (site.sendSelector) {
      sent = await clickElement(client, site.sendSelector).catch(() => false)
      if (sent) sent = await pollTrue(client, emptyProbe, 4_000)
    }
    if (!sent) {
      await pressEnter(client)
      sent = await pollTrue(client, emptyProbe, 3_000)
    }
    if (!sent) throw new VisionError(`${site.label}消息没发出去（输入框里还留着字）：前端可能改版，或这颗账号被限制了`, 0)

    // ④ 等生成结束：回答文本连续 1.2s 不变 + 没有"停止生成"按钮
    let lastText = ''
    let stableSince = 0
    let truncated = false
    const answerDeadline = Date.now() + answerBudgetMs(options.timeoutMs)
    while (Date.now() < answerDeadline) {
      await wait(500)
      const answer = await readAnswer(client, site.answerSelectors, options.prompt)
      const busy = await stillBusy(client, site.busySelectors)
      if (answer.text !== lastText) {
        lastText = answer.text
        stableSince = Date.now()
        continue
      }
      if (lastText !== '' && !busy && Date.now() - stableSince > 1_200) break
    }
    if (lastText === '') {
      const shot = path.join(os.tmpdir(), `dafeiyu-webvision-${site.id}-${Date.now()}.png`)
      await client.screenshot(shot)
      throw new VisionError(`${site.label}没有返回可读的回答（等了 ${Math.round((Date.now() - startedAt) / 1000)} 秒）。截图：${shot}`, 0)
    }
    if (Date.now() >= answerDeadline) truncated = true
    log('网页版识图完成', { site: site.id, chars: lastText.length, elapsedMs: Date.now() - startedAt })
    return { text: lastText, truncated, elapsedMs: Date.now() - startedAt }
  } finally {
    try {
      fs.unlinkSync(imageFile)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把当前对话归到指定「项目」里（豆包的能力，Gemini 没有）。
 *
 * 实测路径（2026-11-17）：输入框第二行那颗「项目」chip → 弹层里选项目 →
 * chip 变成项目名 → 之后发的消息就落在该项目下（侧栏「项目」分组里能看到新会话）。
 *
 * 返回 false 表示没切成（项目不存在 / 弹层没出来 / 前端改版），调用方据此报人话。
 */
export async function selectProject(client: CdpClient, site: WebSiteSpec, projectName: string): Promise<boolean> {
  if (!site.projectChip || projectName.trim() === '') return false
  const chip = `Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === ${JSON.stringify(site.projectChip)})`
  if (!(await clickExpression(client, chip))) return false
  await wait(900)

  // 弹层里的项目项：同名元素可能有多处（侧栏也有一个），取**最靠下**的那个（弹层贴着输入框）
  const item = `Array.from(document.querySelectorAll('div, button, li, [role="menuitem"], [role="option"]'))
      .filter((el) => (el.innerText || '').trim() === ${JSON.stringify(projectName)})
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]`
  if (!(await clickExpression(client, item))) return false
  await wait(1_200)

  return client
    .evaluate<boolean>(`Array.from(document.querySelectorAll('button')).some((b) => (b.innerText || '').trim() === ${JSON.stringify(projectName)})`)
    .catch(() => false)
}

/** 只探登录态（不提问）：给设置页/路由用。 */
export async function probeLogin(client: CdpClient, site: WebSiteSpec): Promise<{ loggedIn: boolean; url: string }> {
  await client.goto(site.loginUrl)
  const ready = await pollTrue(client, `!!document.querySelector(${JSON.stringify(site.editorSelector)})`, 25_000)
  if (!ready) return { loggedIn: false, url: site.loginUrl }
  const loggedIn = await isLoggedIn(client, site)
  const url = await client.evaluate<string>('location.href').catch(() => site.loginUrl)
  return { loggedIn: !!loggedIn, url }
}