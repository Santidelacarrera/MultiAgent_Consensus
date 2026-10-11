/**
 * Dashboard de sólo lectura. El HTML es estático (no contiene datos): pide la API key en el navegador, la guarda en
 * sessionStorage y consulta /v1/debates/recent. Todo el contenido dinámico se inserta con textContent (sin innerHTML).
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MultiAgent Consensus</title>
<style>
 :root{--bg:#0f1115;--fg:#e6e8ee;--mut:#8b93a7;--card:#171a21;--bd:#2a2f3a;--ok:#2ea043;--ko:#f85149;--wa:#d29922;--in:#58a6ff}
 @media(prefers-color-scheme:light){:root{--bg:#f6f8fa;--fg:#1f2328;--mut:#59636e;--card:#fff;--bd:#d1d9e0}}
 body{margin:0;font:14px system-ui,sans-serif;background:var(--bg);color:var(--fg)} main{max-width:1100px;margin:0 auto;padding:16px}
 h1{font-size:18px;margin:0 0 12px} .row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
 .card{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:10px 14px;min-width:120px} .card b{display:block;font-size:20px}
 table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--bd);border-radius:8px;overflow:hidden}
 th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd);font-size:13px} th{color:var(--mut);font-weight:600}
 tr.r{cursor:pointer} tr.r:hover{background:rgba(127,127,127,.1)}
 .b{padding:2px 8px;border-radius:10px;font-size:12px;color:#fff} .approved,.resolved_approved{background:var(--ok)} .rejected,.resolved_rejected,.error{background:var(--ko)}
 .escalated{background:var(--wa)} .running{background:var(--in)} .superseded{background:#6e7681}
 pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px;overflow:auto}
 input,button{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--card);color:var(--fg)}
</style></head><body><main>
<h1>MultiAgent Consensus — debates recientes</h1>
<div class="row"><input id="key" type="password" placeholder="API key (si está configurada)"><button id="go">Cargar</button><span id="msg" style="color:var(--mut)"></span></div>
<div class="row" id="stats"></div>
<table><thead><tr><th>PR</th><th>Commit</th><th>Estado</th><th>Rondas</th><th>Convergencia</th><th>Fecha</th></tr></thead><tbody id="rows"></tbody></table>
<h1 style="margin-top:16px" id="mt" hidden>Minuta</h1><pre id="minutes" hidden></pre>
<script>
const $=id=>document.getElementById(id);
const H=()=>{const k=$('key').value||sessionStorage.getItem('k')||'';return k?{'x-api-key':k}:{}};
function cell(tr,text,cls){const td=document.createElement('td');if(cls){const s=document.createElement('span');s.className='b '+cls;s.textContent=text;td.appendChild(s)}else td.textContent=text;tr.appendChild(td)}
async function load(){
  if($('key').value)sessionStorage.setItem('k',$('key').value);
  const r=await fetch('/v1/debates/recent?limit=50',{headers:H()});
  if(!r.ok){$('msg').textContent='Error '+r.status+(r.status===401?' (API key inválida)':'');return}
  $('msg').textContent='';const list=await r.json();
  const n=s=>list.filter(d=>s.includes(d.status)).length;
  const avg=list.filter(d=>d.convergence!=null);
  $('stats').replaceChildren(...[['Aprobados',n(['approved','resolved_approved'])],['Rechazados',n(['rejected','resolved_rejected'])],['Escalados',n(['escalated'])],['En curso',n(['running'])],
    ['Convergencia media',avg.length?Math.round(100*avg.reduce((a,d)=>a+d.convergence,0)/avg.length)+'%':'—']].map(([k,v])=>{const c=document.createElement('div');c.className='card';const b=document.createElement('b');b.textContent=v;c.append(b,k);return c}));
  const tb=$('rows');tb.replaceChildren();
  for(const d of list){const tr=document.createElement('tr');tr.className='r';
    cell(tr,d.repo+'#'+d.prNumber+' — '+d.title);cell(tr,d.headSha.slice(0,7));cell(tr,d.status,d.status);cell(tr,String(d.rounds));
    cell(tr,d.convergence==null?'—':Math.round(d.convergence*100)+'%');cell(tr,new Date(d.createdAt).toLocaleString());
    tr.onclick=async()=>{const m=await fetch('/v1/debates/'+d.id+'/minutes',{headers:H()});$('minutes').textContent=m.ok?await m.text():'Sin minuta disponible';$('minutes').hidden=false;$('mt').hidden=false;$('minutes').scrollIntoView()};
    tb.appendChild(tr)}
}
$('go').onclick=load;$('key').value=sessionStorage.getItem('k')||'';load();
</script></main></body></html>`;
