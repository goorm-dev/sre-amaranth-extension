// 조직도를 긁는다. 팀을 어떻게 묶을지 규칙을 실제 이름표를 보고 정하려는 것이다.
//
// 지금은 부서명에서 조직 단위 꼬리("팀"·"파트"…)를 떼어 묶고 있는데, 이건 추측이다.
// 조직도에 **상위 부서** 가 들어 있으면 이름을 건드릴 필요 없이 그걸로 묶으면 된다.
// 그게 훨씬 정확하다. 둘 중 뭐가 가능한지 보려고 원본을 그대로 꺼낸다.
//
// 쓰는 법:
//   1) gw.goorm.io 본 창 콘솔에 붙여 넣는다
//   2) 조직도를 연다 (주소록 · 임직원 조회 · 결재선 지정 등 조직 트리가 나오는 화면)
//      트리를 몇 단계 펼쳐 두면 하위 부서까지 잡힌다
//   3) __dumpOrg()
(() => {
  const cap = (window.__capO = window.__capO || []);
  const push = (r) => { cap.push(r); if (cap.length > 500) cap.shift(); };

  if (!window.__capOHooked) {
    const of = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url);
      const rec = { url, method: (init && init.method) || 'GET',
        body: init && typeof init.body === 'string' ? init.body : null };
      push(rec);
      return of.apply(this, arguments).then(async (res) => {
        rec.status = res.status;
        try { rec.res = await res.clone().text(); } catch (_) {}
        return res;
      });
    };
    const OX = window.XMLHttpRequest;
    window.XMLHttpRequest = function () {
      const x = new OX(); let rec = null;
      const open = x.open, send = x.send;
      x.open = function (m, u) { rec = { url: u, method: m }; push(rec); return open.apply(x, arguments); };
      x.send = function (b) {
        if (rec) rec.body = typeof b === 'string' ? b : null;
        x.addEventListener('loadend', () => {
          if (!rec) return;
          rec.status = x.status;
          try { rec.res = String(x.responseText); } catch (_) {}
        });
        return send.apply(x, arguments);
      };
      return x;
    };
    window.__capOHooked = true;
  }

  // 부서처럼 생긴 객체를 찾는다. 키 이름이 화면마다 달라서 후보를 넓게 잡는다.
  const NAME_K = ['deptName', 'deptNm', 'orgName', 'orgNm', 'groupName', 'name', 'text', 'title', 'label'];
  const SEQ_K = ['deptSeq', 'deptCd', 'orgSeq', 'orgCd', 'groupSeq', 'seq', 'id', 'key', 'code'];
  const UP_K = ['upperDeptSeq', 'upDeptSeq', 'parentDeptSeq', 'pDeptSeq', 'upperSeq', 'parentSeq',
    'upperOrgSeq', 'parentId', 'pId', 'upDeptCd', 'upperDeptCd', 'parent'];
  const LV_K = ['deptLevel', 'level', 'depth', 'lv', 'deptLv'];

  const pick = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '') return { k, v: o[k] }; return null; };

  function collect(o, out, depth) {
    if (!o || typeof o !== 'object' || (depth || 0) > 8) return out;
    if (Array.isArray(o)) { for (const v of o) collect(v, out, (depth || 0) + 1); return out; }
    const nm = pick(o, NAME_K);
    const sq = pick(o, SEQ_K);
    // 이름과 식별자가 같이 있고, 이름이 사람 이름처럼 짧은 것만 걸러도 부서가 대부분이다.
    if (nm && sq && typeof nm.v === 'string' && nm.v.length <= 40) {
      out.push({
        name: nm.v, nameKey: nm.k,
        seq: String(sq.v), seqKey: sq.k,
        up: (pick(o, UP_K) || {}).v, upKey: (pick(o, UP_K) || {}).k,
        level: (pick(o, LV_K) || {}).v,
        sample: o,
      });
    }
    for (const v of Object.values(o)) collect(v, out, (depth || 0) + 1);
    return out;
  }

  window.__dumpOrg = () => {
    const rows = cap.filter((r) => r.res);
    const found = [];
    const urls = new Map();
    for (const r of rows) {
      let j; try { j = JSON.parse(r.res); } catch (_) { continue; }
      const got = collect(j, [], 0);
      if (!got.length) continue;
      const u = (r.url || '').split('?')[0];
      urls.set(u, (urls.get(u) || 0) + got.length);
      for (const g of got) found.push({ ...g, url: u, body: r.body });
    }
    if (!found.length) {
      return '부서처럼 보이는 응답을 못 찾았습니다. 조직도 화면을 열고 트리를 펼친 뒤 다시 실행해 주세요.\n'
        + `잡힌 요청:\n  ${[...new Set(rows.map((r) => (r.url || '').split('?')[0]))].join('\n  ')}`;
    }

    // 같은 부서가 여러 응답에 겹쳐 나온다. 하나로 접는다.
    const byKey = new Map();
    for (const f of found) if (!byKey.has(f.seq + '|' + f.name)) byKey.set(f.seq + '|' + f.name, f);
    const uniq = [...byKey.values()];

    const srcs = [...urls.entries()].sort((a, b) => b[1] - a[1])
      .map(([u, n]) => `  ${u}  (${n}건)`).join('\n');

    // 상위 부서가 있으면 그걸로 묶는 게 이름 규칙보다 정확하다. 되는지 본다.
    const bySeq = new Map(uniq.map((d) => [d.seq, d]));
    const withUp = uniq.filter((d) => d.up != null && d.up !== '' && bySeq.has(String(d.up)));
    const tree = withUp.length
      ? uniq.map((d) => {
        const path = [];
        let cur = d, guard = 0;
        while (cur && guard++ < 10) { path.unshift(cur.name); cur = bySeq.get(String(cur.up)); }
        return `  ${d.seq.padEnd(10)} ${path.join(' > ')}`;
      }).sort().join('\n')
      : '  (상위 부서 정보가 없습니다 — 이름 규칙으로 묶어야 합니다)';

    const flat = uniq.map((d) =>
      `  ${d.seq.padEnd(10)} ${String(d.name).padEnd(24)} 상위=${d.up == null ? '-' : d.up}  단계=${d.level == null ? '-' : d.level}`
    ).sort().join('\n');

    const one = uniq[0];
    // 최상위 부서는 상위가 비어 있어서, 상위를 가진 아무 건에서 키 이름을 읽는다.
    const upKey = (uniq.find((d) => d.upKey) || {}).upKey;
    const s = [
      `[응답 출처]\n${srcs}`,
      `[쓰인 키 이름]  이름=${one.nameKey}  식별자=${one.seqKey}  상위=${upKey || '(없음)'}`,
      `[부서 ${uniq.length}건]\n${flat}`,
      `[상위 부서로 이어 본 경로]\n${tree}`,
      `[표본 한 건의 전체 필드]\n${JSON.stringify(one.sample, null, 1).slice(0, 1500)}`,
    ].join('\n\n');
    console.log(s);
    try { copy(s); } catch (_) {}
    return `부서 ${uniq.length}건 — 클립보드에 복사했습니다`;
  };

  // 조직도 응답에는 path 가 있었다. 문제는 **내 정보** 에도 있느냐다 —
  // 확장은 sessionStorage.userInfo 에서 내 부서를 읽는다. 거기에 경로가 있으면
  // API 를 새로 붙일 필요가 없다.
  window.__dumpMe = () => {
    let raw;
    try { raw = sessionStorage.getItem('userInfo'); } catch (_) { return 'sessionStorage 를 못 읽습니다'; }
    if (!raw) return 'userInfo 가 없습니다. gw 에 로그인된 탭에서 실행해 주세요.';
    let j; try { j = JSON.parse(raw); } catch (_) { return 'userInfo 가 JSON 이 아닙니다'; }

    // 부서·경로에 관련돼 보이는 키만 추린다. 이름·메일 같은 건 굳이 꺼내지 않는다.
    const WANT = /^(dept|org|comp|group|biz|parent|path|keyPath|emp(Seq|No)|.*Path.*|.*Name)$/i;
    const hits = [];
    const walk = (o, at, depth) => {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if (Array.isArray(o)) { o.forEach((v, i) => walk(v, `${at}[${i}]`, depth + 1)); return; }
      for (const [k, v] of Object.entries(o)) {
        if (v && typeof v === 'object') { walk(v, `${at}.${k}`, depth + 1); continue; }
        if (v === '' || v == null) continue;
        if (WANT.test(k) || /\|/.test(String(v)) || />/.test(String(v))) {
          hits.push(`  ${at}.${k} = ${JSON.stringify(String(v)).slice(0, 160)}`);
        }
      }
    };
    walk(j, '', 0);
    const s2 = hits.length
      ? `[userInfo 의 부서·경로 관련 값 ${hits.length}개]\n${[...new Set(hits)].join('\n')}`
      : 'userInfo 에서 부서·경로처럼 보이는 값을 못 찾았습니다.';
    console.log(s2);
    try { copy(s2); } catch (_) {}
    return '클립보드에 복사했습니다';
  };

  return '준비됨 —\n'
    + '  __dumpOrg()  조직도 화면을 열고 트리를 펼친 뒤\n'
    + '  __dumpMe()   내 userInfo 에 부서 경로가 있는지 (지금 바로 실행 가능)';
})();
