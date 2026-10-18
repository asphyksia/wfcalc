#!/bin/sh
# Restart the dev server on a given port, replacing whatever was listening there.
# The stale process is found with pgrep on its own command line, never with `pkill -f` (that
# pattern also matches the shell running pkill, which kills the caller) and not with `fuser -k`
# (it cannot read /proc/net/tcp under proot and exits without killing anything, which left the
# old server answering while the new one died on EADDRINUSE).
set -e
PORT="${1:-7801}"
cd "$(dirname "$0")/.."
for pid in $(pgrep -f "server.ts --port ${PORT}\b" 2>/dev/null); do
  kill "$pid" 2>/dev/null || true
done
sleep 1
nohup ./bin/wfcalc serve --port "$PORT" --host 0.0.0.0 >"/tmp/wfcalc-${PORT}.log" 2>&1 &
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:${PORT}/"; then
    echo "http://127.0.0.1:${PORT}"
    exit 0
  fi
done
echo "server did not come up on ${PORT}; see /tmp/wfcalc-${PORT}.log" >&2
exit 1
