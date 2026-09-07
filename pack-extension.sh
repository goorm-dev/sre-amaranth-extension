#!/bin/sh
# 확장을 릴리스용 zip 으로 묶는다. 버전은 manifest 에서 읽는다.
set -e
cd "$(dirname "$0")"
V=$(node -p "require('./manifest.json').version")
OUT="amaranth-extension-v${V}.zip"
rm -f "$OUT"
zip -rq "$OUT" manifest.json src -x '*.DS_Store'
echo "$OUT ($(du -h "$OUT" | cut -f1))"
