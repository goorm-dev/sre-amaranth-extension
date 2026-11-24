// 휴일(주말)근무 신청.
//
// 휴가와 달리 근태신청 화면을 거치지 않는다 — 전자결재 양식 244 "휴일근무신청" 을 바로 쓴다.
// 결재선·문서번호는 그룹웨어가 기본값으로 채우게 두고, 우리는 **본문 칸만** 채운다.
//
//   1) 팝업에서 날짜·시간·목적을 받아 chrome.storage.local.pendingWeekend 에 둔다
//   2) 새 양식 창(#/popup?MicroModuleCode=eap&formId=244…)을 연다
//   3) 그 창의 content script 가 편집기(iframe dzeditor_0, 창 안 iframe 의 안쪽)를 찾아
//      본문 표를 채운다 (fill). 사용자가 확인하고 [상신] 을 누른다.
//
// 편집기는 저장할 때 DOM 을 직렬화한다. 그래서 input·option 은 속성(value=, selected=)까지 바꾼다.
// tools/probe-weekend-fill.js 로 실제 양식에서 채우고 임시저장까지 확인했다.
(function (root) {
  const GW = (root.GW = root.GW || {});

  const FORM_ID = '244';
  const KINDS = ['내근(사무실 근무)', '외근', '출장'];
  const PENDING_TTL = 5 * 60 * 1000;   // 이보다 오래된 요청은 버린다 — 나중에 연 양식에 엉뚱한 값이 들어가지 않게
  const MAX_MIN = 8 * 60;               // 양식 유의사항: 1일 8시간
  const LAST_END = 22 * 60;             // 오후 10시까지

  const pad = (n) => String(n).padStart(2, '0');
  const toMin = (t) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const toHm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

  // 오늘이 주말이면 오늘, 아니면 다가오는 토요일.
  function nextWeekend(now = new Date()) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) d.setDate(d.getDate() + (6 - dow));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // 양식: "4시간마다 30분의 휴게시간이 반드시 필요합니다."
  // 4시간 넘게 일하면 시작 4시간 뒤에 30분을 넣는다. 8시간 상한이라 한 번이면 된다
  // (휴게 포함 구간이 8.5시간을 넘지 않는다).
  function suggestRest(start, end) {
    const s = toMin(start), e = toMin(end);
    if (s == null || e == null || e - s <= 4 * 60) return '';
    return `${toHm(s + 4 * 60)} ~ ${toHm(s + 4 * 60 + 30)}`;
  }

  // 구간과 휴게를 보고 문제를 돌려준다. 막을 것(error)과 알려만 줄 것(warn)을 나눈다.
  function check({ date, start, end, rest, purpose }, isHoliday) {
    const s = toMin(start), e = toMin(end);
    if (!date) return { error: '근무일을 골라 주세요.' };
    if (s == null || e == null) return { error: '시작·종료 시각을 넣어 주세요.' };
    if (e <= s) return { error: '종료 시각이 시작보다 늦어야 합니다.' };
    if (!String(purpose || '').trim()) return { error: '근무목적을 적어 주세요.' };
    const r = /^(\d{1,2}:\d{2})\s*~\s*(\d{1,2}:\d{2})$/.exec(String(rest || '').trim());
    const restMin = r ? Math.max(0, toMin(r[2]) - toMin(r[1])) : 0;
    if (rest && !r) return { error: '휴게 시간은 "12:00 ~ 12:30" 처럼 적어 주세요.' };
    const work = e - s - restMin;
    const warn = [];
    if (work > MAX_MIN) warn.push('휴일근무는 1일 8시간으로 제한됩니다.');
    if (e > LAST_END) warn.push('휴일근무는 오후 10시까지로 제한됩니다.');
    // 1시간 단위는 신청 구간으로 본다. 휴게 30분을 빼고 세면 거의 모든 신청이 걸린다.
    if ((e - s) % 60) warn.push('휴일근무는 1시간 단위로 신청합니다.');
    if (e - s > 4 * 60 && restMin < 30) warn.push('4시간마다 30분의 휴게시간이 필요합니다.');
    if (isHoliday === false) warn.push('주말·공휴일이 아닌 날입니다.');
    return { workMin: work, warn };
  }

  function formHash(uuid) {
    const q = new URLSearchParams({ MicroModuleCode: 'eap', formId: FORM_ID, callComp: 'UBAP001', popupUUID: uuid });
    return `#/popup?${q}`;
  }

  // 새 휴일근무신청 창인가. 임시보관함에서 연 문서(docID 있음)는 건드리지 않는다.
  function isNewForm(hash) {
    const i = String(hash || '').indexOf('?');
    if (i < 0 || !/#\/popup/.test(hash)) return false;
    const q = new URLSearchParams(hash.slice(i + 1));
    return q.get('MicroModuleCode') === 'eap' && q.get('formId') === FORM_ID && !Number(q.get('docID') || 0);
  }

  // ── 양식 채우기 (gw 창 안에서) ─────────────────────────────────────

  // 같은 출처 iframe 까지 뒤져 본문 표를 찾는다. 편집기는 창 > iframe > dzeditor_0 안쪽에 있다.
  function findTable(win) {
    const seen = [];
    const visit = (w) => {
      let doc;
      try { doc = w.document; } catch (_) { return null; }
      seen.push(doc);
      const th = [...doc.querySelectorAll('th')].find((e) => /근무 신청일/.test(e.textContent));
      if (th) return th.closest('table');
      for (let i = 0; i < w.frames.length; i++) {
        const t = visit(w.frames[i]);
        if (t) return t;
      }
      return null;
    };
    return visit(win);
  }

  function fillTable(table, v) {
    const cellAfter = (re) => {
      const h = [...table.querySelectorAll('th,td')].find((e) => re.test(e.textContent.replace(/\s+/g, ' ').trim()));
      return h && h.nextElementSibling;
    };
    const setText = (td, text) => {
      if (!td) return false;
      (td.querySelector('p') || td).textContent = text;
      return true;
    };
    const done = {};

    const date = table.querySelector('input[type=date]');
    if (date) { date.value = v.date; date.setAttribute('value', v.date); done.date = true; }

    // 옵션 value 가 전부 "" 라 글자로 고른다.
    const sel = table.querySelector('select');
    if (sel) {
      [...sel.options].forEach((o, i) => {
        const on = o.textContent.trim() === v.kind;
        o.selected = on;
        if (on) { o.setAttribute('selected', 'selected'); sel.selectedIndex = i; } else o.removeAttribute('selected');
      });
      done.kind = sel.selectedIndex > 0;
    }

    done.time = setText(cellAfter(/^근무 예상 시간/), `${v.start} ~ ${v.end}`);
    done.rest = setText(cellAfter(/^휴게 시간/), v.rest || '-');
    done.purpose = setText(cellAfter(/^근무목적/), v.purpose);

    for (const e of [date, sel].filter(Boolean)) {
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    }
    table.dispatchEvent(new Event('input', { bubbles: true }));
    return done;
  }

  // 양식 창이 다 뜰 때까지 기다렸다가 채운다. 편집기는 창이 열리고 몇 초 뒤에 생긴다.
  function waitAndFill(win, v, { timeout = 30000, every = 400 } = {}) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        const table = findTable(win);
        if (table) return resolve(fillTable(table, v));
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, every);
      };
      tick();
    });
  }

  GW.weekend = {
    FORM_ID, KINDS, PENDING_TTL,
    nextWeekend, suggestRest, check, formHash, isNewForm,
    findTable, fillTable, waitAndFill,
    _t: { toMin, toHm },
  };
})(typeof window !== 'undefined' ? window : globalThis);
