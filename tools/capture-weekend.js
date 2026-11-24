// 주말(휴일)근무 신청이 그룹웨어에서 어떤 요청으로 오가는지 캡처한다.
//
// 휴가 신청(src/lib/leave.js)과 같은 근태신청 화면을 쓰는지, 다른 양식인지 아직 모른다.
// 그래서 주소를 미리 거르지 않고 /human/ · 결재(eap/appro) 쪽 요청을 전부 잡는다.
// 결재 팝업(window.open)에도 같은 후크를 심는다.
//
// 보고 싶은 것
//   1) 근무 종류 코드 — 주말·휴일근무의 atCd·linkAtCd·이름, 시간 입력 방식
//   2) 신청 순서 — 계산 → 검증 → 저장 → 결재문서 중 어떤 단계를 어떤 주소로 거치는지
//   3) 각 단계의 요청 본문과 응답(오류 메시지 포함)
//
// 쓰는 법
//   주말근무 신청은 새 창에서 열린다. 그 **신청 창의 콘솔**에 붙여 넣는다
//   (본 창에 붙여 두면 window.open 으로 열린 창에도 심기지만, 새 탭으로 열리면 안 닿는다).
//   그다음 종류 고르기 → 날짜·시간 넣기 → [임시저장] 까지 한다. [상신] 은 누르지 않는다.
//   임시저장 요청에 양식 칸이 전부 실려 가므로 그것만으로 충분하다.
//   끝나면 __wkDump() 를 부른다. 결과가 클립보드에 복사된다.
//   처음부터 다시 잡으려면 __wkReset().
//
// 화면이 새로 읽히면(메뉴 이동·새로고침) 후크가 사라진다. 잡은 것은 localStorage 에
// 남겨 두므로, 그럴 때는 새 화면에서 이 코드를 다시 붙여 넣고 이어서 하면 된다.
// 결재 팝업·iframe 콘솔에서도 __wkDump() 를 부를 수 있다.
(() => {
  const LS = '__wkcap';
  const load = () => { try { return JSON.parse(localStorage.getItem(LS) || '[]'); } catch (_) { return []; } };
  const save = (a) => { try { localStorage.setItem(LS, JSON.stringify(a)); } catch (_) {
    // 넘치면 응답을 줄여서라도 남긴다.
    try { localStorage.setItem(LS, JSON.stringify(a.map((r) => ({ ...r, res: r.res && r.res.slice(0, 4000) })))); } catch (_) {}
  } };
  const cap = load();
  const WANT = /\/human\/|apiUtilEap|\/eap\/|appro|attend|0h[a-z]\d{5}/i;
  const NOISE = /\.(js|css|png|svg|woff2?|ico)(\?|$)|heartbeat|alarm|notice|polling|unread/i;

  function hook(w, tag) {
    if (!w || w.__wkHooked) return;
    try { w.__wkHooked = true; } catch (_) { return; }
    const keep = (rec) => {
      if (!WANT.test(rec.url || '') || NOISE.test(rec.url || '')) return;
      if (rec.res && rec.res.length > 60000) rec.res = rec.res.slice(0, 60000);
      cap.push(rec); save(cap);
    };
    try { w.__wkDump = (...a) => window.__wkDump(...a); w.__wkReset = () => window.__wkReset(); } catch (_) {}

    // 요청 본문을 글자로. 결재 양식은 FormData·URLSearchParams 로 보내기도 한다.
    const bodyText = (b) => {
      try {
        if (b == null) return null;
        if (typeof b === 'string') return b;
        if (b instanceof w.URLSearchParams) return b.toString();
        if (b instanceof w.FormData) {
          const o = {};
          for (const [k, v] of b.entries()) o[k] = typeof v === 'string' ? v : `[파일 ${v.name || ''}]`;
          return JSON.stringify(o);
        }
      } catch (_) {}
      return null;
    };

    // 화면 쪽 코드가 눈치채지 못하게 원래 객체는 그대로 두고 동작만 덧붙인다.
    // (생성자를 바꿔치기하면 XMLHttpRequest.DONE·instanceof 를 쓰는 라이브러리가
    //  깨진다 — 상신이 고장 난 원인이었다.) 캡처에서 나는 오류는 전부 삼킨다.
    const of = w.fetch;
    if (of) {
      w.fetch = function (input, init) {
        const p = of.apply(this, arguments);
        try {
          const url = String(typeof input === 'string' ? input : (input && input.url) || '');
          const rec = { tag, at: Date.now(), method: (init && init.method) || (input && input.method) || 'GET',
            url, body: bodyText(init && init.body) };
          p.then((res) => {
            rec.status = res.status;
            res.clone().text().then((t) => { rec.res = t; keep(rec); }, () => keep(rec));
          }, () => {});
        } catch (_) {}
        return p;
      };
    }

    const XP = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
    if (XP && !XP.__wkPatched) {
      XP.__wkPatched = true;
      const open = XP.open, send = XP.send;
      XP.open = function (m, u) {
        try { this.__wkRec = { tag, at: 0, method: m, url: String(u), body: null }; } catch (_) {}
        return open.apply(this, arguments);
      };
      XP.send = function (b) {
        try {
          const rec = this.__wkRec;
          if (rec) {
            rec.at = Date.now();
            rec.body = bodyText(b);
            this.addEventListener('loadend', () => {
              try {
                rec.status = this.status;
                if (!this.responseType || this.responseType === 'text') rec.res = String(this.responseText);
                else if (this.responseType === 'json') rec.res = JSON.stringify(this.response);
                keep(rec);
              } catch (_) {}
            });
          }
        } catch (_) {}
        return send.apply(this, arguments);
      };
    }

    // 결재 팝업도 같은 출처라 전역에 손댈 수 있다.
    const oo = w.open;
    w.open = function () {
      const child = oo.apply(this, arguments);
      try { hook(child, 'popup'); } catch (_) {}
      // 팝업이 새 문서를 읽으면서 전역이 바뀌므로 로드 뒤에 한 번 더 심는다.
      try { child && child.addEventListener('load', () => { child.__wkHooked = false; hook(child, 'popup'); }); } catch (_) {}
      return child;
    };
  }
  hook(window, 'main');

  // 화면 일부가 같은 출처 iframe 안에서 돌 수 있다. 있는 것과 새로 생기는 것 모두에 심는다.
  const hookFrame = (f) => {
    const go = () => { try { f.contentWindow.__wkHooked = false; hook(f.contentWindow, 'frame'); } catch (_) {} };
    try { if (f.contentWindow && !f.contentWindow.__wkHooked) hook(f.contentWindow, 'frame'); } catch (_) {}
    f.addEventListener('load', go);
  };
  document.querySelectorAll('iframe').forEach(hookFrame);
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => {
    if (n.tagName === 'IFRAME') hookFrame(n);
    else if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(hookFrame);
  }))).observe(document.documentElement, { childList: true, subtree: true });

  const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
  const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s);
  // 응답이 크면 모양만 남긴다 — 배열은 길이와 앞 두 개.
  const shrink = (v, depth = 0) => {
    if (Array.isArray(v)) return v.length > 2 ? [...v.slice(0, 2).map((x) => shrink(x, depth + 1)), `…총 ${v.length}개`] : v.map((x) => shrink(x, depth + 1));
    if (v && typeof v === 'object') {
      if (depth > 4) return '{…}';
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, depth + 1)]));
    }
    return typeof v === 'string' ? clip(v, 300) : v;
  };

  // 응답 어디에든 atCd 가 든 항목이 있으면 코드표로 모은다 — 주말근무 코드가 여기서 나온다.
  const codes = new Map();
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (v.atCd != null && (v.atNm || v.atItemNm)) {
      const k = `${v.atCd}|${v.linkAtCd || ''}`;
      if (!codes.has(k)) codes.set(k, Object.fromEntries(['atCd', 'atNm', 'linkAtCd', 'atItemNm', 'atItemCd',
        'groupCd', 'timeSetFg', 'workTp', 'useYn'].filter((x) => v[x] !== undefined).map((x) => [x, v[x]])));
    }
    Object.values(v).forEach(walk);
  };

  window.__wkReset = () => { cap.length = 0; save(cap); return '비웠습니다'; };

  window.__wkDump = () => {
    codes.clear();
    // 이전 화면에서 잡아 둔 것도 합친다 (새로고침 뒤 다시 붙여 넣은 경우).
    const saved = load();
    if (saved.length > cap.length) { cap.length = 0; cap.push(...saved); }
    const t0 = cap.length ? cap[0].at : 0;
    const 요청 = cap.map((r) => {
      const res = parse(r.res);
      if (res) walk(res);
      const body = parse(r.body);
      return {
        t: `+${((r.at - t0) / 1000).toFixed(1)}s`,
        창: r.tag,
        method: r.method,
        url: r.url.split('?')[0].replace(/^https?:\/\/[^/]+/, ''),
        query: r.url.includes('?') ? clip(r.url.split('?')[1], 300) : undefined,
        status: r.status,
        요청: body ? shrink(body) : clip(r.body, 1500),
        결과: res ? (res.resultCode !== undefined ? `${res.resultCode} ${res.resultMsg || ''}`.trim() : undefined) : undefined,
        응답: res ? shrink(res.resultData !== undefined ? res.resultData : res) : clip(r.res, 600),
      };
    });
    const 코드표 = [...codes.values()].sort((a, b) => String(a.atCd).localeCompare(String(b.atCd)));
    // 근무 관련으로 보이는 것만 따로 — 이름에 근무·휴일·주말·특근·연장이 든 것.
    const 근무코드 = 코드표.filter((c) => /근무|휴일|주말|특근|연장|초과/.test(`${c.atNm || ''} ${c.atItemNm || ''}`));

    const out = { 근무코드, 요청, 코드표 };
    const s = JSON.stringify(out, null, 1);
    console.log(s);
    try { copy(s); } catch (_) {}
    return `요청 ${요청.length}건 · 코드 ${코드표.length}개(근무 관련 ${근무코드.length}) — 클립보드에 복사했습니다`;
  };

  return `준비됨 (지금까지 ${cap.length}건) — 주말근무 신청을 결재 팝업이 뜨는 데까지 진행한 뒤 __wkDump()`;
})();
