// 팀 휴가 현황 화면이 쓰는 API 를 찾는다.
//
// gw.goorm.io 콘솔에 붙여 실행한 뒤, 휴가자가 보이는 화면을 열고 __dumpTeam() 한다.
//   일정:      /#/UE/UEA/UEA0000
//   부서 근태:  /#/HP/HPD0110/HPD0110 의 "부서 근태일정"
//
// 어떤 경로인지 몰라서 먼저 목록만 뽑고(index), 사람 이름이 들어 있는 응답만
// 골라서 본문을 붙인다. 응답 전체를 다 뜨면 너무 커진다.
(() => {
  const cap = (window.__cap = window.__cap || []);

  function hook(w) {
    if (!w || w.__capHooked) return;
    try { w.__capHooked = true; } catch (_) { return; }

    const of = w.fetch;
    if (of) {
      w.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url);
        const rec = { url, at: Date.now(), method: (init && init.method) || 'GET',
                      body: init && typeof init.body === 'string' ? init.body : null };
        cap.push(rec);
        return of.apply(this, arguments).then(async (res) => {
          rec.status = res.status;
          try { rec.res = (await res.clone().text()); } catch (_) {}
          return res;
        });
      };
    }

    const OX = w.XMLHttpRequest;
    if (OX) {
      w.XMLHttpRequest = function () {
        const x = new OX();
        let rec = null;
        const open = x.open, send = x.send;
        x.open = function (m, u) { rec = { url: u, method: m, at: Date.now() }; cap.push(rec); return open.apply(x, arguments); };
        x.send = function (b) {
          if (rec) rec.body = typeof b === 'string' ? b : null;
          x.addEventListener('loadend', () => {
            if (!rec) return;
            rec.status = x.status;
            try { rec.res = String(x.responseText); } catch (_) {}
          });
          return send.apply(x, arguments);
        };
        return x;
      };
    }
  }
  hook(window);

  // 정적 자산은 뺀다. 남의 이름·휴가 종류가 들어 있으면 유력 후보다.
  const SKIP = /\.(js|css|png|json|woff2?)(\?|$)|langPack|asset-manifest/i;
  const NAMEY = /연차|반차|휴가|휴게|empNm|korNm|userName|atCdNm|atNm/;

  window.__dumpTeam = () => {
    const rows = cap.filter((r) => r.url && !SKIP.test(r.url));
    const index = rows.map((r, i) =>
      `${i}  ${r.method} ${r.url}  status=${r.status} res=${(r.res || '').length}B`
      + (NAMEY.test(r.res || '') ? '   ★후보' : ''));
    const hits = rows.filter((r) => NAMEY.test(r.res || '')).map((r) => ({
      url: r.url, method: r.method, status: r.status,
      body: (r.body || '').slice(0, 1200),
      res: (r.res || '').slice(0, 5000),
    }));
    const s = JSON.stringify({ index, hits }, null, 1);
    console.log(s);
    try { copy(s); } catch (_) {}
    return `전체 ${rows.length}건 / 후보 ${hits.length}건 — 클립보드 복사됨`;
  };

  return '준비됨 — 휴가자가 보이는 화면을 열고 __dumpTeam()';
})();
