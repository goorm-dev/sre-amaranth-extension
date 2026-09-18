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
    for (const v of ['loginView', 'mainView', 'teamView']) $(v).hidden = v !== id;
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
      openRoute();
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
    // 퇴근 시각 옆에 붙는 "(2시간 12분 남음)". 이미 지났으면 "(충족)".
    const leftLabel = (min) => (min > 0 ? `${T.fmtDuration(min)} 남음` : '충족');
    const isCur = viewMonth === T.monthKey(new Date());
    $('plan').innerHTML = !isCur || !plan ? '' : plan.done
      ? `<div class="ptop"><span class="pl">오늘 근무</span><b class="pt done">${T.fmtDuration(plan.workedMin)}</b>
         <i class="pe">${plan.inAt} → ${plan.outAt}</i></div>`
      : `<div class="ptop"><span class="pl">오늘 출근</span><b class="pt">${plan.inAt}</b>
           <i class="pe">${T.fmtDuration(plan.elapsedMin)} 경과</i></div>
         ${plan.creditMin ? `<div class="planleave">${esc(plan.leaveNames.join(' + '))} ${T.fmtDuration(plan.creditMin)} 인정</div>` : ''}
         ${plan.singleTarget
           ? `<div class="planline hl"><span>오늘 필요 (${T.fmtDuration(plan.needMin)})</span>
                <b>${plan.parOut} <em class="left">(${leftLabel(plan.parLeftMin)})</em></b></div>`
           : `<div class="planline"><span>최소 (${T.fmtDuration(plan.minNeedMin)})</span>
                <b>${plan.minOut} <em class="left">(${leftLabel(plan.minLeftMin)})</em></b></div>
              <div class="planline hl"><span>정량 (${T.fmtDuration(plan.needMin)})</span>
                <b>${plan.parOut} <em class="left">(${leftLabel(plan.parLeftMin)})</em></b></div>`}`;

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
      // 지난 날·휴일도 누를 수 있게 둔다 — 그날 누가 쉬었는지는 볼 수 있어야 한다.
      // 계획 편집만 renderEditor 에서 막는다.
      if (!r.standardMin || past) cls.push('noplan');
      const dis = '';
      cells.push(`<button class="${cls.join(' ')}" data-key="${key}"${dis}>` +
        `<span class="d">${d.getDate()}</span><span class="v">${value || '&nbsp;'}</span></button>`);
    }
    $('cal').innerHTML = cells.join('');
  }

  function renderEditor(s) {
    const box = $('caledit');
    const r = s.rows.find((x) => x.key === selectedKey) || {};
    // 마감된 날과 휴일은 계획을 세울 게 없다. 근태 목록만 보여준다.
    const editable = selectedKey && r.standardMin > 0 && selectedKey >= T.toKey(new Date());
    if (!editable) { box.hidden = true; return; }
    box.hidden = false;
    $('editDay').textContent = '근무 계획';
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

  function injectSessionCookies() {
    const s = GW.api.getSession();
    if (!s || !s.token) throw new Error('로그인이 필요합니다.');
    setGwCookie('oAuthToken', s.token);
    setGwCookie('signKey', s.signKey);
    setGwCookie('BIZCUBE_AT', s.token);
    setGwCookie('BIZCUBE_HK', s.signKey);
    setGwCookie('BIZCUBE_TYPE', 'WEB');
  }

  const isNative = () => !!(window.Capacitor && window.Capacitor.isNativePlatform
    && window.Capacitor.isNativePlatform());

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

  // ── 자율휴게 신청 ────────────────────────────────────────────────────
  //
  // 확장과 같은 코드를 쓴다 (lib/break.js). 휴가와 다른 점은 셋 —
  // validateNew 를 부르지 않고, 연차를 쓰지 않고, 사유(appRmkDc)가 들어간다.
  let brState = null;

  function brSyncSpan() {
    const st = $('brStart').value;
    const sp = GW.break.span(st, Number($('brMin').value));
    $('brSpan').textContent = st
      ? `구간 ${lvHm(sp.start)}~${lvHm(sp.end)} · ${sp.minutes}분`
      : '시작 시각을 입력해 주세요.';
    $('brPreview').hidden = true; $('brActions').hidden = true; brState = null;
  }

  async function brPreview() {
    const dk = $('brDate').value, st = $('brStart').value;
    if (!dk || !st) { $('brMsg').textContent = '날짜와 시작 시각을 입력해 주세요.'; return; }
    $('brNext').disabled = true; $('brMsg').textContent = '확인 중…';
    try {
      const pv = await GW.break.preview(dk, st, Number($('brMin').value), $('brReason').value.trim());
      const sched = await GW.leave.profile();
      brState = { pv, sched };
      $('brPreview').hidden = false;
      $('brPreview').innerHTML =
        `<div class="r"><span>날짜</span><b>${esc(T.label(T.fromKey(pv.dateKey)))}</b></div>`
        + `<div class="r"><span>시간</span><b>${lvHm(pv.span.start)} ~ ${lvHm(pv.span.end)}</b></div>`
        + `<div class="r"><span>인정 시간</span><b>${T.fmtDuration(pv.appTm)}</b></div>`
        + `<div class="r"><span>사유</span><b>${esc(pv.reason) || '—'}</b></div>`;
      $('brActions').hidden = false;
      $('brMsg').textContent = '신청서를 만들고 결재 화면을 엽니다. 상신은 그 화면에서 누르세요.';
    } catch (e) { $('brMsg').textContent = e.message || '확인 실패'; }
    finally { $('brNext').disabled = false; }
  }

  async function brSubmit() {
    if (!brState) return;
    $('brSubmit').disabled = true; $('brMsg').textContent = '신청서 만드는 중…';
    try {
      const r = await GW.break.submit(brState.pv, brState.sched);
      $('brMsg').textContent = '결재 화면을 여는 중…';
      await openApproval(r.approvalHash);
    } catch (e) {
      $('brMsg').textContent = '실패: ' + (e.message || '');
      $('brSubmit').disabled = false;
    }
  }

  $('breakBtn').onclick = () => {
    $('breakSheet').hidden = false;
    $('brDate').value = T.toKey(new Date());
    const n = new Date();
    $('brStart').value = `${String(n.getHours()).padStart(2, '0')}:00`;
    $('brMsg').textContent = '';
    brSyncSpan();
  };
  $('brStart').onchange = brSyncSpan;
  $('brMin').onchange = brSyncSpan;
  $('brNext').onclick = brPreview;
  $('brSubmit').onclick = brSubmit;
  $('brCancel').onclick = () => { $('brPreview').hidden = true; $('brActions').hidden = true; brState = null; };
  $('brClose').onclick = () => { $('breakSheet').hidden = true; };

  $('loginBtn').onclick = doLogin;
  $('loginPw').onkeydown = (e) => { if (e.key === 'Enter') doLogin(); };
  $('prevM').onclick = () => { viewMonth = shiftMonth(viewMonth, -1); selectedKey = null; load(); };
  $('nextM').onclick = () => { viewMonth = shiftMonth(viewMonth, 1); selectedKey = null; load(); };
  $('menuBtn').onclick = () => { $('sheet').hidden = false; };
  $('closeSheet').onclick = () => { $('sheet').hidden = true; };
  $('sheet').onclick = (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; };

  // ── 그날 근태 (누가 휴가인지) ────────────────────────────────────────
  //
  // 확장과 같은 흐름이다. 응답이 전사라 우리 팀/전체를 고르고, 날짜별로 한 번만
  // 받아 두고 범위 전환은 클라이언트에서 거른다.
  let dayScope = 'team';
  let dayKey = null;
  const dayCache = new Map();
  const KIND_NM = { leave: '휴가', trip: '출장', field: '외근', etc: '기타' };
  const dHm = (v) => `${v.slice(0, 2)}:${v.slice(2)}`;

  function paintScope() {
    for (const b of $('daySheet').querySelectorAll('[data-scope]')) {
      b.classList.toggle('on', b.dataset.scope === dayScope);
    }
  }

  function renderDay(rows, myDeptSeq) {
    const list = dayScope === 'team' && myDeptSeq
      ? rows.filter((r) => r.deptSeq === String(myDeptSeq))
      : rows;
    $('dayCount').textContent = list.length ? `${list.length}명` : '';
    if (!list.length) {
      $('dayBody').innerHTML = `<div class="dnone">${dayScope === 'team' ? '우리 팀은' : ''} 아무도 없습니다</div>`;
      return;
    }
    $('dayBody').innerHTML = ['leave', 'trip', 'field', 'etc'].map((k) => {
      const g = list.filter((r) => r.kind === k);
      if (!g.length) return '';
      return `<div class="dgrp k-${k}">${KIND_NM[k]}<i>${g.length}명</i></div>`
        + g.map((r) => `<div class="drow">
             <span class="dwho"><b>${esc(r.name)}</b>${
               dayScope === 'all' ? `<i class="ddept">${esc(r.dept)}</i>` : ''}</span>
             <span class="dwhen">${esc(r.atNm)}${
               r.allday ? '' : `<i class="dtime">${dHm(r.from)}~${dHm(r.to)}</i>`}</span>
           </div>`).join('');
    }).join('');
  }

  async function openDay(key) {
    dayKey = key;
    $('daySheet').hidden = false;
    $('dayTitle').textContent = `${T.label(T.fromKey(key))} 근태`;
    $('dayCount').textContent = '';
    paintScope();
    if (dayCache.has(key)) {
      const c = dayCache.get(key);
      renderDay(c.rows, c.myDeptSeq);
      return;
    }
    $('dayBody').textContent = '불러오는 중…';
    try {
      const rows = await GW.api.getDayAttendance(key);
      const myDeptSeq = (GW.api.getSession() || {}).deptSeq;
      dayCache.set(key, { rows, myDeptSeq });
      if (dayKey === key) renderDay(rows, myDeptSeq);
    } catch (e) {
      $('dayBody').innerHTML = `<div class="dbad">${esc(e.message || '조회 실패')}</div>`;
    }
  }

  $('daySheet').querySelector('.dayscope').onclick = (ev) => {
    const b = ev.target.closest('[data-scope]');
    if (!b || b.dataset.scope === dayScope) return;
    dayScope = b.dataset.scope;
    paintScope();
    const hit = dayCache.get(dayKey);
    if (hit) renderDay(hit.rows, hit.myDeptSeq);
    GW.store.setSettings({ dayScope }).catch(() => {});
  };
  $('dayClose').onclick = () => { $('daySheet').hidden = true; };
  $('daySheet').onclick = (e) => { if (e.target === $('daySheet')) $('daySheet').hidden = true; };

  $('cal').onclick = (e) => {
    const b = e.target.closest('button[data-key]');
    if (!b || b.disabled) return;
    selectedKey = b.dataset.key === selectedKey ? null : b.dataset.key;
    render();
    if (selectedKey) openDay(selectedKey);
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


  // ── 근무시간 공유 (우리 팀 · 친구) ──────────────────────────────────────
  //
  // 확장의 팝업과 같은 구조다. 서버는 둘을 구분하지 않는다 —
  // 어느 쪽이든 "주소 + 열쇠" 한 쌍일 뿐이다.
  //
  //   우리 팀 : 그룹웨어 부서에서 주소가 나온다. 고를 수 있는 게 없다.
  //   친구    : 무작위 코드에서 주소가 나온다. 코드를 주고받은 사람끼리 모인다.
  //
  // 자리(selfId)는 사번에서 만든다 — 기기마다 새로 만들면 확장과 앱에서 각각
  // 한 줄씩 생기고 다시 켤 때마다 유령이 쌓인다.
  let tmTab = 'team';
  let teamCfg = null;
  let frCfg = null;        // { rooms: [{ code, label, on }], active, myName }
  let mySelf = null;
  let lastPush = { team: 0, friend: 0 };

  const tmMsg = (t, bad) => {
    $('tmMsg').textContent = t || '';
    $('tmMsg').className = 'msg' + (bad ? ' bad' : '');
  };
  const cfgOf = () => (tmTab === 'team' ? teamCfg : frCfg);
  // 친구 탭에서 지금 보고 있는 방
  const activeRoom = () =>
    (frCfg && (frCfg.rooms || []).find((r) => r.code === frCfg.active)) || null;
  // 공유 체크박스가 가리키는 대상: 우리 팀은 팀 설정, 친구는 "이 방"
  const shareTarget = () => (tmTab === 'team' ? teamCfg : activeRoom());
  const sess = () => GW.api.getSession() || {};

  async function tmSelf(cfg) {
    const s = sess();
    if (s.compSeq && s.empSeq) {
      if (!mySelf) mySelf = await GW.team.selfFrom(s.compSeq, s.empSeq);
      return mySelf;
    }
    if (cfg && cfg.selfId) return cfg;
    return GW.team.newSelf();
  }

  async function tmIds() {
    if (tmTab === 'friend') {
      const r = activeRoom();
      return r ? GW.team.room(r.code) : null;
    }
    const s = sess();
    if (!s.compSeq || !s.deptSeq) throw new Error('부서 정보가 없습니다. 로그아웃 후 다시 로그인해 주세요.');
    return GW.team.derive(s);
  }

  function tmPaintTabs() {
    for (const b of $('tmTabs').querySelectorAll('[data-tab]')) {
      b.classList.toggle('on', b.dataset.tab === tmTab);
    }
    const rooms = (frCfg && frCfg.rooms) || [];
    const joined = tmTab === 'team' || rooms.length > 0;
    $('frRooms').hidden = tmTab !== 'friend' || !rooms.length;
    $('frJoin').hidden = tmTab !== 'friend' || rooms.length > 0;
    $('tmBar').hidden = !joined;
    for (const id of ['frAdd', 'frCopy', 'frLeave']) $(id).hidden = tmTab !== 'friend' || !joined;
    if (tmTab === 'friend') {
      // 켜 둔 방은 앞에 점을 찍는다 — 어디에 올라가고 있는지 한눈에 보이게.
      $('frRooms').innerHTML = rooms.map((r) => {
        const cls = ['frchip'];
        if (r.code === frCfg.active) cls.push('on');
        if (r.on) cls.push('live');
        return `<button type="button" class="${cls.join(' ')}" data-code="${esc(r.code)}">`
          + `${esc(r.label || GW.team.pretty(r.code))}</button>`;
      }).join('');
    }
    const t = shareTarget();
    $('tmOn').checked = !!(t && t.on);
  }

  async function tmShow() {
    show('teamView');
    tmMsg('');
    teamCfg = await GW.store.getTeam();
    // 예전 판본은 방을 하나만 들고 있었다. 목록 구조로 옮겨 담는다.
    frCfg = GW.team.migrateRooms(await GW.store.getFriends());
    tmPaintTabs();
    await tmRefresh();
  }

  async function tmPayload() {
    const settings = await GW.store.getSettings();
    const plans = await GW.store.getPlans();
    const now = new Date();
    const s = GW.calc.summarize(
      { rows: state.rows, leaves: state.leaves, plans, holidays: state.holidays },
      settings, T.monthKey(now), now);
    const plan = GW.calc.todayPlan(s, settings, state.live, now);
    return GW.team.summarize(s, plan, {
      name: (cfgOf() || {}).myName, dept: sess().deptName || '',
    });
  }

  async function tmPushMaybe(force) {
    const cfg = cfgOf();
    const t = shareTarget();
    if (!cfg || !t || !t.on || !cfg.myName || !state.rows.length) return;
    if (!force && Date.now() - lastPush[tmTab] < 2 * 60 * 1000) return;
    lastPush[tmTab] = Date.now();
    try {
      const ids = await tmIds();
      if (!ids) return;
      await GW.team.ensure(ids, tmTab === 'team' ? ids.root || cfg.teamName : '친구');
      await GW.team.publish(ids, await tmSelf(cfg), await tmPayload());
    } catch (_) { /* 본 기능은 막지 않는다 */ }
  }

  async function tmRefresh() {
    const cfg = cfgOf();
    if (tmTab === 'friend' && !activeRoom()) {
      $('tmTitle').textContent = '친구';
      $('tmCount').textContent = '';
      $('tmList').innerHTML = '';
      return;
    }
    $('tmList').textContent = '불러오는 중…';
    try {
      const ids = await tmIds();
      let nm;
      if (tmTab === 'team') {
        // 묶인 이름(뿌리)을 제목으로 쓴다 — 하위 조직이 한 방에 모이기 때문이다.
        nm = ids.root || sess().deptName || (cfg && cfg.teamName) || '우리 팀';
        if (cfg && cfg.teamName !== nm) teamCfg = await GW.store.setTeam({ ...cfg, teamName: nm });
      } else {
        const r = activeRoom();
        nm = r.label || GW.team.pretty(r.code);
      }
      $('tmTitle').textContent = nm;
      await GW.team.ensure(ids, tmTab === 'team' ? nm : '친구');
      const t = shareTarget();
      if (t && t.on && cfg.myName && state.rows.length) {
        lastPush[tmTab] = Date.now();
        await GW.team.publish(ids, await tmSelf(cfg), await tmPayload());
      }
      tmRender((await GW.team.fetchTeam(ids)).members || [], await tmSelf(cfg));
    } catch (e) {
      $('tmList').innerHTML = `<div class="dbad">${esc(e.message)}</div>`;
    }
  }

  function tmRender(members, self) {
    // 예전 판본이 기기마다 자리를 새로 만들어서 같은 사람이 여러 줄로 남아 있을 수
    // 있다. 이름이 같으면 가장 최근 것만 남긴다.
    const byName = new Map();
    for (const m of members) {
      const k = m.name || m.id;
      const cur = byName.get(k);
      if (!cur || (m.at || 0) > (cur.at || 0)) byName.set(k, m);
    }
    const list = [...byName.values()];
    $('tmCount').textContent = list.length ? `${list.length}명` : '';
    if (!list.length) {
      $('tmList').innerHTML = '<div class="dnone">아직 아무도 공유하지 않았습니다</div>';
      return;
    }
    const today = T.toKey(new Date());
    const myId = self && self.selfId;
    $('tmList').innerHTML = list.map((m) => {
      const fresh = T.toKey(new Date(m.at)) === today;
      let right = '<i class="tmstale">오늘 기록 없음</i>';
      if (m.leaveNm && !m.outAt) right = `<i class="tmleave">${esc(m.leaveNm)}</i>`;
      else if (fresh && m.outAt) {
        right = m.leftMin != null && m.leftMin <= 0
          ? `<b class="tmout done">${esc(m.outAt)}</b><i>퇴근</i>`
          : `<b class="tmout">${esc(m.outAt)}</b><i>${
              m.leftMin != null ? `${T.fmtDuration(m.leftMin)} 남음` : ''}</i>`;
      }
      const sub = [
        // 하위 조직이 한 방에 모이므로 팀 탭에서도 각자 부서를 보여 준다.
        m.dept && m.dept !== $('tmTitle').textContent ? esc(m.dept) : null,
        fresh && m.inAt ? `출근 ${esc(m.inAt)}` : null,
        fresh && m.workedMin != null ? `경과 ${short(m.workedMin)}` : null,
        m.monthLeftMin == null ? null
          : m.monthLeftMin <= 0 ? '이달 충족' : `이달 ${short(m.monthLeftMin)}`,
      ].filter(Boolean).join(' · ');
      return `<div class="tmrow${m.id === myId ? ' me' : ''}">
          <span class="tmwho"><b>${esc(m.name)}</b>${sub ? `<em>${sub}</em>` : ''}</span>
          <span class="tmright">${right}</span>
        </div>`;
    }).join('');
  }

  $('teamBtn').onclick = tmShow;
  $('tmBack').onclick = () => show('mainView');

  $('tmTabs').onclick = async (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (!b || b.dataset.tab === tmTab) return;
    tmTab = b.dataset.tab;
    tmMsg('');
    tmPaintTabs();
    await tmRefresh();
  };

  $('tmOn').onchange = async () => {
    // 친구 탭에서는 방마다 따로 켜고 끈다.
    const save = (v) => (tmTab === 'team'
      ? GW.store.setTeam(v).then((x) => (teamCfg = x))
      : GW.store.setFriends(v).then((x) => (frCfg = x)));
    const setOn = (on) => (tmTab === 'team'
      ? save({ ...teamCfg, on })
      : save({
        ...frCfg,
        rooms: (frCfg.rooms || []).map((r) => (r.code === frCfg.active ? { ...r, on } : r)),
      }));
    const cfg = cfgOf();
    if (!$('tmOn').checked) {
      try {
        const ids = await tmIds();
        if (ids) await GW.team.withdraw(ids, await tmSelf(cfg));
      } catch (_) {}
      await setOn(false);
      $('tmNameWrap').hidden = true;
      tmMsg('공유를 껐습니다. 올려 둔 내 기록도 지웠습니다.');
      return tmRefresh();
    }
    try {
      if (!(await tmIds())) throw new Error('먼저 코드를 만들거나 참여해 주세요.');
    } catch (e) { $('tmOn').checked = false; return tmMsg(e.message, true); }
    const s = sess();
    const myName = s.userName || (cfg && cfg.myName)
      || (teamCfg && teamCfg.myName) || (frCfg && frCfg.myName) || ($('tmName').value || '').trim();
    if (!myName) {
      $('tmNameWrap').hidden = false;
      $('tmName').focus();
      $('tmOn').checked = false;
      return tmMsg('표시 이름을 넣고 다시 켜 주세요.', true);
    }
    $('tmNameWrap').hidden = true;
    if (tmTab === 'team') {
      const base = teamCfg || (s.compSeq && s.empSeq ? {} : GW.team.newSelf());
      await save({ ...base, teamName: (teamCfg && teamCfg.teamName) || '우리 팀', myName, on: true });
    } else {
      await save({ ...frCfg, myName });
      await setOn(true);
    }
    tmMsg('공유를 켰습니다.');
    await tmPushMaybe(true);
    tmRefresh();
  };

  // ── 친구 방 ────────────────────────────────────────────────────────────
  //
  // 방은 여러 개 만들 수 있다. 각 방은 따로 켜고 끈다 —
  // 켜 둔 방마다 내 근무시간이 올라간다.
  $('frNew').onclick = async () => {
    const code = GW.team.newCode();
    frCfg = await GW.store.setFriends({
      ...frCfg, rooms: [...(frCfg.rooms || []), { code, label: '', on: false }], active: code,
    });
    tmPaintTabs();
    tmMsg('방을 만들었습니다. 코드를 복사해 보내세요.');
    await tmRefresh();
  };

  $('frAdd').onclick = () => {
    $('frJoin').hidden = false;
    $('frInput').focus();
  };

  $('frJoinBtn').onclick = async () => {
    const code = GW.team.normCode($('frInput').value);
    if (code.length < 8) { tmMsg('코드가 올바르지 않습니다.', true); return; }
    if ((frCfg.rooms || []).some((r) => r.code === code)) {
      frCfg = await GW.store.setFriends({ ...frCfg, active: code });
      $('frInput').value = '';
      tmPaintTabs();
      tmMsg('이미 참여 중인 방입니다.');
      return tmRefresh();
    }
    $('frJoinBtn').disabled = true;
    tmMsg('확인 중…');
    try {
      const data = await GW.team.fetchTeam(await GW.team.room(code));
      frCfg = await GW.store.setFriends({
        ...frCfg, rooms: [...(frCfg.rooms || []), { code, label: '', on: false }], active: code,
      });
      $('frInput').value = '';
      tmPaintTabs();
      tmMsg(`참여했습니다 (${(data.members || []).length}명).`);
      await tmRefresh();
    } catch (e) { tmMsg(e.message, true); }
    $('frJoinBtn').disabled = false;
  };

  $('frRooms').onclick = async (ev) => {
    const b = ev.target.closest('[data-code]');
    if (!b || b.dataset.code === frCfg.active) return;
    frCfg = await GW.store.setFriends({ ...frCfg, active: b.dataset.code });
    tmMsg('');
    tmPaintTabs();
    await tmRefresh();
  };

  $('frCopy').onclick = async () => {
    const r = activeRoom();
    if (!r) return;
    const c = GW.team.pretty(r.code);
    try {
      await navigator.clipboard.writeText(c);
      tmMsg('코드를 복사했습니다. 이 코드를 가진 사람은 서로의 근무시간을 봅니다.');
    } catch (_) { tmMsg(c); }
  };

  $('frLeave').onclick = async () => {
    const r = activeRoom();
    if (!r) return;
    try { await GW.team.withdraw(await GW.team.room(r.code), await tmSelf(frCfg)); } catch (_) {}
    const rooms = (frCfg.rooms || []).filter((x) => x.code !== r.code);
    frCfg = await GW.store.setFriends({ ...frCfg, rooms, active: rooms.length ? rooms[0].code : null });
    tmPaintTabs();
    tmMsg('방에서 나왔습니다. 올려 둔 내 기록도 지웠습니다.');
    await tmRefresh();
  };

  // subPath 로 바로 열기. 아이폰 홈 화면에 /leave · /break 를 따로 추가하면
  // 두 번 탭에 신청서가 뜬다. nginx 가 모든 경로를 index.html 로 떨어뜨린다.
  //
  // 로그인 전에 들어와도 경로를 기억했다가 로그인 뒤에 연다.
  const ROUTES = { '/leave': 'leaveBtn', '/break': 'breakBtn', '/team': 'teamBtn' };

  function openRoute() {
    const btn = ROUTES[location.pathname.replace(/\/+$/, '') || '/'];
    if (btn && $(btn)) $(btn).click();
  }

  (async () => {
    const s = await GW.auth.restore();
    if (s) { enterMain(); openRoute(); } else { show('loginView'); }
  })();
})();
