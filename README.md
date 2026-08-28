# DeepSeek 本地命令助手

在 **chat.deepseek.com** 页面右上角注入一个「本地命令助手」面板：输入 shell 命令，发送给本机的 Python 服务器执行，并把执行结果展示在面板里。

## 架构

```
chat.deepseek.com 页面
        │
        │ content.js 注入按钮 + 面板（输入框 / 发送 / 显示框）
        ▼
  chrome.runtime.sendMessage
        │
        ▼
  background.js (Service Worker)
        │  通过 host_permissions 绕过 CORS
        ▼   POST http://127.0.0.1:8765/exec
  local_server/server.py (Python HTTP 服务器)
        │  subprocess 执行 shell 命令（cmd.exe）
        ▼
  结果 stdout / stderr / returncode / elapsed 原路返回，面板展示
```

为什么命令要经过 background 转发：content script 直接 fetch localhost 会被页面 CORS 拦截，而 Service Worker 在 `host_permissions` 声明后可正常访问本地服务器。

## 目录结构

```
.
├── extension/                 # 浏览器扩展（Manifest V3）
│   ├── manifest.json          # 配置：content_scripts + host_permissions + background
│   ├── background.js          # Service Worker，转发命令到本地服务器
│   ├── content.js             # 检测 chat.deepseek.com 并注入按钮/面板
│   └── style.css              # 注入样式（dslh 前缀，避免冲突）
└── local_server/
    └── server.py              # Python HTTP 服务器：/health、/exec
```

## 使用步骤

### 1. 启动本地服务器

```bash
cd local_server
python server.py                # 默认 127.0.0.1:8765
```

可选参数：`python server.py --port 9000`（改端口时需同步修改 `extension/content.js` 里的 `SERVER_PORT`）。

### 2. 加载扩展（以 Edge / Chrome 为例）

1. 打开浏览器扩展管理页（Edge：`edge://extensions`，Chrome：`chrome://extensions`）。
2. 打开右上角「开发人员模式」。
3. 点击「加载解压缩的扩展」，选择本项目的 `extension` 文件夹。

### 3. 使用

1. 访问 `https://chat.deepseek.com`。
2. 右上角出现 **CMD** 按钮，面板显示「● 已连接」即表示与本地服务器连通。
3. 点击 CMD 打开面板，输入命令（如 `dir` 或 `python -c "print(1+1)"`），回车或点「发送」。
4. 执行结果（标准输出、错误、退出码、耗时）显示在下方显示框。

快捷键：`Enter` 发送，`Shift+Enter` 换行。

### 自动解析 `<command>` 命令

扩展会**实时监听** DeepSeek 页面新增的 AI 回复（自动排除「已思考 / 深度思考」部分，只取正文）：

- 若正文里出现 `<command>xxxxxx</command>`，扩展会**自动把其中的命令填入输入框**，并自动打开面板。
- 适用于让 DeepSeek 输出命令、再由你一键发送到本地执行的场景。
- 多个 `<command>` 时取最后一个；流式输出过程中会持续更新到完整内容。
- 思考内容（含搜索过程）不会进入解析范围。

> 说明：正文解析基于内容特征（思考区域以「已思考/深度思考」开头）定位，不依赖 DeepSeek 的混淆 class，改版后通常仍可正常工作。

## 接口说明

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET  | `/health` | 健康检查，返回 `{"status":"ok"}` |
| POST | `/exec`   | body `{"command":"...", "timeout":60}`，返回 `{ok, stdout, stderr, returncode, elapsed}` |

## 安全提示

- 服务器默认只绑定 `127.0.0.1`，仅本机可访问，**请勿**修改 host 暴露到公网。
- 该工具可执行**任意 shell 命令**，属于高危能力，仅在可信的本机环境使用，注意输入来源安全。
- 服务器默认无鉴权，任何本机进程都能调用它执行命令，请妥善保管运行环境。
