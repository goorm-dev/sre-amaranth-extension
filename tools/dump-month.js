// 이번 달 계산을 날짜별로 펼쳐 본다.
//
// "필요 근무시간이 생각보다 적다" 같은 때, 어느 날이 근무일에서 빠졌는지
// 한 줄씩 보면 바로 드러난다. 월 소정근로는 근무일 판정의 합일 뿐이다.
//
// 쓰는 법: 툴바 아이콘 우클릭 → **검사** → 팝업 콘솔에 붙여 넣는다.
//   (gw 페이지 콘솔이 아니다 — 거기엔 GW 가 없다)
(async () => {
  const T = GW.time;
  const settings = await GW.store.getSettings();
  const mKey = T.monthKey(new Date());
  const { first, last } = T.monthRange(mKey);
  const keys = [...T.eachDay(first, last)].map(T.toKey);

  const [rows, leaves] = await Promise.all([
    GW.api.getWorkTimeList(keys),
    GW.api.getLeaveList(keys[0], keys[keys.length - 1]).catch(() => []),
  ]);
  let holidays = null;
  try { holidays = await GW.api.getHolidays(Number(mKey.slice(0, 4))); } catch (_) {}
  const plans = await GW.store.getPlans();
  const s = GW.calc.summarize({ rows, leaves, plans, holidays }, settings, mKey, new Date());

  const h = (v) => { const m = Math.round(v); return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));

  const lines = s.rows.map((r) => {
    const d = T.fromKey(r.key);
    const raw = byKey[r.key] || {};
    const why = r.standardMin > 0 ? '근무일'
      : (d.getDay() === 0 || d.getDay() === 6) ? '주말'
        : (r.holidayNm || GW.holidays.holidayName(r.key, settings, holidays) || '쉬는 날로 판정');
    return [
      r.key.slice(5), WD[d.getDay()],
      `소정 ${String(r.standardMin).padStart(3)}`,
      `인정 ${String(r.workedMin).padStart(3)}`,
      r.creditMin ? `휴가 ${r.creditMin}` : '        ',
      // 서버가 준 원본도 같이 본다 — 우리 판정과 어긋나는 날을 찾기 위해서다
      `서버소정 ${String(raw.selfCommuteStandardWorkTm ?? raw.standardMin ?? '-').padStart(3)}`,
      why,
    ].join('  ');
  });

  const out = [
    `[${mKey}]  오늘 ${s.todayKey}`,
    `월 소정근로 ${h(s.requiredMin)} (${s.workdayCount}일) · 인정근무 ${h(s.workedMin)}`
      + ` · 휴가인정 ${h(s.creditMin)}`,
    `남은 ${h(s.remainingMin)} · 남은 근무일 ${s.remainingWorkdays}일`
      + ` · 하루 필요 ${s.avgNeededMin == null ? '-' : h(s.avgNeededMin)}`,
    `어제까지 누적 ${s.paceMin >= 0 ? '+' : ''}${h(s.paceMin)}`
      + ` · 휴일 출처 ${s.holidaySource} · 추정일 ${s.estimatedCount}일`,
    `받은 행 ${rows.length}건 / 요청 ${keys.length}일`,
    '',
    ...lines,
  ].join('\n');
  console.log(out);
  try { copy(out); } catch (_) {}
  return '클립보드에 복사했습니다';
})();
