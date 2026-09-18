(function () {
  const T = GW.time;
  const $ = (id) => document.getElementById(id);
  let viewMonth = T.monthKey(new Date());
  let state = { rows: [], leaves: [], plans: {}, holidays: null, live: null, loading: false, error: null, at: null };

  const shiftMonth = (mKey, d) => {
    const [y, m] = mKey.split('-').map(Number);
    return T.monthKey(new Date(y, m - 1 + d, 1));
  };

  function feasibility(s) {
    switch (s.feasibility) {
      case 'done': return { cls: 'ok', text: `소정근로 충족 (+${T.fmtDuration(-s.remainingMin)})` };
      case 'ok': return { cls: 'ok', text: '남은 근무일 매일 6시간이면 충족' };
      case 'tight': return { cls: 'warn', text: `매일 6시간으론 부족 · 하루 ${T.fmtDuration(s.avgNeededMin)} 필요` };
      case 'impossible': return { cls: 'bad', text: `매일 8시간을 채워도 ${T.fmtDuration(s.remainingMin - s.parCapacity)} 부족` };
      default: return { cls: '', text: '' };
    }
  }

  const row = (l, v, cls) => `<div class="row"><span>${l}</span><b class="${cls || ''}">${v}</b></div>`;

  // 캘린더 칸에 들어갈 짧은 표기: 470 → "7:50"
  const esc = (v) => String(v == null ? '' : v)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const short = (min) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;

  let selectedKey = null;

  // 남은 근무일에 계획/휴가가 없으면 평균 필요 시간을 미리 채워 보여준다.
  function renderCalendar(s) {
    const { first, last } = T.monthRange(viewMonth);
    const byKey = Object.fromEntries(s.rows.map((r) => [r.key, r]));
    const cells = [];
    for (let i = 0; i < first.getDay(); i++) cells.push('<button class="blank" disabled></button>');

    for (const d of T.eachDay(first, last)) {
      const key = T.toKey(d);
      const r = byKey[key] || {};
      const past = key < s.todayKey;
      const cls = ['cal-day'];
      let value = '';

      if (!r.standardMin) {
        cls.push('off');
      } else if (past) {
        cls.push('done');
        // 월 집계와 같은 값이어야 한다 — 미반영 휴게를 뺀 실질 인정근무 + 휴가 크레딧
        value = short(r.workedMin + r.creditMin);
      } else if (r.planMin != null) {
        cls.push('plan');
        value = short(r.planMin);
      } else if (r.creditMin > 0) {
        cls.push('leave');
        value = short(Math.max(0, r.standardMin - r.creditMin));
      } else if (s.avgNeededMin != null) {
        value = short(s.avgNeededMin);
      }
      // 휴게·외출은 필요 근무시간을 바꾸지 않고 퇴근만 밀리므로, 값 대신 표식으로 알린다.
      if (key === s.todayKey) cls.push('today');
      if (key === selectedKey) cls.push('sel');

      const tip = [
        r.holidayNm || null,
        r.leaveNames ? `${r.leaveNames.join(', ')} ${T.fmtDuration(r.creditMin)} 인정` : null,
      ].filter(Boolean).join(' · ');
      const title = tip ? ` title="${esc(tip)}"` : '';
      // 지난 날·휴일도 누를 수 있게 둔다 — 그날 누가 쉬었는지는 볼 수 있어야 한다.
      // 계획 편집만 막으면 된다(아래 renderEditor).
      if (!r.standardMin || past) cls.push('noplan');
      const disabled = '';
      cells.push(`<button class="${cls.join(' ')}" data-key="${key}"${disabled}${title}>` +
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
    const fallback = r.planMin != null ? r.planMin
      : (r.creditMin > 0 ? Math.max(0, r.standardMin - r.creditMin) : (s.avgNeededMin ?? s.dailyMin));
    $('editHours').value = (fallback / 60).toFixed(1);
  }

  async function load({ useCache = true } = {}) {
    if (useCache) {
      const cached = await GW.store.getCachedMonth(viewMonth);
      state = {
        rows: cached ? cached.rows : [], leaves: cached ? (cached.leaves || []) : [],
        live: null, loading: true, error: null, at: cached ? cached.at : null,
      };
      await render();
    }
    try {
      const [rows, leaves] = await Promise.all([
        GW.api.getMonth(viewMonth),
        GW.api.getMonthLeaves(viewMonth).catch(() => []),
      ]);
      state.holidays = await loadHolidays(viewMonth);
      await GW.store.cacheMonth(viewMonth, rows, leaves);
      // 오늘 타각은 근태 배치(다음날 새벽) 전이라 월 조회에 없다. 따로 읽는다.
      let live = null;
      if (viewMonth === T.monthKey(new Date())) {
        try { live = await GW.api.getComeLeave(T.toKey(new Date())); } catch (_) {}
      }
      state = { ...state, rows, leaves, live, loading: false, error: null, at: Date.now() };
    } catch (e) {
      state = { ...state, loading: false, error: e.message };
    }
    await render();
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

  async function render() {
    const settings = await GW.store.getSettings();
    state.plans = await GW.store.getPlans();
    const s = GW.calc.summarize({ rows: state.rows, leaves: state.leaves, plans: state.plans, holidays: state.holidays }, settings, viewMonth, new Date());
    const [y, m] = viewMonth.split('-');
    const f = feasibility(s);

    $('monthLabel').textContent = `${y}년 ${Number(m)}월`;
    $('remaining').textContent = T.fmtDuration(Math.max(s.remainingMin, 0));
    $('remaining').className = 'val' + (s.remainingMin <= 0 ? ' ok' : '');
    $('feasibility').textContent = f.text;
    $('feasibility').className = 'sub ' + f.cls;

    $('rows').innerHTML = [
      row('이번 달 인정근무', T.fmtDuration(s.workedMin)),
      s.creditMin ? row('휴가 인정 (예정)', T.fmtDuration(s.creditMin)) : '',
      row('월 소정근로', `${T.fmtDuration(s.requiredMin)} (${s.workdayCount}일)`),
      row('남은 근무일', `${s.remainingWorkdays}일`),
      row('하루 필요', s.avgNeededMin == null
        ? (s.planBalanceMin == null ? '-'
          : `계획 ${s.planBalanceMin >= 0 ? '초과' : '부족'} ${T.fmtDuration(Math.abs(s.planBalanceMin))}`)
        : T.fmtDuration(s.avgNeededMin)),
      row('어제까지 누적', `${s.paceMin >= 0 ? '+' : ''}${T.fmtDuration(s.paceMin)}`, s.paceMin >= 0 ? 'ok' : 'bad'),
    ].join('');

    const plan = GW.calc.todayPlan(s, settings, state.live, new Date());
    const isCurrent = viewMonth === T.monthKey(new Date());
  // 퇴근 시각 옆에 붙는 "(2시간 12분 남음)". 이미 지났으면 "(충족)".
  const leftLabel = (min) => (min > 0 ? `${T.fmtDuration(min)} 남음` : '충족');

    $('plan').innerHTML = !isCurrent || !plan ? '' : plan.done
      ? `<div class="ptop">
           <span class="pl">오늘 근무</span><b class="pt done">${T.fmtDuration(plan.workedMin)}</b>
           <i class="pe">${plan.inAt} → ${plan.outAt}</i>
         </div>`
      : `<div class="ptop">
           <span class="pl">오늘 출근</span><b class="pt">${plan.inAt}</b>
           <i class="pe">${T.fmtDuration(plan.elapsedMin)} 경과</i>
         </div>
         ${plan.creditMin ? `<div class="planleave">${plan.leaveNames.join(' + ')} ${T.fmtDuration(plan.creditMin)} 인정</div>` : ''}
         ${plan.singleTarget
           ? `<div class="planline hl"><span>오늘 필요 (${T.fmtDuration(plan.needMin)})</span>
                <b>${plan.parOut} <em class="left">(${leftLabel(plan.parLeftMin)})</em></b></div>`
           : `<div class="planline"><span>최소 (${T.fmtDuration(plan.minNeedMin)})</span>
                <b>${plan.minOut} <em class="left">(${leftLabel(plan.minLeftMin)})</em></b></div>
              <div class="planline hl"><span>정량 (${T.fmtDuration(plan.needMin)})</span>
                <b>${plan.parOut} <em class="left">(${leftLabel(plan.parLeftMin)})</em></b></div>`}`;

    const notes = [];
    if (s.anomalies.length) {
      notes.push(`근태 이상 ${s.anomalies.length}일 (${
        s.anomalies.map((a) => `${Number(a.key.slice(5, 7))}/${Number(a.key.slice(8))}`).join(', ')
      }) — 인정근무가 0입니다. 근태조정을 신청하세요.`);
    }
    if (state.error) notes.push(state.error);
    else if (s.estimatedCount) notes.push(`아직 집계 전인 ${s.estimatedCount}일은 ${s.holidaySource === 'server' ? '회사 휴일 기준으로' : '공휴일 표로'} 추정했습니다.`);
    if (!GW.holidays.hasTable(Number(y))) notes.push(`${y}년 공휴일 표가 없습니다.`);
    $('hint').textContent = notes.join(' ');
    $('hint').className = 'hint' + (state.error || s.anomalies.length ? ' bad' : '');

    renderCalendar(s);
    renderEditor(s);

    $('stamp').textContent = state.loading ? '불러오는 중…'
      : state.at ? `갱신 ${new Date(state.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '';

    $('daily').value = settings.dailyMinutes / 60;
    $('minFlex').value = settings.minFlexMinutes / 60;
    $('breakMin').value = settings.breakMinutes;
    $('holAdd').value = (settings.holidayAdd || []).join(', ');
    $('holRemove').value = (settings.holidayRemove || []).join(', ');
    paintCorners(settings.panelCorner);
    paintPanelToggle(settings.panelHidden);
    $('panelBubble').checked = !!settings.panelBubble;
    dayScope = settings.dayScope || 'team';
  }

  const parseDates = (t) => (t || '').split(/[,\s]+/).map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));

  // ── 그날 근태 (누가 휴가인지) ────────────────────────────────────────
  //
  // 달력 날짜를 누르면 뜬다. 응답이 전사라서 우리 팀만 볼지 전체를 볼지 고른다.
  // 날짜별로 한 번만 받아 두고 범위 전환은 클라이언트에서 거른다.
  let dayScope = 'team';
  let dayKey = null;
  const dayCache = new Map();

  function paintScope() {
    for (const b of $('daySheet').querySelectorAll('[data-scope]')) {
      b.classList.toggle('on', b.dataset.scope === dayScope);
    }
  }

  const KIND_NM = { leave: '휴가', trip: '출장', field: '외근', etc: '기타' };

  function renderDay(rows, myDeptSeq) {
    const list = dayScope === 'team' && myDeptSeq
      ? rows.filter((r) => r.deptSeq === String(myDeptSeq))
      : rows;
    // 목록이 잘려도 총원이 제목에 있으면 더 있다는 게 보인다.
    $('dayCount').textContent = list.length ? `${list.length}명` : '';
    if (!list.length) {
      $('dayBody').innerHTML = `<div class="dnone">${dayScope === 'team' ? '우리 팀은' : ''} 아무도 없습니다</div>`;
      return;
    }
    // 휴가 → 출장 → 외근 순으로 묶는다. 궁금한 건 대개 휴가다.
    const order = ['leave', 'trip', 'field', 'etc'];
    $('dayBody').innerHTML = order.map((k) => {
      const g = list.filter((r) => r.kind === k);
      if (!g.length) return '';
      return `<div class="dgrp k-${k}">${KIND_NM[k]}<i>${g.length}명</i></div>`
        + g.map((r) => `<div class="drow">
             <span class="dwho"><b>${esc(r.name)}</b>${
               dayScope === 'all' ? `<i class="ddept">${esc(r.dept)}</i>` : ''}</span>
             <span class="dwhen">${esc(r.atNm)}${
               r.allday ? '' : `<i class="dtime">${hm(r.from)}~${hm(r.to)}</i>`}</span>
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
      const { rows, myDeptSeq } = dayCache.get(key);
      renderDay(rows, myDeptSeq);
      return;
    }
    $('dayBody').textContent = '불러오는 중…';
    try {
      const [rows, id] = await Promise.all([
        GW.api.getDayAttendance(key),
        GW.api.wehagoIdentity().catch(() => null),
      ]);
      const myDeptSeq = id && id.deptSeq;
      dayCache.set(key, { rows, myDeptSeq });
      if (dayKey === key) renderDay(rows, myDeptSeq);
    } catch (e) {
      $('dayBody').innerHTML = `<div class="dbad">${esc(e.message || '조회 실패')}</div>`;
    }
  }

  $('daySheet').querySelector('.dayscope').onclick = async (ev) => {
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

  $('cal').onclick = (ev) => {
    const b = ev.target.closest('button[data-key]');
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
    if (!selectedKey) return;
    await GW.store.setPlan(selectedKey, null);
    render();
  };
  $('clearPlans').onclick = async () => {
    await GW.store.clearPlans(viewMonth);
    selectedKey = null;
    render();
  };

  // 확장은 읽기 전용이다. 신청서 작성은 그룹웨어 화면에서 하도록 이동만 시킨다.
  // 이미 열려 있는 gw.goorm.io 탭이 있으면 그 탭을 재사용한다.
  const openScreen = (code) => openUrl(GW.screens.url(code));

  // 어느 탭으로 갈지. 지금 창의 활성 탭이 1순위다. tabs.query 는 결재 팝업 같은
  // 창의 탭도 돌려주므로, 그냥 첫 번째를 집으면 엉뚱한 창을 움직이게 된다.
  async function pickTab() {
    const match = { url: 'https://gw.goorm.io/*' };
    const [active] = await chrome.tabs.query(Object.assign({ active: true, currentWindow: true }, match));
    if (active) return active;
    const tabs = await chrome.tabs.query(match);
    for (const t of tabs) {
      try { if ((await chrome.windows.get(t.windowId)).type === 'normal') return t; } catch (_) {}
    }
    return tabs[0] || null;
  }

  async function openUrl(url) {
    const tab = await pickTab();
    if (!tab) {
      await chrome.tabs.create({ url });
      return;
    }
    await chrome.tabs.update(tab.id, { url, active: true });
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  }
  document.querySelector('.links').onclick = async (ev) => {
    const b = ev.target.closest('[data-open]');
    if (!b) return;
    await openScreen(GW.screens[b.dataset.open]);
    window.close();
  };

  // ── 휴가 신청 ────────────────────────────────────────────────────────
  //
  // calculateApplicationDays → validateNew → 확인 → 0hr00011 → create → 결재 팝업.
  // 상신은 하지 않는다. 결재 화면을 열어 주고 사용자가 거기서 직접 누른다.
  //
  // 결재 팝업의 approkey 는 우리가 만들어 create 에 함께 보낸다(leave.js 참고).
  let lvState = null;
  const lv = (id) => document.getElementById(id);
  const hm = (v) => `${v.slice(0, 2)}:${v.slice(2)}`;

  function lvSyncType() {
    const t = GW.leave.TYPES[lv('lvType').value];
    lv('lvStart').value = hm(t.defStart);
    lvSyncSpan();
  }
  function lvSyncSpan() {
    const tk = lv('lvType').value;
    const sp = GW.leave.span(tk, { startTm: lv('lvStart').value });
    lv('lvSpan').textContent = `구간 ${hm(sp.start)}~${hm(sp.end)} · 휴가 ${sp.hours}시간`;
    lv('lvPreview').hidden = true; lv('lvActions').hidden = true; lvState = null;
  }

  async function lvPreview() {
    const tk = lv('lvType').value, dk = lv('lvDate').value;
    if (!dk) { lv('lvMsg').textContent = '날짜를 선택해 주세요.'; return; }
    lv('lvNext').disabled = true; lv('lvMsg').textContent = '확인 중…';
    try {
      const opts = { startTm: lv('lvStart').value };
      const pv = await GW.leave.preview(tk, dk, opts);
      const sched = await GW.leave.profile();
      const val = await GW.leave.validate(pv, sched);
      lvState = { pv, sched };
      lv('lvPreview').hidden = false;
      lv('lvPreview').innerHTML =
        `<div class="r"><span>제목</span><b>${esc(GW.leave.title(pv))}</b></div>`
        + `<div class="r"><span>구간</span><b>${hm(pv.span.start)}~${hm(pv.span.end)}</b></div>`
        + `<div class="r"><span>인정 시간</span><b>${T.fmtDuration(pv.appTm)}</b></div>`
        + `<div class="r"><span>연차 차감</span><b>${pv.ycUseCnt}일</b></div>`
        + (val.ok ? '' : `<div class="warn">⚠ ${esc(val.problems.join(', '))}</div>`);
      lv('lvActions').hidden = false;
      lv('lvSubmit').disabled = !val.ok;
      lv('lvMsg').textContent = val.ok
        ? '신청서를 만들고 결재 화면을 새 탭으로 엽니다. 상신은 그 화면에서 누르세요.'
        : '검증 경고로 진행할 수 없습니다.';
    } catch (e) { lv('lvMsg').textContent = e.message || '확인 실패'; }
    finally { lv('lvNext').disabled = false; }
  }

  async function lvSubmit() {
    if (!lvState) return;
    lv('lvSubmit').disabled = true; lv('lvMsg').textContent = '신청서 만드는 중…';
    try {
      const r = await GW.leave.submit(lvState.pv, lvState.sched);
      // 결재 화면이 본문을 못 불러오는 경우를 대비해 응답을 남긴다.
      // 팝업의 "마지막 신청 결과" 에서 그대로 복사할 수 있다.
      await chrome.storage.local.set({
        lastLeave: { at: Date.now(), title: r.titleDc, appSq: r.appSq, appDt: r.appDt,
                     coCd: r.coCd, approKey: r.approKey, linkKey: r.linkKey,
                     url: r.approvalHash },
      });
      await chrome.tabs.create({ url: GW.screens.ORIGIN + '/' + r.approvalHash });
      window.close();
    } catch (e) {
      lv('lvMsg').textContent = '실패: ' + (e.message || '');
      lv('lvSubmit').disabled = false;
    }
  }

  async function lvShowLast() {
    let last;
    try { ({ lastLeave: last } = await chrome.storage.local.get('lastLeave')); } catch (_) {}
    lv('lvLast').hidden = !last;
    if (last) lv('lvLastBody').textContent = JSON.stringify(last, null, 1);
  }

  lv('lvOpen').onclick = () => {
    lv('leaveSheet').hidden = false;
    lv('lvDate').value = T.toKey(new Date());
    lvSyncType();
    lv('lvMsg').textContent = '';
    lvShowLast();
  };
  lv('lvType').onchange = lvSyncType;
  lv('lvStart').onchange = lvSyncSpan;
  lv('lvNext').onclick = lvPreview;
  lv('lvSubmit').onclick = lvSubmit;
  lv('lvBack').onclick = () => { lv('lvPreview').hidden = true; lv('lvActions').hidden = true; lvState = null; };
  lv('lvClose').onclick = () => { lv('leaveSheet').hidden = true; };
  lv('leaveSheet').onclick = (e) => { if (e.target === lv('leaveSheet')) lv('leaveSheet').hidden = true; };

  // ── 자율휴게 신청 ────────────────────────────────────────────────────
  //
  // 휴가와 같은 흐름이다 (lib/break.js). 다른 점은 셋뿐이다 —
  // validateNew 를 부르지 않고, 연차를 쓰지 않고, 사유(appRmkDc)가 들어간다.
  let brState = null;

  function brSyncSpan() {
    const sp = GW.break.span(lv('brStart').value, Number(lv('brMin').value));
    lv('brSpan').textContent = lv('brStart').value
      ? `구간 ${hm(sp.start)}~${hm(sp.end)} · ${sp.minutes}분`
      : '시작 시각을 입력해 주세요.';
    lv('brPreview').hidden = true; lv('brActions').hidden = true; brState = null;
  }

  async function brPreview() {
    const dk = lv('brDate').value;
    const st = lv('brStart').value;
    if (!dk || !st) { lv('brMsg').textContent = '날짜와 시작 시각을 입력해 주세요.'; return; }
    lv('brNext').disabled = true; lv('brMsg').textContent = '확인 중…';
    try {
      const pv = await GW.break.preview(dk, st, Number(lv('brMin').value), lv('brReason').value.trim());
      const sched = await GW.leave.profile();
      brState = { pv, sched };
      lv('brPreview').hidden = false;
      lv('brPreview').innerHTML =
        `<div class="r"><span>날짜</span><b>${esc(T.label(T.fromKey(pv.dateKey)))}</b></div>`
        + `<div class="r"><span>시간</span><b>${hm(pv.span.start)} ~ ${hm(pv.span.end)}</b></div>`
        + `<div class="r"><span>인정 시간</span><b>${T.fmtDuration(pv.appTm)}</b></div>`
        + `<div class="r"><span>사유</span><b>${esc(pv.reason) || '<span style="opacity:.5">없음</span>'}</b></div>`;
      lv('brActions').hidden = false;
      lv('brMsg').textContent = '신청서를 만들고 결재 화면을 엽니다. 상신은 그 화면에서 누르세요.';
    } catch (e) { lv('brMsg').textContent = e.message || '확인 실패'; }
    finally { lv('brNext').disabled = false; }
  }

  async function brSubmit() {
    if (!brState) return;
    lv('brSubmit').disabled = true; lv('brMsg').textContent = '신청서 만드는 중…';
    try {
      const r = await GW.break.submit(brState.pv, brState.sched);
      await chrome.storage.local.set({
        lastLeave: { at: Date.now(), kind: '휴게', title: r.titleDc, appSq: r.appSq,
                     appDt: r.appDt, coCd: r.coCd, approKey: r.approKey,
                     linkKey: r.linkKey, url: r.approvalHash },
      });
      await chrome.tabs.create({ url: GW.screens.ORIGIN + '/' + r.approvalHash });
      window.close();
    } catch (e) {
      lv('brMsg').textContent = '실패: ' + (e.message || '');
      lv('brSubmit').disabled = false;
    }
  }

  lv('brOpen').onclick = () => {
    lv('breakSheet').hidden = false;
    lv('brDate').value = T.toKey(new Date());
    const now = new Date();
    lv('brStart').value = `${String(now.getHours()).padStart(2, '0')}:00`;
    lv('brMsg').textContent = '';
    brSyncSpan();
  };
  lv('brStart').onchange = brSyncSpan;
  lv('brMin').onchange = brSyncSpan;
  lv('brNext').onclick = brPreview;
  lv('brSubmit').onclick = brSubmit;
  lv('brBack').onclick = () => { lv('brPreview').hidden = true; lv('brActions').hidden = true; brState = null; };
  lv('brClose').onclick = () => { lv('breakSheet').hidden = true; };
  lv('breakSheet').onclick = (e) => { if (e.target === lv('breakSheet')) lv('breakSheet').hidden = true; };

  $('prevM').onclick = () => { viewMonth = shiftMonth(viewMonth, -1); selectedKey = null; load(); };
  $('nextM').onclick = () => { viewMonth = shiftMonth(viewMonth, 1); selectedKey = null; load(); };
  // 새로고침은 근태 데이터와 버전 확인을 같이 강제한다. TTL 때문에 새 버전이
  // 안 보일 때 사용자가 직접 확인할 수 있는 유일한 통로다.
  $('refresh').onclick = () => { load({ useCache: false }); checkUpdate(true); };

  // 페이지 패널 위치. 고르는 즉시 저장하고, 열려 있는 gw 탭에도 바로 반영된다
  // (content.js 가 storage.onChanged 를 듣는다).
  function paintCorners(corner) {
    for (const b of $('corners').querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.corner === (corner || 'br'));
    }
  }
  // 패널을 끄면 위치 선택기도 의미가 없다. 같이 흐린다.
  function paintPanelToggle(hidden) {
    $('showPanel').checked = !hidden;
    $('corners').style.opacity = hidden ? '.4' : '';
    $('corners').style.pointerEvents = hidden ? 'none' : '';
  }
  $('showPanel').onchange = async () => {
    const hidden = !$('showPanel').checked;
    paintPanelToggle(hidden);
    await GW.store.setSettings({ panelHidden: hidden });
  };

  $('panelBubble').onchange = async () => {
    await GW.store.setSettings({ panelBubble: $('panelBubble').checked });
  };

  // 모서리를 고르면 드래그로 옮긴 좌표는 버린다 (둘이 싸우지 않게).
  $('corners').onclick = async (ev) => {
    const b = ev.target.closest('[data-corner]');
    if (!b) return;
    paintCorners(b.dataset.corner);
    await GW.store.setSettings({ panelCorner: b.dataset.corner, panelPos: null });
  };

  $('save').onclick = async () => {
    await GW.store.setSettings({
      dailyMinutes: Math.round(Number($('daily').value || 8) * 60),
      minFlexMinutes: Math.round(Number($('minFlex').value || 6) * 60),
      breakMinutes: Math.round(Number($('breakMin').value || 0)),
      holidayAdd: parseDates($('holAdd').value),
      holidayRemove: parseDates($('holRemove').value),
    });
    $('saved').textContent = '저장했습니다';
    setTimeout(() => ($('saved').textContent = ''), 1500);
    render();
  };


  // ── 근무시간 공유 (우리 팀 · 친구) ────────────────────────────────────
  //
  // 두 가지가 한 화면에 탭으로 있다. 서버는 둘을 구분하지 않는다 —
  // 어느 쪽이든 "주소 + 열쇠" 한 쌍일 뿐이다.
  //
  //   우리 팀 : 그룹웨어 부서에서 주소가 나온다. 고를 수 있는 게 없다.
  //   친구    : 무작위 코드에서 주소가 나온다. 코드를 주고받은 사람끼리 모인다.
  //             코드가 60비트 무작위라 부서명과 달리 맞혀 볼 수 없다.
  //
  // 자리(selfId)는 사번에서 만든다 — 기기마다 새로 만들면 확장과 웹앱에서 각각
  // 한 줄씩 생기고 다시 켤 때마다 유령이 쌓인다.
  let tmTab = 'team';
  let teamCfg = null;      // { teamName, myName, on, selfId, writeKey }
  let frCfg = null;        // { rooms: [{ code, label, on }], active, myName, selfId, writeKey }
  let mySelf = null;       // { selfId, writeKey } — 사번에서 만든 내 자리
  let lastPush = { team: 0, friend: 0 };

  const tmMsg = (t, bad) => {
    $('tmMsg').textContent = t || '';
    $('tmMsg').className = 'lvmsg' + (bad ? '' : ' ok');
  };
  const cfgOf = () => (tmTab === 'team' ? teamCfg : frCfg);
  // 친구 탭에서 지금 보고 있는 방
  const activeRoom = () =>
    (frCfg && (frCfg.rooms || []).find((r) => r.code === frCfg.active)) || null;
  // 공유 체크박스가 가리키는 대상: 우리 팀은 팀 설정, 친구는 "이 방"
  const shareTarget = () => (tmTab === 'team' ? teamCfg : activeRoom());

  // 부서·사번은 그룹웨어가 알려 준다. 콘텐츠 스크립트가 캐시해 둔 값이다.
  const tmIdentity = () => GW.api.wehagoIdentity().catch(() => null);

  async function tmSelf(id, cfg) {
    if (id && id.compSeq && id.empSeq) {
      if (!mySelf) mySelf = await GW.team.selfFrom(id.compSeq, id.empSeq);
      return mySelf;
    }
    // 사번을 못 읽었을 때만 기기별 값으로 떨어진다.
    if (cfg && cfg.selfId) return cfg;
    return GW.team.newSelf();
  }

  // 현재 탭의 주소. 우리 팀은 부서에서, 친구는 코드에서 나온다.
  async function tmIds() {
    if (tmTab === 'friend') {
      const r = activeRoom();
      return r ? GW.team.room(r.code) : null;
    }
    const id = await tmIdentity();
    if (!id || !id.compSeq || !id.deptSeq) {
      throw new Error('부서 정보를 찾지 못했습니다. gw.goorm.io 탭을 한 번 열었다가 다시 시도해 주세요.');
    }
    return GW.team.derive(id);
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
        const on = ['frchip'];
        if (r.code === frCfg.active) on.push('on');
        if (r.on) on.push('live');
        return `<button type="button" class="${on.join(' ')}" data-code="${esc(r.code)}">`
          + `${esc(r.label || GW.team.pretty(r.code))}</button>`;
      }).join('');
    }
    const t = shareTarget();
    $('tmOn').checked = !!(t && t.on);
  }

  async function tmOpenSheet() {
    $('teamSheet').hidden = false;
    tmMsg('');
    teamCfg = await GW.store.getTeam();
    // 예전 판본은 방을 하나만 들고 있었다. 목록 구조로 옮겨 담는다.
    frCfg = GW.team.migrateRooms(await GW.store.getFriends());
    tmPaintTabs();
    await tmRefresh();
  }

  async function tmPayload(id) {
    const settings = await GW.store.getSettings();
    const plans = await GW.store.getPlans();
    const now = new Date();
    const s = GW.calc.summarize(
      { rows: state.rows, leaves: state.leaves, plans, holidays: state.holidays },
      settings, T.monthKey(now), now);
    const plan = GW.calc.todayPlan(s, settings, state.live, now);
    return GW.team.summarize(s, plan, {
      name: (cfgOf() || {}).myName, dept: (id && id.deptName) || '',
    });
  }

  // 화면을 새로 그릴 때마다 부른다. 자주 불려도 2분에 한 번만 올린다.
  async function tmPushMaybe(force) {
    const cfg = cfgOf();
    const t = shareTarget();
    if (!cfg || !t || !t.on || !cfg.myName || !state.rows.length) return;
    if (!force && Date.now() - lastPush[tmTab] < 2 * 60 * 1000) return;
    lastPush[tmTab] = Date.now();
    try {
      const ids = await tmIds();
      if (!ids) return;
      const id = await tmIdentity();
      await GW.team.ensure(ids, tmTab === 'team' ? ids.root || cfg.teamName : '친구');
      await GW.team.publish(ids, await tmSelf(id, cfg), await tmPayload(id));
    } catch (_) { /* 공유가 안 돼도 본 기능은 막지 않는다 */ }
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
      const id = await tmIdentity();
      let nm = '친구';
      if (tmTab === 'team') {
        // 묶인 이름(뿌리)을 제목으로 쓴다 — "SRE팀"·"SRE 1파트" 가 한 방이므로
        // 어느 한쪽 이름을 걸면 다른 쪽 사람이 "여긴 내 팀이 아닌데" 로 읽는다.
        nm = ids.root || (id && id.deptName) || (cfg && cfg.teamName) || '우리 팀';
        if (cfg && cfg.teamName !== nm) teamCfg = await GW.store.setTeam({ ...cfg, teamName: nm });
      } else {
        const r = activeRoom();
        nm = r.label || GW.team.pretty(r.code);
      }
      $('tmTitle').textContent = nm;
      $('tmTitle').className = tmTab === 'friend' ? 'frcode' : '';
      await GW.team.ensure(ids, tmTab === 'team' ? nm : '친구');
      const t = shareTarget();
      if (t && t.on && cfg.myName && state.rows.length) {
        lastPush[tmTab] = Date.now();
        await GW.team.publish(ids, await tmSelf(id, cfg), await tmPayload(id));
      }
      tmRenderList((await GW.team.fetchTeam(ids)).members || [], await tmSelf(id, cfg));
    } catch (e) {
      $('tmList').innerHTML = `<div class="dbad">${esc(e.message)}</div>`;
    }
  }

  // "언제 퇴근하냐" 가 핵심이다. 그 값을 오른쪽에 크게 두고 나머지는 작게.
  function tmRenderList(members, self) {
    // 예전 판본이 기기마다 자리를 새로 만들어서 같은 사람이 여러 줄로 남아 있을 수
    // 있다. 이름이 같으면 가장 최근 것만 남긴다 — 서버가 정리할 때까지의 안전장치.
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
      // 어제 올린 값을 오늘 퇴근 시각처럼 보여주면 안 된다. 날짜가 바뀌었으면 접는다.
      const fresh = T.toKey(new Date(m.at)) === today;
      let right = '<i class="tmstale">오늘 기록 없음</i>';
      if (m.leaveNm && !m.outAt) right = `<i class="tmleave">${esc(m.leaveNm)}</i>`;
      else if (fresh && m.outAt) {
        right = m.leftMin != null && m.leftMin <= 0
          ? `<b class="tmout done">${esc(m.outAt)}</b><i>퇴근</i>`
          : `<b class="tmout">${esc(m.outAt)}</b><i>${
              m.leftMin != null ? `${T.fmtDuration(m.leftMin)} 남음` : ''}</i>`;
      }
      // 한 줄에 들어가야 줄마다 높이가 같다. 여기서는 "5:22" 꼴로 짧게 쓴다.
      const sub = [
        fresh && m.inAt ? `출근 ${esc(m.inAt)}` : null,
        fresh && m.workedMin != null ? `경과 ${short(m.workedMin)}` : null,
        m.monthLeftMin == null ? null
          : m.monthLeftMin <= 0 ? '이달 충족' : `이달 ${short(m.monthLeftMin)}`,
      ].filter(Boolean).join(' · ');
      // 부서는 이름 옆에 둔다. 아래 줄에 붙이면 "이달 …" 이 밀려 잘린다.
      // 제목과 같은 부서면 군더더기라 뺀다.
      const dept = m.dept && m.dept !== $('tmTitle').textContent ? `<i>${esc(m.dept)}</i>` : '';
      return `<div class="tmrow${m.id === myId ? ' me' : ''}">
          <span class="tmwho">
            <span class="tmnm"><b>${esc(m.name)}</b>${dept}</span>
            ${sub ? `<em>${sub}</em>` : ''}</span>
          <span class="tmright">${right}</span>
        </div>`;
    }).join('');
  }

  $('tmOpen').onclick = tmOpenSheet;
  $('tmClose').onclick = () => { $('teamSheet').hidden = true; };
  $('teamSheet').onclick = (e) => { if (e.target === $('teamSheet')) $('teamSheet').hidden = true; };

  $('tmTabs').onclick = async (ev) => {
    const b = ev.target.closest('[data-tab]');
    if (!b || b.dataset.tab === tmTab) return;
    tmTab = b.dataset.tab;
    tmMsg('');
    tmPaintTabs();
    await tmRefresh();
  };

  // 공유를 켤 때만 자리를 만든다. 켜지 않으면 아무것도 올라가지 않는다.
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
      // 끄면 올려 둔 값도 지운다. "껐는데 어제 값이 남아 있다" 가 없게.
      try {
        const ids = await tmIds();
        if (ids) await GW.team.withdraw(ids, await tmSelf(await tmIdentity(), cfg));
      } catch (_) {}
      await setOn(false);
      $('tmNameWrap').hidden = true;
      tmMsg('공유를 껐습니다. 올려 둔 내 기록도 지웠습니다.');
      return tmRefresh();
    }
    let id;
    try {
      id = await tmIdentity();
      if (!(await tmIds())) throw new Error('먼저 코드를 만들거나 참여해 주세요.');
    } catch (e) { $('tmOn').checked = false; return tmMsg(e.message, true); }
    // 이름은 그룹웨어 응답 구조가 버전마다 달라 못 읽는 경우가 있다.
    // 그때만 직접 넣게 한다 — 팀도 방도 고를 수는 없다.
    const myName = (id && id.name) || (cfg && cfg.myName)
      || (teamCfg && teamCfg.myName) || (frCfg && frCfg.myName) || ($('tmName').value || '').trim();
    if (!myName) {
      $('tmNameWrap').hidden = false;
      $('tmName').focus();
      $('tmOn').checked = false;
      return tmMsg('표시 이름을 넣고 다시 켜 주세요.', true);
    }
    $('tmNameWrap').hidden = true;
    if (tmTab === 'team') {
      const base = teamCfg || (id && id.compSeq && id.empSeq ? {} : GW.team.newSelf());
      await save({ ...base, teamName: (teamCfg && teamCfg.teamName) || '우리 팀', myName, on: true });
    } else {
      await save({ ...frCfg, myName });
      await setOn(true);
    }
    tmMsg('공유를 켰습니다.');
    await tmPushMaybe(true);
    tmRefresh();
  };

  // ── 친구 방 ──────────────────────────────────────────────────────────
  //
  // 방은 여러 개 만들 수 있다 (점심팟 · 스터디 …). 각 방은 따로 켜고 끈다 —
  // 켜 둔 방마다 내 근무시간이 올라간다. 목록에서 하나를 골라 그 방을 본다.
  $('frNew').onclick = async () => {
    // 서버에 자리를 먼저 잡고, 성공한 뒤에만 목록에 넣는다.
    // 거절당했는데 "만들었습니다" 라고 해 두면 없는 방이 칩으로 남는다.
    const code = GW.team.newCode();
    $('frNew').disabled = true;
    tmMsg('만드는 중…');
    try {
      await GW.team.ensure(await GW.team.room(code), '친구');
    } catch (e) {
      $('frNew').disabled = false;
      return tmMsg(e.message, true);
    }
    $('frNew').disabled = false;
    frCfg = await GW.store.setFriends({
      ...frCfg, rooms: [...(frCfg.rooms || []), { code, label: '', on: false }], active: code,
    });
    tmPaintTabs();
    tmMsg('방을 만들었습니다. 코드를 복사해 보내세요.');
    await tmRefresh();
  };

  $('frAdd').onclick = () => {
    // 이미 방이 있어도 새로 만들거나 참여할 수 있게 입력칸을 다시 연다.
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
      const data = await GW.team.fetchTeam(await GW.team.room(code));   // 없는 방이면 여기서 걸린다
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
    try {
      await GW.team.withdraw(await GW.team.room(r.code), await tmSelf(await tmIdentity(), frCfg));
    } catch (_) {}
    const rooms = (frCfg.rooms || []).filter((x) => x.code !== r.code);
    frCfg = await GW.store.setFriends({ ...frCfg, rooms, active: rooms.length ? rooms[0].code : null });
    tmPaintTabs();
    tmMsg('방에서 나왔습니다. 올려 둔 내 기록도 지웠습니다.');
    await tmRefresh();
  };

  // 업데이트 안내. VERSION_URL 이 비어 있으면 check() 가 hasUpdate:false 로 돌아온다.
  async function checkUpdate(force) {
    let info;
    try { info = await GW.updater.check(force); } catch (_) { return; }
    if (!info.hasUpdate || await GW.updater.dismissed(info.latest)) return;
    const bar = $('updateBar');
    bar.innerHTML = `새 버전 <b>v${esc(info.latest)}</b> 이 있습니다 `
      + `<a href="${esc(info.url)}" target="_blank" rel="noreferrer">받기</a>`
      + '<button title="닫기">×</button>';
    bar.querySelector('button').onclick = async () => {
      await GW.updater.dismiss(info.latest);
      bar.hidden = true;
    };
    bar.hidden = false;
  }

  load().then(async () => {
    teamCfg = await GW.store.getTeam().catch(() => null);
    tmPushMaybe(true);
  });
  checkUpdate();
  // 팝업은 열 때마다 새로 조회하므로 자동 재조회는 없다.
  // 다만 열어둔 동안 경과 시간이 낡지 않도록 다시 그리기만 한다 (서버 호출 없음).
  setInterval(render, 30 * 1000);
})();
