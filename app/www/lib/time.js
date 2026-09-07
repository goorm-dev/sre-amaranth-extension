// 시간 파싱/포맷 유틸. 콘텐츠 스크립트와 팝업이 공유한다.
(function (root) {
  const GW = (root.GW = root.GW || {});

  // "08시간 17분", "43시간 43분", "17분", "8h 17m", "-" 등을 분 단위로.
  // 값이 없거나 파싱 불가면 null(0과 구분해야 하므로).
  function parseDuration(text) {
    if (text == null) return null;
    const s = String(text).replace(/\s+/g, ' ').trim();
    if (!s || s === '-' || s === '–' || s === '--') return null;

    const h = s.match(/(-?\d+)\s*(?:시간|시|h)/i);
    const m = s.match(/(-?\d+)\s*(?:분|m)(?![a-z])/i);
    if (h || m) {
      const sign = /^-/.test(s) ? -1 : 1;
      const hv = h ? Math.abs(parseInt(h[1], 10)) : 0;
      const mv = m ? Math.abs(parseInt(m[1], 10)) : 0;
      return sign * (hv * 60 + mv);
    }
    // "08:17" 형태
    const c = s.match(/^(-?)(\d{1,3}):([0-5]\d)$/);
    if (c) return (c[1] ? -1 : 1) * (parseInt(c[2], 10) * 60 + parseInt(c[3], 10));
    return null;
  }

  // 분 -> "8시간 17분"
  function fmtDuration(min, opts) {
    if (min == null || Number.isNaN(min)) return '-';
    const o = opts || {};
    const sign = min < 0 ? '-' : '';
    const a = Math.abs(Math.round(min));
    const h = Math.floor(a / 60);
    const m = a % 60;
    if (o.short) return `${sign}${h}h ${String(m).padStart(2, '0')}m`;
    if (h === 0) return `${sign}${m}분`;
    if (m === 0) return `${sign}${h}시간`;
    return `${sign}${h}시간 ${m}분`;
  }

  const pad = (n) => String(n).padStart(2, '0');

  function toKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function fromKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function monthKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }
  function isSameMonth(key, mKey) {
    return key.slice(0, 7) === mKey;
  }
  function monthRange(mKey) {
    const [y, m] = mKey.split('-').map(Number);
    return { first: new Date(y, m - 1, 1), last: new Date(y, m, 0) };
  }
  function eachDay(from, to) {
    const out = [];
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (d <= to) {
      out.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  function label(d) {
    return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
  }

  // "2026-09-01" ↔ "20260901" (API 날짜 형식)
  function toApiDate(key) { return key.replace(/-/g, ''); }
  function fromApiDate(v) {
    const s = String(v);
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }

  GW.time = {
    parseDuration, fmtDuration, toKey, fromKey, monthKey, toApiDate, fromApiDate,
    isSameMonth, monthRange, eachDay, addDays, label, WD, pad,
  };
})(typeof window !== 'undefined' ? window : globalThis);

// 아마란스 HP 모듈 화면. /gw/gw999A12 메뉴 권한 조회로 코드를 확인했다.
(function (root) {
  const GW = (root.GW = root.GW || {});
  GW.screens = {
    ORIGIN: 'https://gw.goorm.io',
    LEAVE_APPLY: 'HPD0110',   // 근태신청서 (휴가 신청)
    LEAVE_LIST: 'HPD0120',    // 개인근태신청현황
    WORKTIME: 'HPD0210',      // 개인근무시간현황
    CONSENT: 'HPD0220',       // 개인근무시간동의
    url: (code) => `${GW.screens.ORIGIN}/#/HP/${code}/${code}`,
    hash: (code) => `#/HP/${code}/${code}`,

    // 연차 신청 팝업을 딥링크로 바로 열 수는 없다.
    // /#/popup?...&approkey=ERP_<uuid>&formId=249&callComp=UBAP001 형태인데,
    // approkey 는 근태신청서 화면이 문서를 준비할 때 만드는 실제 식별자다.
    // 임의로 만들면 결재 팝업이 연동본문(HP_HPD0110_00011)을 못 찾아
    // "연동본문 데이터 조회 실패" 로 떨어진다. 그래서 신청서 화면까지만 연다.
  };
})(typeof window !== 'undefined' ? window : globalThis);
