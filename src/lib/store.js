// chrome.storage.local 캐시.
//   months:   { "2026-09": { rows: [...], leaves: [...], at: 1756... } }   API 응답 캐시
//   settings: { dailyMinutes, minFlexMinutes, breakMinutes, holidayAdd[], holidayRemove[] }
//   plans:    { "2026-09-15": 360 }   날짜별 계획 근무시간(분)
//   holidays: { 2026: { value: {days, complete}, at } }   회사 휴일 (7일 캐시)
(function (root) {
  const GW = (root.GW = root.GW || {});

  const DEFAULT_SETTINGS = {
    dailyMinutes: 480,    // 하루 소정근로 8시간 (서버의 법정근로시간이 아니라 이 값을 기준으로 쓴다)
    minFlexMinutes: 360,  // 유연근무 하루 최소 6시간
    breakMinutes: 60,     // 휴게시간 (퇴근 시각 계산용)
    holidayAdd: [],       // 공휴일 표에 없는 회사 휴무일
    holidayRemove: [],    // 공휴일 표에서 빼고 근무일로 취급할 날
  };

  // 확장을 새로고침하면 기존 탭의 콘텐츠 스크립트가 고아가 되고, 이후 chrome.* 호출은
  // "Extension context invalidated" 로 터진다. 조용히 죽는 대신 명시적인 오류로 바꿔
  // 호출부가 타이머를 멈추고 안내를 띄울 수 있게 한다.
  class ContextGone extends Error {
    constructor() { super('확장이 업데이트되었습니다. 페이지를 새로고침해 주세요.'); }
  }

  function alive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  async function get(keys) {
    if (!alive()) throw new ContextGone();
    try {
      return await chrome.storage.local.get(keys);
    } catch (e) {
      throw /context invalidated/i.test(e.message || '') ? new ContextGone() : e;
    }
  }

  async function set(obj) {
    if (!alive()) throw new ContextGone();
    try {
      return await chrome.storage.local.set(obj);
    } catch (e) {
      throw /context invalidated/i.test(e.message || '') ? new ContextGone() : e;
    }
  }

  async function getSettings() {
    const { settings } = await get('settings');
    return Object.assign({}, DEFAULT_SETTINGS, settings || {});
  }

  async function setSettings(patch) {
    const next = Object.assign({}, await getSettings(), patch);
    await set({ settings: next });
    return next;
  }

  // 계획 근무시간: { "2026-09-15": 360 }  (분)
  // 회사 휴일은 거의 바뀌지 않는다. 연 단위로 캐시하고 7일마다 다시 받는다.
  const HOLIDAY_TTL = 7 * 24 * 60 * 60 * 1000;

  async function getCachedHolidays(year) {
    const { holidays } = await get('holidays');
    const hit = (holidays || {})[year];
    return hit && Date.now() - hit.at < HOLIDAY_TTL ? hit.value : null;
  }

  async function cacheHolidays(year, value) {
    const { holidays } = await get('holidays');
    const next = Object.assign({}, holidays || {});
    next[year] = { value, at: Date.now() };
    await set({ holidays: next });
  }

  async function getPlans() {
    const { plans } = await get('plans');
    return plans || {};
  }

  async function setPlan(dateKey, minutes) {
    const plans = await getPlans();
    if (minutes == null) delete plans[dateKey]; else plans[dateKey] = minutes;
    await set({ plans });
    return plans;
  }

  async function clearPlans(monthKey) {
    const plans = await getPlans();
    for (const k of Object.keys(plans)) if (!monthKey || k.startsWith(monthKey)) delete plans[k];
    await set({ plans });
    return plans;
  }

  async function getCachedMonth(monthKey) {
    const { months } = await get('months');
    return (months || {})[monthKey] || null;
  }

  async function cacheMonth(monthKey, rows, leaves) {
    const { months } = await get('months');
    const next = Object.assign({}, months || {});
    next[monthKey] = { rows, leaves: leaves || [], at: Date.now() };
    // 최근 6개월만 유지
    const keys = Object.keys(next).sort().slice(-6);
    await set({
      months: Object.fromEntries(keys.map((k) => [k, next[k]])),
    });
  }

  GW.store = {
    DEFAULT_SETTINGS, ContextGone, alive, raw: get, rawSet: set, getSettings, setSettings, getCachedMonth, cacheMonth,
    getPlans, setPlan, clearPlans, getCachedHolidays, cacheHolidays,
  };
})(typeof window !== 'undefined' ? window : globalThis);
