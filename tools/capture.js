// 실제 휴가 신청 흐름을 캡처한다.
//
// gw.goorm.io 본 창 콘솔에 붙여 실행한 뒤, 평소대로 신청서를 채우고 [신청완료] 를
// 누른다. 결재 팝업이 정상으로 뜨면 __capDump() 로 결과를 복사한다.
//
// fetch·XHR 을 모두 감싸고, window.open 으로 열리는 결재 팝업에도 같은 후크를 심는다
// (같은 출처라 자식 창의 전역에 접근할 수 있다).
(() => {
  const cap = (window.__cap = window.__cap || []);

  function hook(w, tag) {
    if (!w || w.__capHooked) return;
    try { w.__capHooked = true; } catch (_) { return; }   // 접근 불가면 포기

    const of = w.fetch;
    if (of) {
      w.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url);
        const rec = {
          tag, url, at: Date.now(),
          method: (init && init.method) || (input && input.method) || 'GET',
          body: init && typeof init.body === 'string' ? init.body : null,
        };
        cap.push(rec);
        return of.apply(this, arguments).then(async (res) => {
          rec.status = res.status;
          try { rec.res = (await res.clone().text()).slice(0, 6000); } catch (_) {}
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
            try { rec.res = String(x.responseText).slice(0, 6000); } catch (_) {}
          });
          return send.apply(x, arguments);
        };
        return x;
      };
    }
  }

  hook(window, 'main');

  // 결재 팝업에도 후크를 심는다. 문서가 갈릴 때마다 다시 심어야 해서 짧게 폴링한다.
  const oOpen = window.open;
  window.open = function (url) {
    const child = oOpen.apply(this, arguments);
    cap.push({ tag: 'window.open', url: String(url), at: Date.now() });
    if (child) {
      const t = setInterval(() => {
        try {
          if (child.closed) return clearInterval(t);
          if (child.location.href && child.location.href !== 'about:blank') {
            hook(child, 'popup');
            if (child.document.readyState === 'complete') clearInterval(t);
          }
        } catch (_) { /* 아직 about:blank */ }
      }, 10);
      setTimeout(() => clearInterval(t), 60000);
    }
    return child;
  };

  window.__capDump = () => {
    const keep = /attendapplication|0hr00011|00011|\/eap\/|appro|popup|HPD0110/i;
    const rows = cap.filter((r) => keep.test(r.url || ''));
    const s = JSON.stringify(rows, null, 1);
    console.log(s);
    try { copy(s); } catch (_) {}
    return `${rows.length}건 / 전체 ${cap.length}건 — 클립보드에 복사했습니다`;
  };

  return '준비됨 — 이제 평소대로 신청서를 채우고 [신청완료] 를 누르세요. 끝나면 __capDump()';
})();
