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

  checkHealth();
})();
