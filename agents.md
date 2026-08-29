# agents.md — 面向 AI / 开发者的项目说明

本文件面向后续接手本项目的人类开发者或 AI 代理，说明项目职责、架构约定、常用命令和注意事项。

## 项目定位

让用户在 `chat.deepseek.com` 页面上直接执行本机命令。核心是「浏览器扩展 UI + 本地命令服务器」两端，中间通过 `127.0.0.1:8765` 的 HTTP 接口通信。

## 关键约定与注意点

1. **通信链路**：content script → background (Service Worker) → localhost HTTP。
   - content script 直接 fetch localhost 会被页面 CORS 拦截，**必须**经 `background.js` 转发（依赖 `manifest.json` 的 `host_permissions`）。
   - 改动端口时，需**同时**修改：`server.py` 的 `--port` 默认值、`extension/content.js` 的 `SERVER_PORT`、`extension/background.js` 的 `DEFAULT_PORT`、README。
2. **样式隔离**：`style.css` 全部使用 `dslh` 前缀（含 HTML id 前缀 `dslh-*`），避免与 chat.deepseek.com 原有样式冲突。新增样式请沿用该前缀。
3. **执行与编码**：`server.py` 用 `subprocess.run(..., shell=True)` 执行命令，Windows 下走 `cmd.exe`，因此支持管道（`|`）、重定向等语法。命令输出以字节捕获，用 `smart_decode` 按「UTF-8 优先、失败回退 GBK/CP1252」智能解码，保证中文正常显示。若将来遇到某命令仍乱码，优先扩展该解码逻辑。
4. **只绑定本机**：服务器固定监听 `127.0.0.1`，勿改 host 到 `0.0.0.0`。该服务无鉴权且能执行任意命令，属高危能力。
5. **安全**：命令由用户手动输入执行。若后续要接入不可信来源的命令，必须先做白名单/沙箱。
6. **正文解析（`<command>` 提取）**：`content.js` 用 MutationObserver 监听新增的 `ds-message` 回复容器，排除思考容器后取正文，提取 `<command>...</command>` 填入输入框。思考容器按「内容特征」（textContent 以「已思考/深度思考」开头）定位，不依赖混淆 class——DeepSeek 改版时优先检查 `findMessageContainer` / `findThinkingContainer` 是否仍命中。
   - **坑（已实测）**：`<command>` 在 HTML 是空元素(void)，浏览器会把 `</command>` 结束标签丢弃。若 AI 把 `<command>` 写在普通段落 → 渲染成 `<command></command>` + 命令文本，正则失效且可能误吞大段文字。因此 `extractCommands` 用**双通道**：通道A 用 textContent 正则处理代码块里被转义成 `&lt;command&gt;` 的配对形式；通道B 用 `querySelectorAll('command')` 取空元素后文本节点的 raw 形式。
   - **再坑**：AI 会在正文里“提及 `<command>` 标签”一词（被转义成文本），与真正的 `<command>cmd</command>` 混在同一 textContent，导致正则从「提及处」一路吞到很远才出现的 `</command>`。修复：通道A 正则用 `[^<]{1,500}`（命令内容不含 `<`，遇下一个标签即停，避免跨标签吞段），并对「长度>120 且含中文」的内容判为解释文字丢弃——既容纳长代码型命令（`python -c "..."`），又排除中文解释误匹配。
   - **三坑**：AI 可能**漏写 `</command>` 闭合标签**（尤其深度思考模式），通道A 强制要求闭合会匹配不到导致「完全不填充」。新增**通道C**：对 `pre/code` 代码块内容忍未闭合的 `<command>`，取 `<command>` 之后到行尾/代码块结束的内容作为命令。
   - **四坑（重要）**：通道C 若无条件启用，会在 AI **流式中途**（命令还没写完）就提取不完整命令执行。因此 `extractCommands(bodyEl, allowUnclosed)` 的通道C 由 `allowUnclosed` 控制；`scanMessage` 先只提取**闭合**命令，若无闭合且存在未闭合 `<command>`，需**连续两轮文本稳定**（`dslhLastText`/`dslhStable`）确认 AI 已输出完成，才用通道C 兜底。
   - **生成锁（最可靠）**：`isDeepSeekGenerating()` 通过发送按钮 SVG path 判断是否在生成——空闲=向上箭头(`M8.3125 0.98`)，生成中=圆角方块停止(`M2 4.88C2 3.68`)。`scanMessage` 开头若检测到正在生成则**拒绝执行**。注意：按钮图标切换**不一定触发 Mutation**，因此锁内用 `setTimeout(…,1500)` **固定间隔轮询重试**（不能用 `scheduleScan`——它 clearTimeout 会无限推迟，导致生成结束后无新 Mutation 就永久不解析）。发送按钮 class 无法区分，只能看 SVG path。
7. **调试手段**：浏览器自动化中 `browser_evaluate` 的沙箱**不支持函数定义与循环**（for/filter/IIFE 均返回 undefined），只能写多语句 + 最后一个表达式 + XPath（`document.evaluate`）；且 script 参数可直接传中文。扒 DOM 时遵循此限制。
   - **"Extension context invalidated"**：开发中每次在扩展管理页点「重新加载」后，已打开的 DeepSeek 页面上残留的旧 content script 的 `chrome.runtime` 上下文会失效，再调用就抛此未捕获异常。这是正常现象，**刷新页面即可**。代码侧已用 `sendToBackground` 统一包装所有 `chrome.runtime.sendMessage`，捕获该异常并返回友好提示（"扩展已更新，请刷新本页后重试"），避免刷屏报错。以后新增任何 `chrome.runtime` 调用都应走 `sendToBackground`。
