// 팀 근무시간 공유.
//
// **그룹웨어의 부서가 그대로 팀이다.** 만들기도 참여도 링크도 열쇠도 없고,
// 사용자가 고를 수 있는 것도 없다 — 팀도 이름도 그룹웨어가 알려 주는 값으로 고정한다.
// 열쇠를 없애면서 "아무 팀이나 지목해서 들여다보기" 까지 같이 막는 방법이 이것이다.
//
//   teamId  = SHA-256("worktime-team-v4:" + compSeq + ":" + 최종소속팀 deptSeq)
//   joinKey = SHA-256("worktime-join-v4:" + compSeq + ":" + 최종소속팀 deptSeq)
//
// "최종 소속 팀" 은 조직도 경로에서 뒤에서부터 찾은 첫 "…팀" 이다 (teamFromPath).
// 본인 부서(deptSeq)로 만들면 "에듀 1파트"·"에듀 2파트" 가 갈라지고, 이름을
// 규칙으로 깎으면 "사업1팀"·"사업2팀" 처럼 다른 팀이 합쳐진다. 조직도가 이미
// 아는 것을 쓴다.
//
// **주소 자체가 비밀은 아니다.** 계산식이 이 저장소에 공개돼 있고 deptSeq 는 작은
// 정수라, API 를 직접 부르는 사람은 여전히 값을 맞춰 볼 수 있다. joinKey 는 서버
// 형식을 맞추는 값일 뿐 보호 수단이 아니다. 실제로 동작하는 것은 남의 칸을
// 덮어쓰지 못하게 하는 writeKey 와, 클라이언트가 자기 부서 말고는 계산하지 않는다는 점이다.
//
// cfg = { teamName, myName, on, selfId, writeKey }   teamName 은 표시용
//
// 친구 방은 별개다 — 부서와 무관하게 코드를 주고받은 사람끼리 모인다.
// 아래 newCode/room 참고. 서버는 둘을 구분하지 않는다.
(function (root) {
  const GW = (root.GW = root.GW || {});

  const ORIGIN = 'https://worktime.goorm.io';
  const BASE = `${ORIGIN}/api`;

  const rid = (n) => {
    const b = new Uint8Array(n);
    root.crypto.getRandomValues(b);
    return Array.from(b, (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
  };

  // 자리(selfId)는 **사람** 에 붙는다. 브라우저마다 새로 만들면 확장과 웹앱에서
  // 각각 한 줄씩 생기고, 다시 켤 때마다 유령이 하나씩 쌓인다(실제로 그랬다).
  // 그룹웨어 사번으로 고정하면 어느 기기에서 켜든 같은 칸을 덮어쓴다.
  const selfFrom = async (compSeq, empSeq) => ({
    selfId: (await sha(`worktime-self-v1:${compSeq}:${empSeq}`)).slice(0, 16),
    writeKey: (await sha(`worktime-selfkey-v1:${compSeq}:${empSeq}`)).slice(0, 32),
  });

  // 사번을 못 읽었을 때만 쓴다. 이 경우는 중복을 못 막는다.
  const newSelf = () => ({ selfId: rid(16), writeKey: rid(24) });

  const b64url = (buf) => {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // ── 친구 방 ──────────────────────────────────────────────────────────
  //
  // 부서와 무관하게, 코드를 주고받은 사람끼리 모인다. 팀과 달리 여기서는 코드가
  // 곧 열쇠다 — 무작위 60비트라 팀명과 달리 맞혀 볼 수 없다.
  //
  //   roomId  = SHA-256("worktime-room-v1:" + 코드)     앞 16자
  //   joinKey = SHA-256("worktime-roomkey-v1:" + 코드)  앞 32자
  //
  // 서버는 이게 팀인지 방인지 모른다. 주소와 열쇠 한 쌍일 뿐이다.

  // 사람이 읽고 옮겨 적는 코드다. 헷갈리는 글자(I·L·O·U)를 뺀 32자를 쓴다.
  const CODE_ABC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

  // 저장은 하이픈 없는 정규형으로, 보여 줄 때만 끊어 준다.
  // 두 사람이 같은 코드를 다르게 적어도 같은 방이 되도록.
  function newCode() {
    const b = new Uint8Array(12);
    root.crypto.getRandomValues(b);
    return Array.from(b, (x) => CODE_ABC[x % 32]).join('');
  }

  const pretty = (code) => {
    const c = normCode(code);
    return c.length === 12 ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}` : c;
  };

  // 손으로 옮겨 적다 보면 O 를 0 으로, I 를 1 로 적는다. 받아 준다.
  const normCode = (v) => String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replace(/[OQ]/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');

  // 예전 판본은 방을 하나만 들고 있었다 ({ code, on }). 목록 구조로 옮겨 담는다.
  function migrateRooms(cfg) {
    if (!cfg) return { rooms: [], active: null, myName: '', at: 0 };
    if (Array.isArray(cfg.rooms)) return { at: 0, ...cfg };
    return cfg.code
      ? { rooms: [{ code: cfg.code, label: '', on: !!cfg.on }],
        active: cfg.code, myName: cfg.myName || '', at: Date.now() }
      : { rooms: [], active: null, myName: cfg.myName || '', at: 0 };
  }

  async function room(code) {
    const c = normCode(code);
    if (c.length < 8) throw new Error('코드가 올바르지 않습니다');
    return {
      teamId: (await sha(`worktime-room-v1:${c}`)).slice(0, 16),
      joinKey: (await sha(`worktime-roomkey-v1:${c}`)).slice(0, 32),
    };
  }

  async function sha(msg) {
    const buf = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
    return b64url(buf);
  }

  // 조직도가 알려 주는 **최종 소속 팀** 으로 묶는다.
  //
  // 경로가 두 군데에서 오는데 모양이 다르다.
  //   내 세션(userInfo)  deptPath   "2038|2042"
  //                      deptPathNm "주식회사 구름|주식회사 구름|인프라본부|SRE팀"
  //   조직도 API         path       "1000|1000|2017|2019|2025|2255"
  //                      pathName   "주식회사 구름>…>에듀그룹>에듀팀>에듀 2파트"
  //
  // 구분자가 | 이기도 하고 > 이기도 하다. 그리고 **길이가 다르다** — 번호 쪽에는
  // 회사 항목이 빠져 있다. 그래서 뒤에서부터 맞춘다.
  //
  // 뒤에서부터 찾은 첫 "…팀" 이 그 사람의 팀이다. "SRE 1파트" 도 "SRE팀" 으로
  // 모이고, "프로덕트디자인팀"·"브랜드디자인팀" 은 각각 남는다.
  //
  // 이름 규칙으로 깎던 방식은 버렸다. "사업1팀"·"사업2팀" 처럼 실제로 다른 팀을
  // 한 덩어리로 합쳐 버린다 — 조직도가 이미 아는 것을 추측할 이유가 없다.
  const split = (v) => String(v || '').split(/[|>]/).map((x) => x.trim()).filter(Boolean);

  function teamFromPath(path, pathName) {
    const seqs = split(path);
    const names = split(pathName);
    if (!seqs.length) return null;
    const n = Math.min(seqs.length, names.length);
    const s2 = seqs.slice(-n);
    const n2 = names.slice(-n);
    for (let i = n - 1; i >= 0; i--) {
      if (/팀$/.test(n2[i])) return { seq: s2[i], name: n2[i] };
    }
    // 팀이라 부를 마디가 없으면 본인 부서로 둔다 (대표이사 · 그룹 직속 등).
    return { seq: seqs[seqs.length - 1], name: n ? n2[n - 1] : '' };
  }

  // 부서 → 팀 주소. 인자는 그룹웨어에서 온 값만 들어온다 —
  // 사용자가 고르는 경로가 없다.
  async function derive(id) {
    const compSeq = id && id.compSeq;
    if (!compSeq) throw new Error('부서 정보를 찾지 못했습니다');
    // 경로가 있으면 최종 소속 팀, 없으면 본인 부서 그대로. 후자는 하위 조직이
    // 갈라지지만, 아무 이름이나 합쳐 버리는 것보다는 낫다.
    const t = teamFromPath(id.path, id.pathName)
      || (id.deptSeq ? { seq: String(id.deptSeq), name: id.deptName || '' } : null);
    if (!t) throw new Error('부서 정보를 찾지 못했습니다');
    const tag = `${compSeq}:${t.seq}`;
    return {
      root: t.name || id.deptName || '우리 팀',
      teamId: (await sha(`worktime-team-v4:${tag}`)).slice(0, 16),
      joinKey: (await sha(`worktime-join-v4:${tag}`)).slice(0, 32),
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

  // 그 자리를 잡는다. 없으면 만들고, 있으면 열쇠만 확인한다.
  // 이름은 줄 때만 바뀐다 — 매번 보내면 이름을 바꿔 둔 사람과 서로 덮어쓴다.
  const ensure = (ids, name) =>
    call('PUT', `/teams/${encodeURIComponent(ids.teamId)}`,
      name ? { joinKey: ids.joinKey, name } : { joinKey: ids.joinKey });



  const fetchTeam = (ids) =>
    call('GET', `/teams/${encodeURIComponent(ids.teamId)}?k=${encodeURIComponent(ids.joinKey)}`);

  const publish = (ids, self, me) =>
    call('PUT', `/teams/${encodeURIComponent(ids.teamId)}/me?k=${encodeURIComponent(ids.joinKey)}`,
      { ...me, id: self.selfId, writeKey: self.writeKey });

  const withdraw = (ids, self) =>
    call('DELETE', `/teams/${encodeURIComponent(ids.teamId)}/me?k=${encodeURIComponent(ids.joinKey)}`,
      { id: self.selfId, writeKey: self.writeKey });

  // ── 기기 간 방 목록 맞추기 ────────────────────────────────────────────
  //
  // 자리(selfId)와 그 열쇠(writeKey)가 사번에서 나오므로, 같은 사람의 PC 와 폰이
  // 같은 값을 계산한다. 맞출 거리를 따로 주고받을 필요가 없다.
  //
  // 대신 계산식이 공개돼 있고 사번은 조직도로 알 수 있다 — 사번을 아는 사람은
  // 남의 방 목록을 읽을 수 있다. 알고 고른 선택이다 (README 참고).
  const pullRooms = (self) =>
    call('GET', `/me?u=${encodeURIComponent(self.selfId)}&k=${encodeURIComponent(self.writeKey)}`);

  const pushRooms = (self, rooms, at) =>
    call('PUT', `/me?u=${encodeURIComponent(self.selfId)}&k=${encodeURIComponent(self.writeKey)}`,
      { rooms, at });

  // 나중에 고친 쪽을 따른다. 두 기기에서 각자 고쳤으면 한쪽이 져야 하는데,
  // "방금 고친 쪽" 이 맞다. 합치면 나간 방이 되살아난다.
  async function syncRooms(self, local) {
    const cfg = migrateRooms(local);
    const mine = cfg.at || 0;
    const remote = await pullRooms(self);
    const theirs = (remote && remote.at) || 0;
    if (theirs > mine) return { ...cfg, rooms: remote.rooms || [], at: theirs };
    if (mine > theirs) await pushRooms(self, cfg.rooms || [], mine);
    return cfg;
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
      // 실제로 퇴근 타각을 찍었는지. "목표 시간을 채웠다" 와 구분해야 한다 —
      // leftMin 만 보면 둘 다 0 이하라서, 아직 일하는 사람이 퇴근으로 보인다.
      done: false,
    };
    if (!plan) return me;              // 휴가·휴일이라 타각이 없는 날
    me.inAt = plan.inAt || null;
    if (plan.done) {
      me.outAt = plan.outAt || null;      // 여기서는 실제 퇴근 타각
      me.workedMin = plan.workedMin;
      me.leftMin = 0;
      me.done = true;
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
    ORIGIN, BASE, newSelf, selfFrom, derive, teamFromPath, newCode, normCode, pretty, room,
    migrateRooms, pullRooms, pushRooms, syncRooms,
    ensure, fetchTeam, publish, withdraw, summarize,
  };
})(typeof window !== 'undefined' ? window : globalThis);
