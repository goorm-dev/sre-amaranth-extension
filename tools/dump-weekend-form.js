// 휴일근무신청(결재 양식 244) 본문을 통째로 파일로 받는다.
//
// capture-weekend.js 가 localStorage(__wkcap)에 남긴 임시저장 요청(eap110A06)에서
// doc_contents 를 꺼내 풀어 쓴다. 콘솔 출력은 잘리므로 파일로 내려받는다.
//
// 쓰는 법
//   임시보관함에서 방금 임시저장한 휴일근무신청 문서를 연다. 그 **문서 창 콘솔**에 붙여 넣는다.
//   (capture-weekend.js 를 붙였던 창과 출처가 같아서 localStorage 를 같이 본다.)
//   wk-form.html, wk-form.json 두 파일이 내려받기 폴더에 생긴다.
(() => {
  let cap = [];
  try { cap = JSON.parse(localStorage.getItem('__wkcap') || '[]'); } catch (_) {}
  const parse = (s) => { try { return JSON.parse(s); } catch (_) { return null; } };
  const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };

  const saves = cap.filter((r) => /eap110A06|eap110A104/.test(r.url || ''));
  const last = saves.filter((r) => /eap110A06/.test(r.url)).pop();
  const p = last && (parse(last.body) || {}).paramItem;
  const tmp = saves.filter((r) => /eap110A104/.test(r.url)).pop();
  const req = tmp && parse((parse(tmp.body) || {}).reqJson);

  const html = dec((p && p.doc_contents) || (req && req.doc_contents) || '');

  // 양식 칸 후보 — input·select·textarea 와 id/name 이 붙은 칸. 채울 곳을 찾는 데 쓴다.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const 칸 = [...doc.querySelectorAll('input,select,textarea,[id],[name],[data-name],[contenteditable]')]
    .map((e) => ({ tag: e.tagName.toLowerCase(), id: e.id || undefined, name: e.getAttribute('name') || undefined,
      type: e.getAttribute('type') || undefined, value: e.value || e.getAttribute('value') || undefined,
      text: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined }))
    .filter((x) => x.id || x.name || x.value || x.tag !== 'div');
  const 표 = [...doc.querySelectorAll('tr')].map((tr) => [...tr.children]
    .map((td) => (td.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ')).filter(Boolean);

  const meta = {
    지금창: location.href,
    문서번호: last && parse(last.res) && parse(last.res).resultData,
    임시저장_칸: p ? Object.fromEntries(Object.entries(p).filter(([k]) => !/doc_contents|LINE|appdocLine/i.test(k))) : null,
    tmp_reqJson_키: req ? Object.keys(req) : null,
    표, 칸,
    본문길이: html.length,
  };

  const down = (name, text, type) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  if (!html) return `임시저장 기록을 못 찾았습니다 (잡힌 요청 ${cap.length}건). capture-weekend.js 를 붙였던 창에서 다시 실행해 주세요.`;
  down('wk-form.html', html, 'text/html');
  down('wk-form.json', JSON.stringify(meta, null, 1), 'application/json');
  return `내려받음 — wk-form.html(${html.length}자), wk-form.json · 표 ${표.length}줄 · 칸 ${칸.length}개`;
})();
