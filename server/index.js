// worktime 공유 API.
//
// 계정도 로그인도 없다. 팀 주소(teamId)와 열쇠(joinKey)는 클라이언트가
// 회사 열쇠와 부서로부터 계산해 온다 (lib/team.js 의 derive 참고).
// 서버는 그게 어떻게 나온 값인지 모른 채 "이 주소에 이 열쇠" 만 확인한다 —
// 회사 열쇠도, 그룹웨어 토큰도 여기로 오지 않는다.
//
// worktime.goorm.io 는 인터넷에서 닿으므로 열쇠 없는 접근은 전부 막는다.
//
//   PUT  /api/teams/:id                  { joinKey, name? } → 있으면 확인, 없으면 생성
//                                        name 을 보내면 이름이 바뀐다 (모두에게 보인다)
//   GET  /api/teams/:id?k=<joinKey>                      → { name, members[] }
//   PUT  /api/teams/:id/me?k=<joinKey>   { id, writeKey, name, ... }
//   DELETE /api/teams/:id/me?k=<joinKey> { id, writeKey }
//
//   GET  /api/me?u=<selfId>&k=<writeKey>              → { rooms[], at }
//   PUT  /api/me?u=<selfId>&k=<writeKey>  { rooms[], at }
//
// /api/me 는 기기 간 방 목록 맞추기다. selfId·writeKey 는 사번에서 나오므로
// 같은 사람의 PC 와 폰이 같은 값을 계산한다 — 맞출 거리가 따로 필요 없다.
//
// writeKey 는 각자 브라우저에서 만든 값이고 서버 밖으로 나가지 않는다 —
// 자기 칸만 갱신할 수 있게 하는 용도다.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { Store, MAX_ROOMS } = require('./store');

const PORT = Number(process.env.PORT || 8081);
const DATA = process.env.DATA_FILE || '/data/teams.json';
const store = new Store(DATA);

// 팀 생성만 IP 단위로 제한한다. 인터넷에 열려 있어서, 안 막으면 아무나 MAX_TEAMS 를
// 채워 남이 팀을 못 만들게 할 수 있다. 읽기·쓰기는 키가 있어야 하므로 제외.
// 사무실이 한 공인 IP 를 쓰면 동료들 것까지 한 계정으로 합산된다. 10회는
// 팀 주소 규칙을 한 번 바꾸거나 방 몇 개 만들면 바로 넘는다(실제로 넘었다).
// 팀·방은 한 번 만들면 계속 쓰므로 평상시 생성은 0에 가깝다. 넉넉히 둔다.
const CREATE_PER_HOUR = 60;
// 키를 틀리는 건 정상 사용에서 거의 없는 일이다. 반복되면 찍어 보는 중이다.
// 키가 18바이트라 맞힐 가능성은 없지만, 두들기는 것 자체를 막는다.
// 생성이 막히면 그 방 조회가 "없는 방" 이 되어 이 계정까지 갉아먹는다.
// 한쪽이 막혔다고 읽기까지 막히면 안 되므로 여유를 둔다.
const BAD_KEY_PER_HOUR = 120;

const buckets = { create: new Map(), badKey: new Map() };
function tooMany(kind, ip, limit) {
  const m = buckets[kind];
  const now = Date.now(), hour = 60 * 60 * 1000;
  if (m.size > 5000) m.clear();                // 메모리가 무한정 늘지 않게
  const list = (m.get(ip) || []).filter((t) => now - t < hour);
  list.push(now);
  m.set(ip, list);
  return list.length > limit;
}
// ALB 뒤라서 remoteAddress 는 전부 ALB 주소다. 실제 클라이언트는 XFF 맨 앞.
const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress || '?';
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// 키 비교는 길이에 따라 빨리 끝나면 안 된다. 앞자리부터 맞춰 나가는 공격을 막는다.
function timingSafeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  if (x.length !== y.length) { crypto.timingSafeEqual(y, y); return false; }
  return crypto.timingSafeEqual(x, y);
}

// 확장(chrome-extension://…)과 웹앱 양쪽에서 부른다. 출처가 제각각이라 열어 두되,
// 자격증명은 안 쓴다(키가 본문·쿼리로 오므로 쿠키가 필요 없다).
function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

// 팀이 없을 때와 열쇠가 틀렸을 때를 한 곳에서 같은 응답으로 돌려준다 —
// 열쇠 없이 팀 존재 여부를 알아낼 수 없게. 반복해서 틀리면 막는다.
const badKey = (req, res) =>
  (tooMany('badKey', clientIp(req), BAD_KEY_PER_HOUR)
    ? send(res, 429, { error: '잠시 후 다시 시도해 주세요' })
    : send(res, 403, { error: '접근할 수 없습니다' }));

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = []; let over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      // 끊지 않고 마저 받아 넘긴다. 연결을 죽이면 클라이언트는 이유를 못 본다.
      if (n > limit) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) { const e = new Error('본문이 너무 큽니다'); e.code = 413; return reject(e); }
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('JSON 이 아닙니다')); }
    });
    req.on('error', reject);
  });
}

