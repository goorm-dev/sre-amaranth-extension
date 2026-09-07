(()=>{const R=[];const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0};
const cls=e=>[...e.classList].slice(0,3).join('.');
const lbl=e=>(e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('title')||'').trim();
const own=e=>[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ').slice(0,40);
document.querySelectorAll('input,select,textarea,button,[role="button"],[role="combobox"],[role="tab"]').forEach(e=>{
 if(!vis(e))return;const r=e.getBoundingClientRect();
 R.push({tag:e.tagName.toLowerCase(),type:e.type||e.getAttribute('role')||'',id:e.id||'',
  cls:cls(e),label:lbl(e),val:(e.value!==undefined?String(e.value):'').slice(0,30),
  text:own(e)||e.textContent.trim().slice(0,30),x:Math.round(r.x),y:Math.round(r.y)});});
R.sort((a,b)=>a.y-b.y||a.x-b.x);
const out=['URL: '+location.href,'요소 '+R.length+'개','',
 ...R.map(o=>`${o.tag}[${o.type}] id="${o.id}" .${o.cls} label="${o.label}" val="${o.val}" text="${o.text}" @${o.x},${o.y}`)].join('\n');
copy(out);console.log(out);console.log('%c클립보드에 복사됨','color:green;font-weight:bold');})()
