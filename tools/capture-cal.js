// 그룹웨어 일정에 열쇠를 숨겨 둘 수 있는지 확인한다.
//
// 팀원이 아무것도 입력하지 않게 하려면 열쇠가 "사내 사람만 얻을 수 있는 곳" 에서
// 와야 한다. 사내 일정이 그런 곳이다 — gw 세션이 있어야 읽히고, 사외에서는 안 된다.
//
// 지금 우리는 sc111A03 을 근태캘린더(acalList:['1'])로만 부른다. 일반 일정도
// 같은 API 로 오는지, 온다면 제목이 어느 필드에 담기는지를 봐야 한다.
//
// 쓰는 법:
//   1) gw 일정에 아무 일정이나 하나 만든다. 제목을 정확히 이렇게:
//        [worktime] test1234
//      공개 범위는 "회사 전체" 또는 "부서 전체" 로 (혼자만 보는 일정이면 의미가 없다)
//   2) gw.goorm.io 본 창 콘솔에 이 파일을 붙여 넣는다
//   3) 일정 화면(UE > 일정)을 열고, 그 일정이 있는 달로 이동한다
//   4) __dumpCal()
(() => {
  const cap = (window.__capC = window.__capC || []);
  const push = (r) => { cap.push(r); if (cap.length > 300) cap.shift(); };

  if (!window.__capCHooked) {
    const of = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url);
      const rec = { url, method: (init && init.method) || 'GET',
        body: init && typeof init.body === 'string' ? init.body : null };
      push(rec);
      return of.apply(this, arguments).then(async (res) => {
        rec.status = res.status;
        try { rec.res = await res.clone().text(); } catch (_) {}
        return res;
      });
    };
    const OX = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const x = new OX(); let rec = null;
      const open = x.open, send = x.send;
      x.open = function (m, u) { rec = { url: u, method: m }; push(rec); return open.apply(x, arguments); };
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
    window.__capCHooked = true;
  }

  const MARK = 'worktime';

  // 값이 MARK 를 담은 필드를 경로째로 찾는다. 제목이 어느 키에 들어가는지 모르므로.
  function findMark(o, path, out, depth) {
    if (!o || typeof o !== 'object' || (depth || 0) > 8) return out;
    if (Array.isArray(o)) {
      o.forEach((v, i) => findMark(v, `${path}[${i}]`, out, (depth || 0) + 1));
      return out;
    }
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') { findMark(v, `${path}.${k}`, out, (depth || 0) + 1); continue; }
      if (typeof v === 'string' && v.includes(MARK)) out.push({ path: `${path}.${k}`, value: v, obj: o });
    }
    return out;
  }

  window.__dumpCal = () => {
    const rows = cap.filter((r) => r.res && /sc111|schres|\/ue\/|calendar|sch/i.test(r.url || ''));
    const hits = [];
    const seen = new Set();
    for (const r of rows) {
      let j; try { j = JSON.parse(r.res); } catch (_) { continue; }
      const f = findMark(j, '', [], 0);
      if (!f.length) continue;
      for (const h of f) {
        const k = r.url + h.path;
        if (seen.has(k)) continue;
        seen.add(k);
        hits.push(`── ${r.method} ${r.url}\n요청: ${(r.body || '(없음)').slice(0, 900)}\n`
          + `찾은 곳: ${h.path} = ${JSON.stringify(h.value)}\n`
          + `그 항목 전체:\n${JSON.stringify(h.obj, null, 1).slice(0, 1800)}`);
      }
    }
    const urls = [...new Set(rows.map((r) => (r.url || '').split('?')[0]))];
    const s = hits.length
      ? `"[worktime]" 를 담은 응답 ${hits.length}건\n\n${hits.join('\n\n')}`
      : `못 찾았습니다.\n일정 화면을 그 달로 열었는지, 제목에 "[worktime]" 이 들어갔는지 확인해 주세요.\n`
        + `살펴본 요청 ${rows.length}건:\n  ${urls.join('\n  ')}`;
    console.log(s);
    try { copy(s); } catch (_) {}
    return `${hits.length}건 — 클립보드에 복사했습니다`;
  };

  return '준비됨 — 일정 화면을 그 일정이 있는 달로 연 뒤 __dumpCal()';
})();
