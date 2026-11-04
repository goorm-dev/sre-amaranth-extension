// 지금 로그인한 세션이 어느 팀으로 묶이는지 본다.
//
// 팀 공유는 세션의 조직도 경로로 팀을 정하고(src/lib/team.js 의 teamFromPath),
// `회사:팀seq` 로 팀 주소(teamId)를 만든다. 같은 팀 목록에 보이려면 teamId 가 같아야 한다.
// 그래서 안 보이는 사람과 보이는 사람이 각자 돌려서 teamId 를 견주면 원인이 나온다.
//
// 어디서 돌리든 된다. 두 곳이 서로 다른 값을 볼 수 있어서 둘 다 찍는다.
//   - gw.goorm.io 탭 콘솔      → 그 탭의 로그인 세션(sessionStorage.userInfo)
//   - 확장 팝업 콘솔(아이콘 우클릭 → 검사) → 확장이 실제로 쓰는 캐시(wehagoIdentity)
//     캐시는 gw 페이지가 열릴 때 세션에서 다시 담긴다. 세션 자체가 로그인 시점 값이라
//     조직이 바뀐 뒤 다시 로그인하지 않았으면 둘 다 예전 부서로 남는다.
(async () => {
  // src/lib/team.js 와 같다. 고칠 때는 같이 고친다.
  const split = (v) => String(v || '').split(/[|>]/).map((x) => x.trim()).filter(Boolean);
  function teamFromPath(path, pathName) {
    const seqs = split(path);
    const names = split(pathName);
    if (!seqs.length) return null;
    const n = Math.min(seqs.length, names.length);
    const s2 = seqs.slice(-n);
    const n2 = names.slice(-n);
    for (let i = n - 1; i >= 0; i--) {
      if (/팀$/.test(n2[i])) return { seq: s2[i], name: n2[i] };
    }
    return { seq: seqs[seqs.length - 1], name: n ? n2[n - 1] : '' };
  }
  const sha = async (msg) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  // src/content.js cacheWehagoIdentity 와 같은 방식으로 세션에서 꺼낸다.
  function findUc(o, d = 0) {
    if (!o || typeof o !== 'object' || d > 6) return null;
    if (o.groupSeq && o.compSeq && o.deptSeq) return o;
    for (const v of Object.values(o)) { const h = findUc(v, d + 1); if (h) return h; }
    return null;
  }
  const fromUc = (uc) => ({
    name: uc.userName || uc.korName || uc.empName || uc.name || '',
    compSeq: uc.compSeq, deptSeq: uc.deptSeq, deptName: uc.deptName,
    path: uc.deptPath || uc.path || '',
    pathName: uc.deptPathNm || (uc.ocUserInfo && uc.ocUserInfo.groupFullPathName)
      || uc.pathName || uc.empAllDeptPathName || '',
  });

  async function judge(label, id) {
    if (!id) return { 출처: label, 결과: '없음' };
    const t = teamFromPath(id.path, id.pathName)
      || (id.deptSeq ? { seq: String(id.deptSeq), name: id.deptName || '' } : null);
    const tag = t && `${id.compSeq}:${t.seq}`;
    return {
      출처: label,
      이름: id.name || '',
      부서: id.deptName || '',
      경로: id.pathName || '(없음)',
      경로번호: id.path || '(없음)',
      판정팀: t ? `${t.name} (seq ${t.seq})${/팀$/.test(t.name) ? '' : ' ← "팀" 마디가 없어 본인 부서로 묶임'}`
        : '판정 불가',
      teamId: tag ? (await sha(`worktime-team-v4:${tag}`)).slice(0, 16) : '-',
      기준시각: id.at ? new Date(id.at).toLocaleString() : '-',
    };
  }

  const out = [];
  try {
    const raw = sessionStorage.getItem('userInfo');
    const uc = raw && findUc(JSON.parse(raw));
    if (uc) out.push(await judge('gw 로그인 세션', fromUc(uc)));
  } catch (_) { /* gw 페이지가 아니면 없다 */ }
  if (globalThis.chrome?.storage?.local) {
    const { wehagoIdentity: id } = await chrome.storage.local.get('wehagoIdentity');
    out.push(await judge('확장 캐시', id));
  }
  if (!out.length) return console.warn('gw.goorm.io 탭이나 확장 팝업 콘솔에서 실행해 주세요.');

  console.table(out);
  const ids = [...new Set(out.map((o) => o.teamId).filter((x) => x && x !== '-'))];
  if (ids.length > 1) console.warn('세션과 확장 캐시의 팀이 다릅니다 — gw 페이지를 한 번 새로고침하면 캐시가 세션 값으로 바뀝니다.');
  const s = JSON.stringify(out, null, 2);
  try { copy(s); } catch (_) {}
  return '클립보드에 복사했어요. 팀 목록에 보이는 사람의 결과와 teamId 를 견줘 보세요.';
})();
