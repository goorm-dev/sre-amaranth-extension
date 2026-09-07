// 업데이트 확인.
//
// 저장소가 private 이라 확장에서 익명 GitHub API 를 호출할 수 없다(토큰을 넣으면 유출된다).
// 대신 정해둔 버전 파일(공개 raw 또는 사내 경로)에서 최신 버전만 읽고,
// 실제 다운로드/설치는 사용자가 릴리스 페이지에서 하도록 링크를 연다.
//
// VERSION_URL 은 팀 상황에 맞게 바꾼다:
//   - 저장소를 public 으로 돌리면 raw.githubusercontent.com/<repo>/main/latest.json
//   - private 유지 시 사내 정적 호스팅에 latest.json 을 올려 그 URL 을 지정
(function (root) {
  const GW = (root.GW = root.GW || {});
  const RELEASES_URL = 'https://github.com/goorm-dev/sre-amaranth-extension/releases/latest';
  const VERSION_URL = '';   // 예: 'https://raw.githubusercontent.com/goorm-dev/sre-amaranth-extension/main/latest.json'
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
