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

  // 「AI 协作协议」初始提示词（与 prompts/ai协作协议.md 保持一致）
  const AI_PROMPT = `【系统协作协议】

你在与我协作完成本地任务。有一套特殊机制：

1. 当你需要我在本地执行命令时，请把命令放进 <command> 标签里，并把整个 <command>...</command> 放在一个 command 代码块中（用三个反引号加 command 作为语言标记包裹），例如：

\`\`\`command
<command>这里写命令</command>
\`\`\`

必须用这种 command 代码块格式，不要写成普通段落——这样命令里的 $ 等符号不会被页面公式渲染破坏。

2. 标签内的内容会被我原样提取并作为 Shell 命令在本机自动执行（Windows/cmd 环境），执行结果会自动回传给你继续分析。如遇到权限不足的问题，可用sudo来提权（Windows最新版安装了sudo，可用于提权到管理员）。另外，我在 D:/CLIs 目录放了一些单文件的实用工具，需要时可以调用它们。

3. 为了确保解析准确，请遵守以下格式规范：
   - 一次**只输出一个 <command>**，不要并列多个，严禁同一次对话输出多个command框；
   - command 代码块内只放 <command>...</command>，命令前后不要夹杂解释文字；
   - 标签内只放纯命令本身，不要放解释、注释或多余符号；
   - 命令内只使用英文半角字符，禁止全角或数学符号（如 −、∗、′、”、（）、＆），必须用 ASCII 的 - * ' " & 等；
   - 命令内允许使用 $（放在 command 代码块内不会被公式渲染破坏），PowerShell 等含 $ 的命令可以直接写；
   - 需要执行较复杂的多行代码时，用一行命令的形式，例如：
\`\`\`command
<command>python -c "import urllib.request, json; print('ok')"</command>
\`\`\`
   - 如果你只是"提到"<command>这个标签（不是在让我执行命令），请不要使用成对的 <command>...</command> 格式，以免被误执行。

4. 安全提醒：
   - 只输出无害、明确的命令；
   - 涉及删除等危险操作前，先询问我；
   - 你每次对话都只能输出一对标签，如果需要多个命令，请等待下次对话

现在开始，请记住这套协议。如果我们接下来要协作，你可以在需要时输出 command 代码块。`;

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
        <div class="dslh-delay-row">
          <label for="dslh-delay" title="开启自动执行与自动发送；结果将在延迟秒数后自动发送给 DeepSeek（0 立即发送，留空关闭自动）">自动发送延迟(秒)</label>
          <input id="dslh-delay" type="number" min="0" max="60" step="1" placeholder="留空关闭" title="开启自动执行与自动发送；结果将在延迟秒数后自动发送给 DeepSeek（0 立即发送，留空关闭自动）">
        </div>
        <div class="dslh-actions">
          <button id="dslh-prompt" type="button" title="把「AI 协作协议」初始提示词填入 DeepSeek 输入框">提示词</button>
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
  const promptBtn = root.querySelector("#dslh-prompt");
  const delayInput = root.querySelector("#dslh-delay");
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

  // 安全发送消息到 background。
  // 扩展在开发中被「重新加载」后，旧页面上残留的 content script 的 chrome.runtime
  // 上下文会失效（报 "Extension context invalidated"）。这里统一捕获，避免未捕获异常，
  // 并返回友好错误提示用户刷新页面。
  function sendToBackground(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp);
        });
      } catch (e) {
        resolve({ ok: false, error: "扩展已更新，请刷新本页后重试" });
      }
    });
  }

  // ---------------- 健康检查（页面加载时探测一次） ----------------
  async function checkHealth() {
    const resp = await sendToBackground({
      type: "exec",
      command: "echo __pong__",
      port: SERVER_PORT,
      timeout: 5,
    });
    setStatus(resp && resp.ok ? "● 已连接" : "● 未连接", !!(resp && resp.ok));
  }

  // ---------------- 发送命令 ----------------
  async function sendCommand() {
    const command = normalizeCommand(input.value.trim()); // 归一化 Unicode 特殊符号
    if (!command) return;

    clearOutput(); // 每次执行命令前清空结果框
    appendOutput("> " + command, "dslh-cmd");
    input.value = "";
    sendBtn.disabled = true;
    sendBtn.textContent = "执行中…";

    const resp = await sendToBackground({
      type: "exec",
      command: command,
      port: SERVER_PORT,
      timeout: 60,
    });
    sendBtn.disabled = false;
    sendBtn.textContent = "发送";

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
    // 自动把命令执行结果填入 DeepSeek 输入框，方便继续让 DeepSeek 分析
    fillDeepSeekInput(formatResult(command, d));
    // 若启用了「自动发送延迟」，等待延迟秒数后点击 DeepSeek 发送按钮
    const autoDelay = getAutoDelay();
    if (autoDelay !== null) {
      appendOutput(`自动发送将于 ${autoDelay}s 后进行…`, "dslh-dim");
      setTimeout(() => {
        if (!clickDeepSeekSend()) {
          appendOutput("自动发送失败：未找到可用的发送按钮", "dslh-err");
        }
      }, autoDelay * 1000);
    }
  }

  // 读取「自动发送延迟」：返回秒数；留空/非法/负值返回 null（关闭自动）
  function getAutoDelay() {
    const v = delayInput ? delayInput.value : "";
    if (v === "" || v == null) return null;
    const n = Number(v);
    if (isNaN(n) || n < 0) return null;
    return n;
  }

  // 定位并点击 DeepSeek 页面的发送按钮（class 含 ds-button--primary 的 role=button）
  function findDeepSeekSendButton() {
    return document.querySelector('[role="button"].ds-button--primary');
  }
  function clickDeepSeekSend() {
    const btn = findDeepSeekSendButton();
    if (btn && !btn.classList.contains("ds-button--disabled")) {
      btn.click();
      return true;
    }
    return false;
  }

  // 把命令执行结果格式化为文本，便于填入 DeepSeek 输入框
  function formatResult(command, d) {
    const lines = [];
    lines.push("> " + command);
    if (d.error) {
      lines.push("执行异常: " + d.error);
    } else {
      if (d.stdout && d.stdout.trim()) lines.push(d.stdout.replace(/\s+$/, ""));
      if (d.stderr && d.stderr.trim())
        lines.push("STDERR: " + d.stderr.replace(/\s+$/, ""));
      lines.push("[退出码 " + d.returncode + " · 耗时 " + d.elapsed + "s]");
    }
    return lines.join("\n");
  }

  // 定位 DeepSeek 页面自己的输入框（textarea，placeholder 含“发送消息”）
  function findDeepSeekInput() {
    const tas = document.querySelectorAll("textarea");
    for (const ta of tas) {
      if (ta.isConnected && !ta.closest("#ds-local-helper-root")) {
        const ph = ta.getAttribute("placeholder") || "";
        if (ph.indexOf("发送消息") >= 0) return ta;
      }
    }
    // 回退：取页面里面积最大的可见 textarea（排除我们扩展自己的输入框）
    let best = null,
      max = 0;
    for (const ta of tas) {
      if (!ta.isConnected || ta.closest("#ds-local-helper-root")) continue;
      const area = ta.offsetWidth * ta.offsetHeight;
      if (area > max) {
        max = area;
        best = ta;
      }
    }
    return best;
  }

  // 填充 DeepSeek 输入框（兼容 React 受控 textarea）
  function fillDeepSeekInput(text) {
    const ta = findDeepSeekInput();
    if (!ta) return;
    const proto = Object.getPrototypeOf(ta);
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) setter.call(ta, text);
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
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

  promptBtn.addEventListener("click", () => {
    fillDeepSeekInput(AI_PROMPT);
    appendOutput("已把「AI 协作协议」提示词填入 DeepSeek 输入框，可发送给 AI", "dslh-cmd");
  });

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

  // 判断是否 AI 回复（assistant），用于过滤掉用户消息。
  // 实测：AI 回复的 ds-message class 以 "ds-message" 开头；用户消息 class 带 hash 前缀（如 "d29f3d7d"）。
  // 兜底：含思考标题（已思考/深度思考）的必是 AI 回复（思考只属于 AI）。
  function isAssistantMessage(msg) {
    const cls = (typeof msg.className === "string" ? msg.className : "").trim();
    if (cls.indexOf("ds-message") === 0) return true;
    if (hasThinkingText(msg)) return true;
    return false;
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

  // 返回「排除思考容器后的克隆消息节点」
  function cloneBody(msgEl) {
    const clone = msgEl.cloneNode(true);
    const think = findThinkingContainer(clone);
    if (think) think.remove();
    return clone;
  }

  // 命令字符归一化：LLM 常输出 Unicode 数学/全角符号（如 − U+2212、∗ U+2217、′ 全角引号），
  // 这些在 cmd/PowerShell 里无法识别导致执行失败。统一转成 ASCII 等价字符。
  function normalizeCommand(s) {
    const map = {
      "\u2212": "-", // MINUS SIGN −
      "\uff0d": "-", // FULLWIDTH HYPHEN-MINUS －
      "\u2217": "*", // ASTERISK OPERATOR ∗
      "\u00d7": "*", // MULTIPLICATION SIGN ×
      "\u2032": "'", // PRIME ′
      "\u2019": "'", // RIGHT SINGLE QUOTATION ’
      "\u2018": "'", // LEFT SINGLE QUOTATION ‘
      "\u201c": '"', // LEFT DOUBLE QUOTATION “
      "\u201d": '"', // RIGHT DOUBLE QUOTATION ”
      "\uff06": "&", // FULLWIDTH AMPERSAND ＆
      "\uff5c": "|", // FULLWIDTH VERTICAL BAR ｜
      "\u3000": " ", // IDEOGRAPHIC SPACE
      "\uff1e": ">", // ＞
      "\uff1c": "<", // ＜
      "\uff1d": "=", // ＝
      "\uff08": "(", // （
      "\uff09": ")", // ）
      "\uff05": "%", // ％
      "\uff04": "$", // ＄
      "\uff0c": ",", // ，
      "\uff1b": ";", // ；
    };
    return s.replace(
      /[\u2212\uff0d\u2217\u00d7\u2032\u2019\u2018\u201c\u201d\uff06\uff5c\u3000\uff1e\uff1c\uff1d\uff08\uff09\uff05\uff04\uff0c\uff1b]/g,
      (ch) => map[ch] || ch
    );
  }

  // 从正文提取 <command> 命令。
  // 双通道原因（已实测）：`<command>` 在 HTML 里是空元素(void)，
  //   1) 若 AI 把它写在代码块里 → 被转义成文本 &lt;command&gt;，需用 textContent 正则匹配（配对完整）；
  //   2) 若 AI 把它写在普通段落里 → 浏览器渲染成空元素 <command></command>，</command> 结束标签被丢弃，
  //      命令内容落在 command 元素后面的文本节点里，需用 DOM 提取。
  // 加长度上限，避免正则匹配到「<command>」后很远才出现的「</command>」而误吞大段文字。
  function extractCommands(bodyEl) {
    const cmds = [];
    const seen = new Set();
    const MAX = 500;

    function add(c) {
      c = normalizeCommand(String(c || "").trim());
      if (c && c.length <= MAX && !seen.has(c)) {
        seen.add(c);
        cmds.push(c);
      }
    }

    // 通道A：textContent 正则（覆盖被转义成 &lt;command&gt; 的配对形式）。
    // [^<]{1,500}：命令内容不含 `<`（从而遇到下一个 <command> 标签即停止，避免跨标签吞长段），
    // 上限放宽到 500 以容纳较长的代码型命令（如 python -c "..."）。
    const text = bodyEl.textContent || "";
    const re = /<command>([^<]{1,500}?)<\/command>/gi;
    let m;
    while ((m = re.exec(text))) {
      const c = m[1].trim();
      // 长且含中文 → 判为正文里的解释文字（提及 <command> 标签），丢弃
      if (c.length > 120 && /[\u4e00-\u9fa5]/.test(c)) continue;
      add(c);
    }

    // 通道B：raw void 元素（<command> 渲染成空元素，命令内容在其后文本节点）
    bodyEl.querySelectorAll("command").forEach((com) => {
      let n = com.nextSibling;
      let buf = "";
      while (n && n.nodeType === Node.TEXT_NODE) {
        buf += n.textContent;
        n = n.nextSibling;
      }
      add(buf.split("\n")[0]); // raw 内联命令通常单行，取到换行为止
    });

    // 通道C：代码块内容忍未闭合的 <command>（AI 常漏写 </command>，尤其深度思考模式）。
    // 此时取 <command> 之后到行尾/代码块结束的内容作为命令。
    bodyEl.querySelectorAll("pre, code").forEach((el) => {
      const t = el.textContent || "";
      let idx = t.indexOf("<command>");
      while (idx >= 0) {
        const rest = t.slice(idx + 9); // 跳过 "<command>"
        const closeIdx = rest.indexOf("</command>");
        if (closeIdx >= 0) {
          add(rest.slice(0, closeIdx));
        } else {
          add(rest.split("\n")[0]); // 未闭合：取到行尾
        }
        const next = t.indexOf("<command>", idx + 9);
        if (next <= idx) break;
        idx = next;
      }
    });

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
    // 命令一填充就自动执行（无需手动点发送）；是否自动发送由「自动发送延迟」决定
    setTimeout(sendCommand, 50); // 等输入框 value 同步后再读取执行
  }

  // 判断消息文本里是否存在思考标题特征
  function hasThinkingText(el) {
    const t = el.textContent || "";
    return (
      t.indexOf("已思考") >= 0 || t.indexOf("深度思考") >= 0
    );
  }

  // 扫描单条消息：排除思考 -> 提取 command -> 填充
  function scanMessage(msg) {
    if (msg.nodeType !== Node.ELEMENT_NODE) return;
    // 由 scheduleScan 的防抖保证消息已稳定后再扫描，
    // 因此这里直接排除思考容器（能定位则排除）并提取正文 command。
    const bodyEl = cloneBody(msg);
    const cmds = extractCommands(bodyEl);
    if (cmds.length) {
      fillInput(cmds[cmds.length - 1]); // 取最后一条（流式输出时最新完整的一条）
    }
  }

  // 防抖扫描：AI 回复是流式的，多次触发 Mutation。每次新变化都重置计时器，
  // 等消息「停止变化」一段时间后再统一扫描，避免在思考/正文尚未渲染完整时误抓中间态。
  const scanQueue = new Set();
  let scanTimer = null;
  function scheduleScan(msg) {
    scanQueue.add(msg);
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const list = Array.from(scanQueue);
      scanQueue.clear();
      for (const m of list) {
        if (m.isConnected) scanMessage(m);
      }
    }, 1200);
  }

  // 监听页面 DOM 变化，发现新增的 ds-message 回复即扫描
  function installWatcher() {
    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const msg = findMessageContainer(node);
          // 只扫描 AI 回复，过滤用户消息（用户消息里的 <command> 不需要解析执行）
          if (msg && isAssistantMessage(msg)) scheduleScan(msg);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  installWatcher();

  checkHealth();
})();
