// 파일 한 개짜리 저장소.
//
// 규모가 작다 — 팀 몇 개, 사람 수십 명, 1인당 몇백 바이트. DB 를 세울 이유가 없고
// 외부 의존이 없는 편이 운영이 쉽다. 메모리에 들고 있다가 바뀌면 파일에 쓴다.
//
// 쓰기는 임시 파일에 쓰고 rename 한다. 쓰는 도중 죽어도 반쪽짜리 파일이 남지 않는다.
'use strict';
const fs = require('fs');
const path = require('path');

// 팀 하나가 몇백 바이트다. 빈 팀은 36시간 뒤 정리되므로 넉넉해도 안 쌓인다.
const MAX_TEAMS = 2000;
const MAX_MEMBERS = 200;          // 팀당
const MAX_PEOPLE = 5000;          // 기기 간 방 목록 동기화용
const MAX_ROOMS = 30;             // 1인당
// 방 목록은 근무 기록과 달리 오래 들고 있어야 한다 — 며칠 쉬었다고 지워지면 안 된다.
const PEOPLE_STALE_MS = 90 * 24 * 60 * 60 * 1000;
// 보여 주려는 건 "오늘 누가 언제 퇴근하나" 다. 사흘을 들고 있으면 그만둔 사람이나
// 옛 판본이 남긴 자리가 계속 목록에 뜬다(실제로 그랬다). 어제 저녁~오늘 아침이
// 이어 보일 만큼만 남긴다.
const STALE_MS = 36 * 60 * 60 * 1000;

class Store {
  constructor(file) {
    this.file = file;
    this.data = { teams: {}, people: {} };
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
      if (!this.data.people) this.data.people = {};
    } catch (_) { this.data = { teams: {}, people: {} }; }
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

  // 부서명이 바뀌면 따라간다. 팀 이름은 표시용이라 아무나 못 바꾸게만 하면 된다
  // (호출부가 joinKey 를 이미 확인한 뒤에 부른다).
  renameTeam(id, name) {
    const t = this.team(id);
    if (!t || !name || t.name === name) return;
    t.name = name;
    this.dirty = true;
  }

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
    const pcut = Date.now() - PEOPLE_STALE_MS;
    for (const [id, p] of Object.entries(this.data.people || {})) {
      if ((p.at || 0) < pcut) { delete this.data.people[id]; this.dirty = true; }
    }
  }

  // ── 기기 간 방 목록 ────────────────────────────────────────────────
  //
  // 자리(selfId)와 그 열쇠(writeKey)는 사번에서 나온다. 같은 사람의 PC 와 폰이
  // 같은 값을 계산하므로, 그걸 열쇠 삼아 방 목록을 맡아 둔다.
  person(id, writeKey) {
    const p = this.data.people[id];
    if (!p) return null;
    if (p.writeKey !== writeKey) return 'forbidden';
    return { rooms: p.rooms || [], at: p.at || 0 };
  }

  putPerson(id, writeKey, rooms, at) {
    const cur = this.data.people[id];
    if (cur && cur.writeKey !== writeKey) return 'forbidden';
    if (!cur && Object.keys(this.data.people).length >= MAX_PEOPLE) return 'full';
    this.data.people[id] = { writeKey, rooms: rooms.slice(0, MAX_ROOMS), at };
    this.dirty = true;
    return true;
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

module.exports = { Store, STALE_MS, MAX_ROOMS };
