/**
 * client/react —— 向**装载器**要 React（`createElement` / hooks / `createRoot`）。
 *
 * ## 为什么不能 `import react`
 *
 * 浏览器半产物的外壳是 `window.__ModuleLoader__.load({ id, factory: (require) => {…} })`
 * （见 `.bin-build.mjs`）：`factory` 的参数 `require` 才是页面的模块表。
 * 写成字面量 `import … from 'react'` 会被打包器在**构建期**解析成 factory 顶部的一句静态
 * require——宿主一旦给不出这个模块，抛出发生在 factory 第一行，表现是
 * `web boot: N entry/entries did not activate`，**整页都起不来**（本体 `pill.ts:813-833`
 * 记着这条事故）。所以模块名走**变量**、留在运行期，被这里的 try 接住。
 *
 * ## 三个模组名都是宿主 page 的 platform seed
 *
 * `react` / `react-dom` / `react-dom/client` 由 `@deepseek-ai/dsh-client-web` 的
 * `staticModules`（platform seed）提供，与官方客户端插件用的是**同一份实例**——
 * 这很关键：hooks 必须与 `createElement` 同源，否则 React 会报
 * "Invalid hook call / dispatcher is null"。
 */
declare const require: ((id: string) => unknown) | undefined

export type CreateElement = (type: unknown, props: Record<string, unknown>) => unknown

export interface ReactHooks {
  useState?: <S>(initial: S) => [S, (next: S) => void]
  useEffect?: (effect: () => void | (() => void), deps?: unknown[]) => void
}

export interface ReactRoot {
  render: (node: unknown) => void
  unmount: () => void
}

export interface ReactRuntime {
  createElement: CreateElement
  hooks: ReactHooks
  createRoot: (container: unknown) => ReactRoot
}

/** 只在运行期解析（`spec` 是变量 ⇒ 打包器不会在构建期把它当静态依赖）。 */
function fromLoader(spec: string): unknown {
  try {
    if (typeof require !== 'function') return undefined
    const id = spec
    return require(id)
  } catch {
    return undefined
  }
}

/**
 * 取整套 React 能力。缺任何一块都返回 `undefined`（调用方画一行中文降级说明，
 * 不许抛、不许让整页起不来）。
 */
export function loadReact(): ReactRuntime | undefined {
  const react = fromLoader('react') as
    | { createElement?: CreateElement; useState?: unknown; useEffect?: unknown; default?: Record<string, unknown> }
    | undefined
  const createElement = react?.createElement ?? (react?.default?.createElement as CreateElement | undefined)
  if (typeof createElement !== 'function') return undefined
  const domClient = fromLoader('react-dom/client') as
    | { createRoot?: (container: unknown) => ReactRoot; default?: { createRoot?: (container: unknown) => ReactRoot } }
    | undefined
  const createRoot = domClient?.createRoot ?? domClient?.default?.createRoot
  if (typeof createRoot !== 'function') return undefined
  return {
    createElement,
    hooks: {
      ...(typeof react?.useState === 'function' ? { useState: react.useState as ReactHooks['useState'] } : {}),
      ...(typeof react?.useEffect === 'function' ? { useEffect: react.useEffect as ReactHooks['useEffect'] } : {}),
    },
    createRoot,
  }
}

/**
 * 把一棵组件树挂进一个**普通 DOM 容器**（房间契约给的就是 HTMLElement）。
 *
 * 返回的清理函数做两件事：`root.unmount()` + 清空容器子节点。
 * 前者把 hooks 状态、副作用、我们自己起的定时器一起撤掉（这就是验收里
 * "切走 tab 后定时器归零"靠的东西），后者防止卸载后的残影留在那一格里。
 */
export function mountReactTree(
  runtime: ReactRuntime,
  container: unknown,
  component: unknown,
  fallbackText: string,
): () => void {
  if (component === undefined) {
    // 与本体 `dafeiyu-page.ts:300-308` 的降级行同一句话（宿主没给 hooks 时）。
    writeFallback(container, fallbackText)
    return () => {
      clearContainer(container)
    }
  }
  const root = runtime.createRoot(container)
  root.render(runtime.createElement(component, {}))
  let done = false
  return () => {
    if (done) return
    done = true
    try {
      root.unmount()
    } catch {
      /* 清理不许抛（它跑在宿主的 switch tab 路径上） */
    }
    clearContainer(container)
  }
}

/**
 * 连 React 都拿不到时的降级：在那一格里写一句话，返回"清空那一格"的清理函数。
 * 表现与本体同款（`dafeiyu-page.ts` 的 `fallbackLine`）：不许留空白格、不许抛。
 */
export function fallbackOnly(container: unknown, text: string): () => void {
  writeFallback(container, text)
  return () => {
    clearContainer(container)
  }
}

function clearContainer(container: unknown): void {
  try {
    const node = container as { replaceChildren?: (...nodes: unknown[]) => void }
    if (typeof node.replaceChildren === 'function') node.replaceChildren()
  } catch {
    /* 容器可能已经被宿主摘掉 */
  }
}

function writeFallback(container: unknown, text: string): void {
  try {
    const node = container as { textContent?: unknown }
    node.textContent = text
  } catch {
    /* 同上 */
  }
}