// 게시 내용은 우리가 정한 모양으로만 받는다. 남이 보낸 것을 그대로 저장하지 않는다.
function sanitize(b) {
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  return {
    id: str(b.id, 64),
    writeKey: str(b.writeKey, 64),
    name: str(b.name, 24),
    dept: str(b.dept, 40),
    // 공유 범위는 보내는 쪽이 정한다. 없으면 없는 대로 둔다.
    outAt: str(b.outAt, 5) || null,        // 예상 퇴근 "18:30"
    inAt: str(b.inAt, 5) || null,          // 출근
    workedMin: num(b.workedMin),           // 오늘 인정근무
    leftMin: num(b.leftMin),               // 퇴근까지 남은
    monthLeftMin: num(b.monthLeftMin),     // 이번 달 남은
    leaveNm: str(b.leaveNm, 20) || null,   // 휴가면 그 이름
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  cors(res, req.headers.origin);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ALB 의 healthcheck-path 는 인그레스 하나에 하나뿐이라 웹(/healthz)과 같은 길을 쓴다.
  if (url.pathname === '/api/healthz' || url.pathname === '/healthz') {
    return send(res, 200, { ok: true });
  }

  // ── 기기 간 방 목록 ────────────────────────────────────────────────
  if (url.pathname === '/api/me') {
    const id = str(url.searchParams.get('u'), 64);
    const key = str(url.searchParams.get('k'), 64);
    if (!id || key.length < 16) return send(res, 400, { error: '잘못된 요청입니다' });

    if (req.method === 'GET') {
      const p = store.person(id, key);
      if (p === 'forbidden') return badKey(req, res);
      return send(res, 200, p || { rooms: [], at: 0 });
    }
    if (req.method === 'PUT') {
      const b = await readBody(req);
      // 우리가 정한 모양으로만 받는다. 남이 보낸 것을 그대로 저장하지 않는다.
      const rooms = (Array.isArray(b.rooms) ? b.rooms : []).slice(0, MAX_ROOMS).map((r) => ({
        code: str(r && r.code, 32),
        label: str(r && r.label, 24),
        on: !!(r && r.on),
      })).filter((r) => r.code);
      const at = Number.isFinite(b.at) ? Math.round(b.at) : Date.now();
      const r = store.putPerson(id, key, rooms, at);
      if (r === 'forbidden') return badKey(req, res);
      if (r === 'full') return send(res, 409, { error: '자리가 가득 찼습니다' });
      return send(res, 200, { ok: true, at });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  const m = url.pathname.match(/^\/api\/teams(?:\/([\w-]{1,64}))?(\/me)?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const [, teamId, isMe] = m;

  try {
    // 팀은 전부 부서에서 파생된다 (teamId·joinKey 를 클라이언트가 계산한다).
    // 무작위로 팀을 만들어 주던 POST /api/teams 는 없앴다 — 쓰이지 않는데
    // 인터넷에 열려 있으면 아무나 팀 한도를 채울 수 있다.
    if (!teamId) return send(res, 404, { error: 'not found' });
    const team = store.team(teamId);

    // 부서에서 파생한 팀. id 와 joinKey 를 클라이언트가 회사 열쇠로 계산해 오므로
    // 서버가 새로 만들어 줄 게 없다 — 있으면 확인만, 없으면 그대로 만든다.
    // 열쇠를 모르면 id 자체를 계산할 수 없어서 남의 부서 자리를 선점할 수 없다.
    if (req.method === 'PUT' && !isMe) {
      const b = await readBody(req);
      const joinKey = str(b.joinKey, 64);
      // 이름은 선택이다. 안 보내면 쓰던 이름을 그대로 둔다 — 매번 보내게 하면
      // 방 이름을 바꿔 둔 사람과 안 바꾼 사람이 서로 덮어쓴다.
      const name = str(b.name, 40);
      if (joinKey.length < 16) return send(res, 400, { error: '열쇠가 올바르지 않습니다' });
      if (team) {
        if (!timingSafeEq(joinKey, team.joinKey)) return badKey(req, res);
        if (name) store.renameTeam(teamId, name);
        return send(res, 200, { name: team.name });
      }
      if (tooMany('create', clientIp(req), CREATE_PER_HOUR)) {
        return send(res, 429, { error: '잠시 후 다시 시도해 주세요' });
      }
      const nm = name || '팀';
      store.createTeam({ id: teamId, joinKey, name: nm });
      return send(res, 200, { name: nm });
    }

    const key = url.searchParams.get('k') || '';
    // 팀이 없을 때와 키가 틀렸을 때를 같은 응답으로 돌려준다 — 팀 존재 여부를
    // 키 없이 알아낼 수 없게. 반복해서 틀리면 막는다.
    if (!team || !timingSafeEq(key, team.joinKey)) return badKey(req, res);

    if (req.method === 'GET' && !isMe) {
      return send(res, 200, { name: team.name, members: store.members(teamId) });
    }

    if (req.method === 'PUT' && isMe) {
      const me = sanitize(await readBody(req));
      if (!me.id || !me.writeKey || !me.name) return send(res, 400, { error: '필수 값이 없습니다' });
      const r = store.putMember(teamId, me);
      if (r === 'forbidden') return send(res, 403, { error: '다른 사람이 쓰는 자리입니다' });
      if (r === 'full') return send(res, 409, { error: '팀 인원이 가득 찼습니다' });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'DELETE' && isMe) {
      const b = await readBody(req);
      const ok = store.removeMember(teamId, str(b.id, 64), str(b.writeKey, 64));
      return send(res, ok ? 200 : 403, ok ? { ok: true } : { error: '지울 수 없습니다' });
    }

    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return send(res, e.code === 413 ? 413 : 400, { error: e.message || 'bad request' });
  }
});

server.listen(PORT, () => console.log(`worktime-api :${PORT}  data=${DATA}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { store.flush(); server.close(() => process.exit(0)); });
}
