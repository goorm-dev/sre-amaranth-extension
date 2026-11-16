// 무급휴가가 그룹웨어에서 어떻게 잡히는지 캡처한다.
//
// 두 가지를 본다.
//   1) 신청 — 무급휴가의 atCd·linkAtCd·이름, 서버가 계산한 인정 시간·연차 차감
//   2) 집계 — 무급휴가를 쓴 날의 근태 행. 이름(atNm)이 뭐로 찍히는지,
//      소정(selfCommuteStandardWorkTm)과 인정근무(appworkTotalTm)가 몇 분인지.
//      확장은 "무급" 이 든 휴가 이름을 보고 서버가 빼먹은 8시간을 채운다 (src/lib/calc.js).
//
// 쓰는 법:
//   gw.goorm.io 본 창 콘솔에 붙여 넣는다. 그다음 아래 중 할 수 있는 것을 한다.
//   - 근태신청에서 무급휴가를 고르고 날짜를 넣은 뒤 [추가] 까지 누른다.
//     [신청완료] 를 누르면 결재 초안이 생긴다 — 보고 싶은 값은 [추가] 까지만 해도 다 잡힌다.
//   - 무급휴가를 이미 쓴 날이 있으면 근무현황(개인 근태) 화면에서 그 달을 연다.
//   끝나면 __unpaidDump() 를 부른다. 결과가 클립보드에 복사된다.
(() => {
  const cap = (window.__unpaid = window.__unpaid || []);
  const WANT = /calculateApplicationDays|validateNew|0hr00011|attendapplication\/create|getWorkTimeList|0hp00001/;

  if (!window.__unpaidHooked) {
    window.__unpaidHooked = true;
    const keep = (url, body, text, status) => {
      if (!WANT.test(url || '')) return;
      cap.push({ url: String(url).split('?')[0], body, status, res: text });
    };

    const of = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url);
      const body = init && typeof init.body === 'string' ? init.body : null;
      return of.apply(this, arguments).then(async (res) => {
        try { keep(url, body, await res.clone().text(), res.status); } catch (_) {}
        return res;
      });
    };

    const OX = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const x = new OX();
      let url = null, body = null;
      const open = x.open, send = x.send;
      x.open = function (m, u) { url = u; return open.apply(x, arguments); };
      x.send = function (b) {
        body = typeof b === 'string' ? b : null;
        x.addEventListener('loadend', () => { try { keep(url, body, String(x.responseText), x.status); } catch (_) {} });
        return send.apply(x, arguments);
      };
      return x;
    };
  }

  const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
  const APP_KEYS = ['atCd', 'linkAtCd', 'atNm', 'timeSetFg', 'startDt', 'endDt', 'startTm', 'endTm',
    'appDy', 'appTm', 'ycUseCnt', 'ycGrantCnt', 'groupCd', 'timeCd', 'workTp'];

  window.__unpaidDump = () => {
    const out = { 신청: [], 신청목록: [], 근태행: [] };
    for (const r of cap) {
      const req = parse(r.body) || {};
      const res = parse(r.res) || {};
      const data = res.resultData;

      if (/calculateApplicationDays/.test(r.url)) {
        out.신청.push({
          단계: '계산',
          요청: pick(req, ['atCd', 'linkAtCd', 'startDate', 'endDate', 'startTime', 'endTime', 'calculateOption']),
          응답: pick(data, ['daysCnt', 'applicationDaysCnt', 'minutes', 'applicationMinutes', 'dailyAppTm',
            'ycUseCnt', 'dailyYcUseCnt', 'exhaustDaysCnt']),
          오류: res.resultCode === 0 ? undefined : res.resultMsg,
        });
      } else if (/validateNew/.test(r.url)) {
        const v = data || {};
        out.신청.push({
          단계: '검증',
          요청: pick(req.newItem, APP_KEYS),
          걸린것: Object.fromEntries(Object.entries(v).filter(([, x]) => Array.isArray(x) && x.length)
            .map(([k, x]) => [k, x.length])),
          오류: res.resultCode === 0 ? undefined : res.resultMsg,
        });
      } else if (/0hr00011|attendapplication\/create/.test(r.url)) {
        out.신청.push({
          단계: /0hr00011/.test(r.url) ? '신청완료' : '결재문서',
          요청: (req.applicationList || []).map((a) => pick(a, APP_KEYS)),
          응답: typeof data === 'string' ? data : pick(data, ['appSq', 'titleDc', 'approState']),
          오류: res.resultCode === 0 ? undefined : res.resultMsg,
        });
      } else if (/0hp00001/.test(r.url)) {
        // 개인 근태신청 목록. 무급이 든 것만 추린다.
        const apps = ((data && data.atPopUpDetailInfos) || []).flatMap((g) => g.attendApplications || []);
        for (const a of apps) {
          if (!/무급/.test(`${a.atItemNm || ''} ${a.atNm || ''}`)) continue;
          out.신청목록.push(pick(a, ['atItemNm', 'atNm', 'atCd', 'linkAtCd', 'startDt', 'endDt',
            'startTm', 'endTm', 'approState', 'approStateNm']));
        }
      } else if (/getWorkTimeList/.test(r.url)) {
        // 근태 행. 휴가·휴무가 찍힌 날만 남긴다 (유급과 견주려고 무급만 거르지 않는다).
        for (const w of data || []) {
          if (!w.atNm || w.atNm === '-') continue;
          out.근태행.push(pick(w, ['atDt', 'atNm', 'atCd', 'selfCommuteStandardWorkTm', 'appworkTotalTm',
            'appworkTm', 'basicworkTm', 'appcomeTm', 'appleaveTm', 'comeTm', 'leaveTm', 'attresultNm', 'holiYn']));
        }
      }
    }
    const seen = new Set();
    out.근태행 = out.근태행.filter((w) => !seen.has(w.atDt) && seen.add(w.atDt));

    const s = JSON.stringify(out, null, 1);
    console.log(s);
    try { copy(s); } catch (_) {}
    return `신청 ${out.신청.length}건 · 무급 신청목록 ${out.신청목록.length}건 · 휴가 찍힌 근태행 ${out.근태행.length}건 — 클립보드에 복사했습니다`;
  };

  return '준비됨 — 무급휴가를 [추가] 까지 해 보거나, 무급휴가를 쓴 달의 근무현황을 연 뒤 __unpaidDump()';
})();
