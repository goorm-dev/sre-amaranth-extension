// 개선 요청 보내기.
//
// 쓰는 사람이 화면에서 바로 적어 보낸다. 읽는 건 관리자뿐이다 —
// 서버가 FEEDBACK_KEY 를 가진 요청에만 목록을 준다.
//
// 보내는 값은 적은 글과 이름·부서·버전뿐이다. 누가 어떤 화면에서
// 겪었는지를 알아야 고칠 수 있어서 이름을 같이 보낸다 (화면에도 그렇게 적는다).
(function (root) {
  const GW = (root.GW = root.GW || {});
  const URL_ = 'https://worktime.goorm.io/api/feedback';

  async function send(text, who) {
    const body = String(text || '').trim();
    if (!body) throw new Error('내용을 적어 주세요.');
    let res;
    try {
      res = await fetch(URL_, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: body.slice(0, 1000),
          name: (who && who.name) || '',
          dept: (who && who.dept) || '',
          ver: (who && who.ver) || '',
        }),
      });
    } catch (_) {
      throw new Error('서버에 연결하지 못했습니다.');
    }
    let d = {};
    try { d = await res.json(); } catch (_) { /* 본문이 없을 수도 있다 */ }
    if (!res.ok) throw new Error(d.error || `보내지 못했습니다 (${res.status})`);
    return d;
  }

  GW.feedback = { send, URL: URL_ };
})(typeof window !== 'undefined' ? window : globalThis);
