// 휴일근무신청(양식 244) 새 문서 창에서 본문 칸을 채워 본다.
//
// 확장은 결재선을 건드리지 않고 "새 양식 창을 연 뒤 본문만 채우는" 방식으로 가려 한다.
// 그러려면 두 가지를 알아야 한다.
//   1) 새 양식 창 주소 — 확장이 그대로 열 주소
//   2) 본문 편집기가 어디 있는지(같은 문서인지 iframe 인지) — 칸을 찾아 채울 수 있는지
// 이 코드는 칸을 찾아 시험 값으로 채우고, 찾은 위치를 wk-probe.json 으로 내려받는다.
//
// 쓰는 법
//   그룹웨어에서 휴일근무신청 양식을 **새로** 연다 (임시보관함 문서 말고).
//   그 창 콘솔에 붙여 넣는다. 화면의 칸이 시험 값으로 바뀌는지 본다.
//   그다음 [임시저장] → 임시보관함에서 열어 값이 남아 있는지 본다. [상신] 은 누르지 않는다.
(() => {
  const TEST = { date: '2026-11-28', kind: '내근(사무실 근무)', time: '10:00 ~ 15:00',
    rest: '12:00 ~ 12:30', purpose: '확장 채우기 시험 — 상신하지 마세요' };

  // 같은 출처 iframe 까지 뒤져 본문 표가 있는 문서를 찾는다.
  const docs = [];
  const visit = (w, path) => {
    try { docs.push({ path, doc: w.document }); } catch (_) { return; }
    for (let i = 0; i < w.frames.length; i++) visit(w.frames[i], `${path}>${i}`);
  };
  visit(window, 'top');
  const frameInfo = (path) => {
    if (path === 'top') return null;
    // 경로의 마지막 iframe 요소 모양 — 확장이 찾아 들어갈 단서
    let w = window; const idx = path.split('>').slice(1).map(Number); let el = null;
    for (const i of idx) { el = [...w.document.querySelectorAll('iframe,frame')][i]; w = w.frames[i]; }
    return el ? { id: el.id || null, cls: el.className || null, name: el.name || null, src: (el.getAttribute('src') || '').slice(0, 120) } : null;
  };

  const out = { 창주소: location.href, 문서수: docs.length, 찾음: null, 채움: {}, 제목칸: [] };

  for (const { path, doc } of docs) {
    // 제목 입력칸 후보
    doc.querySelectorAll('input[type=text],input:not([type])').forEach((i) => {
      if (/휴일근무|\[.*\]/.test(i.value || '') || /제목/.test(i.placeholder || '')) {
        out.제목칸.push({ path, id: i.id || null, name: i.name || null, cls: i.className || null, value: i.value });
      }
    });

    const th = [...doc.querySelectorAll('th')].find((e) => /근무 신청일/.test(e.textContent));
    if (!th) continue;
    const table = th.closest('table');
    out.찾음 = { path, iframe: frameInfo(path), editable: doc.body && doc.body.isContentEditable,
      designMode: doc.designMode, tableCls: table.className || null };

    // 칸 찾기 — 머리글(th/td) 바로 다음 칸
    const cellAfter = (re) => {
      const h = [...table.querySelectorAll('th,td')].find((e) => re.test(e.textContent.replace(/\s+/g, ' ')));
      return h && h.nextElementSibling;
    };
    const setText = (td, v) => {
      if (!td) return false;
      const p = td.querySelector('p') || td;
      p.textContent = v;
      return true;
    };

    // 날짜 — 편집기는 저장할 때 속성(value=)을 읽으므로 속성까지 바꾼다.
    const date = table.querySelector('input[type=date]');
    if (date) { date.value = TEST.date; date.setAttribute('value', TEST.date); out.채움.날짜 = true; }

    // 근무구분 — 옵션 value 가 전부 "" 라 글자로 고른다. selected 속성도 옮긴다.
    const sel = table.querySelector('select');
    if (sel) {
      [...sel.options].forEach((o, i) => {
        const on = o.textContent.trim() === TEST.kind;
        o.selected = on;
        if (on) { o.setAttribute('selected', 'selected'); sel.selectedIndex = i; } else o.removeAttribute('selected');
      });
      out.채움.근무구분 = sel.selectedIndex;
    }

    out.채움.예상시간 = setText(cellAfter(/^근무 예상 시간/), TEST.time);
    out.채움.휴게시간 = setText(cellAfter(/^휴게 시간/), TEST.rest);
    out.채움.근무목적 = setText(cellAfter(/^근무목적/), TEST.purpose);

    // 편집기가 바뀐 줄 알도록 input 이벤트를 흘린다.
    [date, sel].filter(Boolean).forEach((e) => {
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    });
    table.dispatchEvent(new Event('input', { bubbles: true }));

    // 동의 칸 모양 — 체크박스가 따로 있는지
    const agree = [...doc.querySelectorAll('label')].find((l) => /동의/.test(l.textContent));
    out.동의 = agree ? { html: agree.outerHTML.replace(/style="[^"]*"/g, '').slice(0, 300),
      checkbox: !!(agree.querySelector('input') || (agree.previousElementSibling && agree.previousElementSibling.tagName === 'INPUT')) } : null;
    out.표 = table.outerHTML.replace(/style="[^"]*"/g, '').replace(/\s+/g, ' ').slice(0, 4000);
    break;
  }

  const s = JSON.stringify(out, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([s], { type: 'application/json' }));
  a.download = 'wk-probe.json';
  document.body.appendChild(a); a.click(); a.remove();
  console.log(s);
  return out.찾음
    ? `칸을 찾아 채웠습니다 (${out.찾음.path}) — 화면 확인 후 [임시저장] → 임시보관함에서 값이 남는지 봐 주세요`
    : `본문 표를 못 찾았습니다 (문서 ${docs.length}개) — wk-probe.json 을 내려받았습니다`;
})();
