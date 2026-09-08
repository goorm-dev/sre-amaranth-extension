// 아마란스(WEHAGO) API 클라이언트 — 앱 전용.
//
// 확장과 다른 점은 세션을 얻는 방법 하나뿐이다.
//   확장: 브라우저에 이미 있는 쿠키(oAuthToken/signKey)를 읽는다
//   앱  : 직접 로그인해서 {token, hashKey} 를 받아 Preferences 에 보관한다
//
// 서명 방식은 두 가지이고 용도가 다르다.
//   1) 로그인 전  — signature = Base64( SHA256(token + cur_date + tid + pathname) )
//                   token/cur_date 는 GET /get_token/?url=<pathname> 으로 받는다
//                   헤더: signature, transaction-id   (Authorization 없음)
//   2) 로그인 후  — wehago-sign = Base64( HmacSHA256(oAuthToken + tid + timestamp + pathname, signKey) )
//                   헤더: Authorization: Bearer <oAuthToken>, wehago-sign, timestamp, transaction-id
(function (root) {
  const GW = (root.GW = root.GW || {});
  const ORIGIN = 'https://gw.goorm.io';

  class AuthError extends Error {}

  function transactionId() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  const enc = new TextEncoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

  async function sha256B64(message) {
    return b64(await crypto.subtle.digest('SHA-256', enc.encode(message)));
  }
  async function hmacB64(message, key) {
    const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
  }

  async function request(pathname, { method = 'POST', body, headers }) {
    const res = await fetch(ORIGIN + pathname, {
      method,
      headers: Object.assign({
        'Accept': '*/*',
        'Content-type': 'application/json',
        'Access-Domain': ORIGIN,
      }, headers || {}),
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, text };
  }

  // ── 로그인 전: 서명 발급 ────────────────────────────────────────────────
  async function uncertSign(pathname) {
    const tid = transactionId();
    const res = await fetch(`${ORIGIN}/get_token/?url=${encodeURIComponent(pathname)}&_=${Date.now()}`, {
      headers: { 'transaction-id': tid, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error(`서명 발급 실패 (${res.status})`);
    const t = await res.json();
    return { tid, signature: await sha256B64(t.token + t.cur_date + tid + pathname) };
  }

  function formEncode(o) {
    return Object.keys(o || {})
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(o[k] == null ? '' : o[k])}`)
      .join('&');
  }

  // 로그인 계열(/gw/gw050A02)은 application/x-www-form-urlencoded 로 보내야 한다.
  // JSON 으로 보내면 서버가 본문을 못 읽어 resultCode -1 이 난다.
  // withCredentials: 응답의 Set-Cookie 를 브라우저가 저장하게 한다.
  // fetch 의 기본값은 'same-origin' 이라, 다른 출처(gw.goorm.io)가 내려준 쿠키를
  // 그냥 버린다. 세션을 심는 호출에서는 반드시 켜야 한다.
  async function callUncert(pathname, body, { form = false, withCredentials = false } = {}) {
    const { tid, signature } = await uncertSign(pathname);
    const headers = { signature, 'transaction-id': tid };
    const res = await fetch(ORIGIN + pathname, {
      method: 'POST',
      credentials: withCredentials ? 'include' : 'same-origin',
      headers: Object.assign({
        'Accept': '*/*',
        'Content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        'Access-Domain': ORIGIN,
      }, headers),
      body: form ? formEncode(body) : JSON.stringify(body || {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: res.status, json, text };
  }

  // ── 로그인 후: 서명 요청 ────────────────────────────────────────────────
  let session = null;
  function setSession(s) { session = s; }
  function getSession() { return session; }

  async function call(pathname, body, menuCode) {
    if (!session || !session.token) throw new AuthError('로그인이 필요합니다.');
    const tid = transactionId();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = {
      'Authorization': `Bearer ${session.token}`,
      'menu-code': menuCode || 'HPD0210',
      'use-multilang': 'false',
      'timestamp': timestamp,
      'transaction-id': tid,
      'wehago-sign': await hmacB64(session.token + tid + timestamp + pathname, session.signKey),
    };
    const r = await request(pathname, { body, headers });
    if (r.status === 401 || r.status === 403) throw new AuthError('세션이 만료되었습니다. 다시 로그인해 주세요.');
    if (!r.json) throw new Error(`API 오류 ${r.status}`);
    if (r.json.resultCode !== 0) throw new Error(r.json.resultMsg || `API 오류 (${r.json.resultCode})`);
    return r.json.resultData;
  }

  // ── 조회 ────────────────────────────────────────────────────────────────
  function hhmm(v) {
    return /^\d{4}$/.test(String(v)) ? `${String(v).slice(0, 2)}:${String(v).slice(2)}` : null;
  }
  function stampToHhmm(v) {
    const s = String(v || '');
    return /^\d{12}$/.test(s) ? `${s.slice(8, 10)}:${s.slice(10, 12)}` : null;
  }

  async function getWorkTimeList(dateKeys) {
    const rows = await call('/personal/hpd0210/getWorkTimeList',
      { atDtList: dateKeys.map(GW.time.toApiDate) }, 'HPD0210') || [];
    return rows.map((r) => ({
      key: GW.time.fromApiDate(r.atDt),
      standardMin: r.selfCommuteStandardWorkTm || 0,
      workedMin: r.appworkTm || 0,
      basicMin: r.basicworkTm || 0,
      overMin: r.overworkTm || 0,
      breakMin: r.exceptworkTm || 0,
      inAt: hhmm(r.appcomeTm) || hhmm(r.comeTm),
      outAt: hhmm(r.appleaveTm) || hhmm(r.leaveTm),
      resultNm: r.attresultNm === '-' ? null : r.attresultNm,
      leaveNm: r.atNm || null,
      statusNm: r.worktmNm || null,
      holiday: r.holiYn === 'Y',
      empCd: r.empCd,
      coCd: r.coCd,
      deptCd: r.deptCd,
      groupCd: r.groupCd,
      workTp: r.workTp,
      comeStTm: r.comeStTm,   // 스케줄 하한(자율출퇴근) — 없을 수 있음
      leaveStTm: r.leaveStTm,
      timeCd: r.timeCd,
    }));
  }

  async function getMonth(monthKey) {
    const { first, last } = GW.time.monthRange(monthKey);
    return getWorkTimeList(GW.time.eachDay(first, last).map(GW.time.toKey));
  }

  const RE_LEAVE = /휴가|연차|월차|반차|반일|반휴|공가|경조|휴무|대휴/;
  const RE_BREAK = /휴게|외출/;
  const RE_VOID = /반려|취소|취하|반송/;
  const kindOf = (n) => (RE_BREAK.test(n) ? 'break' : RE_LEAVE.test(n) ? 'leave' : null);
  const portionOf = (n) => (/반반차|반반일|반반휴/.test(n) ? 0.25 : /반차|반일|반휴/.test(n) ? 0.5 : 1);
  function spanOf(a, b) {
    const p = (v) => (/^\d{4}$/.test(String(v)) ? +String(v).slice(0, 2) * 60 + +String(v).slice(2) : null);
    const x = p(a); const y = p(b);
    return x == null || y == null ? null : (y >= x ? y - x : y + 1440 - x);
  }

  async function getLeaveList(startKey, endKey) {
    // flag "2" = 사용일 기준 (="1" 은 신청일 기준이라 다른 달 휴가가 딸려 온다)
    const d = await call('/personal/hpd0120/0hp00001',
      { startDt: GW.time.toApiDate(startKey), endDt: GW.time.toApiDate(endKey), flag: '2' }, 'HPD0120');
    const apps = ((d && d.atPopUpDetailInfos) || []).flatMap((g) => g.attendApplications || []);
    return apps
      .filter((a) => {
        const n = `${a.atItemNm || ''} ${a.atNm || ''}`;
        return kindOf(n) && a.reportCancYn !== 'Y' && !RE_VOID.test(a.approStateNm || '');
      })
      .map((a) => {
        const n = `${a.atItemNm || ''} ${a.atNm || ''}`;
        return {
          kind: kindOf(n),
          startKey: GW.time.fromApiDate(a.startDt),
          endKey: GW.time.fromApiDate(a.endDt),
          name: a.atNm || a.atItemNm,
          itemNm: a.atItemNm,
          stateNm: a.approStateNm,
          pending: a.approState !== '1',
          spanMin: spanOf(a.startTm, a.endTm),
          portion: portionOf(n),
        };
      });
  }

  async function getMonthLeaves(monthKey) {
    const { first, last } = GW.time.monthRange(monthKey);
    const rows = await getLeaveList(
      GW.time.toKey(GW.time.addDays(first, -31)),
      GW.time.toKey(GW.time.addDays(last, 31)));
    const from = GW.time.toKey(first); const to = GW.time.toKey(last);
    return rows.filter((lv) => lv.startKey <= to && lv.endKey >= from);
  }

  async function getComeLeave(dateKey) {
    if (!session.empCd || !session.coCd) return null;
    const d = await call('/human/common/judgeTimeManagement/getTodayComeLeaveInfo',
      { empCd: session.empCd, coCd: session.coCd, workDt: GW.time.toApiDate(dateKey) });
    if (!d || d.resultCode !== 'SUCCESS') return null;
    return { inAt: stampToHhmm(d.comeTm), outAt: stampToHhmm(d.leaveTm), holiday: d.holidayYn === 'Y' };
  }

  async function getHolidays(year) {
    const rows = await call('/human/common/getHolidayList', { year: String(year) }, 'HPD0110') || [];
    const days = {};
    for (const h of rows) {
      if (h.holiYn === 'Y' && /^\d{8}$/.test(String(h.holiDt))) days[GW.time.fromApiDate(h.holiDt)] = h.holiNm || '휴일';
    }
    return { year: Number(year), days, complete: Object.keys(days).length >= 8 };
  }

  // 보관 중인 토큰으로 서버가 gw.goorm.io 쿠키를 심게 한다.
  //
  // 웹(worktime.goorm.io)에서도 통한다. 두 도메인은 등록가능도메인이 goorm.io 로
  // 같아 same-site 라서, 쿠키가 저장되기만 하면 gw.goorm.io 로 이동할 때 실려 간다.
  // 저장되게 하려면 credentials:'include' 가 필요하다 — 교차 출처라서.
  // 응답의 Set-Cookie 가 네이티브 CookieManager 에 저장되고, WebView 가 이를 공유하므로
  // 이후 gw.goorm.io 로 이동하면 로그인된 상태로 열린다.
  // (form-urlencoded 필수 — JSON 으로 보내면 resultCode -1)
  async function establishWebSession() {
    if (!session || !session.token) throw new AuthError('로그인이 필요합니다.');
    const r = await callUncert('/gw/gw050A02', {
      loginType: 'set-cookie',
      oAuthToken: session.token,
      signKey: session.signKey,
      a10Domain: ORIGIN,
    }, { form: true, withCredentials: true });
    if (!r.json || r.json.resultCode !== 0) {
      throw new Error((r.json && r.json.resultMsg) || `세션 전달 실패 (${r.status})`);
    }
    return true;
  }

  // 이 브라우저에 gw.goorm.io 세션이 있는가.
  // 그룹웨어 결재 팝업이 뜰 때 하는 것과 똑같은 호출이다 (캡처로 확인:
  // a10Domain 만 보내고 resultCode 200 "이미 로그인된 사용자입니다" 를 받는다).
  // 교차 출처라 쿠키를 태우려면 credentials 가 필요하다.
  async function hasWebSession() {
    try {
      const r = await callUncert('/gw/gw050A02', { a10Domain: ORIGIN },
        { form: true, withCredentials: true });
      const code = r.json ? r.json.resultCode : null;
      return {
        ok: code === 200,
        code,
        status: r.status,
        msg: (r.json && r.json.resultMsg) || (r.text || '').slice(0, 120),
      };
    } catch (e) {
      return { ok: false, code: null, status: 0, msg: e.message || String(e) };
    }
  }

  // 쿠키가 실제로 붙었는지 서버에 물어본다. HttpOnly 라 JS 로는 볼 수 없다.
  //
  // /gw/gw050A24 를 쓰려다 실패했다 — /get_token/ 이 그 경로에는 서명을 발급하지
  // 않는다(401). 인증 전 서명이 허용되는 경로만 쓸 수 있다.
  // 대신 결재 팝업이 부팅할 때 부르는 것과 같은 호출을 쓴다. 세션이 있으면
  // resultCode 200 "이미 로그인된 사용자입니다" 와 sessionInfo 가 온다.
  async function whoAmI() {
    try {
      const r = await callUncert('/gw/gw050A02', { a10Domain: ORIGIN },
        { form: true, withCredentials: true });
      const code = r.json ? r.json.resultCode : null;
      const info = r.json && r.json.resultData && r.json.resultData.sessionInfo;
      const uc = info && info.ucUserInfo;
      return {
        ok: code === 200,
        who: (uc && uc.loginId) || (info && info.portal_id) || null,
        code,
        status: r.status,
        msg: (r.json && r.json.resultMsg) || (r.text || '').slice(0, 100),
      };
    } catch (e) {
      return { ok: false, who: null, code: null, status: 0, msg: e.message || String(e) };
    }
  }

  GW.api = {
    ORIGIN, AuthError, callUncert, call, request, uncertSign, establishWebSession, hasWebSession, whoAmI,
    setSession, getSession,
    getWorkTimeList, getMonth, getLeaveList, getMonthLeaves, getComeLeave, getHolidays,
  };
})(window);
