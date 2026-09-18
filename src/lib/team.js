// 팀 근무시간 공유.
//
// **그룹웨어의 부서가 그대로 팀이다.** 만들기도 참여도 링크도 열쇠도 없고,
// 사용자가 고를 수 있는 것도 없다 — 팀도 이름도 그룹웨어가 알려 주는 값으로 고정한다.
// 열쇠를 없애면서 "아무 팀이나 지목해서 들여다보기" 까지 같이 막는 방법이 이것이다.
//
//   teamId  = SHA-256("worktime-team-v2:" + compSeq + ":" + deptSeq)    앞 16자
//   joinKey = SHA-256("worktime-join-v2:" + compSeq + ":" + deptSeq)    앞 32자
//
// 부서명이 아니라 deptSeq 로 만든다. 부서명은 회사마다 겹칠 수 있고("개발팀") 이름이
// 바뀌면 팀이 갈라진다. compSeq 를 앞에 붙여 회사끼리도 겹치지 않게 한다.
// 부서명은 화면에 보여 줄 때만 쓴다.
//
// **주소 자체가 비밀은 아니다.** 계산식이 이 저장소에 공개돼 있고 deptSeq 는 작은
// 정수라, API 를 직접 부르는 사람은 여전히 값을 맞춰 볼 수 있다. joinKey 는 서버
// 형식을 맞추는 값일 뿐 보호 수단이 아니다. 실제로 동작하는 것은 남의 칸을
// 덮어쓰지 못하게 하는 writeKey 와, 클라이언트가 자기 부서 말고는 계산하지 않는다는 점이다.
//
// cfg = { teamName, myName, on, selfId, writeKey }   teamName 은 표시용
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

  async function sha(msg) {
    const buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
    return b64url(buf);
  }

  // 부서 → 팀 주소. 같은 부서면 어디서 계산해도 같은 값이 나온다.
  // 인자는 그룹웨어에서 온 값만 들어온다 — 사용자가 고르는 경로가 없다.
  async function derive(compSeq, deptSeq) {
    if (!compSeq || !deptSeq) throw new Error('부서 정보를 찾지 못했습니다');
    const tag = `${compSeq}:${deptSeq}`;
    return {
      teamId: (await sha(`worktime-team-v2:${tag}`)).slice(0, 16),
      joinKey: (await sha(`worktime-join-v2:${tag}`)).slice(0, 32),
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
    ORIGIN, BASE, newSelf, derive,
    ensure, fetchTeam, publish, withdraw, summarize,
  };
})(typeof window !== 'undefined' ? window : globalThis);
