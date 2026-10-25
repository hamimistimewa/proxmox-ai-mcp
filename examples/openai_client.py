"""Minimal OpenAI function-calling client for Proxmox AI.

    export PROXMOX_AI_URL=https://proxmox.ai.id
    export PROXMOX_AI_KEY=pak_...
    export OPENAI_API_KEY=sk-...
    python examples/openai_client.py "node mana yang RAM-nya paling mepet?"

The tool list comes from the platform, filtered by the API key's role, so this script never needs to know
which tools exist. Write actions still stop at propose_action; confirming is left to a human on purpose.
"""
import json
import os
import sys
import urllib.parse
import urllib.request

from openai import OpenAI

BASE = os.environ["PROXMOX_AI_URL"].rstrip("/").removesuffix("/api/v1") + "/api/v1"
KEY = os.environ["PROXMOX_AI_KEY"]
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4.1-mini")


def platform(method: str, path: str, params: dict | None = None, body: dict | None = None):
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {KEY}")
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read() or "null")
    except urllib.error.HTTPError as err:
        return {"error": json.loads(err.read() or "{}").get("error", str(err))}


manifest = platform("GET", "/mcp/manifest")
routes = {t["name"]: (t["method"], t["path"]) for t in manifest["tools"]}
tools = [
    {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}}
    for t in manifest["tools"]
]
print(f"{len(tools)} tools for role {manifest['role']}", file=sys.stderr)


def run(name: str, args: dict):
    method, path = routes[name]
    rest = dict(args)
    for key in list(rest):
        token = "{" + key + "}"
        if token in path:
            path = path.replace(token, urllib.parse.quote(str(rest.pop(key))))
    return platform(method, path, params=rest if method == "GET" else None, body=None if method == "GET" else rest)


client = OpenAI()
messages = [
    {"role": "system", "content": manifest["guardrail"] + "\nAnswer in the user's language. Be brief."},
    {"role": "user", "content": " ".join(sys.argv[1:]) or "ringkas kondisi infrastruktur saya"},
]

for _ in range(8):
    reply = client.chat.completions.create(model=MODEL, messages=messages, tools=tools).choices[0].message
    messages.append(reply)
    if not reply.tool_calls:
        print(reply.content)
        break
    for call in reply.tool_calls:
        result = run(call.function.name, json.loads(call.function.arguments or "{}"))
        print(f"  → {call.function.name}", file=sys.stderr)
        messages.append({"role": "tool", "tool_call_id": call.id, "content": json.dumps(result)[:12000]})
else:
    print("Stopped after too many tool rounds.")
