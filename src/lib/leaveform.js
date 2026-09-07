// 근태신청서 폼 자동 입력.
//
// HPD0110 은 두 가지를 같은 해시에서 보여 준다. 처음엔 부서 근태일정 캘린더가 뜨고,
// 왼쪽 양식 목록(검색칸 placeholder "양식명을 입력하세요.")에서 [연차휴가신청서] 를
// 누르면 그 자리에 신청서가 그려진다. 팝업도 라우팅도 아니다.
//
// 양식 목록 항목은 태그·클래스로 잡히지 않아 글자로 찾는다. 나머지(종류 버튼,
// [신청완료])는 span.OBTButton_labelText__… 이라 class 부분일치로 잡힌다.
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

  // 아마란스는 마이크로모듈을 같은 출처 iframe 안에 그리기도 한다. 본문과
  // 읽을 수 있는 iframe 을 모두 뒤진다.
  function docs() {
    const out = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) out.push(f.contentDocument); } catch (_) { /* 교차 출처 */ }
    }
    return out;
  }

  // 우리가 그린 것들은 빼고 본다. 패널에도 [휴가 신청] 버튼이 있어서 그냥 두면
  // 우리 버튼을 우리가 누른다.
  const ours = (el) => !!el.closest('#gw-work-panel, #gw-leave-toast');
  const all = (sel) => docs().flatMap((d) => [...d.querySelectorAll(sel)])
    .filter((el) => visible(el) && !ours(el));
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

  // OBT 는 버튼을 <button> 으로만 그리지 않는다. div·a·span 도 눌린다.
  const CLICKABLE = 'button, a, [role="button"], [class*="button" i], [class*="btn" i]';

  function clickables() {
    const seen = new Set();
    return all(CLICKABLE).filter((el) => {
      const t = el.textContent.trim();
      if (!t || t.length > 20) return false;
      // 겉을 감싼 요소와 속을 다 잡으면 같은 게 여러 번 나온다. 가장 안쪽만 남긴다.
      if (el.querySelector(CLICKABLE)) return false;
      const key = t + '@' + Math.round(el.getBoundingClientRect().left);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const findButton = (text) => clickables().find((b) => b.textContent.trim() === text);

  function clickButton(text) {
    const btn = findButton(text);
    if (btn) { btn.click(); return true; }
    return false;
  }

  // 글자가 정확히 일치하는 것 중 가장 안쪽. 문서 순서상 자손이 뒤에 오므로
  // 마지막 것이 가장 깊다. 클릭은 위로 버블링하니 안쪽을 눌러도 된다.
  function findByText(text) {
    for (const d of docs()) {
      if (!d.body) continue;
      const w = d.createTreeWalker(d.body, NodeFilter.SHOW_ELEMENT);
      let best = null;
      while (w.nextNode()) {
        const el = w.currentNode;
        if (el.textContent.trim() === text && visible(el) && !ours(el)) best = el;
      }
      if (best) return best;
    }
    return null;
  }

  const OPEN_LABEL = '연차휴가신청서';
  const searchBox = () => all('input').find((i) => (i.placeholder || '').includes('양식명'));

  // 양식 목록에서 연차휴가신청서를 찾아 연다.
  async function openForm() {
    let el = findByText(OPEN_LABEL);
    if (!el) {
      // 목록이 길면 검색으로 걸러 낸다
      const q = searchBox();
      if (q) {
        setValue(q, OPEN_LABEL);
        q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await sleep(900);
        el = findByText(OPEN_LABEL);
      }
    }
    if (!el) return false;

    el.click();
    if (await waitForForm(6000)) return true;
    // 목록 위젯이 더블클릭을 요구하기도 한다
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return waitForForm(20000);
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

  const hasSubmit = () => all('button').some((b) => b.textContent.trim() === '신청완료');
  const formReady = () => dateInputs().length >= 2 && hasSubmit();

  // 폼이 그려질 때까지 기다린다. 콜드 로딩이면 마이크로모듈까지 내려받느라
  // 꽤 걸린다.
  async function waitForForm(timeout) {
    const deadline = Date.now() + (timeout || 45000);
    while (Date.now() < deadline) {
      if (formReady()) return true;
      await sleep(300);
    }
    return false;
  }

  // 신청서가 이미 떠 있으면 'ready', 양식 목록까지 그려졌으면 'needOpen'.
  async function awaitScreen(timeout) {
    const deadline = Date.now() + (timeout || 45000);
    while (Date.now() < deadline) {
      if (formReady()) return 'ready';
      if (findByText(OPEN_LABEL) || searchBox()) return 'needOpen';
      await sleep(300);
    }
    return 'none';
  }

  // 실패했을 때 화면에 무엇이 있었는지. 추측 대신 이걸 보고 고친다.
  function diagnose() {
    const c = clickables().map((b) => b.textContent.trim());
    return [
      `해시 ${location.hash || '(없음)'}`,
      `문서 ${docs().length}`,
      `날짜칸 ${dateInputs().length}`,
      `시간칸 ${timeInputs().length}`,
      `입력칸 ${all('input').length}`,
      `양식검색 ${searchBox() ? '있음' : '없음'}`,
      `${OPEN_LABEL} ${findByText(OPEN_LABEL) ? '있음' : '없음'}`,
      `누를것 ${c.length}${c.length ? ': ' + c.slice(0, 24).join(' / ') : ''}`,
    ].join(' · ');
  }

  // req: { typeKey, dateKey, start, end }   start/end 는 "HHMM"
  async function fill(req) {
    const steps = [];
    const fail = (msg) => { const e = new Error(msg); e.steps = steps; throw e; };

    const screen = await awaitScreen();
    if (screen === 'none') fail(`근태 화면을 찾지 못했습니다.\n${diagnose()}`);
    if (screen === 'needOpen') {
      if (!(await openForm())) fail(`[${OPEN_LABEL}] 을 열지 못했습니다.\n${diagnose()}`);
      steps.push('신청서 열기');
    }
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

  GW.leaveform = { fill, submit, openForm, waitForForm, awaitScreen, formReady, diagnose, findByText, TYPES, TYPE_LABELS, span, to12h, setValue };
})(typeof window !== 'undefined' ? window : globalThis);
