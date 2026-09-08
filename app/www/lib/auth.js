// 로그인 — 아마란스 2단계 흐름 (실제 로그인 요청 캡처로 확인).
//
//   0) POST /gw/gw050B01 {host}          → groupSeq, credentialEncryptUseYn
//   1) POST /gw/gw050A02 (form)          → loginType=checkLoginId, loginId(base64)
//        아이디 존재 확인. 성공 = resultCode 200
//   2) POST /gw/gw050A02 (form)          → loginId(base64), password(base64), simpleLoginYn=Y ...
//        성공 = resultCode 200 & resultData.sessionInfo (토큰 포함)
//
// 요청은 application/x-www-form-urlencoded, 값은 Base64(UTF-8). 성공 코드는 0 이 아니라 200.
//
// credentials 는 붙이지 않는다. 웹에서 gw 세션을 이관하려고 붙여 봤지만, 우리
// 토큰은 gw 웹 세션으로 인정되지 않아 소용이 없었다(README 참고).
// credentialEncryptUseYn 이 "Y" 면 AES-128 이지만 현재 조회값은 "N".
(function (root) {
  const GW = (root.GW = root.GW || {});
  const P = '/gw/gw050A02';

  const b64utf8 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

  async function getLoginConfig() {
    const r = await GW.api.callUncert('/gw/gw050B01', { host: new URL(GW.api.ORIGIN).host });
    const d = r.json && r.json.resultData;
    if (!d) throw new Error('로그인 설정을 가져오지 못했습니다.');
    return {
      groupSeq: (d.groupMap && d.groupMap.groupSeq) || (d.jedisMp && d.jedisMp.groupSeq),
      encryptUse: d.credentialEncryptUseYn === 'Y',
    };
  }

  // sessionInfo 안에서 토큰/서명키를 찾는다 (서버 버전마다 키 이름이 조금씩 다르다).
  function pickToken(json) {
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 6) return null;
      const tok = o.auth_a_token || o.oAuthToken || o.token || o.accessToken;
      const key = o.auth_h_key || o.signKey || o.hashKey || o.hash_key;
      if (tok && key) return { token: String(tok), signKey: String(key) };
      for (const v of Object.values(o)) {
        if (v && typeof v === 'object') { const hit = walk(v, depth + 1); if (hit) return hit; }
      }
      return null;
    };
    return walk(json, 0);
  }

  function keyList(o, out, depth) {
    if (!o || typeof o !== 'object' || depth > 4) return out;
    for (const [k, v] of Object.entries(o)) {
      out.push(k);
      if (v && typeof v === 'object') keyList(v, out, depth + 1);
    }
    return out;
  }

  async function login(loginId, password) {
    const cfg = await getLoginConfig();
    if (cfg.encryptUse) throw new Error('이 서버는 자격증명 암호화(AES)를 요구합니다. 앱에 해당 경로가 아직 없습니다.');
    const groupSeq = cfg.groupSeq;
    const encId = b64utf8(loginId);

    // 1단계: 아이디 확인
    const s1 = await GW.api.callUncert(P, {
      loginId: encId, groupSeq, loginType: 'checkLoginId', apiTarget: 'web',
      langCode: 'kr', a10Domain: GW.api.ORIGIN,
    }, { form: true });
    if (!s1.json || s1.json.resultCode !== 200) {
      const err = new Error((s1.json && s1.json.resultMsg) || `아이디 확인 실패 (${s1.status})`);
      err.diag = { step: 1, code: s1.json && s1.json.resultCode };
      throw err;
    }

    // 2단계: 비밀번호 제출
    const s2 = await GW.api.callUncert(P, {
      loginId: encId, password: b64utf8(password), groupSeq,
      scLoginYn: 'N', fidoPasswdLoginYn: null, simpleLoginYn: 'Y',
      apiTarget: 'web', langCode: 'kr', a10Domain: GW.api.ORIGIN,
    }, { form: true });

    if (!s2.json || s2.json.resultCode !== 200) {
      const err = new Error((s2.json && s2.json.resultMsg) || `로그인 실패 (${s2.status})`);
      err.diag = { step: 2, code: s2.json && s2.json.resultCode };
      throw err;
    }

    const hit = pickToken(s2.json.resultData);
    if (!hit) {
      const err = new Error('로그인은 됐지만 토큰을 찾지 못했습니다.');
      err.diag = { step: 2, code: 200, keys: keyList(s2.json.resultData, [], 0).slice(0, 60) };
      throw err;
    }

    const session = Object.assign({ groupSeq, at: Date.now() }, hit);
    GW.api.setSession(session);

    // empCd/coCd — 오늘 타각 조회에 필요. 근태 행에서 확보한다.
    try {
      const today = new Date();
      const keys = [];
      for (let i = 1; i <= 45; i++) keys.push(GW.time.toKey(GW.time.addDays(today, -i)));
      const rows = await GW.api.getWorkTimeList(keys);
      const r = rows.find((x) => x.empCd && x.coCd);
      if (r) { session.empCd = r.empCd; session.coCd = r.coCd; }
    } catch (_) {}

    await GW.store.setSession(session);
    return session;
  }

  async function restore() {
    const s = await GW.store.getSession();
    if (s && s.token && s.signKey) { GW.api.setSession(s); return s; }
    return null;
  }
  async function logout() { GW.api.setSession(null); await GW.store.clearSession(); }

  GW.auth = { login, restore, logout, getLoginConfig };
})(window);
