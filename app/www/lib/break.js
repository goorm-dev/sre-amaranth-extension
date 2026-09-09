// 자율휴게 신청 (점심시간 외 개인용무, 최대 1시간).
//
// 실제 신청을 캡처해 재현했다. 휴가와 뼈대는 같고 다른 점만 적는다.
//   - atCd 5201 / linkAtCd 5110      (연차휴가는 1101~1107 / 1010)
//   - 결재 양식 formId 151 / HP_HPD0110_00052 "자율휴게신청서"
//   - validateNew 를 부르지 않는다. 화면도 안 부른다
//   - 연차를 쓰지 않으므로 ycUseCnt·ycGrantCnt 는 0
//   - appRmkDc 에 사유가 들어간다 (화면에서 필수처럼 쓰인다)
//
// 흐름은 휴가와 동일하다:
//   calculateApplicationDays → 0hr00011 → create
//     → GetLinkKey → SetEnageGroup → saveLinkKey → 결재 팝업
// 상신은 하지 않는다. 결재 화면을 열어 주고 사용자가 거기서 누른다.
(function (root) {
  const GW = (root.GW = root.GW || {});

  const AT_CD = '5201';
  const LINK_AT = '5110';
  const MENU = 'HPD0110';
  const MAX_MIN = 60;   // 양식 설명: "최대 1시간까지 추가 휴게신청"

  const FORM = {
    id: '151',
    dTp: 'HP_HPD0110_00052',
    nm: '자율휴게신청서',
    contentsApi: '/human/attendapplication/interlock/getInterlockFormContents',
    statusApi: '/human/attendapplication/interlock/setInterlockSync',
  };

  const api = () => GW.api;
  const P_CALC = '/human/common/attendapplication/calculateApplicationDays';
  const P_SAVE = '/human/attendapplication/0hr00011';
  const P_CREATE = '/human/attendapplication/create';
  const P_GETLINKKEY = '/system/apiUtilEap/GetLinkKey';
  const P_SETENAGE = '/system/apiUtilEap/SetEnageGroup';
  const P_SAVELINK = '/human/openapi/attendapplication/saveLinkKey';

  const apiDate = (key) => key.replace(/-/g, '');
  const hhmm = (t) => (/^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}` : (t || ''));

  function addMin(hhmmStr, mins) {
    const t = Number(hhmmStr.slice(0, 2)) * 60 + Number(hhmmStr.slice(2)) + mins;
    return String(Math.floor(t / 60) % 24).padStart(2, '0') + String(t % 60).padStart(2, '0');
  }

  // 시작 시각 + 길이(분) → 구간. 길이는 상한에서 자른다.
  function span(startTm, minutes) {
    const start = String(startTm || '').replace(':', '');
    const min = Math.min(MAX_MIN, Math.max(1, minutes || MAX_MIN));
    return { start, end: addMin(start, min), minutes: min };
  }

  // 서버가 인정 시간을 계산해 준다. 상신은 하지 않는다.
  async function preview(dateKey, startTm, minutes, reason) {
    const sp = span(startTm, minutes);
    const d = await api().call(P_CALC, {
      startDate: apiDate(dateKey), endDate: apiDate(dateKey),
      startTime: sp.start, endTime: sp.end,
      atCd: AT_CD, linkAtCd: LINK_AT,
      empCd: undefined, appRmkDc: reason || '', calculateOption: 'HOLIDAY_EXCLUSION',
    }, MENU);
    if (!d) throw new Error('신청 계산에 실패했습니다.');
    return {
      dateKey, span: sp, reason: reason || '',
      coCd: d.coCd, empCd: d.empCd, empNm: d.empNm, deptCd: d.deptCd, deptNm: d.deptNm,
      appDy: d.applicationDaysCnt != null ? d.applicationDaysCnt : d.daysCnt,
      appTm: d.applicationMinutes != null ? d.applicationMinutes : d.dailyAppTm,
      groupCd: d.applicationInfo && d.applicationInfo.groupCd,
    };
  }

  function buildItem(pv, sched) {
    return {
      detailSq: null, coCd: pv.coCd || sched.coCd, appDt: null, appSq: null,
      deptCd: pv.deptCd || sched.deptCd, empCd: pv.empCd,
      linkAtCd: LINK_AT, atCd: AT_CD, atYm: null,
      atDt: apiDate(pv.dateKey), baseAtDt: null,
      startDt: apiDate(pv.dateKey), endDt: apiDate(pv.dateKey),
      comeStTm: sched.comeStTm, leaveStTm: sched.leaveStTm,
      startTm: pv.span.start, endTm: pv.span.end,
      actStartTm: null, actEndTm: null,
      appDyFg: 'D', appDy: String(pv.appDy), appTm: pv.appTm, appRmkDc: pv.reason,
      ycUseCnt: 0, ycGrantCnt: 0,          // 휴게는 연차를 쓰지 않는다
      atSchYn: 'N',
      workTp: sched.workTp, groupCd: pv.groupCd || sched.groupCd, timeCd: sched.timeCd,
      reportCancYn: 'N', cancellationApplication: false,
      deptNm: pv.deptNm, empNm: pv.empNm,
    };
  }

  function title(pv) {
    const [, m, d] = pv.dateKey.split('-');
    return `[${pv.deptNm} ${pv.empNm}] ${m}-${d} (${hhmm(pv.span.start)}~${hhmm(pv.span.end)})`
      + `(${Number(pv.appDy).toFixed(1)}일) 휴게신청서`;
  }

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      }));

  // 초안 생성 + 결재 연동 등록. 확인 화면에서 사용자가 누른 뒤에만 호출할 것.
  async function submit(pv, sched) {
    const item = buildItem(pv, sched);
    const emp = [{ empCd: pv.empCd, korNm: pv.empNm, deptCd: pv.deptCd, deptNm: pv.deptNm, divNm: '' }];

    // 응답이 결재문서 제목이다. 우리가 조립하지 않고 서버 값을 쓴다.
    const saved = await api().call(P_SAVE, { applicationList: [item], employeeList: emp }, MENU);
    const titleDc = typeof saved === 'string' && saved ? saved : title(pv);

    const created = await api().call(P_CREATE, {
      coCd: '', appDt: '', appEmpCd: pv.empCd, deptCd: '',
      titleDc, approLineId: '', calLinkKey: '', linkKey: '',
      approState: '', fileGroup: 0, version: 'v2',
      employeeList: emp, applicationList: [item],
    }, MENU);
    if (!created || !created.appSq) throw new Error('결재문서 초안이 만들어지지 않았습니다.');
    const { appSq, appDt } = created;
    const coCd = created.coCd || pv.coCd;

    // approKey 는 우리가 만들지만 서버에 등록해야 쓸 수 있다 (휴가와 동일).
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

  GW.break = { AT_CD, LINK_AT, FORM, MAX_MIN, span, preview, submit, title, buildItem };
})(window);
