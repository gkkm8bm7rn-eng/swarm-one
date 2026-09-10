from pathlib import Path

idx = Path("index.html")
s = idx.read_text(encoding="utf-8")
for old in ("0.7.1", "0.7.2"):
    s = s.replace(f"SWARM One · v{old}", "SWARM One · v0.8.0")
    s = s.replace(f"./app.js?v={old}", "./app.js?v=0.8.0")
idx.write_text(s, encoding="utf-8")

sw = Path("service-worker.js")
s = sw.read_text(encoding="utf-8")
for old in ("0.7.1", "0.7.2"):
    s = s.replace(f"swarm-one-v{old}", "swarm-one-v0.8.0")
    s = s.replace(f"./app.js?v={old}", "./app.js?v=0.8.0")
if '"./vision-worker.js?v=0.8.0"' not in s:
    s = s.replace('"./app.js?v=0.8.0",', '"./app.js?v=0.8.0",\n  "./vision-worker.js?v=0.8.0",')
sw.write_text(s, encoding="utf-8")

print("Shell version patch complete")
