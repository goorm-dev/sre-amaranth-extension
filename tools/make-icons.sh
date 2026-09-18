#!/bin/sh
# src/icons/icon.svg 하나에서 모든 PNG 를 뽑는다.
#
# 헤드리스 크롬으로 큰 판을 한 번 그리고 sips 로 줄인다.
# 작은 크기를 직접 그리면 창 최소 크기에 걸려서 엉뚱하게 나온다.
set -e
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
SVG=src/icons/icon.svg
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 모서리를 둥글게 뒀으므로 배경은 투명해야 한다.
cat > "$TMP/i.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}svg{display:block;width:1024px;height:1024px}</style>
$(cat "$SVG")
HTML
"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 \
  --screenshot="$TMP/icon-1024.png" --window-size=1024,1024 \
  --virtual-time-budget=2000 "file://$TMP/i.html" 2>/dev/null

# 확장 (manifest.json 의 icons · action.default_icon)
for s in 16 32 48 128; do
  sips -z $s $s "$TMP/icon-1024.png" --out "src/icons/icon-$s.png" >/dev/null
  echo "  src/icons/icon-$s.png"
done
# 웹앱 (manifest.webmanifest · apple-touch-icon)
for s in 180 192 512; do
  sips -z $s $s "$TMP/icon-1024.png" --out "app/www/icons/icon-$s.png" >/dev/null
  echo "  app/www/icons/icon-$s.png"
done
