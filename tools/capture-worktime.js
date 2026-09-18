// "추가로 받은 근무시간" 이 어디로 오는지 찾는다.
//
// 회사가 근무시간을 얹어 주는 경우(스마데 등) 개인근무시간현황에는 보이는데
// 확장에는 안 잡힌다. 둘 중 하나다 —
//   (가) 근무시간 행(getWorkTimeList)의 우리가 안 쓰는 필드에 들어 있다
//   (나) 근태신청 목록(0hp00001)에 있는데 이름이 "휴가|연차|…" 에 안 걸려 버려진다
// 어느 쪽인지 봐야 고칠 수 있어서, 원본 응답을 그대로 꺼낸다.
//
// 쓰는 법: gw.goorm.io 본 창 콘솔에 붙여 넣고,
//   1) 개인근무시간현황(근태 > 개인근무시간현황) 을 연다
//   2) 2시간이 붙은 그 달로 이동한다
//   3) 근태신청 목록도 한 번 연다
//   4) __dumpWork('2026-09-17')   ← 2시간이 붙은 날짜
(() => {
  const cap = (window.__capW = window.__capW || []);

  const push = (rec) => { cap.push(rec); if (cap.length > 400) cap.shift(); };

  const of = window.fetch;
  if (of && !window.__capWHooked) {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url);
      const rec = { url, method: (init && init.method) || 'GET',
        body: init && typeof init.body === 'string' ? init.body.slice(0, 800) : null };
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
        if (rec) rec.body = typeof b === 'string' ? b.slice(0, 800) : null;
        x.addEventListener('loadend', () => {
          if (!rec) return;
          rec.status = x.status;
          try { rec.res = String(x.responseText); } catch (_) {}
        });
        return send.apply(x, arguments);
      };
      return x;
    };
    window.__capWHooked = true;
  }

  // 그 날짜가 들어 있는 응답에서, 값이 있는 필드만 추린다.
  // 분 단위로 보이는 숫자(0 아님)와 이름처럼 보이는 문자열이 단서다.
  function fields(obj, dt, out, path, depth) {
    if (!obj || typeof obj !== 'object' || (depth || 0) > 5) return out;
    if (Array.isArray(obj)) {
      for (const v of obj) fields(v, dt, out, path, (depth || 0) + 1);
      return out;
    }
    const mine = Object.values(obj).some((v) => String(v) === dt);
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') { fields(v, dt, out, `${path}${k}.`, (depth || 0) + 1); continue; }
      if (!mine) continue;
      if (v === null || v === '' || v === 0 || v === '0' || v === 'N' || v === '-') continue;
      out.push(`${path}${k} = ${JSON.stringify(v)}`);
    }
    return out;
  }

  // 어느 날이 "그 날" 인지 모를 때. 한 달치를 한 줄씩 훑어서 튀는 날을 찾는다.
  // 인정근무(appworkTm)가 체류-제외-외출 과 안 맞는 날이 곧 얹어 준 시간이 있는 날이다.
  window.__dumpMonth = () => {
    const rows = [];
    const apps = [];
    for (const r of cap) {
      if (!r.res) continue;
      let j; try { j = JSON.parse(r.res); } catch (_) { continue; }
      collect(j, rows, apps, 0);
    }
    const seen = new Set();
    const line = (r) => {
      const hm = (v) => (/^\d{4}$/.test(String(v)) ? `${String(v).slice(0, 2)}:${String(v).slice(2)}` : '----');
      const span = (() => {
        const p = (v) => (/^\d{4}$/.test(String(v)) ? +String(v).slice(0, 2) * 60 + +String(v).slice(2) : null);
        const a = p(r.appcomeTm || r.comeTm), b = p(r.appleaveTm || r.leaveTm);
        return a != null && b != null ? (b >= a ? b - a : b + 1440 - a) : null;
      })();
      const ex = r.exceptworkTm || 0, og = r.outgoworkTm || 0;
      const expect = span == null ? null : span - ex - og;
      const gap = expect == null || r.appworkTm == null ? null : r.appworkTm - expect;
      return [
        String(r.atDt).slice(4, 6) + '/' + String(r.atDt).slice(6),
        (r.atNm || r.attresultNm || '-').padEnd(8),
        `인정${String(r.appworkTm ?? '-').padStart(4)}`,
        `체류${String(span ?? '-').padStart(4)}`,
        `제외${String(ex).padStart(3)}`,
        `외출${String(og).padStart(3)}`,
        `소정${String(r.selfCommuteStandardWorkTm ?? '-').padStart(4)}`,
        `${hm(r.appcomeTm || r.comeTm)}~${hm(r.appleaveTm || r.leaveTm)}`,
        gap ? `  ★차이 ${gap > 0 ? '+' : ''}${gap}분` : '',
      ].join(' ');
    };
    const body = rows
      .filter((r) => r.atDt && !seen.has(r.atDt) && seen.add(r.atDt))
      .sort((a, b) => String(a.atDt).localeCompare(String(b.atDt)))
      .map(line).join('\n');
    const ap = apps.map((a) => `  ${a.startDt}~${a.endDt} ${a.atItemNm || ''} ${a.atNm || ''}`
      + ` ${a.startTm || ''}~${a.endTm || ''} ${a.approStateNm || ''}`
      + ` atCd=${a.atCd || '?'} atItemCd=${a.atItemCd || '?'}`).join('\n');
    const s2 = `[근무시간 행]\n${body || '(없음)'}\n\n[근태신청 ${apps.length}건]\n${ap || '(없음)'}`;
    console.log(s2);
    try { copy(s2); } catch (_) {}
    return '클립보드에 복사했습니다';
  };

  // 합계는 날짜가 안 붙어 있어서 __dumpWork 의 필터에 걸리지 않는다.
  // 응답을 통째로 보되, 긴 배열은 한 건만 남겨 모양만 본다.
  // 화면에 보이는 "총 근무시간" 이 어느 필드인지 여기서 찾는다.
  window.__dumpShape = (urlPart) => {
    const want = new RegExp(urlPart || 'getWorkTimeList|hpd0210|worktm|total|sum', 'i');
    const rows = cap.filter((r) => want.test(r.url || '') && r.res);
    if (!rows.length) {
      return `못 찾았습니다. 잡힌 요청: ${[...new Set(cap.map((r) => (r.url || '').split('?')[0]))].join('\n')}`;
    }
    const trim = (o, depth) => {
      if (Array.isArray(o)) {
        return o.length ? [`…배열 ${o.length}건 중 1건`, trim(o[0], depth + 1)] : [];
      }
      if (!o || typeof o !== 'object') return o;
      if (depth > 6) return '…';
      const out = {};
      for (const [k, v] of Object.entries(o)) out[k] = trim(v, depth + 1);
      return out;
    };
    const out = rows.map((r) => {
      let j; try { j = JSON.parse(r.res); } catch (_) { return `── ${r.url}\n(JSON 아님) ${String(r.res).slice(0, 300)}`; }
      return `── ${r.method} ${r.url}\n요청: ${r.body || '(없음)'}\n${JSON.stringify(trim(j, 0), null, 1)}`;
    });
    // 같은 요청이 여러 번 잡히므로 중복은 접는다
    const uniq = [...new Set(out)];
    const s2 = uniq.join('\n\n');
    console.log(s2);
    try { copy(s2); } catch (_) {}
    return `${uniq.length}건 — 클립보드에 복사했습니다`;
  };

  // 응답 모양이 화면마다 달라서 키 이름으로 찾는다.
  function collect(o, rows, apps, depth) {
    if (!o || typeof o !== 'object' || depth > 6) return;
    if (Array.isArray(o)) { for (const v of o) collect(v, rows, apps, depth + 1); return; }
    if (o.atDt && ('appworkTm' in o || 'basicworkTm' in o)) rows.push(o);
    if (o.startDt && o.endDt && (o.atNm || o.atItemNm)) apps.push(o);
    for (const v of Object.values(o)) collect(v, rows, apps, depth + 1);
  }

  window.__dumpWork = (dateKey) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '')) return '__dumpWork("2026-09-17") 처럼 날짜를 주세요';
    const dt = dateKey.replace(/-/g, '');
    const want = /getWorkTimeList|0hp00001|hpd0210|hpd0120|worktm|attend/i;
    const rows = cap.filter((r) => want.test(r.url || '') && r.res);
    const out = rows.map((r) => {
      let j; try { j = JSON.parse(r.res); } catch (_) { return null; }
      const f = fields(j, dt, [], '', 0);
      if (!f.length) return null;
      return `── ${r.method} ${r.url}\n${[...new Set(f)].join('\n')}`;
    }).filter(Boolean);
    const s = out.length
      ? `${dateKey} 에 걸린 응답 ${out.length}건\n\n${out.join('\n\n')}`
      : `${dateKey} 가 들어 있는 응답을 못 찾았습니다. 그 달로 이동한 뒤 다시 실행해 주세요.`
        + `\n(잡힌 요청 ${cap.length}건: ${[...new Set(cap.map((r) => (r.url || '').split('?')[0].split('/').pop()))].join(', ')})`;
    console.log(s);
    try { copy(s); } catch (_) {}
    return `${out.length}건 — 클립보드에 복사했습니다`;
  };

  return '준비됨 — 개인근무시간현황(또는 동의)을 그 달로 열고 근태신청 목록도 한 번 연 뒤,\n'
    + '  __dumpMonth()            ← 한 달치를 훑어 "★차이" 가 붙은 날을 찾는다\n'
    + '  __dumpWork("2026-09-11") ← 특정 날짜의 원본 필드를 전부 본다\n'
    + '  __dumpShape()            ← 응답 전체 모양 (합계가 어디 있는지 찾을 때)';
})();
