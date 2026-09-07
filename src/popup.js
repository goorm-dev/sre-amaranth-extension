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
        value = short(r.netWorkedMin + r.creditMin);
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
      if (r.extraBreakMin > 0) cls.push('brk');
      if (key === s.todayKey) cls.push('today');
      if (key === selectedKey) cls.push('sel');

      const tip = [
        r.holidayNm || null,
        r.extraBreakMin > 0 ? `${(r.breakNames || ['휴게']).join(', ')} ${T.fmtDuration(r.extraBreakMin)} 제외` : null,
        r.leaveNames ? `${r.leaveNames.join(', ')} ${T.fmtDuration(r.creditMin)} 인정` : null,
      ].filter(Boolean).join(' · ');
      const title = tip ? ` title="${esc(tip)}"` : '';
      const disabled = !r.standardMin || past ? ' disabled' : '';
      cells.push(`<button class="${cls.join(' ')}" data-key="${key}"${disabled}${title}>` +
        `<span class="d">${d.getDate()}</span><span class="v">${value || '&nbsp;'}</span></button>`);
    }
    $('cal').innerHTML = cells.join('');
  }

  function renderEditor(s) {
    const box = $('caledit');
    if (!selectedKey) { box.hidden = true; return; }
    box.hidden = false;
    const d = T.fromKey(selectedKey);
    const r = s.rows.find((x) => x.key === selectedKey) || {};
    $('editDay').innerHTML = esc(T.label(d))
      + (r.extraBreakMin > 0 ? ` <em class="ebrk">휴게 ${esc(T.fmtDuration(r.extraBreakMin))}</em>` : '');
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
           ${plan.extraBreakMin ? `<div class="planleave brk">${plan.breakNames.join(' + ')} ${T.fmtDuration(plan.extraBreakMin)} 제외</div>` : ''}
         ${plan.singleTarget
           ? `<div class="planline hl"><span>오늘 필요 (${T.fmtDuration(plan.needMin)})</span><b>${plan.parOut}</b></div>`
           : `<div class="planline"><span>최소 (${T.fmtDuration(plan.minNeedMin)})</span><b>${plan.minOut}</b></div>
              <div class="planline hl"><span>정량 (${T.fmtDuration(plan.needMin)})</span><b>${plan.parOut}</b></div>`}`;

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
  }

  const parseDates = (t) => (t || '').split(/[,\s]+/).map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));

  $('cal').onclick = (ev) => {
    const b = ev.target.closest('button[data-key]');
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

  async function openUrl(url) {
    const [tab] = await chrome.tabs.query({ url: 'https://gw.goorm.io/*' });
    if (tab) {
      await chrome.tabs.update(tab.id, { url, active: true });
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
    } else {
      await chrome.tabs.create({ url });
    }
    window.close();
  }
  document.querySelector('.links').onclick = (ev) => {
    const b = ev.target.closest('[data-open]');
    if (b) openScreen(GW.screens[b.dataset.open]);
  };

  $('prevM').onclick = () => { viewMonth = shiftMonth(viewMonth, -1); selectedKey = null; load(); };
  $('nextM').onclick = () => { viewMonth = shiftMonth(viewMonth, 1); selectedKey = null; load(); };
  $('refresh').onclick = () => load({ useCache: false });

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

  load();
  checkUpdate();
  // 팝업은 열 때마다 새로 조회하므로 자동 재조회는 없다.
  // 다만 열어둔 동안 경과 시간이 낡지 않도록 다시 그리기만 한다 (서버 호출 없음).
  setInterval(render, 30 * 1000);
})();
