// 업데이트 확인.
//
// 저장소의 latest.json 에서 최신 버전만 읽는다. 설치는 확장이 하지 않는다 —
// 압축해제 로드 방식이라 자동 설치가 불가능하고, 릴리스 페이지 링크만 띄운다.
//
// GitHub API 가 아니라 raw 파일을 쓴다. API 는 인증 없이 rate limit 이 빡세고
// (시간당 60회/IP), raw 는 그런 제한이 사실상 없다. 응답도 우리가 만든 두 줄이다.
(function (root) {
  const GW = (root.GW = root.GW || {});
  const RELEASES_URL = 'https://github.com/goorm-dev/sre-amaranth-extension/releases/latest';
  const VERSION_URL = 'https://raw.githubusercontent.com/goorm-dev/sre-amaranth-extension/main/latest.json';
  const CHECK_TTL = 6 * 60 * 60 * 1000;

  const parseVer = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  function cmp(a, b) {
    const x = parseVer(a); const y = parseVer(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  async function check(force) {
    const current = chrome.runtime.getManifest().version;
    const base = { current, releasesUrl: RELEASES_URL, hasUpdate: false };
    if (!VERSION_URL) return base;   // 버전 파일이 설정되지 않으면 확인을 건너뛴다

    let cache = {};
    try { cache = (await chrome.storage.local.get('updateCheck')).updateCheck || {}; } catch (_) {}
    if (!force && cache.at && Date.now() - cache.at < CHECK_TTL) return decorate(cache, base);

    try {
      const res = await fetch(`${VERSION_URL}?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();   // { version: "1.1.0", url?: "..." }
      const info = { at: Date.now(), latest: String(j.version || '').replace(/^v/, ''), url: j.url || RELEASES_URL };
      try { await chrome.storage.local.set({ updateCheck: info }); } catch (_) {}
      return decorate(info, base);
    } catch (_) {
      return decorate(cache, base);
    }
  }

  function decorate(info, base) {
    if (!info || !info.latest) return base;
    return Object.assign({}, base, {
      latest: info.latest,
      url: info.url || RELEASES_URL,
      hasUpdate: cmp(base.current, info.latest) < 0,
    });
  }

  async function dismissed(latest) {
    try { return (await chrome.storage.local.get('updateDismissed')).updateDismissed === latest; }
    catch (_) { return false; }
  }
  async function dismiss(latest) {
    try { await chrome.storage.local.set({ updateDismissed: latest }); } catch (_) {}
  }

  GW.updater = { check, dismiss, dismissed, cmp, RELEASES_URL };
})(typeof window !== 'undefined' ? window : globalThis);
