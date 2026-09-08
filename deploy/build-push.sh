#!/bin/sh
# 웹앱 이미지를 빌드해 latest 로 올리고 재시작한다.
# 버저닝은 쓰지 않는다 — latest + imagePullPolicy:Always + rollout restart.
set -e
cd "$(dirname "$0")/.."

REG=879684891358.dkr.ecr.ap-northeast-2.amazonaws.com
IMG="$REG/goorm/worktime-web:latest"
export AWS_PROFILE="${AWS_PROFILE:-arn:aws:iam::879684891358:role/goorm_Infra}"
export AWS_PAGER=""

echo "▸ 문법·참조 검사"
for f in app/www/app.js app/www/lib/*.js src/*.js src/lib/*.js; do node --check "$f"; done
node tools/check-ids.js

echo "▸ 공유 라이브러리 동기화"
sh app/sync-lib.sh

echo "▸ 빌드·푸시 (노드가 amd64 라 크로스 빌드)"
aws ecr get-login-password --region ap-northeast-2 | docker login -u AWS --password-stdin "$REG" >/dev/null
docker buildx build --platform linux/amd64 -t "$IMG" --push .

echo "▸ 다이제스트 고정 후 롤아웃"
# latest 만으로는 파드마다 다른 이미지를 당길 수 있다. imagePullPolicy:Always 는
# "시작할 때 당긴다" 만 보장하지, 두 파드가 같은 걸 받는다는 보장이 아니다.
# 실제로 한 파드는 이전 latest, 다른 파드는 새 latest 를 물고 서로 다른 내용을
# 서빙한 적이 있다. 그래서 방금 올린 다이제스트로 못 박는다.
# (버전 번호는 여전히 쓰지 않는다 — 태그는 latest 하나뿐이다)
DIGEST=$(aws ecr describe-images --region ap-northeast-2 \
  --repository-name goorm/worktime-web --image-ids imageTag=latest \
  --query 'imageDetails[0].imageDigest' --output text)
echo "  $DIGEST"
CTX=$(kubectl config get-contexts -o name | grep internal-k8s)
kubectl --context "$CTX" -n worktime set image deploy/worktime-web \
  "web=$REG/goorm/worktime-web@$DIGEST"
kubectl --context "$CTX" -n worktime rollout status deploy/worktime-web --timeout=150s

echo "▸ 서빙본 대조"
# 롤아웃 직후에는 ALB 가 아직 구 파드로 보낼 수 있다. 잠깐 재시도한다.
for f in app.js index.html app.css lib/auth.js lib/gwapi.js lib/leave.js; do
  L=$(shasum -a256 "app/www/$f" | cut -c1-16)
  ok=""
  for i in 1 2 3 4 5 6; do
    S=$(curl -s "https://worktime.goorm.io/$f?$(date +%s)-$i" | shasum -a256 | cut -c1-16)
    [ "$L" = "$S" ] && { ok=1; break; }
    sleep 3
  done
  [ -n "$ok" ] && echo "  ✓ $f" || { echo "  ✗ $f  로컬=$L 서빙=$S"; exit 1; }
done
echo "완료: https://worktime.goorm.io"
