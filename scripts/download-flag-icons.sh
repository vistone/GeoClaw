#!/usr/bin/env bash
# 从 flagcdn 拉取全球国旗 w20 PNG 到 viz/flight-map/vendor/flags（需代理时可设 https_proxy）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/viz/flight-map/vendor/flags"
W20="$OUT/w20"
mkdir -p "$W20"

curl -fsSL -o "$OUT/codes.json" "https://flagcdn.com/en/codes.json"
python3 - <<PY
import json, os, subprocess, time
from pathlib import Path
out = Path(r"$W20")
codes = json.load(open(r"$OUT/codes.json"))
keys = sorted(codes)
print("codes", len(keys))
env = os.environ.copy()
ok = fail = 0
fails = []
for i, code in enumerate(keys):
    dest = out / f"{code}.png"
    url = f"https://flagcdn.com/w20/{code}.png"
    done = False
    for attempt in range(4):
        r = subprocess.run(
            ["curl", "-fsSL", "-m", "45", "-o", str(dest), "-w", "%{http_code}", url],
            env=env, capture_output=True, text=True,
        )
        http = (r.stdout or "").strip()
        if http == "200" and dest.exists() and dest.stat().st_size > 20:
            ok += 1
            done = True
            break
        time.sleep(0.3 * (attempt + 1))
    if not done:
        fail += 1
        fails.append((code, http))
        if dest.exists():
            dest.unlink()
    if (i + 1) % 50 == 0:
        print(f"… {i+1}/{len(keys)}")
print("ok", ok, "fail", fail)
if fails:
    print("fails", fails)
    raise SystemExit(1)
print("done", out)
PY
