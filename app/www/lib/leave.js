// 휴가 신청 + 결재상신.
//
// 실제 신청서가 만드는 요청을 캡처해 재현했다. 흐름:
//   1) calculateApplicationDays  — 서버가 일수·시간·연차차감을 계산 (읽기)
//   2) validateNew               — 서버가 중복·잔여연차 등을 검증 (읽기)
//   3) create                    — 결재상신. approLineId 를 비우면 서버가 기본 결재선을 붙인다
//
// atCd/시간대는 아마란스 코드 그대로. 결재선은 앱이 만들지 않는다(서버 기본선 사용).
(function (root) {
  const GW = (root.GW = root.GW || {});

  // 지원하는 휴가 종류. atCd 는 calculateApplicationDays 로 검증했다.
  // 종류별 atCd·시간대. calculateApplicationDays 로 연차차감(yc)을 검증했다.
  //   종일 09:00~18:00(yc 1.0) / 오전반차 09:00~14:00(0.5) / 오후반차 15:00~19:00(0.5)
  //   보상(연차보상)은 +4 오프셋 코드. 반차 4종은 실제 이력, 종일 2종은 yc=1 로 확인.
  const TYPES = {
    annual:    { atCd: '1101', name: '연차',        start: '0900', end: '1800', timeSetFg: 'ALL', full: true },
    amHalf:    { atCd: '1102', name: '오전반차',    start: '0900', end: '1400', timeSetFg: 'AM' },
    pmHalf:    { atCd: '1103', name: '오후반차',    start: '1500', end: '1900', timeSetFg: 'PM' },
    annualComp:{ atCd: '1105', name: '연차(보상)',  start: '0900', end: '1800', timeSetFg: 'ALL', full: true },
    amHalfComp:{ atCd: '1106', name: '오전반차(보상)', start: '0900', end: '1400', timeSetFg: 'AM' },
    pmHalfComp:{ atCd: '1107', name: '오후반차(보상)', start: '1500', end: '1900', timeSetFg: 'PM' },
  };
  const LINK_AT = '1010';   // 연차휴가 그룹

  const api = () => GW.api;
  const P_CALC = '/human/common/attendapplication/calculateApplicationDays';
  const P_VALID = '/human/attendapplication/validateNew';
  const P_CREATE = '/human/attendapplication/create';
  const MENU = 'HPD0110';

  // 신청자 정보 + 근무 스케줄 필드. 최근 근무일 행에서 가져온다.
  async function profile() {
    const s = api().getSession ? api().getSession() : null;
    let sched = { coCd: '1000', deptCd: null, groupCd: 'F100', workTp: '8',
                  comeStTm: '0730', leaveStTm: '2200', timeCd: '' };
    try {
      const today = new Date();
      const keys = [];
      for (let i = 1; i <= 20; i++) keys.push(GW.time.toKey(GW.time.addDays(today, -i)));
      const rows = await api().getWorkTimeList(keys);
      const r = rows.find((x) => x.coCd && x.deptCd);
      if (r) {
        sched = {
          coCd: r.coCd, deptCd: r.deptCd, groupCd: r.groupCd || 'F100',
          workTp: r.workTp || '8',
          comeStTm: r.comeStTm || '0730', leaveStTm: r.leaveStTm || '2200',
          timeCd: r.timeCd || '',
        };
      }
    } catch (_) {}
    return sched;
  }

  const apiDate = (key) => key.replace(/-/g, '');
  const hhmm = (t) => (/^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}` : (t || ''));

  // 미리보기(확인 화면)에 필요한 값을 서버 계산으로 채운다. 상신은 하지 않는다.
  async function preview(typeKey, dateKey, empNmHint) {
    const t = TYPES[typeKey];
    if (!t) throw new Error('지원하지 않는 휴가 종류입니다.');
    const d = await api().call(P_CALC, {
      startDate: apiDate(dateKey), endDate: apiDate(dateKey),
      startTime: t.start, endTime: t.end, atCd: t.atCd, linkAtCd: LINK_AT,
      empCd: undefined, appRmkDc: '', calculateOption: 'HOLIDAY_EXCLUSION',
    }, MENU);
    if (!d) throw new Error('신청 계산에 실패했습니다.');
    return {
      typeKey, type: t, dateKey,
      coCd: d.coCd, empCd: d.empCd, empNm: d.empNm, deptCd: d.deptCd, deptNm: d.deptNm,
      appDy: d.applicationDaysCnt != null ? d.applicationDaysCnt : d.daysCnt,
      appTm: d.applicationMinutes != null ? d.applicationMinutes : d.dailyAppTm,
      ycUseCnt: d.ycUseCnt != null ? d.ycUseCnt : d.dailyYcUseCnt,
      groupCd: d.applicationInfo && d.applicationInfo.groupCd,
    };
  }

  function buildItem(pv, sched) {
    const t = pv.type;
    return {
      detailSq: null, coCd: pv.coCd || sched.coCd, appDt: null, appSq: null,
      deptCd: pv.deptCd || sched.deptCd, empCd: pv.empCd,
      linkAtCd: LINK_AT, atCd: t.atCd, atYm: null,
      atDt: apiDate(pv.dateKey), baseAtDt: null,
      startDt: apiDate(pv.dateKey), endDt: apiDate(pv.dateKey),
      comeStTm: sched.comeStTm, leaveStTm: sched.leaveStTm,
      startTm: t.start, endTm: t.end,
      actStartTm: null, actEndTm: null,
      appDyFg: t.dayFg, appDy: String(pv.appDy), appTm: pv.appTm, appRmkDc: '',
      ycUseCnt: pv.ycUseCnt, ycGrantCnt: 0,
      workTp: sched.workTp, groupCd: pv.groupCd || sched.groupCd, timeCd: sched.timeCd,
      reportCancYn: 'N', cancellationApplication: false,
      deptNm: pv.deptNm, empNm: pv.empNm,
    };
  }

  function title(pv) {
    const [, m, d] = pv.dateKey.split('-');
    const t = pv.type;
    const range = t.full ? '' : ` (${hhmm(t.start)}~${hhmm(t.end)})`;
    return `[${pv.deptNm} ${pv.empNm}]  ${m}-${d}${range}(${Number(pv.appDy).toFixed(1)}일)${t.name}신청서`;
  }

  // 검증 (읽기). 문제가 있으면 메시지를 돌려준다.
  async function validate(pv, sched) {
    const item = buildItem(pv, sched);
    const emp = [{ empCd: pv.empCd, korNm: pv.empNm, deptCd: pv.deptCd, deptNm: pv.deptNm, divNm: '' }];
    const v = await api().call(P_VALID, {
      checkRange: 'ALL', checkPoint: 'ADD', empCdList: [pv.empCd], alreadyAddedItems: [],
      newItem: Object.assign({}, item, {
        atNm: pv.type.name, timeSetFg: pv.type.timeSetFg,
        repeatTp: 'NONE', holidayYn: 'N',
        datePeriod: { from: apiDate(pv.dateKey), to: apiDate(pv.dateKey) },
        employeeList: emp,
      }),
    }, MENU);
    const problems = [];
    const push = (arr, label) => { if (arr && arr.length) problems.push(`${label} ${arr.length}건`); };
    if (v) {
      push(v.duplicateSubmittedApplicationDetails, '이미 상신된 신청');
      push(v.duplicateAlreadyAddedList, '중복');
      push(v.insufficientAnnualLeaveList, '잔여 연차 부족');
      push(v.minusAnnualLeaveLimitedList, '연차 한도 초과');
      push(v.annualLeaveClosedList, '연차 마감');
      push(v.notGeneratedAnnualLeaveList, '미부여 연차');
    }
    return { ok: problems.length === 0, problems, raw: v };
  }

  // 결재상신 (쓰기). 확인 화면에서 사용자가 누른 뒤에만 호출할 것.
  async function submit(pv, sched) {
    const item = buildItem(pv, sched);
    const emp = [{ empCd: pv.empCd, korNm: pv.empNm, deptCd: pv.deptCd, deptNm: pv.deptNm, divNm: '' }];
    const res = await api().call(P_CREATE, {
      coCd: '', appDt: '', appEmpCd: pv.empCd, deptCd: '',
      titleDc: title(pv), approLineId: '', calLinkKey: '', linkKey: '',
      approState: '', fileGroup: 0, version: 'v2',
      employeeList: emp, applicationList: [item],
    }, MENU);
    return res;
  }

  GW.leave = { TYPES, preview, validate, submit, title, profile, buildItem };
})(window);
