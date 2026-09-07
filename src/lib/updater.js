// 자동 업데이트 확인. 압축해제 확장은 스토어 자동갱신이 없으므로,
// GitHub 최신 릴리스의 태그와 manifest 버전을 비교해 새 버전을 안내한다.
// (설치는 사용자가 직접 — .zip 을 받아 chrome://extensions 에서 교체)
(function (root) {
  const GW = (root.GW = root.GW || {});
  const REPO = 'goorm-dev/sre-amaranth-extension';
  const API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const CHECK_TTL = 6 * 60 * 60 * 1000;   // 6시간에 한 번만 확인

  function parseVer(v) {
    return String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  }
  // a < b 이면 -1
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
    let cache = {};
    try { cache = (await chrome.storage.local.get('updateCheck')).updateCheck || {}; } catch (_) {}

    if (!force && cache.at && Date.now() - cache.at < CHECK_TTL) {
      return decorate(cache, current);
    }
    try {
      const res = await fetch(API, { headers: { 'Accept': 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(String(res.status));
      const rel = await res.json();
      const info = {
        at: Date.now(),
        latest: (rel.tag_name || '').replace(/^v/, ''),
        url: rel.html_url,
        asset: (rel.assets || []).find((a) => a.name.endsWith('.zip'))?.browser_download_url || rel.html_url,
        notes: (rel.body || '').slice(0, 500),
      };
      try { await chrome.storage.local.set({ updateCheck: info }); } catch (_) {}
      return decorate(info, current);
    } catch (_) {
      return decorate(cache, current);   // 실패 시 캐시(있으면)로
    }
  }

  function decorate(info, current) {
    if (!info || !info.latest) return { current, hasUpdate: false };
    return {
      current,
      latest: info.latest,
      url: info.url,
      asset: info.asset,
      notes: info.notes,
      hasUpdate: cmp(current, info.latest) < 0,
    };
  }

  async function dismissed(latest) {
    try { return (await chrome.storage.local.get('updateDismissed')).updateDismissed === latest; }
    catch (_) { return false; }
  }
  async function dismiss(latest) {
    try { await chrome.storage.local.set({ updateDismissed: latest }); } catch (_) {}
  }

  GW.updater = { check, dismiss, dismissed, cmp };
})(typeof window !== 'undefined' ? window : globalThis);
