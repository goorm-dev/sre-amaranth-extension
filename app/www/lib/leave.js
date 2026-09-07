// 휴가 신청 + 결재상신.
//
// 실제 신청서가 만드는 요청을 캡처해 재현했다. 흐름:
//   1) calculateApplicationDays  — 서버가 일수·시간·연차차감을 계산 (읽기)
//   2) validateNew               — 서버가 중복·잔여연차 등을 검증 (읽기)
//   3) 0hr00011                  — 신청 확정. 응답이 결재문서 제목이다
//   4) create                    — 결재문서(초안) 생성 → appSq/appDt/coCd, approState "2"
//   5) GetLinkKey                 — 우리가 만든 approKey 를 등록하고 linkKey 를 받는다
//   6) SetEnageGroup              — 그 approKey 에 양식·제목·본문조회API 를 붙인다
//   7) saveLinkKey                — linkKey 를 방금 만든 초안(appSq)에 묶는다
//   8) /#popup?...&approkey=…     — 결재 팝업. 여기서 사용자가 결재상신을 누른다
//
// 5~7 이 핵심이다. approkey 는 클라이언트가 만드는 난수(ERP_<uuid>)지만 그냥 만들어
// 쓰는 값이 아니라 서버에 등록해야 하는 값이다. 이 세 단계를 빠뜨리면 팝업이
// "연동본문 데이터 조회 실패 / HP_HPD0110_00011" 로 떨어진다.
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
  const P_GETLINKKEY = '/system/apiUtilEap/GetLinkKey';  // approKey 등록 → linkKey 발급
  const P_SETENAGE = '/system/apiUtilEap/SetEnageGroup'; // approKey 에 양식·본문조회API 연결
  const P_SAVELINK = '/human/openapi/attendapplication/saveLinkKey';  // linkKey ↔ 초안
  const MENU = 'HPD0110';

  // 연차휴가신청서 결재 양식. /eap/eap096A45 (searchFormDTp: HPD0110) 로 조회되는 목록의
  // 한 항목이고, 값이 고정이라 굳이 매번 조회하지 않는다.
  const FORM = {
    id: '249',
    dTp: 'HP_HPD0110_00011',
    nm: '연차휴가신청서',
    contentsApi: '/human/attendapplication/interlock/getInterlockFormContents',
    statusApi: '/human/attendapplication/interlock/setInterlockSync',
  };

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

  // 초안 생성 + 결재 연동 등록 (쓰기). 확인 화면에서 사용자가 누른 뒤에만 호출할 것.
  // 상신은 하지 않는다 — 팝업을 열어 주고 사용자가 거기서 [결재상신] 을 누른다.
  async function submit(pv, sched) {
    const item = buildItem(pv, sched);
    const emp = [{ empCd: pv.empCd, korNm: pv.empNm, deptCd: pv.deptCd, deptNm: pv.deptNm, divNm: '' }];

    // 신청 확정. 응답이 결재문서 제목이다 — 우리가 조립하지 않고 서버 값을 쓴다.
    const saved = await api().call(P_SAVE, { applicationList: [item], employeeList: emp }, MENU);
    const titleDc = typeof saved === 'string' && saved ? saved : title(pv);

    const created = await api().call(P_CREATE, {
      coCd: '', appDt: '', appEmpCd: pv.empCd, deptCd: '',
      titleDc, approLineId: '', calLinkKey: '', linkKey: '',
      approState: '', fileGroup: 0, version: 'v2',
      employeeList: emp, applicationList: [item],
    }, MENU);
    if (!created || !created.appSq) {
      throw new Error('결재문서 초안이 만들어지지 않았습니다.');
    }
    const { appSq, appDt } = created;
    const coCd = created.coCd || pv.coCd;

    // approKey 는 우리가 만들지만 서버에 등록해야 쓸 수 있다.
    const approKey = `ERP_${uuid()}`;
    const link = await api().call(P_GETLINKKEY,
      { menuCode: MENU, approKey, vPCoCd: coCd, coCd }, MENU);
    const linkKey = link && link.linkKey;
    if (!linkKey) throw new Error('연동 키를 발급받지 못했습니다.');

    await api().call(P_SETENAGE, {
      approKey, formDTp: FORM.dTp, formId: FORM.id, linkKey, formNm: FORM.nm,
      docTitle: titleDc, contents: '',
      contentsApi: FORM.contentsApi, statusApi: FORM.statusApi,
      dummy1: '', link: '', vPCoCd: coCd, coCd,
    }, MENU);

    await api().call(P_SAVELINK, { linkKey, appSq, coCd, appDt }, MENU);

    const q = new URLSearchParams({
      MicroModuleCode: 'eap', appLineId: '', appLineList: '[]',
      approkey: approKey, fileList: '[]',
      formId: FORM.id, callComp: 'UBAP001', popupUUID: uuid(),
    });

    return { titleDc, appSq, appDt, coCd, approKey, linkKey, approvalHash: `#popup?${q}` };
  }

  GW.leave = { TYPES, FORM, preview, validate, submit, title, profile, buildItem, span, addMin };
})(window);
