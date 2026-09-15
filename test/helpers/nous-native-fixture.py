#!/usr/bin/env python3
"""Native Code Mode acceptance. Default uses a fake provider; --live calls Nous.
No installed config/service is changed. Credentials stay in inherited environment.
"""
import argparse
import datetime
import re
import secrets
import hashlib
import json
import os
from pathlib import Path
import queue
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
MODEL = "nous/deepseek/deepseek-v4.1-flash"
UPSTREAM = "deepseek/deepseek-v4.1-flash"
MARKER = "NOUS_CODE_MODE_NATIVE_OK"
INTERNAL = secrets.token_urlsafe(32)
CALLER = secrets.token_urlsafe(32)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def stop(proc):
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def safe_json(value):
    encoded = json.dumps(value, indent=2)
    for secret in [os.environ.get("NOUS_API_KEY"), INTERNAL, CALLER]:
        if secret:
            encoded = encoded.replace(secret, "[redacted]")
    return encoded


def source_hashes():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [ROOT / "src/nous-direct.mjs", ROOT / "src/router.mjs", ROOT / "src/namespace-relay.mjs", ROOT / "src/nous-tool-availability.mjs", ROOT / "src/nous-provider-lock.mjs", ROOT / "src/nous-provider-lock.py", Path(__file__).resolve()]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="explicitly call Nous with synthetic data")
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--codex", default="codex")
    parser.add_argument("--model-catalog", type=Path, default=Path.home() / ".codex/codex-router/merged-models.json")
    parser.add_argument("--workspace-parent", type=Path)
    args = parser.parse_args()
    receipt = {"started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "run_id": str(uuid.uuid4()), "evidence_class": "native_code_mode_live_nous_isolated_router" if args.live else "native_code_mode_fake_provider_isolated_router", "model": MODEL, "effort": "max", "provider_live": args.live, "installed_services_changed": False}
    receipt["source_sha256"] = source_hashes()
    processes = []
    logs = []
    events = []
    with tempfile.TemporaryDirectory(prefix="nous-native-state-") as state_tmp, tempfile.TemporaryDirectory(prefix="nous-native-work-", dir=args.workspace_parent) as work_tmp:
        state, workspace = Path(state_tmp), Path(work_tmp)
        (workspace / "native-custom-proof.txt").write_text("pending\n")
        source_catalog = json.loads(args.model_catalog.read_text())
        selected_model = next((row for row in source_catalog["models"] if row.get("slug") == MODEL), None)
        if selected_model is None:
            raise RuntimeError("the specified catalog has no exact Nous V4.1 Flash row")
        model_catalog = state / "client-model-catalog.json"
        model_catalog.write_text(json.dumps({"models": [selected_model]}))
        receipt["native_catalog_sha256"] = hashlib.sha256(model_catalog.read_bytes()).hexdigest()
        (state / "enabled-providers.json").write_text('{"version":1,"providers":["nous"]}\n')
        api_port, router_port = free_port(), free_port()
        if api_port == router_port:
            raise RuntimeError("ephemeral port collision; no processes or provider request started")
        (state / "router-home").mkdir()
        fixture_env = {**{k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NOUS_API_KEY", "XDG_CACHE_HOME", "CODEX_ROUTER_NOUS_LOCK_PYTHON"}}, "CODEX_HOME": str(state / "router-home"), "MODEL_ROUTER_STATE_DIR": str(state), "CODEX_ROUTER_STATE_DIR": str(state), "CODEX_ROUTER_INTERNAL_KEY": INTERNAL, "CODEX_ROUTER_CALLER_KEY": CALLER, "CODEX_ROUTER_API_PORT": str(api_port), "CODEX_ROUTER_PORT": str(router_port), "CODEX_ROUTER_GATEWAY_BASE_URL": f"http://127.0.0.1:{api_port}/v1", "CODEX_ROUTER_GATEWAY_HEALTH_URL": f"http://127.0.0.1:{api_port}/health", "CODEX_ROUTER_API_HEALTH_URL": f"http://127.0.0.1:{api_port}/health", "CODEX_ROUTER_SHOW_ALL_MODELS": "1", "CODEX_ROUTER_QUIET": "0", "MODEL_ROUTER_QUIET": "0"}
        if not args.live:
            fixture_env["NOUS_API_KEY"] = "SYNTHETIC_FAKE_PROVIDER_KEY"
            fixture_env["XDG_CACHE_HOME"] = str(state / "fake-provider-cache")
        receipt["provider_lock_scope"] = "shared_host_cache" if args.live else "isolated_fake_provider_cache"
        proof_path = state / "mock-provider-proof.json"
        bootstrap = state / "api-bootstrap.mjs"
        # No request text or credential value is written to the proof.
        bootstrap.write_text(f'''
import assert from 'node:assert/strict';
import {{ writeFileSync }} from 'node:fs';
await import({json.dumps((ROOT / 'src/api-forwarder.mjs').as_uri())});
if ({str(not args.live).lower()}) {{
  let calls = 0; const expected = [];
  const code = [
    "text(await tools.exec_command({{cmd: \\\"printf 'NOUS_CODE_MODE_NATIVE_OK\\\\\\\\n' > native-custom-proof.txt\\\"}}));",
    "text(await tools.exec_command({{cmd: 'cat native-custom-proof.txt'}}));",
  ];
  globalThis.fetch = async (url, options) => {{
    assert.equal(String(url), 'https://inference-api.nousresearch.com/v1/chat/completions');
    const p = JSON.parse(options.body); assert.equal(p.model, {json.dumps(UPSTREAM)});
    assert.equal(p.reasoning_effort, 'max'); calls += 1; assert.ok(calls <= 3);
    const prior = p.messages.filter(m => m.role === 'assistant' && m.tool_calls).flatMap(m => m.tool_calls);
    assert.deepEqual(prior.map(c => c.function.arguments), expected);
    let message, finish;
    if (calls <= 2) {{
      const tool = p.tools.find(t => ['exec', 'functions__exec'].includes(t.function.name));
      assert.ok(tool, 'custom exec must be offered');
      const raw = '  {{ "input" : ' + JSON.stringify(code[calls - 1]) + ' }}\\n';
      expected.push(raw);
      message = {{role:'assistant', content:null, reasoning_content:'Synthetic replay proof.', reasoning_details:[{{type:'reasoning.text',text:'Synthetic replay proof.'}}], tool_calls:[{{id:'synthetic_call_'+calls,type:'function',function:{{name:tool.function.name,arguments:raw}}}}]}};
      finish = 'tool_calls';
    }} else {{
      const outputs = p.messages.filter(m => m.role === 'tool');
      assert.equal(outputs.length, 2);
      assert.ok(outputs[1].content.includes({json.dumps(MARKER)}));
      message = {{role:'assistant',content:{json.dumps(MARKER)}}};finish='stop';
    }}
    writeFileSync({json.dumps(str(proof_path))}, JSON.stringify({{calls,prior_calls_replayed:prior.length,exact_raw_arguments:true}}));
    return new Response(JSON.stringify({{id:'synthetic_response_'+calls,model:{json.dumps(UPSTREAM)},choices:[{{index:0,message,finish_reason:finish}}],usage:{{prompt_tokens:1,completion_tokens:1,total_tokens:2}}}}),{{status:200,headers:{{'Content-Type':'application/json'}}}});
  }};
}}
process.stdout.write('FIXTURE_READY\\n');
''')
        try:
            for command, name in [(["node", str(bootstrap)], "api"), (["node", str(ROOT / "src/router.mjs")], "router")]:
                log = (state / (name + ".stderr")).open("w")
                logs.append(log)
                proc = subprocess.Popen(command, cwd=ROOT, env=fixture_env, stdout=subprocess.PIPE, stderr=log, text=True)
                processes.append(proc)
            caller_url = f"http://127.0.0.1:{router_port}/_codex-router/{CALLER}/v1"
            deadline = time.monotonic() + 15
            while True:
                if any(p.poll() is not None for p in processes):
                    raise RuntimeError("isolated router process exited before readiness")
                try:
                    with urllib.request.urlopen(caller_url + "/models", timeout=1) as response:
                        if response.status == 200:
                            break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("isolated router did not become ready")
                    time.sleep(0.05)
            codex_home = state / "codex-home"
            codex_home.mkdir()
            native_env = {k: v for k, v in os.environ.items() if k in {"PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SSL_CERT_FILE", "SSL_CERT_DIR"}}
            native_env["CODEX_HOME"] = str(codex_home)
            native_env["XDG_CACHE_HOME"] = str(state / "native-cache")
            log = (state / "native.stderr").open("w")
            logs.append(log)
            native = subprocess.Popen([args.codex, "app-server", "--stdio"], cwd=ROOT, env=native_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
            processes.append(native)
            inbox = queue.Queue()
            def pump():
                for line in native.stdout:
                    try:
                        inbox.put(json.loads(line))
                    except ValueError:
                        pass
                inbox.put({"local_eof": True})
            threading.Thread(target=pump, daemon=True).start()
            def receive(timeout):
                message = inbox.get(timeout=timeout)
                if message.get("local_eof"):
                    raise RuntimeError("native App Server exited")
                if message.get("method") in {"item/completed", "turn/completed", "error"}:
                    events.append(message)
                return message
            def call(number, method, params):
                native.stdin.write(json.dumps({"id": number, "method": method, "params": params}) + "\n")
                native.stdin.flush()
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    message = receive(max(0.1, deadline - time.monotonic()))
                    if message.get("id") == number:
                        if "error" in message:
                            raise RuntimeError("native RPC failed: " + json.dumps(message["error"]))
                        return message["result"]
                raise RuntimeError("native RPC deadline")
            call(1, "initialize", {"clientInfo": {"name": "nous_code_mode_fixture", "version": "1"}, "capabilities": {"experimentalApi": True}})
            native.stdin.write('{"method":"initialized","params":{}}\n')
            native.stdin.flush()
            config = {"model_providers.fixture": {"name": "Isolated native fixture", "base_url": caller_url, "wire_api": "responses", "requires_openai_auth": False, "supports_standalone_web_search": True, "request_max_retries": 0, "stream_max_retries": 0}, "model_catalog_json": str(model_catalog), "model_reasoning_effort": "max", "features.code_mode": True, "features.code_mode_only": True, "features.memories": False, "features.goals": False, "features.unified_exec": True, "agents.enabled": False, "project_doc_max_bytes": 0, "web_search": "live", "shell_environment_policy.include_only": ["PATH", "LANG", "TMPDIR"]}
            start = call(2, "thread/start", {"cwd": str(workspace), "model": MODEL, "modelProvider": "fixture", "config": config, "ephemeral": True, "approvalPolicy": "never", "sandbox": "workspace-write", "baseInstructions": "Perform only the bounded synthetic file task using native Code Mode and tools. Preserve exact tool results.", "developerInstructions": "Only native-custom-proof.txt in the supplied workspace may be read or written. No network, other files, extra agents, or permission questions. Use exactly two separate exec calls, each containing one tools.exec_command call, then finish."})
            receipt["native_start_model"] = start.get("model")
            receipt["native_start_provider"] = start.get("modelProvider")
            if start.get("model") != MODEL:
                raise RuntimeError("native model binding mismatch")
            thread_id = start["thread"]["id"]
            call(3, "turn/start", {"threadId": thread_id, "model": MODEL, "effort": "max", "input": [{"type": "text", "text": "Use Code Mode exec twice. First call tools.exec_command to write exactly NOUS_CODE_MODE_NATIVE_OK plus one newline to native-custom-proof.txt. In a second separate exec call use tools.exec_command to read that file back. Print each tool result with text(). Reply exactly NOUS_CODE_MODE_NATIVE_OK after the successful readback. Do not use web search or inspect anything else."}]})
            terminal = None
            deadline = time.monotonic() + (900 if args.live else 90)
            while time.monotonic() < deadline:
                try:
                    message = receive(min(20, max(0.1, deadline - time.monotonic())))
                except queue.Empty:
                    continue
                if message.get("method") == "turn/completed":
                    terminal = message["params"]["turn"]
                    break
                if "id" in message and "method" in message:
                    native.stdin.write(json.dumps({"id": message["id"], "error": {"code": -32000, "message": "Fixture forbids additional client actions"}}) + "\n")
                    native.stdin.flush()
            data = (workspace / "native-custom-proof.txt").read_bytes()
            items = [e.get("params", {}).get("item", {}) for e in events if e.get("method") == "item/completed"]
            messages = [i.get("text", "") for i in items if i.get("type") == "agentMessage"]
            commands = [i for i in items if i.get("type") == "commandExecution"]
            receipt["commands"] = [{k: i.get(k) for k in ["command", "status", "exitCode"]} for i in commands]
            receipt["commands_succeeded"] = len(commands) == 2 and all(i.get("status") == "completed" and i.get("exitCode") == 0 for i in commands)
            receipt.update(terminal_status=terminal.get("status") if terminal else None, terminal_error=terminal.get("error") if terminal else None, file_matches=data == (MARKER + "\n").encode(), file_sha256=hashlib.sha256(data).hexdigest(), item_types=[i.get("type") for i in items], final_marker_matches=bool(messages and messages[-1].strip() == MARKER))
            if proof_path.exists():
                receipt["mock_provider"] = json.loads(proof_path.read_text())
            receipt["accepted"] = bool(terminal and terminal.get("status") == "completed" and receipt["file_matches"] and receipt["final_marker_matches"] and receipt["commands_succeeded"])
        except Exception as exc:
            receipt.update(accepted=False, error=str(exc).replace(CALLER, "[synthetic caller]").replace(INTERNAL, "[synthetic internal]"))
        finally:
            for proc in reversed(processes):
                stop(proc)
            for log in logs:
                log.close()
            # Error classes only in retained logs; no provider request/response bodies.
            receipt["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            api_log = (state / "api.stderr").read_text() if (state / "api.stderr").exists() else ""
            receipt["provider_responses"] = [{"model": m, "status": int(status)} for m, status in re.findall(r"provider=nous model=(\S+) status=(\d+)", api_log)]
            if args.live:
                receipt["accepted"] = bool(receipt.get("accepted") and receipt["provider_responses"] and all(r["model"] == UPSTREAM and r["status"] == 200 for r in receipt["provider_responses"]))
            receipt["source_unchanged"] = receipt["source_sha256"] == source_hashes()
            receipt["accepted"] = bool(receipt.get("accepted") and receipt["source_unchanged"])
            receipt["fixture_log_tail"] = {name: (state / name).read_text()[-1600:] for name in ["api.stderr", "router.stderr", "native.stderr"] if (state / name).exists()}
            args.receipt.parent.mkdir(parents=True, exist_ok=True)
            args.receipt.write_text(safe_json(receipt) + "\n")
    print(safe_json({k: v for k, v in receipt.items() if k not in {"fixture_log_tail"}}))
    return 0 if receipt.get("accepted") else 1


if __name__ == "__main__":
    raise SystemExit(main())
