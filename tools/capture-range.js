// 여러 날짜에 걸친 휴가·휴게 신청이 어떤 모양인지 본다.
//
// 지금 우리는 하루짜리만 만든다 — startDt·endDt·datePeriod 에 같은 날짜를 박아
// 넣는다. API 는 이미 범위를 받게 생겼지만, 여러 날일 때 create 가
//   (가) 항목 하나에 startDt~endDt 를 담는지
//   (나) 날짜마다 항목을 하나씩 만들어 배열로 보내는지
// 를 모른다. 이건 실제 신청을 지켜보는 수밖에 없다 — 우리가 지어내서 눌러 볼 수는 없다.
//
// "식사 휴게" 처럼 우리가 모르는 종류의 atCd 를 찾는 데도 쓴다 (__dumpTypes).
// 코드를 지어낼 수는 없다 — 틀린 값으로 신청하면 엉뚱한 결재가 올라간다.
//
// 쓰는 법:
//   1) gw.goorm.io 본 창 콘솔에 붙여 넣는다
//   2) 평소대로 **여러 날짜** 휴가(또는 자율휴게)를 신청한다.
//      결재 팝업이 뜨는 데까지만 하면 된다. 상신은 안 해도 된다.
//      (가능하면 연속 3일 이상, 중간에 주말이 끼면 더 좋다)
//   3) __dumpRange()
//
// 하루짜리도 한 번 해 두면 무엇이 달라지는지 바로 보인다.
(() => {
  const cap = (window.__capR = window.__capR || []);
  const push = (r) => { cap.push(r); if (cap.length > 400) cap.shift(); };

  // 결재 팝업은 window.open 으로 뜨고 같은 출처라 거기에도 후크를 심을 수 있다.
  function hook(w, tag) {
    if (!w || w.__capRHooked) return;
    try { w.__capRHooked = true; } catch (_) { return; }

    const of = w.fetch;
    if (of) {
      w.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url);
        const rec = { tag, url, method: (init && init.method) || 'GET',
          body: init && typeof init.body === 'string' ? init.body : null };
        push(rec);
        return of.apply(this, arguments).then(async (res) => {
          rec.status = res.status;
          try { rec.res = (await res.clone().text()).slice(0, 20000); } catch (_) {}
          return res;
        });
      };
    }
    const OX = w.XMLHttpRequest;
    if (OX) {
      w.XMLHttpRequest = function () {
        const x = new OX(); let rec = null;
        const open = x.open, send = x.send;
        x.open = function (m, u) { rec = { tag, url: u, method: m }; push(rec); return open.apply(x, arguments); };
        x.send = function (b) {
          if (rec) rec.body = typeof b === 'string' ? b : null;
          x.addEventListener('loadend', () => {
            if (!rec) return;
            rec.status = x.status;
            try { rec.res = String(x.responseText).slice(0, 20000); } catch (_) {}
          });
          return send.apply(x, arguments);
        };
        return x;
      };
    }
  }
  hook(window, 'main');

  if (!window.__capROpen) {
    window.__capROpen = window.open;
    window.open = function () {
      const child = window.__capROpen.apply(window, arguments);
      const t = setInterval(() => {
        try {
          if (!child || child.closed) return clearInterval(t);
          if (child.location.href && child.location.href !== 'about:blank') {
            hook(child, 'popup');
            if (child.document.readyState === 'complete') clearInterval(t);
          }
        } catch (_) { /* 아직 about:blank */ }
      }, 10);
      setTimeout(() => clearInterval(t), 60000);
      return child;
    };
  }

  // 우리가 쓰는 호출들. 날짜가 어디에 어떻게 들어가는지가 관심사다.
  const WANT = /calculateApplicationDays|validateNew|0hr00011|attendapplication\/create|saveLinkKey|GetLinkKey|SetEnageGroup/i;

  // 날짜처럼 생긴 값(YYYYMMDD)과 일수·시간 항목을 눈에 띄게 뽑아 준다.
  const DATEY = /^(atDt|baseAtDt|startDt|endDt|startDate|endDate|from|to|appDy|appDyFg|appTm|ycUseCnt|repeatTp|holidayYn|calculateOption|startTm|endTm)$/;

  function marks(o, path, out, depth) {
    if (!o || typeof o !== 'object' || (depth || 0) > 6) return out;
    if (Array.isArray(o)) {
      out.push(`${path} = 배열 ${o.length}건`);
      o.forEach((v, i) => marks(v, `${path}[${i}]`, out, (depth || 0) + 1));
      return out;
    }
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object') { marks(v, `${path}.${k}`, out, (depth || 0) + 1); continue; }
      if (DATEY.test(k) || /^\d{8}$/.test(String(v))) out.push(`${path}.${k} = ${JSON.stringify(v)}`);
    }
    return out;
  }

  window.__dumpRange = () => {
    const rows = cap.filter((r) => WANT.test(r.url || ''));
    if (!rows.length) {
      return '신청 호출을 못 잡았습니다. 이 스크립트를 먼저 붙여 넣고 신청을 진행해 주세요.\n'
        + `잡힌 요청 ${cap.length}건`;
    }
    const out = rows.map((r, i) => {
      const name = (r.url || '').split('?')[0].split('/').pop();
      let body = r.body;
      try { body = JSON.stringify(JSON.parse(r.body), null, 1); } catch (_) {}
      let hi = '';
      try { hi = [...new Set(marks(JSON.parse(r.body), '', [], 0))].join('\n  '); } catch (_) {}
      return `── ${i}  ${r.method} ${name}  (${r.tag}, status=${r.status})\n`
        + (hi ? `날짜·일수만 추리면:\n  ${hi}\n\n` : '')
        + `요청 전문:\n${String(body || '(없음)').slice(0, 4000)}\n\n`
        + `응답(앞부분):\n${String(r.res || '(없음)').slice(0, 800)}`;
    });
    const s = `[신청 호출 ${rows.length}건]\n\n${out.join('\n\n')}`;
    console.log(s);
    try { copy(s); } catch (_) {}
    return `${rows.length}건 — 클립보드에 복사했습니다`;
  };

  // 근태신청 항목(atCd). 근무시간 구분(9202 정상근무 · 9203 중식 …)과 섞이지 않게
  // 신청 항목의 모양을 요구한다 — atItemCd 나 timeSetFg 를 가진 것만 센다.
  // 그것들은 calculateApplicationDays 응답의 worktimeList 에 들어 있어서,
  // atCd+이름만 보면 그쪽이 딸려 온다(실제로 딸려 왔다).
  //
  // 다만 이건 거들 뿐이다. 확실한 것은 __dumpRange() 다 — 그 신청서를 실제로
  // 한 번 진행하면 0hr00011·create 항목에 atCd·linkAtCd 가, SetEnageGroup 에
  // formId·formDTp·formNm 이 그대로 찍힌다. 양식까지 알아야 붙일 수 있다.
  window.__dumpTypes = () => {
    const hits = [];
    const walk = (o, where, depth) => {
      if (!o || typeof o !== 'object' || depth > 7) return;
      if (Array.isArray(o)) { for (const v of o) walk(v, where, depth + 1); return; }
      const nm = o.atNm || o.atItemNm;
      const shaped = o.atItemCd != null || o.timeSetFg != null;
      if (o.atCd && nm && shaped) {
        hits.push(`  atCd=${String(o.atCd).padEnd(6)} linkAtCd=${String(o.linkAtCd || '-').padEnd(6)}`
          + ` atItemCd=${String(o.atItemCd || '-').padEnd(4)} timeSetFg=${String(o.timeSetFg || '-').padEnd(6)}`
          + ` ${nm}   ← ${where}`);
      }
      for (const v of Object.values(o)) walk(v, where, depth + 1);
    };
    for (const r of cap) {
      if (!r.res) continue;
      let j; try { j = JSON.parse(r.res); } catch (_) { continue; }
      walk(j, (r.url || '').split('?')[0].split('/').pop(), 0);
    }
    const uniq = [...new Set(hits)].sort();
    const s2 = uniq.length
      ? `[근태신청 항목 ${uniq.length}종]\n${uniq.join('\n')}\n\n`
        + '양식(formId·formDTp·formNm)은 여기에 안 나옵니다. 그 신청서를 결재 팝업까지\n'
        + '한 번 진행한 뒤 __dumpRange() 를 주세요.'
      : '신청 항목을 못 찾았습니다.\n'
        + '이건 목록 화면에 잘 안 나옵니다 — 그 신청서를 실제로 한 번 진행(결재 팝업까지)한 뒤\n'
        + '__dumpRange() 를 주시면 atCd·linkAtCd·양식이 전부 찍힙니다.';
    console.log(s2);
    try { copy(s2); } catch (_) {}
    return uniq.length ? `${uniq.length}종 — 클립보드에 복사했습니다` : s2;
  };

  window.__capRClear = () => { cap.length = 0; return '비웠습니다. 이제 다음 신청을 해 보세요.'; };

  return '준비됨 —\n'
    + '  __dumpRange()  ← 이게 확실합니다. 그 신청서를 결재 팝업까지 한 번 진행한 뒤\n'
    + '                 atCd·linkAtCd·양식(formId·formDTp·formNm)이 전부 찍힙니다\n'
    + '  __dumpTypes()  근태신청 항목만 추려 보기 (거들 뿐)\n'
    + '  __capRClear()  비우고 다시 (하루짜리와 비교할 때)';
})();