8. **结果回填与清空**：`sendCommand` 每次执行前调用 `clearOutput()` 清空结果框；执行完成后再调用 `fillDeepSeekInput(formatResult(...))` 把结果写入 DeepSeek 输入框。DeepSeek 输入框是 `textarea`（placeholder 含「发送消息」），由 `findDeepSeekInput` 定位，填充用原生 value setter + input 事件以兼容 React 受控组件。
9. **全自动模式**：**自动执行始终开启**——`fillInput` 填充命令后无条件 `setTimeout(sendCommand,50)` 执行。是否自动发送由面板「自动发送延迟(秒)」（`#dslh-delay`）决定：`getAutoDelay()` 留空/非法/负值返回 `null`（自动执行但**不自动发送**，只填入 DeepSeek 输入框），填数字则 `sendCommand` 回调里 `setTimeout(()=>clickDeepSeekSend(), delay*1000)` 延迟后自动发送。DeepSeek 发送按钮是 `[role="button"].ds-button--primary`（输入为空时带 `ds-button--disabled`），由 `findDeepSeekSendButton` / `clickDeepSeekSend` 定位点击。
10. **提示词按钮**：面板「提示词」按钮（`#dslh-prompt`）点击后 `fillDeepSeekInput(AI_PROMPT)` 把协作协议提示词填入 DeepSeek 输入框。`AI_PROMPT` 常量内嵌在 `content.js` 顶部，**需与 `prompts/ai协作协议.md` 内容保持一致**——改提示词时两处都要同步。
11. **思考内容误抓（重要）**：AI 回复是流式的，思考内容常含 `<command>`。**方案**：`scheduleScan` 用**防抖**（每次变化重置计时，等消息「停止变化 1.2s」后才扫），此时消息已稳定、思考容器可定位，`cloneBody` 正常排除思考再提取正文。注意：曾加过「`scanMessage` 里 `hasThinkingText && !findThinkingContainer` 则跳过」的逻辑，但它在思考容器定位不到（DeepSeek 结构变化）时会**永久跳过导致完全不解析**，已移除——防抖已能避免流式中间态误抓，靠 `findThinkingContainer` 能否定位来决定是否跳过过于脆弱。
12. **用户消息过滤**：只解析 AI 回复，不解析用户消息。`isAssistantMessage(msg)` 判断：AI 回复的 `ds-message` class 以 `ds-message` 开头，用户消息 class 带 hash 前缀（如 `d29f3d7d`）；兜底是含思考标题的必为 AI。`installWatcher` 里只对 AI 消息 `scheduleScan`。
13. **命令字符归一化**：LLM 常输出 Unicode 数学/全角符号（− U+2212、∗ U+2217、′ 全角引号等），cmd/PowerShell 无法识别导致执行失败（如 `Get−WmiObject`）。`normalizeCommand(s)` 把这些符号统一转成 ASCII（−→-、∗→*、全角引号/括号→半角等），在 `extractCommands` 的 `add()` 和 `sendCommand` 入口都调用。若遇到新的执行失败，优先检查 AI 命令里是否有未覆盖的 Unicode 符号，往 `normalizeCommand` 的 map 里补。
14. **`$` 被公式渲染破坏（重要，已采用方案A解决）**：DeepSeek 页面支持数学公式渲染（`$...$`），**普通段落**里的 `$` 会被当公式边界解析，导致 `$d` 变 `d`、空格丢失、命令错乱（信息在渲染层已丢失）。**规避方案**：协作协议要求 AI 把 `<command>...</command>` 放在 **command 代码块**里（```` ```command ... ``` ````）。代码块是字面输出、不做公式渲染，`$` 完整保留。扩展提取逻辑**无需改动**——`extractCommands` 通道A 用 `textContent` 正则，天然兼容代码块内文本（代码块里的 `<command>` 被转义成 `&lt;command&gt;`，textContent 还原后正常匹配）。若未来仍需在普通段落拿 `$` 原文，只能走「注入 MAIN world 拦截流式响应」方案B（更复杂，暂未实现）。

## 常用命令

```bash
# 启动本地服务器
cd local_server && python server.py            # 127.0.0.1:8765

# 手动测试接口
Invoke-RestMethod http://127.0.0.1:8765/health
Invoke-RestMethod http://127.0.0.1:8765/exec -Method Post -ContentType 'application/json' -Body '{"command":"dir"}'
```

## 测试策略

- **本地服务器**：`/health` 与 `/exec` 可直接用 `Invoke-RestMethod` 验证。
- **扩展**：需人工加载到 Edge/Chrome（开发者模式 → 加载解压缩的扩展 → 选 `extension` 目录），打开 chat.deepseek.com 验证按钮、连通状态与命令回显。**本仓库不自动跑扩展端测试**。

## 维护原则

- 任何改动（代码、文档、配置）后同步更新 `README.md` 与 `agents.md`。
- 改动后提交 git，提交信息使用中文，说明改动动机。
