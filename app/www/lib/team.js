// 팀 근무시간 공유.
//
// 부서로 자동으로 묶인다. 팀을 만들거나 참여하는 절차가 없다 —
// 그룹웨어가 알려 주는 부서(compSeq·deptSeq)가 곧 팀이다.
//
// 문제는 서버가 "이 사람이 우리 회사 사람이고 정말 그 부서냐" 를 알 방법이 없다는
// 것이다. worktime.goorm.io 는 인터넷에서 닿으므로, deptSeq 를 그냥 믿으면
// 아무나 남의 부서 근무시간을 읽어 간다.
//
// 그래서 **회사 열쇠** 하나를 쓴다. 설치할 때 한 번 넣으면 그 뒤로는 전부 자동이다.
//
//   teamId  = HMAC(회사열쇠, "team:compSeq:deptSeq")   앞 16자
//   joinKey = HMAC(회사열쇠, "key:compSeq:deptSeq")    앞 32자
//
// 열쇠를 모르면 팀 주소(teamId)를 계산조차 할 수 없다. 서버는 여전히 아무것도
// 모른 채 "이 주소에 이 열쇠" 만 확인한다 — 회사 열쇠는 서버로 가지 않는다.
//
// cfg = { companyKey, myName, on, selfId, writeKey }
(function (root) {
  const GW = (root.GW = root.GW || {});

  const ORIGIN = 'https://worktime.goorm.io';
  const BASE = `${ORIGIN}/api`;

  const rid = (n) => {
    const b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return Array.from(b, (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
  };

  // 브라우저마다 한 번만 만든다. 같은 사람이 확장과 웹앱을 같이 쓰면 두 칸으로
  // 보이는데, 그걸 합치려면 계정이 필요하다 — 여기서는 받지 않는다.
  const newSelf = () => ({ selfId: rid(16), writeKey: rid(24) });

  const b64url = (buf) => {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // 사람이 손으로 옮겨 적는 값이다. 앞뒤 공백과 중간 연속 공백만 정리한다.
  // 대소문자는 건드리지 않는다 — 줄이면 그만큼 추측이 쉬워진다.
  const normKey = (k) => String(k || '').trim().replace(/\s+/g, ' ');

  async function hmac(companyKey, msg) {
    const enc = new TextEncoder();
    const key = await root.crypto.subtle.importKey(
      'raw', enc.encode(normKey(companyKey)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64url(await root.crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  }

  // 부서 → 팀 주소. 같은 회사 열쇠와 같은 부서면 어디서 계산해도 같은 값이 나온다.
  async function derive(companyKey, compSeq, deptSeq) {
    if (!normKey(companyKey)) throw new Error('회사 열쇠가 없습니다');
    if (!compSeq || !deptSeq) throw new Error('부서 정보를 찾지 못했습니다');
    const tag = `${compSeq}:${deptSeq}`;
    return {
      teamId: (await hmac(companyKey, `team:${tag}`)).slice(0, 16),
      joinKey: (await hmac(companyKey, `key:${tag}`)).slice(0, 32),
    };
  }

  // 열쇠를 잘못 적으면 조용히 "나 혼자인 팀" 이 된다 — 오류가 안 난다.
  // 네 글자를 서로 맞춰 보면 같은 열쇠를 쓰는지 바로 안다.
  const fingerprint = async (companyKey) =>
    (await hmac(companyKey, 'fingerprint')).slice(0, 4).toUpperCase();

  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) {
      throw new Error('공유 서버에 연결하지 못했습니다');
    }
    let data = {};
    try { data = await res.json(); } catch (_) { /* 본문이 없을 수도 있다 */ }
    if (!res.ok) throw new Error(data.error || `공유 서버 오류 (${res.status})`);
    return data;
  }

  // 우리 부서 자리를 잡는다. 없으면 만들고, 있으면 열쇠만 확인한다.
  // 부서명이 바뀌면 따라간다.
  const ensure = (ids, deptName) =>
    call('PUT', `/teams/${encodeURIComponent(ids.teamId)}`,
      { joinKey: ids.joinKey, name: deptName || '우리 팀' });

  const fetchTeam = (ids) =>
    call('GET', `/teams/${encodeURIComponent(ids.teamId)}?k=${encodeURIComponent(ids.joinKey)}`);

  const publish = (ids, cfg, me) =>
    call('PUT', `/teams/${encodeURIComponent(ids.teamId)}/me?k=${encodeURIComponent(ids.joinKey)}`,
      { ...me, id: cfg.selfId, writeKey: cfg.writeKey });

  const withdraw = (ids, cfg) =>
    call('DELETE', `/teams/${encodeURIComponent(ids.teamId)}/me?k=${encodeURIComponent(ids.joinKey)}`,
      { id: cfg.selfId, writeKey: cfg.writeKey });

  // 계산 결과에서 공유할 조각만 뽑는다. 원본을 통째로 보내지 않는다 —
  // 서버에 남는 건 이 필드들이 전부다.
  function summarize(state, plan, who) {
    const row = state && state.todayRow;
    const me = {
      name: (who && who.name) || '',
      dept: (who && who.dept) || '',
      inAt: null,
      outAt: null,
      workedMin: null,
      leftMin: null,
      monthLeftMin: state ? state.remainingMin : null,
      leaveNm: (row && row.leaveNames) || null,
    };
    if (!plan) return me;              // 휴가·휴일이라 타각이 없는 날
    me.inAt = plan.inAt || null;
    if (plan.done) {
      me.outAt = plan.outAt || null;
      me.workedMin = plan.workedMin;
      me.leftMin = 0;
      return me;
    }
    // 공유하는 건 "정량(소정근로) 기준 퇴근" 이다. 최소 6시간은 각자 사정이라
    // 남이 볼 값으로는 맞지 않는다.
    me.outAt = plan.parOut || null;
    me.workedMin = plan.elapsedMin;
    me.leftMin = plan.parLeftMin;
    if (!me.leaveNm && plan.leaveNames) me.leaveNm = plan.leaveNames;
    return me;
  }

  GW.team = {
    ORIGIN, BASE, newSelf, normKey, derive, fingerprint,
    ensure, fetchTeam, publish, withdraw, summarize,
  };
})(typeof window !== 'undefined' ? window : globalThis);
