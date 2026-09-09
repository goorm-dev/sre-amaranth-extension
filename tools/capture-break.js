// 휴게(외출) 신청 흐름 캡처.
//
// gw.goorm.io 본 창 콘솔에 붙여 실행한 뒤, 평소대로 휴게 신청을 한 번 한다.
// 결재 팝업이 뜨면 __dumpBreak() 로 결과를 복사한다.
//
// 휴가와 뼈대는 같을 것이다. 다른 것만 알아내면 된다:
//   - atCd / linkAtCd      (휴게·외출의 근태 항목 코드)
//   - formId / formDTp     (결재 양식. 연차휴가는 249 / HP_HPD0110_00011)
//   - 시간 구간을 어떻게 넣는지 (휴게는 근로시간에서 빠지므로 계산이 반대다)
(() => {
  const cap = (window.__cap = window.__cap || []);

  function hook(w, tag) {
    if (!w || w.__capHooked) return;
    try { w.__capHooked = true; } catch (_) { return; }

    const of = w.fetch;
    if (of) {
      w.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url);
        const rec = {
          tag, url, at: Date.now(),
          method: (init && init.method) || 'GET',
          body: init && typeof init.body === 'string' ? init.body : null,
        };
        cap.push(rec);
        return of.apply(this, arguments).then(async (res) => {
          rec.status = res.status;
          try { rec.res = (await res.clone().text()).slice(0, 12000); } catch (_) {}
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
        x.open = function (m, u) { rec = { tag, url: u, method: m, at: Date.now() }; cap.push(rec); return open.apply(x, arguments); };
        x.send = function (b) {
          if (rec) rec.body = typeof b === 'string' ? b : null;
          x.addEventListener('loadend', () => {
            if (!rec) return;
            rec.status = x.status;
            try { rec.res = String(x.responseText).slice(0, 12000); } catch (_) {}
          });
          return send.apply(x, arguments);
        };
        return x;
      };
    }
  }

  hook(window, 'main');

  const oOpen = window.open;
  window.open = function (url) {
    const child = oOpen.apply(this, arguments);
    cap.push({ tag: 'window.open', url: String(url), at: Date.now() });
    return child;
  };

  // 코드표(at00001·eap096A45)는 길어서 따로, 나머지는 요청/응답 그대로.
  const CODES = /at00001|eap096A45/i;
  const FLOW = /calculateApplicationDays|validateNew|0hr00011|attendapplication\/create|GetLinkKey|SetEnageGroup|saveLinkKey/i;

  window.__dumpBreak = () => {
    const pick = (re, resLimit) => cap
      .filter((r) => re.test(r.url || ''))
      .map((r) => ({
        url: r.url, method: r.method, status: r.status,
        body: (r.body || '').slice(0, 1500),
        res: (r.res || '').slice(0, resLimit),
      }));
    const s = JSON.stringify({
      codes: pick(CODES, 6000),
      flow: pick(FLOW, 1500),
      opened: cap.filter((r) => r.tag === 'window.open').map((r) => r.url),
    }, null, 1);
    console.log(s);
    try { copy(s); } catch (_) {}
    return `코드표 ${pick(CODES, 1).length}건 / 흐름 ${pick(FLOW, 1).length}건 — 클립보드 복사됨`;
  };

  return '준비됨 — 근태신청서에서 휴게 신청을 한 번 하고 __dumpBreak()';
})();
