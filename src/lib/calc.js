// 월 단위 근무시간 집계.
//
// 소정근로시간(selfCommuteStandardWorkTm)은 서버가 날짜별로 내려준다 — 공휴일·연차
// 처리가 모두 반영된 값이라 평일을 직접 셀 필요가 없다. 연차·반차 인정분도 서버가
// 이미 인정근무(appworkTm)에 반영해 준다.
//
// 다만 서버 값은 **다음날 새벽 배치**로 채워지므로 오늘·미래 날짜는 0으로 온다.
// 그래서 마감된 날은 서버 값, 아직 안 온 날은 공휴일 표로 추정하는 하이브리드다.
// 추정이 틀려도 달이 진행되면서 서버 값으로 교정된다.
(function (root) {
  const GW = (root.GW = root.GW || {});

  // 신청 구간에서 실제 휴가 인정 시간을 뽑는다.
  //
  //   오전반차 09:00~14:00 → 300분   (점심 휴게 1시간이 구간에 포함돼 있다)
  //   오후반차 14:00~18:00 → 240분   (휴게 없음)
  //
  // 둘 다 실제로는 4시간이다. 그래서 구간이 4시간을 넘으면 휴게 1시간을 뺀다.
  // 종일연차 09:00~18:00(540분)도 같은 규칙으로 480분이 된다.
  // 반환: { min, breakUsed } — breakUsed 는 이 구간이 이미 흡수한 휴게시간.
  // 휴게는 하루에 한 번만 적용되므로, 휴가가 먼저 써버렸으면 남은 근무에는 더하지 않는다.
  function creditFromSpan(spanMin, breakMin) {
    if (spanMin == null) return null;
    if (spanMin <= 240) return { min: spanMin, breakUsed: 0 };
    const brk = breakMin || 60;
    return { min: Math.max(0, spanMin - brk), breakUsed: brk };
  }

  // 근태신청을 날짜별 인정 시간(분)으로 펼친다.
  // 하루에 오전반차 + 오후반차처럼 여러 건이 겹치면 합산하되 소정근로를 넘지 않게 한다.
  function leaveCreditsByDate(leaves, dailyMin, breakMin) {
    const out = {};
    for (const lv of leaves || []) {
      if ((lv.kind || 'leave') !== 'leave') continue;   // 휴게는 방향이 반대라 여기서 제외
      const from = GW.time.fromKey(lv.startKey);
      const to = GW.time.fromKey(lv.endKey);
      // 여러 날에 걸친 휴가는 매일 하루치로 본다.
      const multi = lv.startKey !== lv.endKey;
      for (const d of GW.time.eachDay(from, to)) {
        const key = GW.time.toKey(d);
        // 여러 날짜짜리는 하루치, 하루짜리는 신청 구간에서 뽑는다.
        // 구간이 없으면 이름으로 (반차 = 절반) 추정한다.
        const fromSpan = multi ? null : creditFromSpan(lv.spanMin, breakMin);
        const min = multi
          ? dailyMin
          : Math.min(fromSpan == null ? Math.round(dailyMin * lv.portion) : fromSpan.min, dailyMin);
        const cur = out[key] || { min: 0, breakUsed: 0, names: [] };
        cur.min += min;
        cur.breakUsed = Math.min((breakMin || 60), cur.breakUsed + (fromSpan ? fromSpan.breakUsed : 0));
        cur.names.push(lv.name);
        out[key] = cur;
      }
    }
    return out;
  }


  function hhmmToMin(t) {
    const [h, m] = String(t).split(':').map(Number);
    return h * 60 + m;
  }

  function summarize({ rows, leaves, plans, holidays }, settings, monthKey, now) {
    const T = GW.time;
    const base = now || new Date();
    const today = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const todayKey = T.toKey(today);

    const raw = (rows || []).filter((r) => r.key.startsWith(monthKey));

    // 하루 기준은 설정값(8시간) 고정이다.
    // 서버의 selfCommuteStandardWorkTm 은 법정근로시간이라 8시간보다 짧게 잡히는 날이 있는데,
    // 그걸 기준으로 평균을 내면 실제로 채워야 하는 시간과 어긋난다.
    // 서버 값은 "그날이 근무일인가"를 판별하는 데만 쓴다.
    const dailyMin = settings.dailyMinutes || 480;

    // 휴가 크레딧을 언제 더할지가 관건이다.
    //
    // 서버는 결재가 **완료된** 휴가만 배치에 반영한다 (그 날 행의 leaveNm 에 "오전반차" 등이 찍힌다).
    // 결재진행 중이면 마감된 날이어도 반차가 빠진 순수 타각 시간만 들어온다.
    //   예) 9/1 오전반차(결재진행) → appworkTm 388분(14:39~21:07). 반차 4시간이 통째로 누락.
    //
    // 그래서 "마감 여부"가 아니라 "서버가 그 휴가를 반영했는지"로 판단한다.
    const credits = leaveCreditsByDate(leaves, dailyMin, settings.breakMinutes);

    // 아직 배치가 안 돈 날은 추정치를 채운다.
    const month = raw.map((r) => {
      const settled = r.standardMin > 0 || r.key < todayKey;
      const isWorkday = settled ? r.standardMin > 0 : GW.holidays.isWorkday(r.key, settings, holidays);
      const standardMin = isWorkday ? dailyMin : 0;   // 근무일이면 무조건 8시간
      // 서버 행에 휴가명이 찍혀 있으면 이미 인정근무에 반영된 것이므로 더하지 않는다.
      const serverApplied = !!r.leaveNm;
      const c = (!serverApplied && credits[r.key]) || null;
      const creditMin = c ? Math.min(c.min, standardMin) : 0;
      // 사용자가 "이 날은 N시간만 하겠다"고 정해둔 날. 마감 전이고 근무일일 때만 의미가 있다.
      const planned = (plans || {})[r.key];
      const planMin = (!settled && isWorkday && planned != null) ? planned : null;
      // 휴게·외출 신청은 건드리지 않는다. 결재가 끝나면 서버가 인정근무에 반영한다.
      return {
        ...r,
        standardMin,
        estimated: !settled && standardMin > 0,
        creditMin,
        planMin,
        leaveBreakMin: c ? c.breakUsed : 0,   // 휴가 구간이 이미 흡수한 휴게시간
        leaveNames: c ? c.names : null,
        holidayNm: standardMin ? null : GW.holidays.holidayName(r.key, settings, holidays),
      };
    });
    const estimatedCount = month.filter((r) => r.estimated).length;

    const requiredMin = month.reduce((a, r) => a + r.standardMin, 0);
    const workedMin = month.reduce((a, r) => a + r.workedMin, 0);
    const creditMin = month.reduce((a, r) => a + r.creditMin, 0);
    const fulfilledMin = workedMin + creditMin;
    const remainingMin = requiredMin - fulfilledMin;

    const workdays = month.filter((r) => r.standardMin > 0);
    const closed = workdays.filter((r) => r.key < todayKey);
    // 휴가로 하루가 통째로 채워지는 날은 "출근해야 하는 날"에서 뺀다.
    const remaining = workdays.filter((r) => r.key >= todayKey && r.creditMin < r.standardMin);

    // 그룹웨어 화면의 "N월 누적 …초과달성" 과 같은 값 (마감된 날 기준).
    const paceMin = closed.reduce((a, r) => a + (r.workedMin + r.creditMin - r.standardMin), 0);
    const leaveDays = month.filter((r) => r.creditMin > 0);

    // 근태 이상: 타각은 남아 있는데 인정근무가 0인 날.
    // 출근 타각이 빠지면 아마란스가 "이상근태"로 분류하고 appworkTm 을 0으로 준다.
    // 그대로 두면 그날 8시간이 통째로 부족분으로 빨려 들어가므로 눈에 띄게 알린다.
    // (근태조정을 신청해야 채워진다 — 확장이 계산으로 메울 수 있는 값이 아니다)
    const anomalies = closed
      .filter((r) => r.workedMin === 0 && r.creditMin === 0 && (r.inAt || r.outAt))
      .map((r) => ({
        key: r.key,
        inAt: r.inAt,
        outAt: r.outAt,
        resultNm: r.resultNm,
        // 타각이 둘 다 있으면 못 받은 시간을 어림한다.
        lostMin: r.inAt && r.outAt
          ? Math.max(0, hhmmToMin(r.outAt) - hhmmToMin(r.inAt) - (settings.breakMinutes || 0))
          : null,
      }));

    const remainingWorkdays = remaining.length;

    // 하루 필요 = 남은 시간을 남은 근무일로 나눈 평균.
    //
    // 단, 필요 시간이 이미 정해진 날은 분자·분모에서 빼고 **나머지 날**로만 평균을 낸다.
    //   · 반차가 걸린 날 → 8시간 − 반차
    //   · 사용자가 계획을 넣은 날 → 그 값
    // 이걸 섞으면 반차 날의 4시간이 평균을 끌어내려서, 평범한 날 몇 시간 해야 하는지
    // 알 수 없게 된다.
    const fixedDays = remaining.filter((r) => r.planMin != null || r.creditMin > 0);
    const openDays = remaining.filter((r) => r.planMin == null && r.creditMin === 0);
    const fixedNeedMin = fixedDays.reduce(
      (a, r) => a + (r.planMin != null ? r.planMin : r.standardMin - r.creditMin), 0);

    const avgNeededMin = openDays.length
      ? (remainingMin - fixedNeedMin) / openDays.length
      : null;
    // 남은 날이 전부 정해져 있으면, 그 계획대로 했을 때의 과부족.
    const planBalanceMin = openDays.length ? null : fixedNeedMin - remainingMin;

    const floorCapacity = remainingWorkdays * settings.minFlexMinutes;
    const parCapacity = remainingWorkdays * dailyMin;
    let feasibility;
    if (remainingMin <= 0) feasibility = 'done';
    else if (remainingMin > parCapacity) feasibility = 'impossible';  // 매일 8시간을 채워도 부족
    else if (remainingMin > floorCapacity) feasibility = 'tight';     // 매일 6시간으로는 부족
    else feasibility = 'ok';                                          // 6시간씩만 해도 충족

    const todayRow = month.find((r) => r.key === todayKey) || null;

    return {
      monthKey, today, todayKey, rows: month,
      requiredMin, workedMin, creditMin, fulfilledMin, remainingMin,
      leaveDays,
      workdayCount: workdays.length,
      closedCount: closed.length,
      remainingWorkdays,
      isTodayWorkday: !!(todayRow && todayRow.standardMin > 0),
      todayRow,
      paceMin, avgNeededMin, dailyMin, estimatedCount,
      holidaySource: holidays && holidays.complete ? 'server' : 'table',
      anomalies,
      openWorkdays: openDays.length,
      plannedDays: remaining.filter((r) => r.planMin != null).length,
      fixedNeedMin, planBalanceMin,
      floorCapacity, parCapacity, feasibility,
      hasData: month.length > 0,
      settings,
    };
  }

  // 출근 시각 기준으로 "언제 퇴근하면 되는지".
  // live = getComeLeave() 의 실시간 타각. 근태 배치 전이라 서버 집계에 없는 오늘도 잡힌다.
  function todayPlan(s, settings, live, now) {
    const row = s.todayRow;
    const inAt = (live && live.inAt) || (row && row.inAt);
    const outAt = (live && live.outAt) || (row && row.outAt);
    if (!inAt) return null;

    const hm = (t) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const inMin = hm(inAt);
    // 휴게는 하루 한 번. 휴가 구간(예: 오전반차 09:00~14:00)이 이미 썼으면 또 빼지 않는다.
    // 여기에 휴게·외출 신청분을 더한다 — 근로시간에서 빠지므로 퇴근이 그만큼 밀린다.
    const brk = Math.max(0, (settings.breakMinutes || 0) - ((row && row.leaveBreakMin) || 0));

    // 반차를 썼으면 그만큼 오늘 채워야 할 시간이 줄어든다.
    const creditMin = (row && row.creditMin) || 0;
    const standardMin = (row && row.standardMin) || s.dailyMin;
    const needMin = Math.max(0, standardMin - creditMin);
    // 반차를 쓴 날은 유연근무 하한(6시간)이 적용되지 않는다.
    // 그날 남은 소정근로가 곧 최소 근무시간이다 (오전반차 → 4시간).
    const minNeedMin = creditMin > 0 ? needMin : Math.min(settings.minFlexMinutes, needMin);

    if (outAt) {
      // 집계된 인정근무가 있으면 그 값을, 없으면 타각 기준으로 환산한다.
      const workedMin = row && row.workedMin > 0
        ? row.workedMin
        : Math.max(0, hm(outAt) - inMin - brk);
      return { done: true, inAt, outAt, workedMin };
    }

    const base = inMin + brk;
    const at = (workMin) => {
      const t = base + workMin;
      return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(Math.round(t % 60)).padStart(2, '0')}`;
    };

    const clock = now || new Date();
    const elapsedMin = Math.max(0, clock.getHours() * 60 + clock.getMinutes() - base);

    return {
      done: false,
      inAt,
      elapsedMin,
      creditMin,
      leaveNames: (row && row.leaveNames) || null,
      minNeedMin,
      needMin,
      singleTarget: minNeedMin === needMin,   // 반차 날은 최소=정량이라 한 줄로 보여준다
      minOut: at(minNeedMin),
      parOut: at(needMin),
    };
  }

  GW.calc = { summarize, todayPlan };
})(typeof window !== 'undefined' ? window : globalThis);
