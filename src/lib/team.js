// 팀 근무시간 공유.
//
// **팀명이 곧 주소다.** 같은 팀명을 쓰는 사람끼리 모인다. 그게 전부다 —
// 만들기도 참여도 링크도 열쇠도 없다. 팀명은 그룹웨어의 부서명으로 미리 채워지므로
// 대개 손댈 것이 없고, 부서와 다른 이름으로 모이고 싶으면 고쳐 쓰면 된다.
//
//   teamId  = SHA-256("worktime-team-v1:" + 팀명)    앞 16자
//   joinKey = SHA-256("worktime-join-v1:" + 팀명)    앞 32자
//
// **비밀이 아니다.** 팀명을 아는 사람은 누구나 그 팀을 읽을 수 있다. 서버가 요청자를
// 확인할 방법이 없는데(계정도 로그인도 없다) 열쇠까지 없애기로 했으므로, 팀명이
// 사실상 공개된 주소다. joinKey 는 서버가 요구하는 형식을 맞추는 값일 뿐 보호 수단이
// 아니다. 남의 칸을 덮어쓰지 못하게 하는 writeKey 만 실제로 동작한다.
//
// cfg = { teamName, myName, on, selfId, writeKey }
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

  // 사람이 손으로 적는 이름이다. "SRE팀" 과 "sre 팀" 이 갈라지면 서로 못 만난다.
  // 공백을 모두 지우고 소문자로 맞춘 값으로 주소를 만든다 (보이는 이름은 적은 그대로).
  const normName = (v) => String(v || '').trim().replace(/\s+/g, '').toLowerCase();

  async function sha(msg) {
    const buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
    return b64url(buf);
  }

  // 팀명 → 팀 주소. 같은 팀명이면 어디서 계산해도 같은 값이 나온다.
  async function derive(teamName) {
    const n = normName(teamName);
    if (!n) throw new Error('팀 이름이 없습니다');
    return {
      teamId: (await sha(`worktime-team-v1:${n}`)).slice(0, 16),
      joinKey: (await sha(`worktime-join-v1:${n}`)).slice(0, 32),
    };
  }

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

  // 그 팀 자리를 잡는다. 없으면 만들고, 있으면 이름만 맞춘다.
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
    ORIGIN, BASE, newSelf, normName, derive,
    ensure, fetchTeam, publish, withdraw, summarize,
  };
})(typeof window !== 'undefined' ? window : globalThis);
