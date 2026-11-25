/**
 * rooms.test — 拆包后**房间注册**的三条判据（这一轮新补的）。
 *
 * 为什么这三条必须单独钉：拆包最容易失败的地方不是路由（那三条/八条路由有本体
 * `tests/vision.test.ts`、`tests/xyq.test.ts` 同款判据盯着），而是**浏览器半有没有
 * 真的向宿主领房**。它坏了的表现极其安静：文件都在、页面不报错、就是设置页里没有
 * 那两个 tab。所以：
 *
 * 1. **两间房都注册了，id/label/order 都对** —— 名字写错就是"静默不挂载"；
 * 2. **拿不到宿主注册表时不抛、不刷 error** —— 宿主版本旧是常态，不是故障；
 * 3. **切走 tab 时清理函数真的被调用** —— 验收原话是"切走 tab 后定时器归零"，
 *    这里钉的是它的必要条件：`mount` 返回的那个清理函数被调过、且**只调一次**。
 *
 * 跑法：esbuild 把**真实源码** `src/client/rooms.ts` 打成一份自包含脚本，丢进
 * `node:vm` 的假环境里跑（与形象包 `tests/widget.test.ts` 同一套做法）：
 * 测的是会被装进 `client.cjs` 的那份代码，而不是它的复制品。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOMS_SOURCE = fileURLToPath(new URL('../../src/client/rooms.ts', import.meta.url))

interface RoomsModule {
  ROOM_DEFINITIONS: Array<{ id: string; label: string; order: number }>
  waitForRooms: (ms?: number) => Promise<unknown>
  registerRooms: (host: unknown, renderers: Record<string, (container: unknown) => unknown>) => { stop: () => void }
  registerDafeiyuRooms: (renderers: Record<string, (container: unknown) => unknown>, ms?: number) => Promise<unknown>
}

/** 把 rooms.ts 打成一份 iife，在给定的沙箱里求值，取回它的导出。 */
async function loadRooms(sandbox: Record<string, unknown>): Promise<RoomsModule> {
  const esbuild = (await import('esbuild')) as {
    build: (options: Record<string, unknown>) => Promise<{ outputFiles?: Array<{ text: string }> }>
  }
  const built = await esbuild.build({
    entryPoints: [ROOMS_SOURCE],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'RoomsUnderTest',
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  const source = built.outputFiles?.[0]?.text ?? ''
  assert.ok(source.length > 500, 'esbuild 没产出房间脚本（entry 或依赖解析出问题了）')

  const context = vm.createContext(sandbox)
  new vm.Script(source, { filename: 'rooms-under-test.js' }).runInContext(context)
  return (context as unknown as { RoomsUnderTest: RoomsModule }).RoomsUnderTest
}

/** 一个只记账的假注册表（形状照本体 `client/rooms.ts` 的 `RoomHost`）。 */
function fakeHost(): {
  host: { register: (room: unknown) => () => void }
  rooms: Array<{ id: string; label: string; order?: number; mount: (container: unknown) => unknown }>
  unregistered: string[]
} {
  const rooms: Array<{ id: string; label: string; order?: number; mount: (container: unknown) => unknown }> = []
  const unregistered: string[] = []
  return {
    host: {
      register(room: unknown) {
        const typed = room as (typeof rooms)[number]
        rooms.push(typed)
        return () => {
          unregistered.push(typed.id)
        }
      },
    },
    rooms,
    unregistered,
  }
}

test('房间：两间都注册了（id / label / order 与本体分栏定稿一致）', async () => {
  const roomsModule = await loadRooms({ console })
  const { host, rooms } = fakeHost()
  const handle = roomsModule.registerRooms(host, {
    vision: () => undefined,
    xyq: () => undefined,
  })

  assert.equal(rooms.length, 2, '两间房都要登记（少一间 = 设置页少一个 tab）')
  const vision = rooms.find((room) => room.id === 'vision')
  const xyq = rooms.find((room) => room.id === 'xyq')
  assert.ok(vision, '缺 id=vision 的房（「肥鱼识图」）')
  assert.ok(xyq, '缺 id=xyq 的房（「鲸鱼做梦」）')
  assert.equal(vision!.label, '肥鱼识图', 'tab 上的字必须是「肥鱼识图」')
  assert.equal(xyq!.label, '鲸鱼做梦', 'tab 上的字必须是「鲸鱼做梦」（product 名改了，id 仍是 xyq）')
  assert.equal(vision!.order, 40)
  assert.equal(xyq!.order, 50)
  assert.equal(typeof vision!.mount, 'function')
  assert.equal(typeof xyq!.mount, 'function')

  // 注销：两间都要撤（插件卸载 / HMR 重载时走这条路）
  handle.stop()
  assert.deepEqual([...roomsModule.ROOM_DEFINITIONS.map((room) => room.id)].sort(), ['vision', 'xyq'])
})

test('房间：宿主没有注册表时静默放弃——不抛、不 console.error', async () => {
  const errors: unknown[] = []
  const warns: unknown[] = []
  // 沙箱里**故意不给** `__dafeiyuRooms`，也不给 addEventListener（模拟"宿主版本旧"）。
  const roomsModule = await loadRooms({
    console: {
      error: (...args: unknown[]) => errors.push(args),
      warn: (...args: unknown[]) => warns.push(args),
      log: () => undefined,
    },
    setTimeout,
    clearTimeout,
  })

  // ① waitForRooms 超时后返回 undefined，而不是抛
  const waited = await roomsModule.waitForRooms(20)
  assert.equal(waited, undefined, '拿不到宿主时要返回 undefined')

  // ② registerDafeiyuRooms 整条路也不抛
  const handle = await roomsModule.registerDafeiyuRooms({ vision: () => undefined, xyq: () => undefined }, 20)
  assert.equal(handle, undefined, '没有宿主时不该假装登记成功')

  assert.deepEqual(errors, [], '降级不是故障：一条 console.error 都不许有')
  assert.deepEqual(warns, [], '连 warn 也不该刷（宿主版本旧是常态）')
})

test('房间：切走 tab 时 mount 的清理函数被调用，且只调一次', async () => {
  const roomsModule = await loadRooms({ console })
  const { host, rooms } = fakeHost()

  const mounted: string[] = []
  const disposed: string[] = []
  const containers: unknown[] = []
  const handle = roomsModule.registerRooms(host, {
    vision: (container) => {
      mounted.push('vision')
      containers.push(container)
      return () => disposed.push('vision')
    },
    xyq: (container) => {
      mounted.push('xyq')
      containers.push(container)
      return () => disposed.push('xyq')
    },
  })

  const visionRoom = rooms.find((room) => room.id === 'vision')!
  // 宿主建 tab 时给的是一个普通 DOM 容器；这里给一个最小的假节点即可（房间只往下传）。
  const container = { appendChild: () => undefined }
  const cleanup = visionRoom.mount(container) as (() => void) | undefined
  assert.deepEqual(mounted, ['vision'], 'mount 必须被调用到（不然 tab 是空白格）')
  assert.equal(containers[0], container, '宿主给的容器要原样交给那一栏')
  assert.equal(typeof cleanup, 'function', 'mount 必须返回清理函数（宿主切走 tab 时调它）')

  // 模拟"切走 tab"：宿主调那一个清理函数，且**调两次也只生效一次**。
  cleanup!()
  cleanup!()
  assert.deepEqual(disposed, ['vision'], '清理函数要被调用，且幂等（重复调用不许重复释放）')

  // 再挂一次（切回来）仍然可用：新树、新清理函数。
  const again = visionRoom.mount(container) as (() => void) | undefined
  assert.equal(typeof again, 'function')
  again!()
  assert.deepEqual(mounted, ['vision', 'vision'])
  assert.deepEqual(disposed, ['vision', 'vision'])

  handle.stop()
})
