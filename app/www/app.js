// 화면 orchestration. 계산은 전부 lib/calc.js (확장과 동일한 파일) 가 한다.
(function () {
  const T = GW.time;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let viewMonth = T.monthKey(new Date());
  let state = { rows: [], leaves: [], plans: {}, holidays: null, live: null, loading: false, error: null, at: null };
  let selectedKey = null;
  let tick = null;

  const show = (id) => {
    for (const v of ['loginView', 'mainView']) $(v).hidden = v !== id;
  };

  // ── 로그인 ──────────────────────────────────────────────────────────────
  async function doLogin() {
    const id = $('loginId').value.trim();
    const pw = $('loginPw').value;
    if (!id || !pw) { $('loginMsg').textContent = '아이디와 비밀번호를 입력해 주세요.'; return; }
    $('loginBtn').disabled = true;
    $('loginMsg').textContent = '로그인 중…';
    $('diag').hidden = true;
    try {
      await GW.auth.login(id, pw);
      if (!$('remember').checked) await GW.store.clearSession();
      $('loginPw').value = '';
      $('loginMsg').textContent = '';
      enterMain();
    } catch (e) {
      $('loginMsg').textContent = e.message || '로그인에 실패했습니다.';
      if (e.diag) {
        $('diag').hidden = false;
        $('diagBody').textContent = JSON.stringify(e.diag, null, 1);
      }
    } finally {
      $('loginBtn').disabled = false;
    }
  }

  // ── 데이터 ──────────────────────────────────────────────────────────────
  async function loadHolidays(monthKey) {
    const year = Number(monthKey.slice(0, 4));
    const cached = await GW.store.getCachedHolidays(year);
    if (cached) return cached;
    try {
      const h = await GW.api.getHolidays(year);
      await GW.store.cacheHolidays(year, h);
      return h;
    } catch (_) { return null; }
  }

  async function load({ useCache = true } = {}) {
    state.loading = true;
    if (useCache) {
      const c = await GW.store.getCachedMonth(viewMonth);
      if (c) { state.rows = c.rows; state.leaves = c.leaves || []; }
      await render();
    }
    try {
      const [rows, leaves] = await Promise.all([
        GW.api.getMonth(viewMonth),
        GW.api.getMonthLeaves(viewMonth).catch(() => []),
      ]);
      state.holidays = await loadHolidays(viewMonth);
      await GW.store.cacheMonth(viewMonth, rows, leaves);
      let live = null;
      if (viewMonth === T.monthKey(new Date())) {
        try { live = await GW.api.getComeLeave(T.toKey(new Date())); } catch (_) {}
      }
      Object.assign(state, { rows, leaves, live, error: null, at: Date.now() });
    } catch (e) {
      state.error = e.message;
      if (e instanceof GW.api.AuthError) { await GW.auth.logout(); show('loginView'); $('loginMsg').textContent = e.message; }
    }
    state.loading = false;
    await render();
  }

  // ── 렌더 ────────────────────────────────────────────────────────────────
  function verdict(s) {
    switch (s.feasibility) {
      case 'done': return { c: 'ok', t: `소정근로 충족 (+${T.fmtDuration(-s.remainingMin)})` };
      case 'ok': return { c: 'ok', t: '남은 근무일 매일 6시간이면 충족' };
      case 'tight': return { c: 'warn', t: `매일 6시간으론 부족 · 하루 ${T.fmtDuration(s.avgNeededMin)} 필요` };
      case 'impossible': return { c: 'bad', t: `매일 8시간을 채워도 ${T.fmtDuration(s.remainingMin - s.parCapacity)} 부족` };
      default: return { c: '', t: '' };
    }
  }
  const row = (l, v, cls) => `<div class="row"><span>${l}</span><b class="${cls || ''}">${v}</b></div>`;
  const short = (m) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  const shiftMonth = (m, d) => {
    const [y, mm] = m.split('-').map(Number);
    return T.monthKey(new Date(y, mm - 1 + d, 1));
  };

  async function render() {
    const settings = await GW.store.getSettings();
    state.plans = await GW.store.getPlans();
    const s = GW.calc.summarize(
      { rows: state.rows, leaves: state.leaves, plans: state.plans, holidays: state.holidays },
      settings, viewMonth, new Date());
    const [y, m] = viewMonth.split('-');
    const v = verdict(s);

    $('monthLabel').textContent = `${y}년 ${Number(m)}월`;
    $('remaining').textContent = T.fmtDuration(Math.max(s.remainingMin, 0));
    $('remaining').className = 'val' + (s.remainingMin <= 0 ? ' ok' : '');
    $('feasibility').textContent = v.t;
    $('feasibility').className = 'sub ' + v.c;

    $('rows').innerHTML = [
      row('이번 달 인정근무', T.fmtDuration(s.workedMin)),
      s.creditMin ? row('휴가 인정 (예정)', T.fmtDuration(s.creditMin)) : '',
      row('월 소정근로', `${T.fmtDuration(s.requiredMin)} (${s.workdayCount}일)`),
      row('남은 근무일', `${s.remainingWorkdays}일`),
      row('하루 필요', s.avgNeededMin != null ? T.fmtDuration(s.avgNeededMin)
        : s.planBalanceMin == null ? '-'
        : `계획 ${s.planBalanceMin >= 0 ? '초과' : '부족'} ${T.fmtDuration(Math.abs(s.planBalanceMin))}`),
      row('어제까지 누적', `${s.paceMin >= 0 ? '+' : ''}${T.fmtDuration(s.paceMin)}`, s.paceMin >= 0 ? 'ok' : 'bad'),
    ].join('');

    const plan = GW.calc.todayPlan(s, settings, state.live, new Date());
    const isCur = viewMonth === T.monthKey(new Date());
    $('plan').innerHTML = !isCur || !plan ? '' : plan.done
      ? `<div class="ptop"><span class="pl">오늘 근무</span><b class="pt done">${T.fmtDuration(plan.workedMin)}</b>
         <i class="pe">${plan.inAt} → ${plan.outAt}</i></div>`
      : `<div class="ptop"><span class="pl">오늘 출근</span><b class="pt">${plan.inAt}</b>
           <i class="pe">${T.fmtDuration(plan.elapsedMin)} 경과</i></div>
         ${plan.creditMin ? `<div class="planleave">${esc(plan.leaveNames.join(' + '))} ${T.fmtDuration(plan.creditMin)} 인정</div>` : ''}
         ${plan.extraBreakMin ? `<div class="planleave brk">${esc(plan.breakNames.join(' + '))} ${T.fmtDuration(plan.extraBreakMin)} 제외</div>` : ''}
         ${plan.singleTarget
           ? `<div class="planline hl"><span>오늘 필요 (${T.fmtDuration(plan.needMin)})</span><b>${plan.parOut}</b></div>`
           : `<div class="planline"><span>최소 (${T.fmtDuration(plan.minNeedMin)})</span><b>${plan.minOut}</b></div>
              <div class="planline hl"><span>정량 (${T.fmtDuration(plan.needMin)})</span><b>${plan.parOut}</b></div>`}`;

    renderCalendar(s);
    renderEditor(s);

    const notes = [];
    if (s.anomalies.length) notes.push(`근태 이상 ${s.anomalies.length}일 (${
      s.anomalies.map((a) => `${Number(a.key.slice(5, 7))}/${Number(a.key.slice(8))}`).join(', ')}) — 인정근무 0. 근태조정을 신청하세요.`);
    if (state.error) notes.push(state.error);
    else if (s.estimatedCount) notes.push(`아직 집계 전인 ${s.estimatedCount}일은 ${
      s.holidaySource === 'server' ? '회사 휴일 기준으로' : '공휴일 표로'} 추정했습니다.`);
    $('hint').textContent = notes.join(' ');
    $('hint').className = 'hint' + (state.error || s.anomalies.length ? ' bad' : '');

    $('stamp').textContent = state.loading ? '불러오는 중…'
      : state.at ? `갱신 ${new Date(state.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '';

    $('daily').value = settings.dailyMinutes / 60;
    $('minFlex').value = settings.minFlexMinutes / 60;
    $('breakMin').value = settings.breakMinutes;
  }

  function renderCalendar(s) {
    const { first, last } = T.monthRange(viewMonth);
    const byKey = Object.fromEntries(s.rows.map((r) => [r.key, r]));
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push('<button class="blank" disabled></button>');
    for (const d of T.eachDay(first, last)) {
      const key = T.toKey(d);
      const r = byKey[key] || {};
      const past = key < s.todayKey;
      const cls = []; let value = '';
      if (!r.standardMin) cls.push('off');
      else if (past) { cls.push('done'); value = short(r.netWorkedMin + r.creditMin); }
      else if (r.planMin != null) { cls.push('plan'); value = short(r.planMin); }
      else if (r.creditMin > 0) { cls.push('leave'); value = short(Math.max(0, r.standardMin - r.creditMin)); }
      else if (s.avgNeededMin != null) value = short(s.avgNeededMin);
      if (r.extraBreakMin > 0) cls.push('brk');
      if (key === s.todayKey) cls.push('today');
      if (key === selectedKey) cls.push('sel');
      const dis = !r.standardMin || past ? ' disabled' : '';
      cells.push(`<button class="${cls.join(' ')}" data-key="${key}"${dis}>` +
        `<span class="d">${d.getDate()}</span><span class="v">${value || '&nbsp;'}</span></button>`);
    }
    $('cal').innerHTML = cells.join('');
  }

  function renderEditor(s) {
    const box = $('caledit');
    if (!selectedKey) { box.hidden = true; return; }
    box.hidden = false;
    const r = s.rows.find((x) => x.key === selectedKey) || {};
    $('editDay').innerHTML = esc(T.label(T.fromKey(selectedKey)))
      + (r.extraBreakMin > 0 ? ` <em class="ebrk">휴게 ${esc(T.fmtDuration(r.extraBreakMin))}</em>` : '');
    const fb = r.planMin != null ? r.planMin
      : (r.creditMin > 0 ? Math.max(0, r.standardMin - r.creditMin) : (s.avgNeededMin ?? s.dailyMin));
    $('editHours').value = (fb / 60).toFixed(1);
  }

  // ── 진입/이벤트 ─────────────────────────────────────────────────────────
  function enterMain() {
    show('mainView');
    load();
    clearInterval(tick);
    // 경과 시간·퇴근 시각만 다시 그린다 (서버 호출 없음)
    tick = setInterval(() => { if (!document.hidden) render(); }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - (state.at || 0) > 10 * 60 * 1000) load({ useCache: false });
    });
  }

  $('loginBtn').onclick = doLogin;
  $('loginPw').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  $('prevM').onclick = () => { viewMonth = shiftMonth(viewMonth, -1); selectedKey = null; load(); };
  $('nextM').onclick = () => { viewMonth = shiftMonth(viewMonth, 1); selectedKey = null; load(); };
  $('menuBtn').onclick = () => { $('sheet').hidden = false; };
  $('closeSheet').onclick = () => { $('sheet').hidden = true; };
  $('sheet').onclick = (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; };

  $('cal').onclick = (e) => {
    const b = e.target.closest('button[data-key]');
    if (!b || b.disabled) return;
    selectedKey = b.dataset.key === selectedKey ? null : b.dataset.key;
    render();
  };
  $('editApply').onclick = async () => {
    const h = Number($('editHours').value);
    if (!selectedKey || !Number.isFinite(h)) return;
    await GW.store.setPlan(selectedKey, Math.round(h * 60));
    render();
  };
  $('editClear').onclick = async () => {
    if (selectedKey) { await GW.store.setPlan(selectedKey, null); render(); }
  };
  $('clearPlans').onclick = async () => {
    await GW.store.clearPlans(viewMonth); selectedKey = null; render();
  };
  $('save').onclick = async () => {
    await GW.store.setSettings({
      dailyMinutes: Math.round(Number($('daily').value || 8) * 60),
      minFlexMinutes: Math.round(Number($('minFlex').value || 6) * 60),
      breakMinutes: Math.round(Number($('breakMin').value || 0)),
    });
    $('sheet').hidden = true;
    render();
  };
  $('logout').onclick = async () => {
    await GW.auth.logout();
    clearInterval(tick);
    $('sheet').hidden = true;
    show('loginView');
  };

  (async () => {
    const s = await GW.auth.restore();
    if (s) enterMain(); else show('loginView');
  })();
})();
