// gw.goorm.io 위에 떠 있는 요약 패널. 데이터는 근태 API에서 직접 가져온다.
(function () {
  const GW = window.GW;
  const T = GW.time;

  let viewMonth = T.monthKey(new Date());
  let state = { rows: [], leaves: [], plans: {}, holidays: null, live: null, loading: false, error: null, at: null };
  let panel = null;

  async function load(monthKey, { useCache = true } = {}) {
    if (useCache) {
      const cached = await GW.store.getCachedMonth(monthKey);
      if (cached) { state = { rows: cached.rows, leaves: cached.leaves || [], live: null, loading: true, error: null, at: cached.at }; render(); }
      else { state = { rows: [], leaves: [], live: null, loading: true, error: null, at: null }; render(); }
    }
    try {
      const [rows, leaves] = await Promise.all([
        GW.api.getMonth(monthKey),
        GW.api.getMonthLeaves(monthKey).catch(() => []),
      ]);
      state.holidays = await loadHolidays(monthKey);
      await GW.store.cacheMonth(monthKey, rows, leaves);
      // 오늘 타각은 근태 배치(다음날 새벽) 전이라 월 조회에 없다. 따로 읽는다.
      let live = null;
      if (monthKey === T.monthKey(new Date())) {
        try { live = await GW.api.getComeLeave(T.toKey(new Date())); } catch (_) {}
      }
      state = { ...state, rows, leaves, live, loading: false, error: null, at: Date.now() };
      auto.ok();
      auto.last.full = auto.last.punch = Date.now();
    } catch (e) {
      state = { ...state, loading: false, error: e.message };
      auto.fail(e);
    }
    render();
  }


  // 회사 휴일. 서버 목록이 1순위고, 실패하면 내장 표로 폴백한다.
  async function loadHolidays(monthKey) {
    const year = Number(monthKey.slice(0, 4));
    const cached = await GW.store.getCachedHolidays(year);
    if (cached) return cached;
    try {
      const h = await GW.api.getHolidays(year);
      await GW.store.cacheHolidays(year, h);
      return h;
    } catch (_) {
      return null;
    }
  }

  // 오늘 타각만 다시 읽는다 (단일 호출). 월 집계는 다음날 새벽 배치라 낮에 볼 필요가 없다.
  async function refreshPunch() {
    auto.last.punch = Date.now();
    try {
      state.live = await GW.api.getComeLeave(T.toKey(new Date()));
      auto.ok();
    } catch (e) {
      auto.fail(e);
    }
    render();
  }

  // ── 자동 갱신 ──────────────────────────────────────────────────────────
  //
  // 화면에서 가장 빨리 낡는 값(경과 시간·퇴근 시각)은 서버와 무관하다. new Date() 로
  // 계산되므로 로컬 타이머로 다시 그리기만 하면 된다 — 서버 호출 0.
  //
  // 서버 조회는 "바뀌었을 법할 때"만 한다. 월 집계는 다음날 새벽 배치라 낮에 아무리
  // 불러도 값이 그대로고, 오늘 타각은 출퇴근 2번뿐이다. 주기적으로 전체를 다시 부르면
  // 인사 시스템만 두드리게 된다.
  const auto = {
    tick: 30 * 1000,          // 로컬 재렌더
    punch: 5 * 60 * 1000,     // 타각 조회 (퇴근 전에만)
    stale: 10 * 60 * 1000,    // 탭 복귀 시 이만큼 지났으면 전체 재조회
    maxBackoff: 30 * 60 * 1000,

    timer: null,
    last: { full: 0, punch: 0 },
    fails: 0,
    until: 0,                 // 백오프 해제 시각
    stopped: null,            // 세션 만료 등으로 자동 갱신을 멈춘 사유
    dayKey: T.toKey(new Date()),

    dead: false,              // 확장이 새로고침돼 이 스크립트가 고아가 된 상태

    ok() { this.fails = 0; this.until = 0; },

    fail(e) {
      // 확장이 업데이트되면 이 스크립트는 되살릴 방법이 없다. 멈추고 안내만 남긴다.
      if (e instanceof GW.store.ContextGone) { this.die(e.message); return; }
      // 세션이 만료되면 계속 두드려봐야 소용없다. 멈추고 수동 재시도를 기다린다.
      if (e instanceof GW.api.AuthError) { this.stopped = e.message; return; }
      this.fails += 1;
      this.until = Date.now() + Math.min(this.maxBackoff, 60 * 1000 * 2 ** (this.fails - 1));
    },

    resume() { if (!this.dead) { this.stopped = null; this.fails = 0; this.until = 0; } },

    die(msg) {
      this.dead = true;
      this.stopped = msg;
      clearInterval(this.timer);
      showDead(msg);
    },
  };

  // 저장소를 못 읽는 상태라 정상 렌더가 불가능하다. 패널을 안내 문구로 갈아끼운다.
  function showDead(msg) {
    if (!panel || !document.body.contains(panel)) return;
    panel.innerHTML = `
      <div class="gwp-head"><span class="gwp-title">구름 근무시간</span></div>
      <div class="gwp-body">
        <div class="gwp-note gwp-bad">${esc(msg)}</div>
        <div class="gwp-actions">
          <button class="gwp-btn gwp-primary" data-act="reload">새로고침</button>
        </div>
      </div>`;
  }

  // 오늘 퇴근 타각이 찍혔거나 근무일이 아니면 더 볼 필요가 없다.
  function shouldPollPunch(s) {
    if (state.live && state.live.outAt) return false;
    if (s.todayRow && s.todayRow.outAt) return false;
    return true;
  }

  async function pulse() {
    if (auto.dead) return;
    if (!GW.store.alive()) return auto.die('확장이 업데이트되었습니다. 페이지를 새로고침해 주세요.');
    if (document.hidden) return;      // 안 보이는 탭에서는 아무것도 하지 않는다
    await render();                    // 경과 시간·퇴근 시각 갱신 (서버 호출 없음)
    if (auto.stopped) return;

    const now = Date.now();
    if (now < auto.until) return;

    // 자정을 넘겼으면 전부 다시 읽는다
    const today = T.toKey(new Date());
    if (today !== auto.dayKey) {
      auto.dayKey = today;
      viewMonth = T.monthKey(new Date());
      return load(viewMonth, { useCache: false });
    }

    if (viewMonth === T.monthKey(new Date())) {
      const settings = await GW.store.getSettings();
      const s = GW.calc.summarize(
        { rows: state.rows, leaves: state.leaves, plans: state.plans }, settings, viewMonth, new Date());
      if (shouldPollPunch(s) && now - auto.last.punch > auto.punch) refreshPunch();
    }
    sharePush();
  }

  // ── 팀 공유 게시 ──────────────────────────────────────────────────────
  //
  // 팝업은 열었을 때만 올리므로 대부분의 시간 동안 남이 보는 값이 낡는다.
  // gw 탭에 떠 있는 이 패널이 주기적으로 올려 준다 (5분에 한 번).
  //
  // 팀 주소는 팀 이름에서 계산한다 (lib/team.js).
  //
  // 실패해도 조용히 넘어간다 — 공유는 부가 기능이고, 본 화면을 막으면 안 된다.
  const SHARE_EVERY = 5 * 60 * 1000;
  let sharedAt = 0;

  async function sharePush() {
    if (Date.now() - sharedAt < SHARE_EVERY || !state.rows.length) return;
    let cfg;
    try { cfg = await GW.store.getTeam(); } catch (_) { return; }
    if (!cfg || !cfg.teamName || cfg.on === false) return;
    sharedAt = Date.now();
    try {
      const { wehagoIdentity: id } = await GW.store.raw('wehagoIdentity');
      if (!id || !id.compSeq || !id.deptSeq) return;
      const ids = await GW.team.derive(id.compSeq, id.deptSeq);

      const settings = await GW.store.getSettings();
      const now = new Date();
      const mKey = T.monthKey(now);
      // 지난 달을 보고 있어도 올리는 값은 항상 이번 달이어야 한다.
      const cur = mKey === viewMonth ? state : (await GW.store.getCachedMonth(mKey)) || {};
      const rows = cur.rows || [];
      if (!rows.length) return;
      const s = GW.calc.summarize(
        { rows, leaves: cur.leaves || [], plans: await GW.store.getPlans(), holidays: state.holidays },
        settings, mKey, now);
      const plan = GW.calc.todayPlan(s, settings, mKey === viewMonth ? state.live : null, now);

      await GW.team.ensure(ids, id.deptName || cfg.teamName);
      await GW.team.publish(ids, cfg, GW.team.summarize(s, plan, {
        name: cfg.myName, dept: id.deptName || '',
      }));
    } catch (_) { /* 다음 주기에 다시 시도한다 */ }
  }

  // 탭 복귀 감지는 한 번만 단다. 패널을 껐다 켤 때마다 달면 리스너가 쌓인다.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || auto.stopped || !panel) return;
    // 오래 자리를 비웠으면 통째로, 아니면 평소 주기대로.
    if (Date.now() - auto.last.full > auto.stale) load(viewMonth, { useCache: false });
    else pulse();
  });

  function startAuto() {
    clearInterval(auto.timer);
    auto.timer = setInterval(pulse, auto.tick);
  }

  const esc = (v) => String(v == null ? '' : v)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function shiftMonth(mKey, delta) {
    const [y, m] = mKey.split('-').map(Number);
    return T.monthKey(new Date(y, m - 1 + delta, 1));
  }

  function feasibility(s) {
    switch (s.feasibility) {
      case 'done': return { cls: 'ok', text: `소정근로 충족 (+${T.fmtDuration(-s.remainingMin)})` };
      case 'ok': return { cls: 'ok', text: '남은 근무일 매일 6시간이면 충족' };
      case 'tight': return { cls: 'warn', text: `매일 6시간으론 부족 · 하루 ${T.fmtDuration(s.avgNeededMin)} 필요` };
      case 'impossible': return { cls: 'bad', text: `매일 8시간을 채워도 ${T.fmtDuration(s.remainingMin - s.parCapacity)} 부족` };
      default: return { cls: '', text: '' };
    }
  }

  // 패널을 끄면 DOM 에서 지우고 자동 갱신도 멈춘다. 팝업은 따로 동작하므로
  // 조회를 계속할 이유가 없다. 다시 켜면 새로고침 없이 되살린다.
  let panelOff = false;   // 진행 중이던 조회가 패널을 되살리지 못하게 막는 빗장

  function teardownPanel() {
    panelOff = true;
    clearInterval(auto.timer);
    auto.timer = null;
    if (panel) { panel.remove(); panel = null; }
  }

  async function setupPanel() {
    panelOff = false;
    if (panel) return;
    await render();
    const { collapsed } = await chrome.storage.local.get('collapsed');
    if (collapsed && panel) panel.classList.add('gwp-collapsed');
    load(viewMonth);
    startAuto();
    showUpdateIfAny();
  }

  // 팀 근태 조회(/schres/sc111A03)는 본문에 WEHAGO 식별자를 요구한다 —
  // groupSeq·compSeq·deptSeq·이메일. ERP 코드(empCd/coCd)와는 다른 체계다.
  // gw.goorm.io 의 sessionStorage.userInfo 에 들어 있고, 콘텐츠 스크립트는
  // 같은 출처라 읽을 수 있다(격리 세계라도 스토리지는 공유된다). 팝업은 다른
  // 출처라 못 읽으므로 여기서 캐시해 준다.
  function cacheWehagoIdentity() {
    let raw;
    try { raw = sessionStorage.getItem('userInfo'); } catch (_) { return; }
    if (!raw) return;
    let uc;
    try { uc = findUcUserInfo(JSON.parse(raw)); } catch (_) { return; }
    if (!uc || !uc.groupSeq) return;
    const id = {
      groupSeq: uc.groupSeq, compSeq: uc.compSeq, deptSeq: uc.deptSeq,
      empSeq: uc.empSeq, deptName: uc.deptName,
      // 팀 공유의 표시 이름 기본값으로 쓴다. 키 이름이 버전마다 달라 후보를 훑는다.
      name: uc.userName || uc.korName || uc.empName || uc.name || '',
      emailAddr: uc.emailAdd, emailDomain: uc.emailDomain, at: Date.now(),
    };
    chrome.storage.local.set({ wehagoIdentity: id }).catch(() => {});
  }

  // 응답 구조가 버전마다 달라 키 이름으로 찾는다.
  function findUcUserInfo(o, depth) {
    if (!o || typeof o !== 'object' || (depth || 0) > 6) return null;
    if (o.groupSeq && o.compSeq && o.deptSeq) return o;
    for (const v of Object.values(o)) {
      const hit = findUcUserInfo(v, (depth || 0) + 1);
      if (hit) return hit;
    }
    return null;
  }

  const CORNERS = ['tl', 'tr', 'bl', 'br'];
  const CORNER_IC = { tl: '◰', tr: '◳', bl: '◱', br: '◲' };
  const CORNER_NM = { tl: '왼쪽 위', tr: '오른쪽 위', bl: '왼쪽 아래', br: '오른쪽 아래' };
  // 패널은 30초마다 다시 그려진다. 선택기 열림 상태를 여기 두고 렌더 뒤에 다시 씌운다.
  let pickOpen = false;

  function applyCorner(corner) {
    if (!panel || panelPos) return;   // 드래그로 옮긴 위치가 있으면 그게 우선이다
    const c = CORNERS.includes(corner) ? corner : 'br';
    panel.classList.remove(...CORNERS.map((x) => `gwp-${x}`));
    panel.classList.add(`gwp-${c}`);
  }

  // ── 드래그로 옮기기 ──────────────────────────────────────────────────
  //
  // 좌표를 쓰면 모서리 클래스는 끄고 left/top 으로 잡는다. 화면 밖으로 못 나가게
  // 항상 가둔다 — 창이 작아지거나 접혀서 크기가 바뀌어도 다시 당겨 넣는다.
  let panelPos = null;

  function clamp(x, y) {
    const r = panel.getBoundingClientRect();
    const pad = 4;
    return {
      x: Math.max(pad, Math.min(x, window.innerWidth - r.width - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - r.height - pad)),
    };
  }

  function applyPos(pos) {
    if (!panel) return;
    panelPos = pos;
    if (!pos) return;   // 좌표를 지우면 다음 렌더에서 모서리로 돌아간다
    panel.classList.remove(...CORNERS.map((x) => `gwp-${x}`));
    const c = clamp(pos.x, pos.y);
    panel.style.left = `${c.x}px`;
    panel.style.top = `${c.y}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function clearPos() {
    panelPos = null;
    if (!panel) return;
    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = '';
  }

  // 헤더를 잡고 끈다. 버튼 위에서 시작한 것은 건드리지 않는다.
  function startDrag(ev) {
    if (!panel || ev.button !== 0) return;
    if (ev.target.closest('button, a, input, .gwp-corners')) return;
    const r = panel.getBoundingClientRect();
    const dx = ev.clientX - r.left;
    const dy = ev.clientY - r.top;
    let moved = false;

    const move = (e) => {
      // 몇 픽셀은 클릭으로 본다. 안 그러면 접기 버튼을 누르다 미세하게 흔들려도
      // 드래그로 잡혀 위치가 바뀐다.
      if (!moved && Math.hypot(e.clientX - ev.clientX, e.clientY - ev.clientY) < 4) return;
      moved = true;
      panel.classList.add('gwp-dragging');
      applyPos({ x: e.clientX - dx, y: e.clientY - dy });
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      panel.classList.remove('gwp-dragging');
      if (moved) GW.store.setSettings({ panelPos }).catch(() => {});
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  // 창 크기가 바뀌면 화면 밖으로 나간 패널을 다시 당겨 넣는다.
  window.addEventListener('resize', () => { if (panelPos) applyPos(panelPos); });

  function ensurePanel() {
    if (panelOff) return null;
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    panel.id = 'gw-work-panel';
    panel.addEventListener('click', onClick);
    panel.addEventListener('pointerdown', (ev) => {
      if (ev.target.closest('.gwp-head')) startDrag(ev);
    });
    document.body.appendChild(panel);
    return panel;
  }

  function onClick(ev) {
    const a = ev.target.closest('[data-act]');
    if (!a) return;
    ev.preventDefault(); ev.stopPropagation();
    const act = a.dataset.act;
    if (act === 'prev') { viewMonth = shiftMonth(viewMonth, -1); load(viewMonth); }
    else if (act === 'next') { viewMonth = shiftMonth(viewMonth, 1); load(viewMonth); }
    else if (act === 'reload') location.reload();
    else if (act === 'refresh') { auto.resume(); load(viewMonth, { useCache: false }); }
    // 확장은 읽기 전용이다. 신청서 작성은 그룹웨어 화면에서 하도록 이동만 시킨다.
    else if (act === 'apply-leave') location.hash = GW.screens.hash(GW.screens.LEAVE_APPLY);
    else if (act === 'corner') {
      pickOpen = !pickOpen;
      panel.classList.toggle('gwp-pick', pickOpen);
    } else if (act === 'corner-set') {
      pickOpen = false;
      panel.classList.remove('gwp-pick');
      clearPos();                           // 모서리를 고르면 드래그 위치는 버린다
      applyCorner(a.dataset.corner);        // 저장을 기다리지 않고 바로 옮긴다
      GW.store.setSettings({ panelCorner: a.dataset.corner, panelPos: null }).catch(() => {});
      for (const b of panel.querySelectorAll('[data-act="corner-set"]')) {
        b.classList.toggle('on', b.dataset.corner === a.dataset.corner);
      }
    } else if (act === 'toggle') {
      panel.classList.toggle('gwp-collapsed');
      chrome.storage.local.set({ collapsed: panel.classList.contains('gwp-collapsed') });
    }
  }

  async function render() {
    if (auto.dead) return;
    try {
      await renderInner();
    } catch (e) {
      if (e instanceof GW.store.ContextGone) auto.die(e.message);
      else console.warn('[구름 근무시간] 렌더 실패:', e);
    }
  }

  async function renderInner() {
    const el = ensurePanel();
    if (!el) return;   // 패널을 꺼 둔 상태. 진행 중이던 조회가 여기로 들어온다.
    const settings = await GW.store.getSettings();
    if (settings.panelPos) applyPos(settings.panelPos); else clearPos();
    applyCorner(settings.panelCorner);
    panel.classList.toggle('gwp-bubble', !!settings.panelBubble);
    panel.classList.toggle('gwp-pick', pickOpen);
    state.plans = await GW.store.getPlans();
    const s = GW.calc.summarize({ rows: state.rows, leaves: state.leaves, plans: state.plans, holidays: state.holidays }, settings, viewMonth, new Date());
    // 퇴근 시각 옆에 붙는 "(2시간 12분 남음)". 이미 지났으면 "(충족)".
    const leftLabel = (min) => (min > 0 ? `${T.fmtDuration(min)} 남음` : '충족');

    const plan = GW.calc.todayPlan(s, settings, state.live, new Date());
    const f = feasibility(s);
    const [y, m] = viewMonth.split('-');

    const isCurrentMonth = viewMonth === T.monthKey(new Date());
    const planBlock = !isCurrentMonth || !plan ? '' : plan.done
      ? `<div class="gwp-plan">
           <div class="gwp-ptop">
             <span class="pl">오늘 근무</span><b class="pt done">${T.fmtDuration(plan.workedMin)}</b>
             <i class="pe">${plan.inAt} → ${plan.outAt}</i>
           </div>
         </div>`
      : `<div class="gwp-plan">
           <div class="gwp-ptop">
             <span class="pl">오늘 출근</span><b class="pt">${plan.inAt}</b>
             <i class="pe">${T.fmtDuration(plan.elapsedMin)} 경과</i>
           </div>
           ${plan.creditMin ? `<div class="gwp-plan-leave">${plan.leaveNames.join(' + ')} ${T.fmtDuration(plan.creditMin)} 인정</div>` : ''}
           ${plan.singleTarget
             ? `<div class="gwp-plan-row gwp-hl"><span>오늘 필요 (${T.fmtDuration(plan.needMin)})</span>
                  <b>${plan.parOut} <em class="gwp-left">(${leftLabel(plan.parLeftMin)})</em></b></div>`
             : `<div class="gwp-plan-row"><span>최소 (${T.fmtDuration(plan.minNeedMin)})</span>
                  <b>${plan.minOut} <em class="gwp-left">(${leftLabel(plan.minLeftMin)})</em></b></div>
                <div class="gwp-plan-row gwp-hl"><span>정량 (${T.fmtDuration(plan.needMin)})</span>
                  <b>${plan.parOut} <em class="gwp-left">(${leftLabel(plan.parLeftMin)})</em></b></div>`}
         </div>`;

    const anomalyNote = s.anomalies.length
      ? `<div class="gwp-note gwp-bad">근태 이상 ${s.anomalies.length}일 — ${
          s.anomalies.map((a) => `${Number(a.key.slice(5, 7))}/${Number(a.key.slice(8))}${
            a.inAt || a.outAt ? ` (${a.inAt || '--:--'}~${a.outAt || '--:--'})` : ''}`).join(', ')
        } 인정근무 0. 근태조정을 신청하세요.</div>`
      : '';

    const note = state.error
      ? `<div class="gwp-note gwp-bad">${state.error}</div>`
      : s.estimatedCount
        ? `<div class="gwp-note">아직 집계 전인 ${s.estimatedCount}일은 ${s.holidaySource === 'server' ? '회사 휴일 기준으로' : '공휴일 표로'} 추정했습니다</div>`
        : '';

    el.innerHTML = `
      <div class="gwp-head">
        <button class="gwp-nav" data-act="prev" title="이전 달">‹</button>
        <span class="gwp-title">${y}년 ${Number(m)}월 근무</span>
        <button class="gwp-nav" data-act="next" title="다음 달">›</button>
        <button class="gwp-nav" data-act="corner" title="패널 위치">⤢</button>
        <button class="gwp-toggle" data-act="toggle" title="접기/펼치기">▾</button>
        <span class="gwp-bub">${s.remainingMin <= 0 ? '완료' : T.fmtDuration(Math.max(s.remainingMin, 0))}</span>
        <div class="gwp-corners">
          ${CORNERS.map((c) => `<button data-act="corner-set" data-corner="${c}"
            title="${CORNER_NM[c]}" class="${settings.panelCorner === c ? 'on' : ''}">${CORNER_IC[c]}</button>`).join('')}
        </div>
      </div>
      <div class="gwp-body">
        <div class="gwp-hero">
          <div class="gwp-hero-label">남은 근무시간</div>
          <div class="gwp-hero-value ${s.remainingMin <= 0 ? 'ok' : ''}">${T.fmtDuration(Math.max(s.remainingMin, 0))}</div>
          <div class="gwp-hero-sub ${f.cls}">${f.text}</div>
        </div>
        <div class="gwp-rows">
          <div class="gwp-row"><span>이번 달 인정근무</span><b>${T.fmtDuration(s.workedMin)}</b></div>
          ${s.creditMin ? `<div class="gwp-row gwp-sub"><span>휴가 인정 (예정)</span><b>${T.fmtDuration(s.creditMin)}</b></div>` : ''}
          <div class="gwp-row"><span>월 소정근로</span><b>${T.fmtDuration(s.requiredMin)} <i>(${s.workdayCount}일)</i></b></div>
          <div class="gwp-row"><span>남은 근무일</span><b>${s.remainingWorkdays}일</b></div>
          <div class="gwp-row"><span>하루 필요</span><b>${
            s.avgNeededMin != null ? T.fmtDuration(s.avgNeededMin)
            : s.planBalanceMin == null ? '-'
            : `계획 ${s.planBalanceMin >= 0 ? '초과' : '부족'} ${T.fmtDuration(Math.abs(s.planBalanceMin))}`
          }</b></div>
          ${s.plannedDays ? `<div class="gwp-row gwp-sub"><span>계획 설정한 날</span><b>${s.plannedDays}일</b></div>` : ''}
          <div class="gwp-row"><span>어제까지 누적</span><b class="${s.paceMin >= 0 ? 'ok' : 'bad'}">${s.paceMin >= 0 ? '+' : ''}${T.fmtDuration(s.paceMin)}</b></div>
        </div>
        ${planBlock}
        ${anomalyNote}
        ${note}
        <div class="gwp-actions">
          <button class="gwp-btn gwp-primary" data-act="apply-leave">휴가 신청</button>
          <button class="gwp-btn" data-act="refresh" ${state.loading ? 'disabled' : ''}>새로고침</button>
        </div>
        <div class="gwp-status${auto.stopped ? ' gwp-stopped' : ''}">${
          auto.stopped ? `${esc(auto.stopped)} · 새로고침으로 재시도`
          : state.loading ? '불러오는 중…'
          : auto.until > Date.now() ? `연결 실패 · ${Math.ceil((auto.until - Date.now()) / 60000)}분 뒤 재시도`
          : state.at ? `갱신 ${new Date(state.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : ''
        }</div>
      </div>`;
  }

  // 새 버전 안내. 압축해제 로드라 자동 설치는 불가능하고 링크만 띄운다.
  // 팝업을 안 여는 사람도 있어서 패널에도 한 줄 붙인다.
  async function showUpdateIfAny() {
    let info;
    try { info = await GW.updater.check(); } catch (_) { return; }
    if (!info.hasUpdate || await GW.updater.dismissed(info.latest)) return;
    if (!panel || !document.body.contains(panel)) return;
    const bar = document.createElement('div');
    bar.className = 'gwp-update';
    bar.innerHTML = `새 버전 <b>v${esc(info.latest)}</b>`
      + ` <a href="${esc(info.url)}" target="_blank" rel="noreferrer">받기</a>`
      + '<button title="닫기">×</button>';
    bar.querySelector('button').onclick = (ev) => {
      ev.stopPropagation();
      GW.updater.dismiss(info.latest);
      bar.remove();
    };
    panel.prepend(bar);
  }

  // 근태신청서·결재 같은 별도 팝업 창에는 띄우지 않는다.
  // 아마란스가 window.open() 으로 여는 창이라 opener 가 잡힌다.
  // (Chrome 88+ 는 target="_blank" 에 noopener 를 기본 적용하므로, opener 가 있으면
  //  스크립트가 연 팝업이라고 봐도 된다)
  if (window.opener || window.top !== window) return;

  (async () => {
    // 리스너를 먼저 단다. 꺼진 상태로 들어와도 팝업에서 켜면 바로 뜨게.
    chrome.storage.onChanged.addListener((changes, area) => {
      const c = area === 'local' && changes.settings;
      if (!c || !c.newValue) return;
      if (c.newValue.panelHidden) teardownPanel();
      else if (!panel) setupPanel();
      else {
        if (c.newValue.panelPos) applyPos(c.newValue.panelPos); else clearPos();
        applyCorner(c.newValue.panelCorner);
        panel.classList.toggle('gwp-bubble', !!c.newValue.panelBubble);
      }
    });

    cacheWehagoIdentity();

    let settings;
    try { settings = await GW.store.getSettings(); } catch (_) { return; }
    if (!settings.panelHidden) await setupPanel();
  })();
})();
