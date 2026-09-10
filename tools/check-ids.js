// 배포 전 정적 검사.
//
//   1) 스크립트가 참조하는 엘리먼트 id 가 HTML 에 실제로 있는지
//
// 없으면 $('...').onclick = ... 이 평가 도중 TypeError 를 내고, 그 뒤의 모든
// 바인딩이 통째로 죽는다. 증상은 "버튼이 아무 반응 없음" 이라 원인을 찾기 어렵다.
// 실제로 lvGwLogin 하나가 빠져서 로그인 버튼이 죽은 적이 있다.
const fs = require('fs');

const PAIRS = [
  ['app/www/index.html', ['app/www/app.js']],
  ['src/popup.html', ['src/popup.js']],
];

let bad = 0;
for (const [htmlPath, jsPaths] of PAIRS) {
  if (!fs.existsSync(htmlPath)) continue;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const have = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  for (const jsPath of jsPaths) {
    if (!fs.existsSync(jsPath)) continue;
    const js = fs.readFileSync(jsPath, 'utf8');
    // getElementById 별칭이 여럿이다 ($ 와 lv). 별칭을 늘리면 여기에 추가한다.
    // \b 는 $ 앞에서 안 먹는다($ 가 단어문자가 아니라서). 뒤돌아보기로 막는다.
    const used = new Set([...js.matchAll(/(?<![\w$])(?:\$|lv)\('([^']+)'\)/g)].map((m) => m[1]));
    const missing = [...used].filter((id) => !have.has(id)).sort();
    if (missing.length) {
      console.error(`✗ ${jsPath} → ${htmlPath} 에 없는 id: ${missing.join(', ')}`);
      bad++;
    } else {
      console.log(`✓ ${jsPath} (${used.size}개 id 모두 존재)`);
    }
  }
}
//   2) 정의되지 않은 식별자 (eslint no-undef)
//   3) manifest.json 과 latest.json 의 버전 일치
//
// 둘 다 증상이 "그 기능만 조용히 죽음" 이라 눈으로는 못 잡는다. 실제로 없는 버튼
// 참조로 로그인 버튼이 통째로 죽었고, 범위 삭제가 isNative·injectSessionCookies
// 정의를 삼켜 결재 화면 열기가 깨진 채로 APK 가 나갔다.
// 릴리스 태그는 manifest.json 버전에 맞춘다. latest.json 이 어긋나면 업데이트
// 안내가 안 뜨거나 엉뚱한 버전을 가리킨다 — 눈으로는 절대 안 잡히는 부류다.
const mv = JSON.parse(fs.readFileSync('manifest.json', 'utf8')).version;
const lv = JSON.parse(fs.readFileSync('latest.json', 'utf8')).version;
if (mv !== lv) {
  console.error(`✗ 버전 불일치: manifest.json ${mv} ≠ latest.json ${lv}`);
  bad++;
} else {
  console.log(`✓ 버전 ${mv} (manifest = latest)`);
}

const { execFileSync } = require('child_process');
const TARGETS = ['app/www/app.js', 'app/www/lib', 'src'];
try {
  execFileSync('eslint', TARGETS.filter((t) => fs.existsSync(t)), { stdio: 'inherit' });
  console.log('✓ eslint no-undef 통과');
} catch (e) {
  console.error('✗ eslint 검사 실패');
  bad++;
}

process.exit(bad ? 1 : 0);
