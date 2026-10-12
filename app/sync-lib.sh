#!/bin/sh
# 확장과 앱이 계산·신청 로직을 공유한다. 이 파일들은 플랫폼 의존성이 전혀 없어 그대로 복사한다.
# (gwapi/store 는 세션 획득 방식이 달라 앱 전용 구현을 쓴다)
set -e
cd "$(dirname "$0")"
for f in time.js holidays.js calc.js leave.js break.js team.js feedback.js; do
  cp "../src/lib/$f" "www/lib/$f"
  echo "  동기화: $f"
done
# 패치노트는 확장과 앱이 같은 것을 쓴다. 설치된 판과 어긋나면 안 되므로 같이 옮긴다.
cp ../src/notes.json www/notes.json
echo "  동기화: notes.json"
