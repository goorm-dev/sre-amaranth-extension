// 휴가 신청 + 결재상신.
//
// 실제 신청서가 만드는 요청을 캡처해 재현했다. 흐름:
//   1) calculateApplicationDays  — 서버가 일수·시간·연차차감을 계산 (읽기)
//   2) validateNew               — 서버가 중복·잔여연차 등을 검증 (읽기)
//   3) 0hr00011                  — 신청완료. 근태신청 레코드 저장
//   4) create                    — 결재문서(초안) 생성. approLineId 를 비우면 서버 기본 결재선
//   5) #/popup?...&approkey=…    — 결재 팝업. 여기서 사용자가 결재상신을 누른다
//
// approkey 가 핵심이다. 팝업의 연동(HP_HPD0110_00011)이 그 키로 초안을 찾아 본문을
// 채운다. 예전엔 create 에 linkKey:'' 를 보내 놓고 팝업 URL 에는 그 자리에서 만든
// 난수를 넣어서, 서버가 등록된 적 없는 키를 찾다가 "연동본문 데이터 조회 실패" 로
// 떨어졌다. 같은 값을 create 에 실어 보내야 한다.
//
// atCd/시간대는 아마란스 코드 그대로. 결재선은 앱이 만들지 않는다(서버 기본선 사용).
(function (root) {
  const GW = (root.GW = root.GW || {});

  // 지원하는 휴가 종류. atCd 는 calculateApplicationDays 로 검증했다.
  // 종류별 atCd·시간대. calculateApplicationDays 로 연차차감(yc)을 검증했다.
  //   종일 09:00~18:00(yc 1.0) / 오전반차 09:00~14:00(0.5) / 오후반차 15:00~19:00(0.5)
  //   보상(연차보상)은 +4 오프셋 코드. 반차 4종은 실제 이력, 종일 2종은 yc=1 로 확인.
  // hours = 실제 휴가 시간. 신청 구간은 점심을 물고 있으면 휴게 60분이 끼어 있다.
  //   오전반차 09:00~14:00(5시간 구간) → 인정 240분   ← 휴게 포함
  //   오후반차 15:00~19:00(4시간 구간) → 인정 240분   ← 휴게 없음
  // 시작 시각만 사용자가 정한다. 구간 길이는 종류가 정한다.
  const TYPES = {
    annual:    { atCd: '1101', name: '연차',           hours: 8, defStart: '0900', pad: 60, timeSetFg: 'ALL', full: true },
    amHalf:    { atCd: '1102', name: '오전반차',       hours: 4, defStart: '0900', pad: 60, timeSetFg: 'AM' },
    pmHalf:    { atCd: '1103', name: '오후반차',       hours: 4, defStart: '1500', pad: 0,  timeSetFg: 'PM' },
    annualComp:{ atCd: '1105', name: '연차(보상)',     hours: 8, defStart: '0900', pad: 60, timeSetFg: 'ALL', full: true },
    amHalfComp:{ atCd: '1106', name: '오전반차(보상)', hours: 4, defStart: '0900', pad: 60, timeSetFg: 'AM' },
    pmHalfComp:{ atCd: '1107', name: '오후반차(보상)', hours: 4, defStart: '1500', pad: 0,  timeSetFg: 'PM' },
  };

  // "0900" + 300분 → "1400"
  function addMin(hhmmStr, mins) {
    const t = Number(hhmmStr.slice(0, 2)) * 60 + Number(hhmmStr.slice(2)) + mins;
    const h = Math.floor(t / 60) % 24;
    return String(h).padStart(2, '0') + String(t % 60).padStart(2, '0');
  }

  // 선택한 시작 시각으로 신청 구간을 만든다.
  function span(typeKey, opts) {
    const t = TYPES[typeKey];
    const start = ((opts || {}).startTm || t.defStart).replace(':', '');
    return { start, end: addMin(start, t.hours * 60 + t.pad), hours: t.hours };
  }
  const LINK_AT = '1010';   // 연차휴가 그룹

  const api = () => GW.api;
  const P_CALC = '/human/common/attendapplication/calculateApplicationDays';
  const P_VALID = '/human/attendapplication/validateNew';
  const P_SAVE = '/human/attendapplication/0hr00011';   // 신청완료 — 근태신청 레코드 저장
  const P_CREATE = '/human/attendapplication/create';    // 결재문서 생성
  const MENU = 'HPD0110';

  // 신청자 정보 + 근무 스케줄 필드. 최근 근무일 행에서 가져온다.
  async function profile() {
    const s = api().getSession ? api().getSession() : null;
    // comeStTm/leaveStTm/timeCd/workTp 는 근무 스케줄 값이라 getWorkTimeList 에 없다.
    // 실제 신청 요청에서 확인한 값을 기본으로 쓴다 (workTp 는 근무제 코드가 아니라
    // 신청서의 근무구분이라 근태 행의 workTp(8=자율출퇴근)와 다르다).
    let sched = { coCd: '1000', deptCd: null, groupCd: 'F100', workTp: '1',
                  comeStTm: '0730', leaveStTm: '2200', timeCd: '7730' };
    try {
      const today = new Date();
      const keys = [];
      for (let i = 1; i <= 20; i++) keys.push(GW.time.toKey(GW.time.addDays(today, -i)));
      const rows = await api().getWorkTimeList(keys);
      const r = rows.find((x) => x.coCd && x.deptCd);
      if (r) {
        // 회사·부서·근무그룹만 실제 행에서 가져온다. 나머지는 위 기본값을 유지한다.
        sched = Object.assign({}, sched, {
          coCd: r.coCd || sched.coCd,
          deptCd: r.deptCd || sched.deptCd,
          groupCd: r.groupCd || sched.groupCd,
        });
      }
    } catch (_) {}
    return sched;
  }

  const apiDate = (key) => key.replace(/-/g, '');
  const hhmm = (t) => (/^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}` : (t || ''));

  // 미리보기(확인 화면)에 필요한 값을 서버 계산으로 채운다. 상신은 하지 않는다.
  async function preview(typeKey, dateKey, opts) {
    const t = TYPES[typeKey];
    if (!t) throw new Error('지원하지 않는 휴가 종류입니다.');
    const sp = span(typeKey, opts);
    const d = await api().call(P_CALC, {
      startDate: apiDate(dateKey), endDate: apiDate(dateKey),
      startTime: sp.start, endTime: sp.end, atCd: t.atCd, linkAtCd: LINK_AT,
      empCd: undefined, appRmkDc: '', calculateOption: 'HOLIDAY_EXCLUSION',
    }, MENU);
    if (!d) throw new Error('신청 계산에 실패했습니다.');
    return {
      typeKey, type: t, dateKey, span: sp,
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
      startTm: pv.span.start, endTm: pv.span.end,
      actStartTm: null, actEndTm: null,
      appDyFg: 'D', appDy: String(pv.appDy), appTm: pv.appTm, appRmkDc: '',
      ycUseCnt: pv.ycUseCnt, ycGrantCnt: 0,
      workTp: sched.workTp, groupCd: pv.groupCd || sched.groupCd, timeCd: sched.timeCd,
      reportCancYn: 'N', cancellationApplication: false,
      deptNm: pv.deptNm, empNm: pv.empNm,
    };
  }

  function title(pv) {
    const [, m, d] = pv.dateKey.split('-');
    const t = pv.type;
    const range = t.full ? '' : ` (${hhmm(pv.span.start)}~${hhmm(pv.span.end)})`;
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

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));

  // 응답 어딘가에 서버가 정한 연동키가 실려 올 수 있다. 있으면 그게 우선이다.
  // 우리가 보낸 키를 그대로 쓰면 되는 경우와, 서버가 새로 발급하는 경우를 모두 받는다.
  function findLinkKey(obj, depth) {
    if (obj == null || (depth || 0) > 6) return null;
    if (typeof obj === 'string') return /^ERP_/.test(obj) ? obj : null;
    if (Array.isArray(obj)) {
      for (const v of obj) { const hit = findLinkKey(v, (depth || 0) + 1); if (hit) return hit; }
      return null;
    }
    if (typeof obj !== 'object') return null;
    // 이름이 맞는 것부터 본다
    for (const k of ['linkKey', 'approKey', 'approkey', 'calLinkKey']) {
      if (typeof obj[k] === 'string' && obj[k]) return obj[k];
    }
    for (const v of Object.values(obj)) { const hit = findLinkKey(v, (depth || 0) + 1); if (hit) return hit; }
    return null;
  }

  // 초안 생성 (쓰기). 확인 화면에서 사용자가 누른 뒤에만 호출할 것.
  //
  // 실제 화면의 순서를 그대로 따른다:
  //   0hr00011 (근태신청 저장) → create (결재문서 생성) → 결재 팝업
  // create 만 호출하면 붙일 신청 레코드가 없어 아무것도 만들어지지 않는다.
  //
  // 결재 팝업의 approkey 는 우리가 만들어 create 에 함께 보낸다. 팝업의 연동
  // (HP_HPD0110_00011)이 그 키로 방금 만든 초안을 찾아 본문을 채운다.
  // approState 는 "2"(미상신 초안)로 돌아오는 게 정상이다 — 상신은 팝업에서 한다.
  async function submit(pv, sched) {
    const item = buildItem(pv, sched);
    const emp = [{ empCd: pv.empCd, korNm: pv.empNm, deptCd: pv.deptCd, deptNm: pv.deptNm, divNm: '' }];
    const linkKey = `ERP_${uuid()}`;

    const saved = await api().call(P_SAVE, { applicationList: [item], employeeList: emp }, MENU);

    const created = await api().call(P_CREATE, {
      coCd: '', appDt: '', appEmpCd: pv.empCd, deptCd: '',
      titleDc: title(pv), approLineId: '',
      calLinkKey: linkKey, linkKey,
      approState: '', fileGroup: 0, version: 'v2',
      employeeList: emp, applicationList: [item],
    }, MENU);

    const approKey = findLinkKey(created) || findLinkKey(saved) || linkKey;
    const q = new URLSearchParams({
      MicroModuleCode: 'eap', appLineId: '', appLineList: '[]',
      approkey: approKey, fileList: '[]',
      formId: '249', callComp: 'UBAP001', popupUUID: uuid(),
    });

    return {
      saved, created, linkKey, approKey,
      sentKey: linkKey === approKey,          // 우리 키가 그대로 쓰였는지
      approvalHash: `#/popup?${q.toString()}`,
    };
  }

  GW.leave = { TYPES, preview, validate, submit, title, profile, buildItem, span, addMin, findLinkKey };
})(window);
