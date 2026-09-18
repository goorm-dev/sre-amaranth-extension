// worktime 공유 API.
//
// 팀 링크가 곧 권한이다 — 계정도 로그인도 없다. 팀을 만들면 joinKey 가 나오고,
// 그 키를 가진 사람만 읽고 쓸 수 있다. worktime.goorm.io 는 인터넷에서 닿으므로
// 키 없는 접근은 전부 막는다.
//
//   POST /api/teams                      { name }        → { teamId, joinKey }
//   GET  /api/teams/:id?k=<joinKey>                      → { name, members[] }
//   PUT  /api/teams/:id/me?k=<joinKey>   { id, writeKey, name, ... }
//   DELETE /api/teams/:id/me?k=<joinKey> { id, writeKey }
//
// writeKey 는 각자 브라우저에서 만든 값이고 서버 밖으로 나가지 않는다 —
// 자기 칸만 갱신할 수 있게 하는 용도다.
'use strict';
const http = require('http');
const crypto = require('crypto');
const { Store } = require('./store');

const PORT = Number(process.env.PORT || 8081);
const DATA = process.env.DATA_FILE || '/data/teams.json';
const store = new Store(DATA);

const rid = (n) => crypto.randomBytes(n).toString('base64url');

// 팀 생성만 IP 단위로 제한한다. 인터넷에 열려 있어서, 안 막으면 아무나 MAX_TEAMS 를
// 채워 남이 팀을 못 만들게 할 수 있다. 읽기·쓰기는 키가 있어야 하므로 제외.
const CREATE_PER_HOUR = 10;
const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), hour = 60 * 60 * 1000;
  const list = (hits.get(ip) || []).filter((t) => now - t < hour);
  if (hits.size > 5000) hits.clear();          // 메모리가 무한정 늘지 않게
  list.push(now);
  hits.set(ip, list);
  return list.length > CREATE_PER_HOUR;
}
// ALB 뒤라서 remoteAddress 는 전부 ALB 주소다. 실제 클라이언트는 XFF 맨 앞.
const clientIp = (req) =>
  String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket.remoteAddress || '?';
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

// 확장(chrome-extension://…)과 웹앱 양쪽에서 부른다. 출처가 제각각이라 열어 두되,
// 자격증명은 안 쓴다(키가 본문·쿼리로 오므로 쿠키가 필요 없다).
function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin');
}

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

  const m = url.pathname.match(/^\/api\/teams(?:\/([\w-]{1,64}))?(\/me)?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const [, teamId, isMe] = m;

  try {
    // 팀 만들기
    if (req.method === 'POST' && !teamId) {
      if (tooMany(clientIp(req))) return send(res, 429, { error: '잠시 후 다시 시도해 주세요' });
      const b = await readBody(req);
      const name = str(b.name, 40) || '팀';
      const team = store.createTeam({ id: rid(9), joinKey: rid(18), name });
      return send(res, 200, { teamId: team.id, joinKey: team.joinKey, name: team.name });
    }

    if (!teamId) return send(res, 404, { error: 'not found' });
    const team = store.team(teamId);
    const key = url.searchParams.get('k') || '';
    // 팀이 없을 때와 키가 틀렸을 때를 같은 응답으로 돌려준다 — 팀 존재 여부를
    // 키 없이 알아낼 수 없게.
    if (!team || key !== team.joinKey) return send(res, 403, { error: '링크가 올바르지 않습니다' });

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
