// 스크립트가 참조하는 엘리먼트 id 가 HTML 에 실제로 있는지 검사한다.
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
    const used = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    const missing = [...used].filter((id) => !have.has(id)).sort();
    if (missing.length) {
      console.error(`✗ ${jsPath} → ${htmlPath} 에 없는 id: ${missing.join(', ')}`);
      bad++;
    } else {
      console.log(`✓ ${jsPath} (${used.size}개 id 모두 존재)`);
    }
  }
}
process.exit(bad ? 1 : 0);
