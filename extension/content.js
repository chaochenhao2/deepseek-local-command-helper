// DeepSeek 本地命令助手 - 内容脚本
// 检测当前网址是否为 chat.deepseek.com，若是则在右上角注入按钮和面板。
// 面板包含：输入框、发送按钮、显示框。
// 命令经 background (service worker) 转发到本地服务器执行。

(function () {
  "use strict";

  const HOST = window.location.hostname.toLowerCase();

  // 仅在 chat.deepseek.com 生效
  if (
    HOST !== "chat.deepseek.com" &&
    HOST !== "www.chat.deepseek.com" &&
    !HOST.endsWith(".chat.deepseek.com")
  ) {
    return;
  }

  // 防止重复注入
  if (document.getElementById("ds-local-helper-root")) {
    return;
  }

  const SERVER_PORT = 8765; // 与本地 server.py 端口一致

  // ---------------- 创建 UI ----------------
  function buildUI() {
    const root = document.createElement("div");
    root.id = "ds-local-helper-root";
    root.innerHTML = `
      <button id="dslh-toggle" title="本地命令助手" type="button">
        <span class="dslh-dot"></span>CMD
      </button>
      <div id="dslh-panel" class="dslh-hidden">
        <div class="dslh-header">
          <span>本地命令助手</span>
          <span class="dslh-status" id="dslh-status">● 未连接</span>
          <button id="dslh-close" type="button" title="关闭">×</button>
        </div>
        <textarea id="dslh-input" placeholder="输入 shell 命令，例如：dir&#10;或 python -c \"print(1+1)\"&#10;回车发送，Shift+回车换行"></textarea>
        <div class="dslh-actions">
          <button id="dslh-send" type="button">发送</button>
        </div>
        <pre id="dslh-output" class="dslh-output"><span class="dslh-placeholder">命令执行结果将显示在这里…</span></pre>
      </div>
    `;
    document.documentElement.appendChild(root);
    return root;
  }

  const root = buildUI();
  const toggleBtn = root.querySelector("#dslh-toggle");
  const panel = root.querySelector("#dslh-panel");
  const closeBtn = root.querySelector("#dslh-close");
  const input = root.querySelector("#dslh-input");
  const sendBtn = root.querySelector("#dslh-send");
  const output = root.querySelector("#dslh-output");
  const statusEl = root.querySelector("#dslh-status");

  // ---------------- 状态 ----------------
  function setStatus(text, online) {
    statusEl.textContent = text;
    statusEl.classList.toggle("dslh-online", !!online);
  }

  function appendOutput(text, cls) {
    // 移除占位符
    const placeholder = output.querySelector(".dslh-placeholder");
    if (placeholder) placeholder.remove();
    const line = document.createElement("div");
    line.className = "dslh-line " + (cls || "");
    line.textContent = text;
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
  }

  function clearOutput() {
    output.innerHTML =
      '<span class="dslh-placeholder">命令执行结果将显示在这里…</span>';
  }

  // ---------------- 健康检查（页面加载时探测一次） ----------------
  function checkHealth() {
    chrome.runtime.sendMessage(
      { type: "exec", command: "echo __pong__", port: SERVER_PORT, timeout: 5 },
      (resp) => {
        if (chrome.runtime.lastError) {
          setStatus("● 未连接", false);
          return;
        }
        if (resp && resp.ok) {
          setStatus("● 已连接", true);
        } else {
          setStatus("● 未连接", false);
        }
      }
    );
  }

  // ---------------- 发送命令 ----------------
  function sendCommand() {
    const command = input.value.trim();
    if (!command) return;

    appendOutput("> " + command, "dslh-cmd");
    input.value = "";
    sendBtn.disabled = true;
    sendBtn.textContent = "执行中…";

    chrome.runtime.sendMessage(
      { type: "exec", command: command, port: SERVER_PORT, timeout: 60 },
      (resp) => {
        sendBtn.disabled = false;
        sendBtn.textContent = "发送";

        if (chrome.runtime.lastError) {
          appendOutput("扩展错误: " + chrome.runtime.lastError.message, "dslh-err");
          return;
        }
        if (!resp || !resp.ok) {
          appendOutput((resp && resp.error) || "未知错误", "dslh-err");
          setStatus("● 未连接", false);
          return;
        }

        const d = resp.data;
        if (d.error) {
          appendOutput("执行异常: " + d.error, "dslh-err");
        } else {
          const out = (d.stdout || "").trim();
          const err = (d.stderr || "").trim();
          if (out) appendOutput(out, "dslh-out");
          if (err) appendOutput(err, "dslh-err");
          if (!out && !err) appendOutput("(无输出)", "dslh-dim");
          appendOutput(
            `[退出码 ${d.returncode} · 耗时 ${d.elapsed}s]`,
            "dslh-dim"
          );
        }
      }
    );
  }

  // ---------------- 事件绑定 ----------------
  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const hidden = panel.classList.toggle("dslh-hidden");
    toggleBtn.classList.toggle("dslh-active", !hidden);
  });

  closeBtn.addEventListener("click", () => {
    panel.classList.add("dslh-hidden");
    toggleBtn.classList.remove("dslh-active");
  });

  sendBtn.addEventListener("click", sendCommand);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCommand();
    }
  });

  // ---------------- 解析 DeepSeek 返回内容，提取 <command> 填充输入框 ----------------
  // 结构（实测 chat.deepseek.com）：
  //   ds-message 容器（class 含 "ds-message"）= 一条 AI 回复
  //   其内思考容器：以「已思考 / 深度思考」文本开头、位于消息容器内的最外层块
  //   正文 = 消息容器去掉思考容器后的内容
  // 说明：思考容器按「内容特征」定位，不依赖具体混淆 class，便于 DeepSeek 改版后仍可用。

  // 从某节点向上找 ds-message 容器
  function findMessageContainer(node) {
    let el = node;
    while (el && el !== document.body) {
      const cls = typeof el.className === "string" ? el.className : "";
      if (cls.split(/\s+/).indexOf("ds-message") >= 0) return el;
      el = el.parentElement;
    }
    return null;
  }

  // 在消息容器内找到「已思考 / 深度思考」标题元素
  function findTitleEl(msgEl) {
    const walker = document.createTreeWalker(
      msgEl,
      NodeFilter.SHOW_TEXT,
      null
    );
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent || "";
      if (t.indexOf("已思考") >= 0 || t.indexOf("深度思考") >= 0) {
        return n.parentElement;
      }
    }
    return null;
  }

  // 定位思考容器：标题向上，取「textContent 以思考标题开头」且位于消息容器内的最外层容器
  function findThinkingContainer(msgEl) {
    const titleEl = findTitleEl(msgEl);
    if (!titleEl) return null;
    let el = titleEl.parentElement;
    let candidate = null;
    while (el && el !== msgEl) {
      const t = (el.textContent || "").trim();
      if (
        t.startsWith("已思考") ||
        t.startsWith("深度思考") ||
        t.startsWith("已深度思考")
      ) {
        candidate = el;
      }
      el = el.parentElement;
    }
    return candidate;
  }

  // 提取正文 HTML（排除思考容器）
  function extractBody(msgEl) {
    const clone = msgEl.cloneNode(true);
    const think = findThinkingContainer(clone);
    if (think) think.remove();
    return clone.innerHTML || "";
  }

  // 从正文 HTML 解析出所有 <command>...</command>（先做 HTML 反转义，兼容被转义成文本的情况）
  function parseCommands(bodyHTML) {
    const html = bodyHTML
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const cmds = [];
    const re = /<command>([\s\S]*?)<\/command>/gi;
    let m;
    while ((m = re.exec(html))) {
      // 去掉 command 内部可能残留的 HTML 标签，取纯文本
      const clean = m[1].replace(/<[^>]*>/g, "").trim();
      if (clean) cmds.push(clean);
    }
    return cmds;
  }

  // 填充输入框（兼容 React 受控 textarea）
  function fillInput(text) {
    if (input.value === text) return;
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(input, text);
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // 自动打开面板，方便用户看到已填充内容
    panel.classList.remove("dslh-hidden");
    toggleBtn.classList.add("dslh-active");
    appendOutput("检测到 <command>，已自动填入命令: " + text, "dslh-cmd");
  }

  // 扫描单条消息：提取正文 -> 解析 command -> 填充
  function scanMessage(msg) {
    if (msg.nodeType !== Node.ELEMENT_NODE) return;
    const body = extractBody(msg);
    const cmds = parseCommands(body);
    if (cmds.length) {
      fillInput(cmds[cmds.length - 1]); // 取最后一条（流式输出时最新完整的一条）
    }
  }

  // 节流扫描：流式输出会多次触发 Mutation，合并到一次 setTimeout 里统一处理
  const scanQueue = new Set();
  let scanTimer = null;
  function scheduleScan(msg) {
    scanQueue.add(msg);
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const list = Array.from(scanQueue);
      scanQueue.clear();
      for (const m of list) {
        if (m.isConnected) scanMessage(m);
      }
    }, 600);
  }

  // 监听页面 DOM 变化，发现新增的 ds-message 回复即扫描
  function installWatcher() {
    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const msg = findMessageContainer(node);
          if (msg) scheduleScan(msg);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  installWatcher();

  checkHealth();
})();
