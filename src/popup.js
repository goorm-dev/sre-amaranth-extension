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
    $('editDay').innerHTML = esc(T.label(d));
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

  load();
  checkUpdate();
  // 팝업은 열 때마다 새로 조회하므로 자동 재조회는 없다.
  // 다만 열어둔 동안 경과 시간이 낡지 않도록 다시 그리기만 한다 (서버 호출 없음).
  setInterval(render, 30 * 1000);
})();
