/**
 * xyq-selfheal.test —— 「调用前自愈」的判据（全进程内：假执行器、假下载，不真装不联网）。
 *
 * 钉五件事 + 两条边界：
 *   ① CLI 缺失 ⇒ 触发安装（假 runner 断言真实命令行），且**只在被调用时**装；
 *   ② 安装成功后再定位成功，并继续原调用；
 *   ③ 安装失败 ⇒ 中文错误含手工命令，且退避期内不重复安装（不重试轰炸）；
 *   ④ 未登录 ⇒ 返回授权链接 + 续等命令，同会话第二次不再重复发起登录；
 *   ⑤ 云雀缺 Access Key ⇒ 说清三处填哪儿（设置页 / 配置文件 / 环境变量）；
 *   边界 A：非 Windows 不跑安装脚本，只给手工命令；
 *   边界 B：autoInstall:false / autoLogin:false 时只报告、不动手。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createXyqService } from '../src/xyq/service.js'
import { createJimengService } from '../src/xyq/jimeng/service.js'
import { extractWindowsInstaller } from '../src/xyq/selfheal.js'
import { startXyq } from '../src/xyq/start.js'
import type { CliRunner } from '../src/xyq/cli.js'

const NOVEL = 'C:/jimeng/bin/jimeng-novel.exe'
const OUT_DIR = 'D:/out/jimeng'
const AUTH_FAILED = {
  code: 0,
  stdout: JSON.stringify({
    status: 'error',
    error: {
      code: 'AUTH_FAILED',
      details: { auth: { reason: 'credential_expired', nextAction: 'login' } },
      hint: '执行 jimeng-novel login --non-interactive，由用户在浏览器确认授权',
    },
  }),
  stderr: '',
  timedOut: false,
}
const CREDIT_OK = { code: 0, stdout: JSON.stringify({ status: 'ok', data: { balance: 999 } }), stderr: '', timedOut: false }
const LOGIN_OK = {
  code: 0,
  stdout: JSON.stringify({
    status: 'ok',
    data: {
      status: 'authorization_required',
      challenge: {
        deviceCode: 'dc-1',
        verificationUri: 'https://jimeng.test/auth?code=ABC',
        verificationUriComplete: 'https://jimeng.test/auth?code=ABC&device=dc-1',
      },
      nextCommand: '"C:/jimeng/bin/jimeng-novel.exe" login --wait --device-code dc-1',
    },
  }),
  stderr: '',
  timedOut: false,
}

// 一段「sh 脚本里内嵌 Windows 安装器」的最小复刻（与线上 novel-cli 同形）
const EMBEDDED_PS1 = 'Write-Output ok'
const NOVEL_SH = `#!/usr/bin/env bash\nDEFAULT_WINDOWS_INSTALLER_BASE64='${Buffer.from(EMBEDDED_PS1, 'utf8').toString('base64')}'\n`

type Reply = { code?: number; stdout?: string; stderr?: string; timedOut?: boolean }

function reply(value: Reply) {
  return { code: value.code ?? 0, stdout: value.stdout ?? '', stderr: value.stderr ?? '', timedOut: value.timedOut ?? false }
}

interface HarnessInit {
  installed?: boolean
  installOk?: boolean
  platform?: NodeJS.Platform
  credit?: Reply
  login?: Reply
  generateVideo?: Reply
  xyq?: Reply
  accessKey?: string
}

function makeHarness(init: HarnessInit = {}) {
  let installed = init.installed ?? false
  const calls: string[][] = []
  const logs: string[] = []
  const fetched: string[] = []
  const tempScripts: string[] = []

  const run: CliRunner = async (args) => {
    calls.push(args)
    const exe = args[0] ?? ''
    const command = args.join(' ')
    if (exe.includes('powershell')) {
      if (init.installOk === true) installed = true
      return { code: init.installOk === true ? 0 : 1, stdout: 'installed output', stderr: init.installOk === true ? '' : 'Access denied', timedOut: false }
    }
    if (command.includes('credit get')) return reply(init.credit ?? CREDIT_OK)
    if (command.includes(' login ')) return reply(init.login ?? LOGIN_OK)
    if (command.includes('generate-video')) {
      return reply(
        init.generateVideo ?? {
          code: 0,
          stdout: JSON.stringify({ status: 'ok', data: { items: [{ output_path: 'D:/out/jimeng/S01.mp4' }] } }),
          stderr: '',
          timedOut: false,
        },
      )
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'drc-heal-'))
  const configFile = path.join(dir, 'xyq.json')
  writeFileSync(configFile, JSON.stringify({ accessKey: init.accessKey ?? 'ak-test' }), 'utf8')

  const jimeng = createJimengService({
    run,
    locate: () => (installed ? { novel: NOVEL } : {}),
    outDir: OUT_DIR,
    log: (message) => logs.push(message),
    platform: init.platform ?? 'win32',
    fetchText: async (url: string) => {
      fetched.push(url)
      return NOVEL_SH
    },
    writeTempScript: (_name: string, content: string) => {
      tempScripts.push(content)
      return { file: 'C:/tmp/jimeng-novel-install.ps1', cleanup: () => undefined }
    },
    waitVideoSec: 5,
  })
  const xyqRun: CliRunner = async () => reply(init.xyq ?? {})
  const service = createXyqService({
    configFile,
    run: xyqRun,
    resolveCli: async () => 'cli',
    channels: { jimeng },
    sleep: async () => undefined,
    pollIntervalMs: 0,
    log: () => {},
  })
  return { service, jimeng, calls, logs, fetched, tempScripts, configFile, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('① CLI 缺失 ⇒ 触发自动安装（断言真实命令行 + 下载地址）', async () => {
  const h = makeHarness({ installed: false, installOk: true })
  try {
    const result = await h.service.generateVideo({ prompt: '第一镜', model: 'seedance_2.0', channel: 'jimeng', autoInstall: true })
    assert.equal(result.ok, true, '装完就要继续往下走')

    const powershellCalls = h.calls.filter((args) => (args[0] ?? '').includes('powershell'))
    assert.equal(powershellCalls.length, 2, '一条装画布、一条装短剧')
    assert.ok((powershellCalls[0] ?? []).join(' ').includes('https://jimeng.jianying.com/canvas-cli/install.ps1'), '画布走官方 install.ps1')
    assert.ok((powershellCalls[1] ?? []).includes('-File'), '短剧走落地后的 ps1 文件')
    assert.deepEqual(h.fetched, ['https://jimeng.jianying.com/novel-cli'], '短剧 CLI 从官网脚本取')
    assert.equal(h.tempScripts.length, 1, '临时安装器要落盘再跑')
    assert.ok(h.logs.some((line) => line.includes('开始自动安装')), '装了就得留一行中文日志')
    assert.ok(h.logs.some((line) => line.includes('自动安装完成')))
  } finally {
    h.cleanup()
  }
})

test('② 安装成功后再定位成功，并按绝对路径继续原调用', async () => {
  const h = makeHarness({ installed: false, installOk: true })
  try {
    const result = await h.service.generateVideo({ prompt: '第二镜', model: 'seedance_2.0', channel: 'jimeng', autoInstall: true })
    assert.equal(result.ok, true)
    assert.deepEqual(result.files, ['D:/out/jimeng/S01.mp4'])
    const generate = h.calls.find((args) => args[1] === 'generate-video')!
    assert.equal(generate[0], NOVEL, '装完之后必须用绝对路径 spawn')
    assert.equal(h.calls.filter((args) => (args[0] ?? '').includes('powershell')).length, 2)
  } finally {
    h.cleanup()
  }
})

test('③ 安装失败 ⇒ 中文错误含手工命令，且退避期内不再重试', async () => {
  const h = makeHarness({ installed: false, installOk: false })
  try {
    const first = await h.service.generateVideo({ prompt: 'x', model: 'seedance_2.0', channel: 'jimeng', autoInstall: true })
    assert.equal(first.ok, false)
    assert.match(String(first.message), /自动安装失败/)
    assert.match(String(first.message), /irm https:\/\/jimeng\.jianying\.com\/canvas-cli\/install\.ps1 \| iex/, '要给能直接复制的手工命令')
    assert.ok(h.logs.some((line) => line.includes('自动安装失败')), '失败也要留一行日志')
    const attemptsAfterFirst = h.calls.filter((args) => (args[0] ?? '').includes('powershell')).length
    assert.equal(attemptsAfterFirst, 2)

    const second = await h.service.generateVideo({ prompt: 'x', model: 'seedance_2.0', channel: 'jimeng', autoInstall: true })
    assert.equal(second.ok, false)
    const attemptsAfterSecond = h.calls.filter((args) => (args[0] ?? '').includes('powershell')).length
    assert.equal(attemptsAfterSecond, attemptsAfterFirst, '退避期内不许再来一轮下载')
    assert.match(String(second.message), /不再重试/)
  } finally {
    h.cleanup()
  }
})

test('④ 未登录 ⇒ 给授权链接与续等命令；同会话第二次不再重复发起登录', async () => {
  const h = makeHarness({ installed: true, credit: AUTH_FAILED, login: LOGIN_OK })
  try {
    const first = await h.service.generateVideo({ prompt: 'x', model: 'seedance_2.0', channel: 'jimeng' })
    assert.equal(first.ok, false)
    assert.match(String(first.message), /https:\/\/jimeng\.test\/auth/, '链接要原样给用户')
    assert.match(String(first.message), /授权完告诉我/, '一句话说清下一步')
    assert.match(String(first.message), /login --wait --device-code dc-1/, '续等命令要带上')
    assert.equal(h.calls.filter((args) => args.includes('--non-interactive')).length, 1, '只发起一次')

    const second = await h.service.generateVideo({ prompt: 'x', model: 'seedance_2.0', channel: 'jimeng' })
    assert.equal(second.ok, false)
    assert.match(String(second.message), /https:\/\/jimeng\.test\/auth/, '第二次复述同一个链接')
    assert.equal(h.calls.filter((args) => args.includes('--non-interactive')).length, 1, '同会话不重复发起登录')
    assert.ok(h.logs.some((line) => line.includes('自动发起浏览器授权')), '发起授权要留一行日志')
  } finally {
    h.cleanup()
  }
})

test('⑤ 云雀缺 Access Key ⇒ 说清三处填哪儿（设置页 / 配置文件 / 环境变量）', async () => {
  const h = makeHarness({ installed: true, accessKey: '' })
  try {
    const result = await h.service.generateImage({ prompt: '画一只鲸鱼' })
    assert.equal(result.ok, false)
    const message = String(result.message)
    assert.match(message, /Access Key/)
    assert.match(message, /大肥鱼 → 小云雀/, '要指名设置页哪一栏')
    assert.ok(message.includes(h.configFile), '要给配置文件的绝对路径')
    assert.match(message, /XYQ_ACCESS_KEY/, '要给环境变量名')
  } finally {
    h.cleanup()
  }
})

test('边界 A：非 Windows 不跑安装脚本，只给手工命令', async () => {
  const h = makeHarness({ installed: false, installOk: true, platform: 'linux' })
  try {
    // 自动安装现在默认关，要走到「非 Windows 分支」必须显式开
    const result = await h.jimeng.preflight!({ autoInstall: true })
    assert.equal(result.ok, false)
    assert.equal(h.calls.filter((args) => (args[0] ?? '').includes('powershell')).length, 0, '非 Windows 绝不去跑 ps1')
    assert.equal(h.fetched.length, 0)
    assert.match(String(result.ok ? '' : result.message), /不是 Windows/)
  } finally {
    h.cleanup()
  }
})

test('边界 B：autoInstall:false / autoLogin:false 只报告不动手', async () => {
  const h = makeHarness({ installed: false, installOk: true })
  try {
    const noInstall = await h.jimeng.preflight!({ autoInstall: false })
    assert.equal(noInstall.ok, false)
    assert.match(String(noInstall.ok ? '' : noInstall.message), /autoInstall:false/)
    assert.match(String(noInstall.ok ? '' : noInstall.message), /手工安装/)
    assert.equal(h.calls.filter((args) => (args[0] ?? '').includes('powershell')).length, 0)
  } finally {
    h.cleanup()
  }

  const h2 = makeHarness({ installed: true, credit: AUTH_FAILED })
  try {
    const noLogin = await h2.jimeng.preflight!({ autoLogin: false })
    assert.equal(noLogin.ok, false)
    assert.match(String(noLogin.ok ? '' : noLogin.message), /autoLogin:false/)
    assert.equal(h2.calls.filter((args) => args.includes('--non-interactive')).length, 0, '关掉就绝不发起授权')
  } finally {
    h2.cleanup()
  }
})

test('自动安装只在被调用时触发：startXyq 启动期间一次都不装', async () => {
  const calls: string[][] = []
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-start2-'))
  const run: CliRunner = async (args) => {
    calls.push(args)
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  const handle = startXyq(
    { get: () => undefined } as never,
    {
      dshHome: dir,
      log: () => undefined,
      run,
      resolveCli: async () => 'cli',
      jimengChannel: createJimengService({ run, locate: () => ({}), log: () => undefined, platform: 'win32' }),
    },
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.match(String(handle.probe.jimeng), /^unavailable:/)
    assert.equal(calls.filter((args) => (args[0] ?? '').includes('powershell')).length, 0, '启动阶段不许装任何东西')
  } finally {
    handle.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractWindowsInstaller：从 sh 里抠出 base64 安装器（抠不到返回 undefined）', () => {
  assert.equal(extractWindowsInstaller(NOVEL_SH), EMBEDDED_PS1)
  assert.equal(extractWindowsInstaller('#!/usr/bin/env bash\necho hi\n'), undefined)
})