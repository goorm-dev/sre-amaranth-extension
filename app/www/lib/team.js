// 팀 근무시간 공유.
//
// worktime.goorm.io 에 올려 둔 API 한 곳에 모은다. 계정은 없고 팀 링크가 곧 권한이다 —
// 링크를 받은 사람만 그 팀을 읽고 쓸 수 있다.
//
// 이 파일은 저장소를 모른다. 확장은 chrome.storage, 앱은 localStorage 를 쓰므로
// 설정(cfg)은 부르는 쪽이 들고 있다가 넘긴다.
//
//   cfg = { teamId, joinKey, teamName, selfId, writeKey, on }
//
// selfId/writeKey 는 브라우저에서 한 번 만들어 계속 쓴다. writeKey 는 "내 칸은 나만
// 고친다" 는 용도이고 남에게 보이지 않는다 — 서버가 응답에서 빼고 준다.
(function (root) {
  const GW = (root.GW = root.GW || {});

  const ORIGIN = 'https://worktime.goorm.io';
  const BASE = `${ORIGIN}/api`;

  const rid = (n) => {
    const b = new Uint8Array(n);
    (root.crypto || root.msCrypto).getRandomValues(b);
    return Array.from(b, (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
  };

  // 브라우저마다 한 번만 만든다. 같은 사람이 확장과 웹앱을 같이 쓰면 두 칸으로
  // 보이는데, 그걸 합치려면 계정이 필요하다 — 여기서는 받지 않는다.
  const newSelf = () => ({ selfId: rid(16), writeKey: rid(24) });

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

  const create = (name) => call('POST', '/teams', { name });

  const fetchTeam = (cfg) =>
    call('GET', `/teams/${encodeURIComponent(cfg.teamId)}?k=${encodeURIComponent(cfg.joinKey)}`);

  const publish = (cfg, me) =>
    call('PUT', `/teams/${encodeURIComponent(cfg.teamId)}/me?k=${encodeURIComponent(cfg.joinKey)}`,
      { ...me, id: cfg.selfId, writeKey: cfg.writeKey });

  const withdraw = (cfg) =>
    call('DELETE', `/teams/${encodeURIComponent(cfg.teamId)}/me?k=${encodeURIComponent(cfg.joinKey)}`,
      { id: cfg.selfId, writeKey: cfg.writeKey });

  // 주고받는 링크. 웹앱이 열어서 t·k 를 읽는다.
  const linkFor = (cfg) =>
    `${ORIGIN}/team?t=${encodeURIComponent(cfg.teamId)}&k=${encodeURIComponent(cfg.joinKey)}`;

  // 링크든 "t=…&k=…" 조각이든 받아 준다. 사람이 손으로 붙여 넣는 값이다.
  function parseLink(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    let q = s;
    const i = s.indexOf('?');
    if (i >= 0) q = s.slice(i + 1);
    const p = new URLSearchParams(q.replace(/^#/, ''));
    const teamId = p.get('t');
    const joinKey = p.get('k');
    return teamId && joinKey ? { teamId, joinKey } : null;
  }

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

  GW.team = { ORIGIN, BASE, newSelf, create, fetchTeam, publish, withdraw, linkFor, parseLink, summarize };
})(typeof window !== 'undefined' ? window : globalThis);
