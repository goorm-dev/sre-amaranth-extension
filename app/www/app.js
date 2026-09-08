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
      else if (past) { cls.push('done'); value = short(r.workedMin + r.creditMin); }
      else if (r.planMin != null) { cls.push('plan'); value = short(r.planMin); }
      else if (r.creditMin > 0) { cls.push('leave'); value = short(Math.max(0, r.standardMin - r.creditMin)); }
      else if (s.avgNeededMin != null) value = short(s.avgNeededMin);
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
    $('editDay').innerHTML = esc(T.label(T.fromKey(selectedKey)));
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

  // ── 아마란스 화면 열기 ───────────────────────────────────────────────
  //
  // 휴가 상신은 앱이 직접 하지 않는다. 결재선·검증이 화면 안에 있어서
  // API 로 흉내내면 미상신 초안만 쌓인다. 대신 세션을 쿠키로 심고 진짜 화면을 연다.
  //
  // iframe 은 쓰지 않는다 — 앱 WebView 출처(localhost)와 교차 출처라
  // ── 휴가 신청 ────────────────────────────────────────────────────────
  //
  // 확장과 같은 흐름이다 (lib/leave.js 공유):
  //   calculateApplicationDays → validateNew → 확인 → 0hr00011 → create
  //     → GetLinkKey → SetEnageGroup → saveLinkKey → 결재 화면
  // 상신은 하지 않는다. 결재 화면을 띄워 주고 거기서 사용자가 누른다.
  let lvState = null;
  const lvHm = (v) => `${v.slice(0, 2)}:${v.slice(2)}`;

  function lvSyncType() {
    $('lvStart').value = lvHm(GW.leave.TYPES[$('lvType').value].defStart);
    lvSyncSpan();
  }
  function lvSyncSpan() {
    const sp = GW.leave.span($('lvType').value, { startTm: $('lvStart').value });
    $('lvSpan').textContent = `구간 ${lvHm(sp.start)}~${lvHm(sp.end)} · 휴가 ${sp.hours}시간`;
    $('lvPreview').hidden = true; $('lvActions').hidden = true; lvState = null;
  }

  async function lvPreview() {
    const dk = $('lvDate').value;
    if (!dk) { $('lvMsg').textContent = '날짜를 선택해 주세요.'; return; }
    $('lvNext').disabled = true; $('lvMsg').textContent = '확인 중…';
    try {
      const pv = await GW.leave.preview($('lvType').value, dk, { startTm: $('lvStart').value });
      const sched = await GW.leave.profile();
      const val = await GW.leave.validate(pv, sched);
      lvState = { pv, sched };
      $('lvPreview').hidden = false;
      $('lvPreview').innerHTML =
        `<div class="r"><span>종류</span><b>${esc(pv.type.name)}</b></div>`
        + `<div class="r"><span>날짜</span><b>${esc(T.label(T.fromKey(pv.dateKey)))}</b></div>`
        + `<div class="r"><span>시간</span><b>${lvHm(pv.span.start)} ~ ${lvHm(pv.span.end)}</b></div>`
        + `<div class="r"><span>인정 시간</span><b>${T.fmtDuration(pv.appTm)}</b></div>`
        + `<div class="r"><span>연차 차감</span><b>${pv.ycUseCnt}일</b></div>`
        + (val.ok ? '' : `<div class="warn">⚠ ${esc(val.problems.join(', '))}</div>`);
      $('lvActions').hidden = false;
      $('lvSubmit').disabled = !val.ok;
      $('lvMsg').textContent = val.ok
        ? '신청서를 만들고 결재 화면을 엽니다. 상신은 그 화면에서 누르세요.'
        : '검증 경고로 진행할 수 없습니다.';
    } catch (e) { $('lvMsg').textContent = e.message || '확인 실패'; }
    finally { $('lvNext').disabled = false; }
  }

  async function lvSubmit() {
    if (!lvState) return;
    $('lvSubmit').disabled = true;

    // 세션을 미리 확인하지 않는다. 교차 출처에서 그 확인을 하면 gw 에 로그인돼
    // 있어도 resultCode -1 이 나온다 — 오탐이었고, 되던 흐름을 막고 있었다.
    // 확장도 안드로이드도 확인 없이 그냥 이동한다. 같게 간다.
    $('lvMsg').textContent = '신청서 만드는 중…';
    try {
      const r = await GW.leave.submit(lvState.pv, lvState.sched);
      $('lvMsg').textContent = '결재 화면을 여는 중…';
      await openApproval(r.approvalHash);
    } catch (e) {
      $('lvMsg').textContent = '실패: ' + (e.message || '');
      $('lvSubmit').disabled = false;
    }
  }

  // WebView 자체를 gw.goorm.io 로 옮긴다. iframe 은 앱 출처(localhost)에 대해
  // 서드파티라 안드로이드가 쿠키를 막지만, 1st-party 이동이면 정상 적용된다.
  // (capacitor.config.json 의 server.allowNavigation 으로 허용)
  //
  // Capacitor 의 document.cookie 세터는 문자열의 domain= 을 파싱해
  // 네이티브 CookieManager 로 넘긴다. 그래서 domain 을 명시하면 앱 출처와
  // 무관하게 gw.goorm.io 쿠키를 심을 수 있다.
  // 네이티브에서만 쿠키를 심는다. Capacitor 의 document.cookie 세터가 domain= 을
  // 파싱해 네이티브 CookieManager 로 넘기고, WebView 는 깨끗한 상태로 시작한다.
  function setGwCookie(key, value) {
    document.cookie = `${key}=${value}; domain=${new URL(GW.api.ORIGIN).hostname}; path=/`;
  }

  async function openApproval(hash) {
    // 네이티브는 검증된 경로 그대로 — 두 가지를 다 태운다(v1.1.0 APK 와 동일).
    //   1) 쿠키를 직접 심는다. Capacitor 가 domain= 을 파싱해 네이티브
    //      CookieManager 로 넘기고 WebView 가 그 쿠키통을 쓴다.
    //   2) 서버가 심게 한다. loginType=set-cookie 로 5개를 내려준다.
    if (isNative()) {
      try { injectSessionCookies(); } catch (_) {}
      try { await GW.api.establishWebSession(); } catch (_) {}
    }

    // 브라우저에서 열면 쿠키를 건드리지 않는다. 우리 토큰은 gw 웹 세션으로
    // 인정되지 않고, 오히려 사용자의 진짜 세션을 덮어써서 로그아웃시킨다
    // (README "웹앱은 불가능하다" 참고).
    window.location.href = `${GW.api.ORIGIN}/${hash}`;   // 뒤로가기로 복귀
  }

  $('leaveBtn').onclick = () => {
    $('leaveSheet').hidden = false;
    $('lvDate').value = T.toKey(new Date());
    $('lvMsg').textContent = '';
    lvSyncType();
  };
  $('lvType').onchange = lvSyncType;
  $('lvStart').onchange = lvSyncSpan;
  $('lvNext').onclick = lvPreview;
  $('lvSubmit').onclick = lvSubmit;
  $('lvCancel').onclick = () => { $('lvPreview').hidden = true; $('lvActions').hidden = true; lvState = null; };
  $('lvClose').onclick = () => { $('leaveSheet').hidden = true; };

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
