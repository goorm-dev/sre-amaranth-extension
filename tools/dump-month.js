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

  // 신청 목록은 실패를 숨기지 않는다 — 빈 목록으로 넘어가면 "신청 없음" 으로 오해한다.
  let leaveErr = null;
  const [rows, leaves, allApps] = await Promise.all([
    GW.api.getWorkTimeList(keys),
    GW.api.getLeaveList(keys[0], keys[keys.length - 1]).catch((e) => { leaveErr = e.message; return []; }),
    // 계산이 거르기 전의 원본 신청 목록. 계산에 안 들어가는 종류(출장·병가 등)를 찾으려고 본다.
    GW.api.call('/personal/hpd0120/0hp00001',
      { startDt: T.toApiDate(keys[0]), endDt: T.toApiDate(keys[keys.length - 1]), flag: '2' }, 'HPD0120')
      .then((d) => ((d && d.atPopUpDetailInfos) || []).flatMap((g) => g.attendApplications || []))
      .catch(() => []),
  ]);
  let holidays = null;
  try { holidays = await GW.api.getHolidays(Number(mKey.slice(0, 4))); } catch (_) {}
  const plans = await GW.store.getPlans();
  const s = GW.calc.summarize({ rows, leaves, plans, holidays }, settings, mKey, new Date());

  // 음수도 받는다 — 부호를 떼고 나눈다 (안 그러면 -72:-37 처럼 찍힌다).
  const h = (v) => {
    const m = Math.round(v), a = Math.abs(m);
    return `${m < 0 ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  };
  const WD = ['일', '월', '화', '수', '목', '금', '토'];
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  // 근태신청 목록에서 그날 걸린 휴가. 서버 행의 휴가명과 견주려고 같이 찍는다.
  // 계산에 들어간 것은 "신청", 걸러진 것은 "신청(미반영)" 으로 찍는다.
  const appsByKey = {};
  const used = new Set(leaves.map((lv) => `${lv.startKey}|${lv.endKey}|${lv.name}`));
  for (const a of allApps) {
    if (a.reportCancYn === 'Y' || /반려|취소|취하|반송/.test(a.approStateNm || '')) continue;
    const from = T.fromApiDate(a.startDt), to = T.fromApiDate(a.endDt);
    const name = a.atNm || a.atItemNm;
    const tag = used.has(`${from}|${to}|${name}`) ? '신청' : '신청(미반영)';
    for (const d of T.eachDay(T.fromKey(from), T.fromKey(to))) {
      (appsByKey[T.toKey(d)] = appsByKey[T.toKey(d)] || [])
        .push(`${tag} ${a.atItemNm || ''}/${name}[${a.atCd || '-'}](${a.approStateNm || '-'})`);
    }
  }

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
      // 서버 행에 찍힌 휴가명·코드·판정, 그리고 근태신청 목록. 비어 있으면 안 찍는다.
      raw.leaveNm ? `서버휴가 ${raw.leaveNm}${raw.atCd ? `(${raw.atCd})` : ''}` : '',
      raw.resultNm ? `판정 ${raw.resultNm}` : '',
      appsByKey[r.key] ? appsByKey[r.key].join(', ') : '',
    ].filter((x, i) => i < 7 || x).join('  ');
  });

  const out = [
    `[${mKey}]  오늘 ${s.todayKey}`,
    `월 소정근로 ${h(s.requiredMin)} (${s.workdayCount}일) · 인정근무 ${h(s.workedMin)}`
      + ` · 휴가인정 ${h(s.creditMin)}`,
    `남은 ${h(s.remainingMin)} · 남은 근무일 ${s.remainingWorkdays}일`
      + ` · 하루 필요 ${s.avgNeededMin == null ? '-' : h(s.avgNeededMin)}`,
    `어제까지 누적 ${s.paceMin >= 0 ? '+' : ''}${h(s.paceMin)}`
      + ` · 휴일 출처 ${s.holidaySource} · 추정일 ${s.estimatedCount}일`,
    `받은 행 ${rows.length}건 / 요청 ${keys.length}일`
      + (leaveErr ? ` · 휴가 신청 조회 실패: ${leaveErr}` : ''),
    '',
    ...lines,
  ].join('\n');
  console.log(out);
  try { copy(out); } catch (_) {}
  return '클립보드에 복사했습니다';
})();
