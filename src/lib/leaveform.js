// 근태신청서(HPD0110) 폼 자동 입력.
//
// fill() 은 종류·날짜·시간만 채우고 멈춘다. 아무것도 저장하지 않는다.
// submit() 은 [신청완료] 를 눌러 결재 팝업을 띄운다 — approkey 는 SPA 가 이때
// 만들어 window.open 에 실어 보내므로, 팝업을 띄우려면 이 버튼을 눌러야 한다.
//
// submit() 은 반드시 사용자의 실제 클릭 안에서 불러야 한다. 스크립트가 스스로
// 누르면 transient activation 이 없어 window.open 이 팝업 차단에 걸린다.
// 결재 팝업까지 뜨고 나서도 [결재상신] 은 사용자가 직접 누른다.
//
// 클래스명에 빌드 해시가 붙으므로(OBTDatePickerRebuild_inputYMD__PtxMy)
// 접두사 부분일치로 찾는다.
(function (root) {
  const GW = (root.GW = root.GW || {});

  // 종류별 기본 시간대. 신청 구간 = 휴가시간 + (휴게 포함 시 1시간).
  //   오전반차 09:00~14:00(5시간, 휴게 포함) / 오후반차 15:00~19:00(4시간, 미포함)
  const TYPES = {
    annual:     { hours: 8, defStart: '0900', defBreak: true,  full: true },
    amHalf:     { hours: 4, defStart: '0900', defBreak: true },
    pmHalf:     { hours: 4, defStart: '1500', defBreak: false },
    annualComp: { hours: 8, defStart: '0900', defBreak: true,  full: true },
    amHalfComp: { hours: 4, defStart: '0900', defBreak: true },
    pmHalfComp: { hours: 4, defStart: '1500', defBreak: false },
  };

  function addMin(hhmm, mins) {
    const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(2)) + mins;
    return String(Math.floor(t / 60) % 24).padStart(2, '0') + String(t % 60).padStart(2, '0');
  }

  function span(typeKey, opts) {
    const t = TYPES[typeKey];
    const o = opts || {};
    const start = (o.startTm || t.defStart).replace(':', '');
    const withBreak = o.includeBreak == null ? t.defBreak : !!o.includeBreak;
    return { start, end: addMin(start, t.hours * 60 + (withBreak ? 60 : 0)), withBreak, hours: t.hours };
  }

  const TYPE_LABELS = {
    annual: '연차',
    amHalf: '오전반차',
    pmHalf: '오후반차',
    annualComp: '연차(보상)',
    amHalfComp: '오전반차(보상)',
    pmHalfComp: '오후반차(보상)',
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const all = (sel) => [...document.querySelectorAll(sel)].filter(visible);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // React 제어 입력이라 value 를 직접 넣으면 무시된다.
  // 네이티브 setter 로 넣고 input/change 를 직접 발생시켜야 상태가 갱신된다.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickButton(text) {
    const btn = all('button').find((b) => b.textContent.trim() === text);
    if (btn) { btn.click(); return true; }
    return false;
  }

  // "1500" → { ampm: '오후', hh: '03', mm: '00' }
  function to12h(hhmm) {
    const h = Number(hhmm.slice(0, 2));
    const m = hhmm.slice(2);
    const ampm = h < 12 ? '오전' : '오후';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return { ampm, hh: String(h12).padStart(2, '0'), mm: m };
  }

  const dateInputs = () => all('[class*="OBTDatePickerRebuild_inputYMD"]');
  const timeInputs = () => all('[class*="OBTTimePicker2_input"]');

  // 폼이 그려질 때까지 기다린다.
  async function waitForForm(timeout) {
    const deadline = Date.now() + (timeout || 15000);
    while (Date.now() < deadline) {
      if (dateInputs().length >= 2 && all('button').some((b) => b.textContent.trim() === '신청완료')) return true;
      await sleep(300);
    }
    return false;
  }

  // req: { typeKey, dateKey, start, end }   start/end 는 "HHMM"
  async function fill(req) {
    const steps = [];
    const fail = (msg) => { const e = new Error(msg); e.steps = steps; throw e; };

    if (!(await waitForForm())) fail('근태신청서 폼을 찾지 못했습니다.');
    steps.push('폼 확인');

    const label = TYPE_LABELS[req.typeKey];
    if (!label) fail('지원하지 않는 휴가 종류입니다.');
    if (!clickButton(label)) fail(`"${label}" 버튼을 찾지 못했습니다.`);
    steps.push(`종류: ${label}`);
    await sleep(700);   // 종류를 고르면 시간대가 기본값으로 다시 그려진다

    const dates = dateInputs();
    if (dates.length < 2) fail('날짜 입력칸을 찾지 못했습니다.');
    setValue(dates[0], req.dateKey);
    setValue(dates[1], req.dateKey);
    dates[1].blur();
    steps.push(`날짜: ${req.dateKey}`);
    await sleep(500);

    // 종일이면 시간대는 서식 기본값을 그대로 둔다.
    if (req.start && req.end) {
      const t = timeInputs();
      if (t.length < 6) {
        steps.push('시간 입력칸 없음 — 기본값 유지');
      } else {
        const s = to12h(req.start);
        const e = to12h(req.end);
        for (const [el, v] of [[t[0], s.ampm], [t[1], s.hh], [t[2], s.mm],
                               [t[3], e.ampm], [t[4], e.hh], [t[5], e.mm]]) {
          setValue(el, v);
        }
        t[5].blur();
        steps.push(`시간: ${req.start}~${req.end}`);
      }
    }

    await sleep(300);
    return steps;
  }

  // [신청완료]. 여기서 초안이 만들어지고 결재 팝업이 열린다.
  function submit() {
    return clickButton('신청완료');
  }

  GW.leaveform = { fill, submit, waitForForm, TYPES, TYPE_LABELS, span, to12h, setValue };
})(typeof window !== 'undefined' ? window : globalThis);
