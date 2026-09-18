#!/bin/sh
# 생성된 안드로이드 프로젝트에 버전을 박아 넣는다.
#
# app/android/ 는 `cap add android` 로 만들어지는 생성물이라 통째로 gitignore 돼 있다.
# 그래서 거기 적힌 versionCode 는 이 기계에만 있고, 프로젝트를 다시 만들면 1 로 돌아간다.
# 추적되는 app/package.json 의 version 을 유일한 출처로 삼고 여기서 계산한다.
#
#   1.4.2 → versionName "1.4.2"  versionCode 10402
#
# versionCode 는 올라가기만 하면 된다(안드로이드 요구). 자리마다 100 을 주면
# 1.4.2 < 1.4.10 < 1.5.0 순서가 그대로 지켜진다.
set -e
cd "$(dirname "$0")"

G=android/app/build.gradle
[ -f "$G" ] || { echo "android 프로젝트가 없습니다. npx cap add android 를 먼저 하세요." >&2; exit 1; }

V=$(node -p "require('./package.json').version")
CODE=$(node -p "const [a,b,c]=require('./package.json').version.split('.').map(Number); a*10000+b*100+c")

# 이미 올라간 값보다 낮으면 안 된다 — 안드로이드가 다운그레이드를 거부한다.
CUR=$(sed -n 's/.*versionCode \([0-9]*\).*/\1/p' "$G" | head -1)
if [ -n "$CUR" ] && [ "$CUR" -gt "$CODE" ]; then
  echo "versionCode 가 내려갑니다 ($CUR → $CODE). package.json 의 version 을 올리세요." >&2
  exit 1
fi

sed -i '' "s/versionCode .*/versionCode $CODE/; s/versionName \".*\"/versionName \"$V\"/" "$G"
echo "  versionName $V · versionCode $CODE"
