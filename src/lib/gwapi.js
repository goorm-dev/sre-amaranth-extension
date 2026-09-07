// 아마란스(WEHAGO) 근태 API 클라이언트.
//
// 요청 규약 — 번들(main.js)에서 확인하고 실제 요청으로 검증했다:
//   Authorization : "Bearer " + cookie.oAuthToken
//   transaction-id: 32자리 랜덤 hex
//   timestamp     : Math.floor(Date.now()/1000)
//   Access-Domain : https://gw.goorm.io
//   menu-code     : 화면 코드
//   wehago-sign   : Base64( HmacSHA256(token + tid + timestamp + pathname, cookie.signKey) )
//                   ※ pathname 만 서명한다 (쿼리스트링 제외)
//
// 사원/회사 코드(empCd/coCd)는 보내지 않아도 서버가 토큰에서 판별한다.
(function (root) {
  const GW = (root.GW = root.GW || {});
  const ORIGIN = 'https://gw.goorm.io';

  // 콘텐츠 스크립트는 document.cookie, 팝업 등 확장 페이지는 chrome.cookies 를 쓴다.
  async function readCookie(name) {
    if (typeof chrome !== 'undefined' && chrome.cookies && chrome.cookies.get) {
      if (!GW.store.alive()) throw new GW.store.ContextGone();
      const c = await chrome.cookies.get({ url: ORIGIN + '/', name });
      return c ? decodeURIComponent(c.value) : null;
    }
    const hit = document.cookie.split('; ').find((c) => c.startsWith(name + '='));
    return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
  }

  async function credentials() {
    const [token, signKey] = await Promise.all([readCookie('oAuthToken'), readCookie('signKey')]);
    return { token, signKey };
  }

  function transactionId() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  async function sign(message, key) {
    const enc = new TextEncoder();
    const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const s = await crypto.subtle.sign('HMAC', k, enc.encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(s)));
  }

  class AuthError extends Error {}

  async function call(pathname, body, menuCode) {
    const { token, signKey } = await credentials();
    if (!token || !signKey) {
      throw new AuthError('로그인 세션을 찾지 못했습니다. gw.goorm.io 에 로그인해 주세요.');
    }
    const timestamp = String(Math.floor(Date.now() / 1000));
    const tid = transactionId();

    const res = await fetch(ORIGIN + pathname, {
      method: 'POST',
      headers: {
        'Accept': '*/*',
        'Content-type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Access-Domain': ORIGIN,
        'menu-code': menuCode || 'HPD0210',
        'use-multilang': 'false',
        'timestamp': timestamp,
        'transaction-id': tid,
        'wehago-sign': await sign(token + tid + timestamp + pathname, signKey),
      },
      body: JSON.stringify(body || {}),
    });

    if (res.status === 401 || res.status === 403) {
      throw new AuthError('세션이 만료되었습니다. gw.goorm.io 에서 다시 로그인해 주세요.');
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok || !json) throw new Error(`API 오류 ${res.status}`);
    if (json.resultCode !== 0) throw new Error(json.resultMsg || `API 오류 (resultCode ${json.resultCode})`);
    return json.resultData;
  }

  // ── 사원 식별자 ────────────────────────────────────────────────────────
  // 오늘 출퇴근 조회(getTodayComeLeaveInfo)는 empCd/coCd 가 필수다.
  // 근태 조회 응답 행에 둘 다 들어있으므로 거기서 뽑아 캐시한다.
  let identity = null;

  async function loadIdentity() {
    if (identity) return identity;
    const { gwIdentity } = await GW.store.raw('gwIdentity');
    if (gwIdentity) identity = gwIdentity;
    return identity;
  }

  async function rememberIdentity(rows) {
    const hit = (rows || []).find((r) => r.empCd && r.coCd);
    if (!hit) return;
    const next = { empCd: hit.empCd, coCd: hit.coCd };
    if (identity && identity.empCd === next.empCd) return;
    identity = next;
    await GW.store.rawSet({ gwIdentity: next });
  }

  // 캐시가 비어 있으면 최근 근무 기록을 훑어 사원코드를 확보한다.
  async function resolveIdentity() {
    const cached = await loadIdentity();
    if (cached) return cached;
    const today = new Date();
    const keys = [];
    for (let i = 1; i <= 45; i++) keys.push(GW.time.toKey(GW.time.addDays(today, -i)));
    await getWorkTimeList(keys);
    return identity;
  }

  // dateKeys: ["2026-09-01", ...] → 근태 원본 행 배열
  async function getWorkTimeList(dateKeys) {
    const raw = await call(
      '/personal/hpd0210/getWorkTimeList',
      { atDtList: dateKeys.map(GW.time.toApiDate) },
      'HPD0210',
    );
    const rows = raw || [];
    await rememberIdentity(rows);
    return rows.map((r) => ({
      key: GW.time.fromApiDate(r.atDt),
      standardMin: r.selfCommuteStandardWorkTm || 0,  // 그날의 소정근로시간 (휴일이면 0)
      workedMin: r.appworkTm || 0,                    // 인정근무 (반차·휴가 인정분 포함)
      basicMin: r.basicworkTm || 0,
      overMin: r.overworkTm || 0,
      breakMin: r.exceptworkTm || 0,                  // 제외근무 = 휴게시간
      inAt: hhmm(r.appcomeTm) || hhmm(r.comeTm),
      outAt: hhmm(r.appleaveTm) || hhmm(r.leaveTm),
      resultNm: r.attresultNm === '-' ? null : r.attresultNm,  // 정상근무 / 휴일 / 지각 / 부족 …
      leaveNm: r.atNm || null,                        // 오전반차 등
      statusNm: r.worktmNm || null,                   // 승인 / 대기
      holiday: r.holiYn === 'Y',
      workTypeNm: r.workNm || null,                   // 자율출퇴근
    }));
  }

  function hhmm(v) {
    if (!v || !/^\d{4}$/.test(String(v))) return null;
    return `${String(v).slice(0, 2)}:${String(v).slice(2)}`;
  }

  // "202609011439" → "14:39"
  function stampToHhmm(v) {
    const s = String(v || '');
    return /^\d{12}$/.test(s) ? `${s.slice(8, 10)}:${s.slice(10, 12)}` : null;
  }

  // 오늘 실시간 타각. 근태 배치(다음날 새벽)를 기다리지 않고 바로 읽힌다.
  async function getComeLeave(dateKey) {
    const id = await resolveIdentity();
    if (!id) return null;
    const d = await call(
      '/human/common/judgeTimeManagement/getTodayComeLeaveInfo',
      { empCd: id.empCd, coCd: id.coCd, workDt: GW.time.toApiDate(dateKey) },
    );
    if (!d || d.resultCode !== 'SUCCESS') return null;
    return { inAt: stampToHhmm(d.comeTm), outAt: stampToHhmm(d.leaveTm), holiday: d.holidayYn === 'Y' };
  }

  // ── 근태신청(휴가) 조회 ────────────────────────────────────────────────
  // 승인·진행 중인 연차/반차를 가져온다. 근태 배치 전인 오늘·미래 휴가는
  // getWorkTimeList 에 잡히지 않으므로 이쪽으로 보완한다.
  const RE_LEAVE = /휴가|연차|월차|반차|반일|반휴|공가|경조|휴무|대휴/;
  // 휴게·외출은 근로시간에서 **빠지는** 신청이다 (atPopupCd 51 / atItemNm "외출" / atNm "휴게").
  // 휴가와 방향이 반대라 따로 분류한다 — 소정근로는 그대로고 퇴근만 밀린다.
  const RE_BREAK = /휴게|외출/;
  const RE_VOID = /반려|취소|취하|반송/;

  function kindOf(name) {
    if (RE_BREAK.test(name)) return 'break';
    if (RE_LEAVE.test(name)) return 'leave';
    return null;   // 출장·시간외 등은 다루지 않는다
  }

  // 신청 구간 길이(분). "0900"~"1400" → 300
  function spanOf(startTm, endTm) {
    const p = (v) => (/^\d{4}$/.test(String(v)) ? Number(String(v).slice(0, 2)) * 60 + Number(String(v).slice(2)) : null);
    const a = p(startTm);
    const b = p(endTm);
    if (a == null || b == null) return null;
    return b >= a ? b - a : b + 1440 - a;   // 자정 넘김 방어
  }

  function portionOf(name) {
    if (/반반차|반반일|반반휴/.test(name)) return 0.25;
    if (/반차|반일|반휴/.test(name)) return 0.5;
    return 1;
  }

  // flag 가 조회 기준을 정한다: "1" = 신청일, "2" = 사용일(휴가일).
  // 사용일 기준이라야 "이 달에 쓰는 휴가"가 그대로 나온다.
  // (flag=1 로 9월을 조회하면 9/1에 신청한 8/24 휴가가 딸려 온다)
  async function getLeaveList(startKey, endKey) {
    const d = await call(
      '/personal/hpd0120/0hp00001',
      { startDt: GW.time.toApiDate(startKey), endDt: GW.time.toApiDate(endKey), flag: '2' },
      'HPD0120',
    );
    const apps = ((d && d.atPopUpDetailInfos) || []).flatMap((g) => g.attendApplications || []);
    return apps
      .filter((a) => {
        const name = `${a.atItemNm || ''} ${a.atNm || ''}`;
        if (!kindOf(name)) return false;
        if (a.reportCancYn === 'Y') return false;
        return !RE_VOID.test(a.approStateNm || '');          // 반려·취소 건 제외
      })
      .map((a) => {
        const name = `${a.atItemNm || ''} ${a.atNm || ''}`;
        return {
          kind: kindOf(name),                                // 'leave' | 'break'
          startKey: GW.time.fromApiDate(a.startDt),
          endKey: GW.time.fromApiDate(a.endDt),
          name: a.atNm || a.atItemNm,
          itemNm: a.atItemNm,
          stateNm: a.approStateNm,
          pending: a.approState !== '1',
          spanMin: spanOf(a.startTm, a.endTm),
          portion: portionOf(name),
        };
      });
  }

  // ── 회사 휴일 ──────────────────────────────────────────────────────────
  // 서버가 연 단위로 내려준다. 법정공휴일뿐 아니라 **회사 자체 휴무일**(창립기념일 등)과
  // 법정공휴일이 아닌 회사 휴무(제헌절 등)까지 들어 있어 내장 표보다 정확하다.
  //
  //   { holiDt:"20260717", holiNm:"제헌절", holiYn:"Y" }
  //
  // holiYn 이 "N" 인 항목은 달력에 등록만 된 기념일이고 휴무일이 아니다 (창립기념일 등).
  // 실제 근태 데이터로 holiYn="Y" → 소정근로 0 인 것을 확인했다.
  async function getHolidays(year) {
    const rows = await call('/human/common/getHolidayList', { year: String(year) }, 'HPD0110');
    const days = {};
    for (const h of rows || []) {
      if (h.holiYn === 'Y' && /^\d{8}$/.test(String(h.holiDt))) {
        days[GW.time.fromApiDate(h.holiDt)] = h.holiNm || '휴일';
      }
    }
    // 아직 그 해 공휴일을 다 등록하지 않은 경우가 있다 (2027년은 3건뿐).
    // 빈약하면 내장 표로 보완해야 하므로 완전성 여부를 함께 넘긴다.
    return { year: Number(year), days, complete: Object.keys(days).length >= 8 };
  }

  async function getMonth(monthKey) {
    const { first, last } = GW.time.monthRange(monthKey);
    return getWorkTimeList(GW.time.eachDay(first, last).map(GW.time.toKey));
  }

  async function getMonthLeaves(monthKey) {
    const { first, last } = GW.time.monthRange(monthKey);
    // 달 경계를 걸친 연차(예: 12/29~1/2)까지 잡으려고 앞뒤로 조금 넓힌 뒤 겹치는 것만 남긴다.
    const rows = await getLeaveList(
      GW.time.toKey(GW.time.addDays(first, -31)),
      GW.time.toKey(GW.time.addDays(last, 31)),
    );
    const from = GW.time.toKey(first);
    const to = GW.time.toKey(last);
    return rows.filter((lv) => lv.startKey <= to && lv.endKey >= from);
  }

  GW.api = {
    call, getWorkTimeList, getMonth, getLeaveList, getMonthLeaves,
    getComeLeave, getHolidays, resolveIdentity, credentials, AuthError,
  };
})(typeof window !== 'undefined' ? window : globalThis);
