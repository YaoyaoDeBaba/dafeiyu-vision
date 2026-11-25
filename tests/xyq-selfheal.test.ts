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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    assert.match(message, /大肥鱼 → 鲸鱼做梦/, '要指名设置页哪一栏（产品已改名）')
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

// ---------------------------------------------------------------------------
// 云雀（pippit-tool-cli）侧的自愈：默认只报错，显式 autoInstall:true 才跑 npx
// ---------------------------------------------------------------------------

function xyqHarness(init: { present?: boolean; installOk?: boolean; accessKey?: string } = {}) {
  let present = init.present ?? false
  const calls: string[][] = []
  const logs: string[] = []
  const run: CliRunner = async (args) => {
    calls.push(args)
    const exe = args[0] ?? ''
    if (exe.startsWith('npx')) {
      if (init.installOk === false) return { code: 1, stdout: 'npm ERR! network', stderr: '', timedOut: false }
      present = true
      return { code: 0, stdout: 'installed', stderr: '', timedOut: false }
    }
    if (args[1] === 'generate-image') return { code: 0, stdout: JSON.stringify({ thread_id: 't', run_id: 'r' }), stderr: '', timedOut: false }
    if (args[1] === 'query-result') {
      return { code: 0, stdout: JSON.stringify({ status: 'succeeded', images: [{ output_path: 'D:/out/a.png' }] }), stderr: '', timedOut: false }
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'drc-xyqheal-'))
  const configFile = path.join(dir, 'xyq.json')
  writeFileSync(configFile, JSON.stringify({ accessKey: init.accessKey ?? 'ak-test' }), 'utf8')
  const service = createXyqService({
    configFile,
    run,
    resolveCli: async () => (present ? 'cli' : undefined),
    locateCli: () => (present ? 'cli' : undefined),
    log: (message) => logs.push(String(message)),
    sleep: async () => undefined,
    pollIntervalMs: 0,
  })
  return { service, calls, logs, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('云雀①：缺 CLI 默认只报错、一次也不跑 npx', async () => {
  const h = xyqHarness({ present: false })
  try {
    const result = await h.service.generateImage({ prompt: '画一只鲸鱼' })
    assert.equal(result.ok, false)
    assert.match(String(result.message), /没找到 pippit-tool-cli/)
    assert.match(String(result.message), /autoInstall:true/, '要告诉用户怎样才能装')
    assert.match(String(result.message), /npx @pippit-dev\/cli@latest install/, '要给手工命令')
    assert.equal(h.calls.filter((args) => (args[0] ?? '').startsWith('npx')).length, 0, '默认绝不自动装')
  } finally {
    h.cleanup()
  }
})

test('云雀①：传 autoInstall:true 才跑 npx（断言命令行），装完继续原调用', async () => {
  const h = xyqHarness({ present: false })
  try {
    const result = await h.service.generateImage({ prompt: '画一只鲸鱼', model: 'Seedream_5.0', autoInstall: true })
    const npxCall = h.calls.find((args) => (args[0] ?? '').startsWith('npx'))!
    assert.ok(/^npx(\.cmd)?$/.test(npxCall[0] ?? ''), 'Windows 上必须是 npx.cmd，否则 spawn 直接 ENOENT')
    assert.equal(npxCall[1], '@pippit-dev/cli@latest')
    assert.equal(npxCall[2], 'install')
    assert.equal(result.ok, true, '装完要接着把这次生图做完')
    assert.deepEqual(result.files, ['D:/out/a.png'])
    assert.ok(h.logs.some((line) => line.includes('开始自动安装')), '自动动作要留一行中文日志')
    assert.ok(h.logs.some((line) => line.includes('自动安装完成')))
  } finally {
    h.cleanup()
  }
})

test('云雀①：安装失败 ⇒ 中文错误含手工命令，退避期内不再跑 npx', async () => {
  const h = xyqHarness({ present: false, installOk: false })
  try {
    const first = await h.service.generateImage({ prompt: '画一只鲸鱼', autoInstall: true })
    assert.equal(first.ok, false)
    assert.match(String(first.message), /自动安装失败/)
    assert.match(String(first.message), /npx @pippit-dev\/cli@latest install/)
    assert.match(String(first.message), /npm ERR! network/, '失败原因要带出来（截断）')
    const attempts = h.calls.filter((args) => (args[0] ?? '').startsWith('npx')).length
    assert.equal(attempts, 1)

    const second = await h.service.generateImage({ prompt: '再画一只', autoInstall: true })
    assert.equal(second.ok, false)
    assert.equal(h.calls.filter((args) => (args[0] ?? '').startsWith('npx')).length, attempts, '退避期内不再下载')
    assert.match(String(second.message), /不再重试/)
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 真 bug：授权码过期后自愈一直复述死链接（真机 40014 / nextAction=restart）
// ---------------------------------------------------------------------------

test('即梦：授权过期 ⇒ 第二次调用带 --restart 并给新链接（不复述死链接）', async () => {
  const loginCalls: string[][] = []
  const links = ['https://jimeng.test/auth?code=OLD', 'https://jimeng.test/auth?code=NEW']
  const expireEnvelope = {
    code: 0,
    stdout: JSON.stringify({
      status: 'error',
      error: {
        code: 'AUTH_FAILED',
        message: '等待网页授权：网页授权已过期',
        details: { auth: { code: 40014, reason: 'authorization_expired', nextAction: 'restart' } },
      },
    }),
    stderr: '',
    timedOut: false,
  }
  let loginIndex = 0
  const run: CliRunner = async (args) => {
    const command = args.join(' ')
    if (command.includes('credit get')) return reply(AUTH_FAILED)
    if (command.includes('--wait')) {
      loginCalls.push(args)
      return reply(expireEnvelope)
    }
    if (command.includes(' login ')) {
      loginCalls.push(args)
      const link = links[loginIndex] ?? links[0]!
      const code = loginIndex === 0 ? 'dc-1' : 'dc-2'
      loginIndex += 1
      return reply({
        stdout: JSON.stringify({
          status: 'ok',
          data: {
            status: 'authorization_required',
            challenge: { deviceCode: code, verificationUri: link },
            nextCommand: `"${NOVEL}" login --wait --device-code ${code}`,
          },
        }),
      })
    }
    return reply({})
  }
  const jimeng = createJimengService({
    run,
    locate: () => ({ novel: NOVEL }),
    outDir: OUT_DIR,
    log: () => undefined,
    platform: 'win32',
  })
  const first = await jimeng.preflight!({})
  assert.equal(first.ok, false)
  assert.match(String(first.message), /code=OLD/)

  const second = await jimeng.preflight!({})
  assert.equal(second.ok, false)
  assert.match(String(second.message), /code=NEW/, '必须给新链接')
  assert.equal(/code=OLD/.test(String(second.message)), false, '不能再复述死链接')
  const restartCall = loginCalls.find((args) => args.includes('--restart'))
  assert.ok(restartCall, '过期后必须用 --restart 重新发起')
  assert.equal(restartCall?.includes('--non-interactive'), true)
})

// ---------------------------------------------------------------------------
// 产品改名：大肥鱼-鲸鱼做梦 —— 只改人看到的名字，契约不许动
// ---------------------------------------------------------------------------

test('展示名：guidance / SKILL 是「大肥鱼-鲸鱼做梦」，两条通道名都在', async () => {
  const { xyqGuidance } = await import('../src/xyq/guidance.js')
  const guidance = xyqGuidance('explicit')
  assert.match(guidance, /大肥鱼-鲸鱼做梦/)
  assert.match(guidance, /小云雀（xyq）/)
  assert.match(guidance, /即梦（jimeng）/)
  assert.equal(/大肥鱼-小云雀/.test(guidance), false, '旧名不许残留')
  assert.match(guidance, /npx @pippit-dev\/cli@latest install/, '云雀安装口令要在文案里')
  assert.match(guidance, /install\.ps1/, '即梦安装口令要在文案里')

  const skill = readFileSync(path.join('assets', 'skills', 'dafeiyu-xyq', 'SKILL.md'), 'utf8')
  assert.match(skill, /^# 大肥鱼-鲸鱼做梦/m)
  assert.match(skill, /npx @pippit-dev\/cli@latest install/)
  assert.match(skill, /login --non-interactive/)
})

test('展示名：包名 / 工具名 / 通道 id / 存储路径 一律没变（只改人看到的名字）', async () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, unknown>
  assert.equal(pkg.name, 'dsh-vision-dafeiyu', '包名是契约，不许动')
  const { XYQ_CHANNEL_IDS } = await import('../src/xyq/channel.js')
  assert.deepEqual([...XYQ_CHANNEL_IDS], ['xyq', 'jimeng'], '通道 id 是契约')
  const { xyqTools } = await import('../src/xyq/tools.js')
  const names = (xyqTools({} as never) as Array<Record<string, unknown>>).map((tool) => tool.name)
  for (const expected of ['generate_image', 'generate_video', 'xyq_balance', 'xyq_models', 'xyq_guide']) {
    assert.ok(names.includes(expected), `工具名 ${expected} 必须还在（${names.join(',')}）`)
  }
  const { resolveXyqConfigFile } = await import('../src/xyq/config.js')
  assert.match(resolveXyqConfigFile('/tmp/dsh-home'), /storages[\\/]dsh-remote-dafeiyu[\\/]xyq\.json$/, '存储路径不许动')
})
