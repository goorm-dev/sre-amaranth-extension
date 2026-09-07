// Capacitor Preferences 기반 저장소. 확장의 chrome.storage.local 자리를 대신한다.
// 인터페이스는 확장과 같게 유지해서 calc.js 가 그대로 돌아가게 한다.
(function (root) {
  const GW = (root.GW = root.GW || {});
  const P = () => root.Capacitor.Plugins.Preferences;

  const DEFAULT_SETTINGS = {
    dailyMinutes: 480,
    minFlexMinutes: 360,
    breakMinutes: 60,
    holidayAdd: [],
    holidayRemove: [],
  };

  async function get(key) {
    const { value } = await P().get({ key });
    if (value == null) return undefined;
    try { return JSON.parse(value); } catch (_) { return undefined; }
  }
  async function set(key, value) {
    await P().set({ key, value: JSON.stringify(value) });
  }
  async function remove(key) {
    await P().remove({ key });
  }

  async function getSettings() {
    return Object.assign({}, DEFAULT_SETTINGS, (await get('settings')) || {});
  }
  async function setSettings(patch) {
    const next = Object.assign({}, await getSettings(), patch);
    await set('settings', next);
    return next;
  }

  const HOLIDAY_TTL = 7 * 24 * 60 * 60 * 1000;
  async function getCachedHolidays(year) {
    const all = (await get('holidays')) || {};
    const hit = all[year];
    return hit && Date.now() - hit.at < HOLIDAY_TTL ? hit.value : null;
  }
  async function cacheHolidays(year, value) {
    const all = (await get('holidays')) || {};
    all[year] = { value, at: Date.now() };
    await set('holidays', all);
  }

  async function getCachedMonth(monthKey) {
    return ((await get('months')) || {})[monthKey] || null;
  }
  async function cacheMonth(monthKey, rows, leaves) {
    const all = (await get('months')) || {};
    all[monthKey] = { rows, leaves: leaves || [], at: Date.now() };
    const keep = Object.keys(all).sort().slice(-4);
    await set('months', Object.fromEntries(keep.map((k) => [k, all[k]])));
  }

  async function getPlans() { return (await get('plans')) || {}; }
  async function setPlan(dateKey, minutes) {
    const plans = await getPlans();
    if (minutes == null) delete plans[dateKey]; else plans[dateKey] = minutes;
    await set('plans', plans);
    return plans;
  }
  async function clearPlans(monthKey) {
    const plans = await getPlans();
    for (const k of Object.keys(plans)) if (!monthKey || k.startsWith(monthKey)) delete plans[k];
    await set('plans', plans);
    return plans;
  }

  // 세션. 확장은 브라우저 쿠키에서 읽지만 앱은 직접 로그인해 받아 보관한다.
  async function getSession() { return (await get('session')) || null; }
  async function setSession(s) { await set('session', s); }
  async function clearSession() { await remove('session'); }

  GW.store = {
    DEFAULT_SETTINGS, getSettings, setSettings,
    getCachedHolidays, cacheHolidays, getCachedMonth, cacheMonth,
    getPlans, setPlan, clearPlans,
    getSession, setSession, clearSession,
    raw: get, rawSet: set,
  };
})(window);
