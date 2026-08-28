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
6. **正文解析（`<command>` 提取）**：`content.js` 用 MutationObserver 监听新增的 `ds-message` 回复容器，排除思考容器后取正文，正则提取 `<command>...</command>` 填入输入框。思考容器按「内容特征」（textContent 以「已思考/深度思考」开头）定位，不依赖混淆 class——DeepSeek 改版时优先检查 `findMessageContainer` / `findThinkingContainer` 这两个函数是否仍命中。
7. **调试手段**：浏览器自动化中 `browser_evaluate` 的沙箱**不支持函数定义与循环**（for/filter/IIFE 均返回 undefined），只能写多语句 + 最后一个表达式 + XPath（`document.evaluate`）；且 script 参数可直接传中文。扒 DOM 时遵循此限制。
8. **结果回填与清空**：`sendCommand` 每次执行前调用 `clearOutput()` 清空结果框；执行完成后再调用 `fillDeepSeekInput(formatResult(...))` 把结果写入 DeepSeek 输入框。DeepSeek 输入框是 `textarea`（placeholder 含「发送消息」），由 `findDeepSeekInput` 定位，填充用原生 value setter + input 事件以兼容 React 受控组件。

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
