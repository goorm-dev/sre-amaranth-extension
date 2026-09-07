// 근태 화면 구조 덤프. gw.goorm.io 콘솔에 붙여 실행하면 클립보드로 복사된다.
//
//   1) 근태 화면에서 한 번   → 좌측 [연차휴가신청서] 를 어떻게 찾는지 알아내려고
//   2) 신청서를 연 뒤 한 번   → 종류 버튼 · 날짜 · 시간 · [신청완료] 를 잡으려고
//
// 출력: 태그 | class | type/placeholder | 값 또는 글자 | x,y
(() => {
  const SEL = [
    'input', 'textarea', 'select',
    'button', 'a', '[role="button"]', '[role="menuitem"]', '[role="treeitem"]', '[role="tab"]',
    'li', '[class*="btn" i]', '[class*="button" i]', '[class*="menu" i]', '[class*="tree" i]',
  ].join(',');

  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) {
    try { if (f.contentDocument) docs.push(f.contentDocument); } catch (_) { /* 교차 출처 */ }
  }

  const out = [];
  for (const d of docs) {
    for (const el of d.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (el.closest('#gw-work-panel,#gw-leave-toast')) continue;   // 우리가 그린 것
      if (el.querySelector(SEL)) continue;                          // 가장 안쪽만
      const isField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
      const txt = String(isField ? el.value : el.textContent).trim().replace(/\s+/g, ' ').slice(0, 40);
      if (!txt && !isField) continue;
      out.push([
        el.tagName.toLowerCase(),
        String(el.className).slice(0, 60),
        [el.type, el.placeholder].filter(Boolean).join(' ').slice(0, 24),
        txt,
        `${Math.round(r.left)},${Math.round(r.top)}`,
      ].join(' | '));
    }
  }

  const s = `문서 ${docs.length} · 해시 ${location.hash}\n` + out.join('\n');
  console.log(s);
  try { copy(s); } catch (_) { /* copy 는 콘솔에서만 있다 */ }
  return `${out.length}개 — 클립보드에 복사했습니다`;
})();
