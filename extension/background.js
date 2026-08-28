// DeepSeek 本地命令助手 - 后台 Service Worker
// 负责把 content script 发来的命令转发给本地 HTTP 服务器，并把结果回传。
// content script 直接 fetch localhost 会被 CORS 拦截，因此必须经过这里
// （配合 manifest 中的 host_permissions，可绕过 CORS）。

const DEFAULT_PORT = 8765;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "exec") {
    return false;
  }

  const port = msg.port || DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}/exec`;

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command: msg.command,
      timeout: msg.timeout || 60,
    }),
  })
    .then(async (res) => {
      const data = await res.json();
      sendResponse({ ok: true, data });
    })
    .catch((err) => {
      sendResponse({
        ok: false,
        error:
          "无法连接本地服务器 " +
          url +
          "。请确认已运行 python server.py。" +
          " (" +
          String(err) +
          ")",
      });
    });

  return true; // 异步响应
});
