# 网页版识图（免 key）是怎么跑起来的

## 为什么必须"登录一次"

实测（2026-11-17）：豆包与 Gemini 的网页版**都没有匿名看图通道**——

| 站点 | 上传入口 | 未登录表现 |
|---|---|---|
| 豆包 | `[data-testid="upload_file_button"]` 点开后才出现隐藏 `input[type=file]` | 发送后被踢回 `?from_logout=1`，对话清空 |
| Gemini | `button[aria-label="上传和工具"]` → 菜单 → `input[accept*="image/"]` | 图片卡在「正在上传图片：50%」 |

所以：用户在设置页点「登录 豆包」→ 宿主弹**有头**浏览器 → 用户登一次 →
cookie 落在本机 profile 里 → 之后所有识图走**无头**复用这份 profile。

## profile 在哪

```
<DSH_HOME>/storages/dsh-remote-dafeiyu/webvision/doubao/
<DSH_HOME>/storages/dsh-remote-dafeiyu/webvision/gemini/
```

与 `vision.json` 同域；卸载插件不删。清除登录态 = 删对应目录。

## 一次识图的流程

```
起 Edge（持久 profile + CDP）→ 进首页 → 校验登录
  →（可选）点输入框的「项目」chip 选项目
  → 清空输入框 → 点上传 → DOM.setFileInputFiles 塞图 → 等附件落地
  → execCommand('insertText') 打字 → 点「发送」（或回车）
  → 轮询：回答文本连续 1.2 秒不变 + 没有"停止生成"按钮 = 答完
```

完成判定不看固定时长；超时返回已生成部分并标注截断。

## 几个反直觉的地方（踩过）

1. **打字不能用 CDP 的 `Input.insertText`**：字符进去了但 Quill 的内部模型没更新，
   发送按钮逻辑上仍是空 → 点了没反应。用 `document.execCommand('insertText')`。
2. **清空输入框必须在塞图之前**：Gemini 的附件挂在 `rich-textarea` 里，清空会把图一起删掉。
3. **无头 UA 带 `HeadlessChrome/` 会被豆包风控**：一次发图就把登录态作废（cookie 还在磁盘上）。
   驱动连上 CDP 后会立刻把 UA 换成正常 Chrome。
4. **关浏览器必须优雅**（`Browser.close`），强杀会丢掉刚落的 login cookie。
5. **只点真鼠标**：`el.click()` 点不动 Gemini 的发送按钮和豆包的「项目」chip，
   要用 `Input.dispatchMouseEvent`。

## 项目（豆包专有）

配置 `webProject` 填项目名 → 每次识图的会话自动归到该项目下，不污染「最近」。
点 chip → 弹层选同名项（同名元素有多处，取最靠下的那个）→ 校验 chip 变成项目名。
Gemini 没有项目能力，配了会被忽略。
