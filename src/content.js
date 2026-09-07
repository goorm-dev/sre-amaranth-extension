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
  }

  function startAuto() {
    clearInterval(auto.timer);
    auto.timer = setInterval(pulse, auto.tick);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden || auto.stopped) return;
      // 오래 자리를 비웠으면 통째로, 아니면 평소 주기대로.
      if (Date.now() - auto.last.full > auto.stale) load(viewMonth, { useCache: false });
      else pulse();
    });
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

  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    panel.id = 'gw-work-panel';
    panel.addEventListener('click', onClick);
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
    else if (act === 'toggle') {
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
    const settings = await GW.store.getSettings();
    state.plans = await GW.store.getPlans();
    const s = GW.calc.summarize({ rows: state.rows, leaves: state.leaves, plans: state.plans, holidays: state.holidays }, settings, viewMonth, new Date());
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
           ${plan.extraBreakMin ? `<div class="gwp-plan-leave brk">${plan.breakNames.join(' + ')} ${T.fmtDuration(plan.extraBreakMin)} 제외</div>` : ''}
           ${plan.singleTarget
             ? `<div class="gwp-plan-row gwp-hl"><span>오늘 필요 (${T.fmtDuration(plan.needMin)})</span><b>${plan.parOut}</b></div>`
             : `<div class="gwp-plan-row"><span>최소 (${T.fmtDuration(plan.minNeedMin)})</span><b>${plan.minOut}</b></div>
                <div class="gwp-plan-row gwp-hl"><span>정량 (${T.fmtDuration(plan.needMin)})</span><b>${plan.parOut}</b></div>`}
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
        <button class="gwp-toggle" data-act="toggle" title="접기/펼치기">▾</button>
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

  // ── 휴가 신청 자동 입력 ──────────────────────────────────────────────
  // 팝업이 chrome.storage 에 남긴 요청을 읽어 근태신청서 폼을 대신 채운다.
  // 채우기만 하고 [신청완료]·[결재상신] 은 누르지 않는다.
  const LEAVE_TTL = 3 * 60 * 1000;

  function toast(html, tone, action) {
    const el = document.createElement('div');
    el.id = 'gw-leave-toast';
    el.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;'
      + 'max-width:440px;padding:12px 16px;border-radius:10px;font:13px/1.5 -apple-system,'
      + '"Apple SD Gothic Neo","Malgun Gothic",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.18);'
      + (tone === 'bad' ? 'background:#fef2f2;color:#991b1b;border:1px solid #fecaca;'
                        : 'background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0;');
    el.innerHTML = html;
    const prev = document.getElementById('gw-leave-toast');
    if (prev) prev.remove();

    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.style.cssText = 'display:block;width:100%;margin-top:10px;padding:9px;border:0;border-radius:8px;'
        + 'background:#1e63d8;color:#fff;font:inherit;font-weight:700;cursor:pointer;';
      // 실제 클릭 안에서 눌러야 window.open 이 팝업 차단에 걸리지 않는다.
      b.addEventListener('click', () => { el.remove(); action.run(); });
      el.appendChild(b);
    } else {
      el.addEventListener('click', () => el.remove());
      setTimeout(() => el.remove(), 20000);
    }
    document.body.appendChild(el);
    return el;
  }

  let leaveBusy = false;

  // SPA 라 해시만 바뀌면 페이지가 다시 뜨지 않는다. 신청서 화면으로 옮겨갈
  // 때까지 기다렸다가 채운다.
  async function waitForScreen(code, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (location.hash.includes(code)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async function claimLeave(req) {
    if (leaveBusy || !req) return;
    if (Date.now() - req.at > LEAVE_TTL) return;
    leaveBusy = true;
    // 요청을 받았다는 것부터 보여 준다. 이게 안 뜨면 콘텐츠 스크립트까지
    // 요청이 오지 않은 것이고, 뜨는데 멈추면 폼 쪽 문제다.
    toast('휴가 신청서를 채우는 중…');
    try {
      if (!(await waitForScreen(GW.screens.LEAVE_APPLY, 10000))) {
        toast('<b>자동 입력 중단</b><br>근태신청서 화면으로 이동하지 못했습니다.', 'bad');
        return;
      }
      await fillLeave(req);
    } finally {
      leaveBusy = false;
    }
  }

  async function runPendingLeave() {
    let req;
    try {
      ({ pendingLeave: req } = await chrome.storage.local.get('pendingLeave'));
      if (!req) return;
      // 한 번 집으면 바로 지운다. 실패해도 새로고침마다 다시 채우지 않게.
      await chrome.storage.local.remove('pendingLeave');
    } catch (_) { return; }
    await claimLeave(req);
  }

  async function fillLeave(req) {
    try {
      const steps = await GW.leaveform.fill(req);
      toast('<b>휴가 신청서를 채웠습니다.</b><br>' + esc(steps.join(' · '))
        + '<br><span style="opacity:.75">내용을 확인하고 아래를 누르면 결재창이 뜹니다.'
        + ' [결재상신] 은 그 창에서 직접 누르세요.</span>',
        null,
        {
          label: '신청완료 → 결재창 열기',
          run: () => {
            if (!GW.leaveform.submit()) toast('<b>[신청완료] 버튼을 찾지 못했습니다.</b>', 'bad');
          },
        });
    } catch (e) {
      toast('<b>자동 입력 실패</b><br>' + esc(e.message)
        + (e.steps && e.steps.length ? '<br>진행: ' + esc(e.steps.join(' · ')) : '')
        + '<br><span style="opacity:.75">직접 입력해 주세요. 저장된 내용은 없습니다.</span>', 'bad');
    }
  }

  // 근태신청서·결재 같은 별도 팝업 창에는 띄우지 않는다.
  // 아마란스가 window.open() 으로 여는 창이라 opener 가 잡힌다.
  // (Chrome 88+ 는 target="_blank" 에 noopener 를 기본 적용하므로, opener 가 있으면
  //  스크립트가 연 팝업이라고 봐도 된다)
  if (window.opener || window.top !== window) return;

  (async () => {
    const { collapsed } = await chrome.storage.local.get('collapsed');
    await render();
    if (collapsed) panel.classList.add('gwp-collapsed');
    load(viewMonth);
    startAuto();
    runPendingLeave();

    // 팝업이 같은 탭의 해시만 바꾸면 이 스크립트는 다시 뜨지 않는다.
    // 그래서 요청이 들어오는 것도 직접 지켜본다.
    chrome.storage.onChanged.addListener((changes, area) => {
      const c = area === 'local' && changes.pendingLeave;
      if (!c || !c.newValue) return;
      chrome.storage.local.remove('pendingLeave');
      claimLeave(c.newValue);
    });
  })();
})();
