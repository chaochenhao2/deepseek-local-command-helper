# -*- coding: utf-8 -*-
"""
本地命令执行服务器
==================
接收浏览器扩展发来的 shell 命令，在本地执行并把结果回传给扩展。

使用：
    python server.py            # 默认 127.0.0.1:8765
    python server.py --port 9000

接口：
    GET  /health   -> 健康检查
    POST /exec     -> body: {"command": "..."}，返回执行结果

安全说明：
    - 只绑定 127.0.0.1，仅本机可访问，请勿修改 host 暴露到公网。
    - 该服务可执行任意 shell 命令，属高危能力，仅在可信本机使用。
"""

import argparse
import json
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class CommandHandler(BaseHTTPRequestHandler):
    # ---- CORS：让扩展 content script 即使从页面 origin 也能访问 ----
    def _set_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # 精简控制台输出
        print("[server]", fmt % args, flush=True)

    # ---- 预检请求 ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._set_cors()
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            self._send_json(200, {"status": "ok", "message": "server alive"})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/exec":
            self._send_json(404, {"error": "not found"})
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_json(400, {"error": "invalid json"})
            return

        command = payload.get("command", "").strip()
        timeout = float(payload.get("timeout", 60))

        if not command:
            self._send_json(400, {"error": "empty command"})
            return

        # ---- 执行命令 ----
        # 说明：Windows 下 cmd.exe 的输出通常是 GBK(cp936)，而部分命令又输出 UTF-8。
        # 因此以字节模式捕获，再按“UTF-8 优先、失败回退 GBK/CP1252”智能解码，
        # 保证中文等非 ASCII 内容能正确回传到扩展。
        def smart_decode(b):
            if b is None:
                return ""
            for enc in ("utf-8", "gbk", "cp1252"):
                try:
                    return b.decode(enc)
                except (UnicodeDecodeError, LookupError):
                    continue
            return b.decode("utf-8", errors="replace")

        start = time.time()
        try:
            proc = subprocess.run(
                command,
                shell=True,                 # Windows 下经 cmd.exe 执行，兼容管道等语法
                capture_output=True,
                timeout=timeout,
            )
            result = {
                "ok": True,
                "stdout": smart_decode(proc.stdout),
                "stderr": smart_decode(proc.stderr),
                "returncode": proc.returncode,
                "elapsed": round(time.time() - start, 3),
            }
        except subprocess.TimeoutExpired:
            result = {
                "ok": False,
                "error": f"command timed out after {timeout}s",
                "stdout": "",
                "stderr": "",
                "returncode": -1,
                "elapsed": round(time.time() - start, 3),
            }
        except Exception as e:  # noqa: BLE001
            result = {
                "ok": False,
                "error": str(e),
                "stdout": "",
                "stderr": "",
                "returncode": -1,
                "elapsed": round(time.time() - start, 3),
            }

        self._send_json(200, result)


def main():
    parser = argparse.ArgumentParser(description="本地命令执行服务器")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=8765, help="监听端口，默认 8765")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), CommandHandler)
    print(f"[server] 本地命令服务器已启动: http://{args.host}:{args.port}", flush=True)
    print("[server] 仅本机可访问。按 Ctrl+C 停止。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] 已停止", flush=True)


if __name__ == "__main__":
    main()
