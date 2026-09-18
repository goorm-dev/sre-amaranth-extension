#!/bin/sh
# 푸시와 릴리스를 한 번에. 버전은 manifest.json 이 정한다.
#
#   sh release.sh "팀 근무시간 공유"            커밋 본문을 릴리스 노트로
#   sh release.sh "팀 근무시간 공유" notes.md   따로 쓴 노트로
#
# 릴리스를 손으로 올리던 시절에 한 번 빠뜨렸다. latest.json 은 1.7.5 인데
# 릴리스가 없으면 확장은 "새 버전 있음" 만 띄우고 받을 게 없다. 그래서 묶었다.
set -e
cd "$(dirname "$0")"

TITLE="$1"
NOTES_FILE="$2"
[ -n "$TITLE" ] || { echo "쓰는 법: sh release.sh \"제목\" [노트파일]" >&2; exit 1; }

V=$(node -p "require('./manifest.json').version")
TAG="v$V"

echo "▸ 상태 점검"
BR=$(git rev-parse --abbrev-ref HEAD)
[ "$BR" = "main" ] || { echo "  main 이 아니라 $BR 입니다" >&2; exit 1; }
# 추적 중인 파일에 커밋 안 된 변경이 있으면 멈춘다. 릴리스에 안 들어간 채로
# 태그가 박히면 zip 과 저장소가 달라진다.
git diff --quiet && git diff --cached --quiet || {
  echo "  커밋하지 않은 변경이 있습니다:" >&2; git status --short >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && {
  echo "  태그 $TAG 가 이미 있습니다" >&2; exit 1; }
gh release view "$TAG" >/dev/null 2>&1 && {
  echo "  릴리스 $TAG 가 이미 있습니다" >&2; exit 1; }

echo "▸ 문법·참조 검사"
for f in app/www/app.js app/www/lib/*.js src/*.js src/lib/*.js server/*.js; do node --check "$f"; done
node tools/check-ids.js   # manifest 와 latest.json 의 버전이 같은지도 여기서 본다

echo "▸ 패키징"
sh pack-extension.sh
ZIP="amaranth-extension-v$V.zip"

# 노트를 안 주면 마지막 커밋 본문을 쓴다.
NOTES=$(mktemp)
trap 'rm -f "$NOTES"' EXIT
if [ -n "$NOTES_FILE" ]; then cat "$NOTES_FILE" > "$NOTES"
else git log -1 --pretty=%b | sed '/^Co-Authored-By:/d' > "$NOTES"; fi

echo "▸ 푸시"
git push origin main

echo "▸ 태그 · 릴리스"
git tag -a "$TAG" -m "$TAG — $TITLE"
git push origin "$TAG"
gh release create "$TAG" "$ZIP" --title "$TAG — $TITLE" --notes-file "$NOTES"

echo "완료: $(gh release view "$TAG" --json url -q .url)"
