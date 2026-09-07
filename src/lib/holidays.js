// 아직 배치가 돌지 않은 날(오늘·미래)의 소정근로시간을 추정하기 위한 공휴일 표.
// 마감된 날은 서버가 내려주는 값을 그대로 쓰므로, 이 표는 "앞으로 남은 날" 추정에만 쓰인다.
// 표가 틀려도 달이 진행되면서 서버 값으로 자동 교정된다.
//
// ── 대체공휴일 규칙 (관공서의 공휴일에 관한 규정 §3) ──────────────────────
//   토요일·일요일 겹침 → 대체 : 3·1절, 광복절, 개천절, 한글날, 부처님오신날, 성탄절
//   토요일·일요일·다른 공휴일 겹침 → 대체 : 어린이날
//   일요일·다른 공휴일 겹침 → 대체 : 설날 연휴, 추석 연휴  ※ 토요일은 대체 없음
//   대체 없음 : 신정, 현충일
//
// 흔한 실수 두 가지 — 표를 고칠 때 반드시 확인할 것:
//   · 추석/설 연휴가 토요일과 겹쳐도 대체휴일은 생기지 않는다
//     (2026 추석 9/24~9/26 중 9/26이 토요일이지만 9/28은 평일이다)
//   · 현충일은 어느 요일에 걸려도 대체휴일이 없다
(function (root) {
  const GW = (root.GW = root.GW || {});

  const BUILTIN = {
    2025: ['2025-01-01', '2025-01-28', '2025-01-29', '2025-01-30', '2025-03-03', '2025-05-01',
           '2025-05-05', '2025-05-06', '2025-06-03', '2025-06-06', '2025-08-15', '2025-10-03',
           '2025-10-06', '2025-10-07', '2025-10-08', '2025-10-09', '2025-12-25'],
    // 2026: 추석 9/24(목)~9/26(토) — 9/26이 토요일이지만 대체휴일 없음
    2026: ['2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-01',
           '2026-05-05', '2026-05-25', '2026-06-06', '2026-08-15', '2026-08-17', '2026-09-24',
           '2026-09-25', '2026-09-26', '2026-10-03', '2026-10-05', '2026-10-09', '2026-12-25'],
    // 2027: 현충일 6/6(일) — 대체휴일 없음 / 성탄절 12/25(토) → 12/27 대체
    2027: ['2027-01-01', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09', '2027-03-01',
           '2027-05-05', '2027-05-13', '2027-06-06', '2027-08-15', '2027-08-16', '2027-09-14',
           '2027-09-15', '2027-09-16', '2027-10-03', '2027-10-04', '2027-10-09', '2027-10-11',
           '2027-12-25', '2027-12-27'],
  };

  function setFor(year, settings) {
    const s = settings || {};
    const set = new Set(BUILTIN[year] || []);
    for (const k of s.holidayRemove || []) set.delete(k);
    for (const k of s.holidayAdd || []) set.add(k);
    return set;
  }

  // 근무일 추정: 주말 아님 + 휴일 아님.
  //
  // 우선순위 — 사용자 설정 > 서버 휴일 > 내장 표.
  // 서버가 그 해 휴일을 충분히 등록해 뒀으면(complete) 내장 표는 아예 쓰지 않는다.
  // 표에만 있고 서버엔 없는 날을 휴일로 잘못 잡는 걸 막기 위해서다.
  function isWorkday(dateKey, settings, server) {
    const d = GW.time.fromKey(dateKey);
    const day = d.getDay();
    if (day === 0 || day === 6) return false;

    const s = settings || {};
    if ((s.holidayRemove || []).includes(dateKey)) return true;
    if ((s.holidayAdd || []).includes(dateKey)) return false;

    if (server && server.days && server.days[dateKey]) return false;
    if (server && server.complete) return true;

    return !(BUILTIN[d.getFullYear()] || []).includes(dateKey);
  }

  // 그 날이 휴일이면 이름을 돌려준다 (달력 표시용)
  function holidayName(dateKey, settings, server) {
    if (server && server.days && server.days[dateKey]) return server.days[dateKey];
    return (BUILTIN[GW.time.fromKey(dateKey).getFullYear()] || []).includes(dateKey) ? '휴일' : null;
  }

  function hasTable(year) { return !!BUILTIN[year]; }

  GW.holidays = { BUILTIN, isWorkday, holidayName, hasTable };
})(typeof window !== 'undefined' ? window : globalThis);
