#!/bin/sh
# Restart the dev server on a given port, replacing whatever was listening there.
# `fuser -k` is used with an explicit port rather than `pkill -f`: a pattern match on the
# command line also matches the shell running pkill, which kills the caller.
set -e
PORT="${1:-7801}"
cd "$(dirname "$0")/.."
fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
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
