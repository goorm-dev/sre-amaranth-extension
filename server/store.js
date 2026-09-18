// 파일 한 개짜리 저장소.
//
// 규모가 작다 — 팀 몇 개, 사람 수십 명, 1인당 몇백 바이트. DB 를 세울 이유가 없고
// 외부 의존이 없는 편이 운영이 쉽다. 메모리에 들고 있다가 바뀌면 파일에 쓴다.
//
// 쓰기는 임시 파일에 쓰고 rename 한다. 쓰는 도중 죽어도 반쪽짜리 파일이 남지 않는다.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_TEAMS = 500;
const MAX_MEMBERS = 200;          // 팀당
const STALE_MS = 3 * 24 * 60 * 60 * 1000;   // 사흘 지난 게시물은 버린다

class Store {
  constructor(file) {
    this.file = file;
    this.data = { teams: {} };
    this.dirty = false;
    this.load();
    // 몰아서 쓴다. 게시가 몰려도 디스크를 계속 두들기지 않는다.
    this.timer = setInterval(() => this.flush(), 2000);
    this.timer.unref?.();
    this.sweeper = setInterval(() => this.sweep(), 60 * 60 * 1000);
    this.sweeper.unref?.();
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!this.data || typeof this.data !== 'object') this.data = { teams: {} };
      if (!this.data.teams) this.data.teams = {};
    } catch (_) { this.data = { teams: {} }; }
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.dirty = true;   // 다음 주기에 다시 시도한다
      console.error('[store] 쓰기 실패:', e.message);
    }
  }

  createTeam(team) {
    if (Object.keys(this.data.teams).length >= MAX_TEAMS) throw new Error('팀이 너무 많습니다');
    this.data.teams[team.id] = { ...team, members: {}, at: Date.now() };
    this.dirty = true;
    return this.data.teams[team.id];
  }

  team(id) { return this.data.teams[id] || null; }

  putMember(teamId, member) {
    const t = this.team(teamId);
    if (!t) return null;
    const existing = t.members[member.id];
    // 한 번 자리를 잡은 selfId 는 그 writeKey 로만 갱신된다. 남의 칸을 못 덮어쓴다.
    if (existing && existing.writeKey !== member.writeKey) return 'forbidden';
    if (!existing && Object.keys(t.members).length >= MAX_MEMBERS) return 'full';
    t.members[member.id] = { ...member, at: Date.now() };
    t.at = Date.now();
    this.dirty = true;
    return t.members[member.id];
  }

  removeMember(teamId, id, writeKey) {
    const t = this.team(teamId);
    if (!t || !t.members[id]) return false;
    if (t.members[id].writeKey !== writeKey) return false;
    delete t.members[id];
    this.dirty = true;
    return true;
  }

  // 아무도 안 쓰는 팀은 지운다. members() 가 오래된 사람을 걷어내므로, 걷어낸 뒤
  // 빈 채로 사흘이 지난 팀은 되살아날 일이 없다. 안 하면 MAX_TEAMS 가 서서히 찬다.
  sweep() {
    const cut = Date.now() - STALE_MS;
    for (const [id, t] of Object.entries(this.data.teams)) {
      for (const [mid, m] of Object.entries(t.members)) {
        if (m.at < cut) { delete t.members[mid]; this.dirty = true; }
      }
      if (!Object.keys(t.members).length && t.at < cut) {
        delete this.data.teams[id]; this.dirty = true;
      }
    }
  }

  // 오래된 게시물은 빼고 돌려준다. writeKey 는 절대 밖으로 내보내지 않는다.
  members(teamId) {
    const t = this.team(teamId);
    if (!t) return [];
    const cut = Date.now() - STALE_MS;
    const out = [];
    for (const [id, m] of Object.entries(t.members)) {
      if (m.at < cut) { delete t.members[id]; this.dirty = true; continue; }
      const { writeKey, ...safe } = m;
      out.push(safe);
    }
    return out.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ko'));
  }
}

module.exports = { Store, STALE_MS };
