import {MAX_FILE,MAX_BATCH,SUPPORTED} from './engine.js';
const $=id=>document.getElementById(id);
const icon=id=>`<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const human=n=>n<1024?n+' B':n<1024*1024?(n/1024).toFixed(1)+' KB':(n/1024/1024).toFixed(1)+' MB';
const worker=new Worker(new URL('./converter-worker.js',import.meta.url),{type:'module'}),pending=new Map(),entries=new Map();
let sequence=0,keySequence=0,target='abr',allowLossy=false,busy=false,adding=false,planSequence=0,outputURLs=[],toastTimer;
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
function rpc(type,payload={},progress){const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject,progress});worker.postMessage({id,type,...payload},payload.buffer?[payload.buffer]:[]);});}
worker.onmessage=({data:m})=>{const p=pending.get(m.id);if(!p)return;if(m.type==='progress'){p.progress?.(m);return;}pending.delete(m.id);if(m.type==='error')p.reject(new Error(m.message));else p.resolve(m);};
worker.onerror=()=>{const message='转换引擎加载失败，请刷新并使用支持 Web Worker 的新版浏览器。';for(const p of pending.values())p.reject(new Error(message));pending.clear();toast(message);};
function revokeResult(){for(const url of outputURLs)URL.revokeObjectURL(url);outputURLs=[];$('result-content').hidden=true;$('result-content').replaceChildren();$('result-empty').hidden=false;$('result-tag').textContent='等待转换';}
function makeURL(data,type){const url=URL.createObjectURL(new Blob([data],{type}));outputURLs.push(url);return url;}
function ready(){return [...entries.values()].filter(e=>e.doc);}
function render(){
 const list=$('file-list');list.innerHTML='';
 for(const entry of entries.values()){
 const ext=entry.file.name.split('.').pop().toUpperCase(),doc=entry.doc,plan=entry.plan;
 const row=document.createElement('article');row.className='file-row';row.dataset.key=entry.key;
 const status=entry.error?'读取失败':!doc?'正在解析':doc.opaque?'仅可存档':plan?.ok?'就绪':'待选择';
 row.innerHTML=`<div class="file-row-head"><div class="file-type">${esc(ext.slice(0,5))}</div><div class="file-copy"><strong title="${esc(entry.file.name)}">${esc(entry.file.name)}</strong><small>${human(entry.file.size)}${doc?' · '+esc(doc.software)+' · '+doc.tipCount+' 个笔尖':''}</small></div><span class="file-status ${entry.error?'error':doc?.opaque||plan&&!plan.ok?'warn':''}">${!doc&&!entry.error?'<span class="spinner"></span>':esc(status)}</span><button class="icon-btn remove-file" aria-label="移除 ${esc(entry.file.name)}" ${busy?'disabled':''}>${icon('close')}</button></div>`;
 row.querySelector('.remove-file').onclick=()=>remove(entry.key);
 if(entry.error){const p=document.createElement('p');p.className='error-message';p.textContent=entry.error;row.append(p);}
 if(doc){
 const p=document.createElement('div');p.className='file-plan'+(plan&&!plan.ok?' blocked':'');p.textContent=plan?.label||'正在检查目标格式…';row.append(p);
 if(entry.previewURLs.length){const strip=document.createElement('div');strip.className='preview-strip';for(const preview of entry.previewURLs){const figure=document.createElement('figure');figure.className='preview-tip';figure.innerHTML=`<div><img src="${preview.url}" alt="${esc(preview.label)}"></div><figcaption>${esc(preview.caption)}</figcaption>`;strip.append(figure);}row.append(strip);}
 const details=document.createElement('details');details.className='file-details';const losses=plan?.losses||doc.losses;
 details.innerHTML=`<summary>参数、依赖与转换说明${losses.length?' · '+losses.length+' 项说明':''}</summary><ul>${losses.map(x=>'<li>'+esc(x)+'</li>').join('')}</ul><pre>${esc(JSON.stringify({sourceHash:doc.sourceHash,metadata:doc.metadata},null,2))}</pre>`;row.append(details);
 }
 list.append(row);
 }
 const hasFiles=entries.size>0;$('dropzone').classList.toggle('compact',hasFiles);$('queue-toolbar').hidden=!hasFiles;$('queue-label').textContent=`导入队列 · ${entries.size} 个文件`;
 $('file-count').innerHTML=`${entries.size} <small>个</small>`;$('tip-count').innerHTML=`${ready().reduce((n,e)=>n+e.doc.tipCount,0)} <small>个</small>`;
 const n=ready().filter(e=>e.plan?.ok).length;$('ready-count').textContent=n+' 个文件';$('convert').disabled=busy||adding||!n||[...entries.values()].some(e=>!e.doc&&!e.error);
 $('export-caption').textContent=busy?'正在本地处理，请稍候':adding?'正在读取文件…':!entries.size?'导入文件后即可开始':n?`将处理 ${n} 个文件${n<entries.size?'，其余文件不进入输出':''}`:'调整导出设置，或选择可逆存档';
}
async function updatePlans(){const revision=++planSequence;const keys=ready().map(e=>e.key);if(!keys.length){render();return;}try{const {plans}=await rpc('plan',{keys,target,allowLossy});if(revision!==planSequence)return;for(const plan of plans){const e=entries.get(plan.key);if(e)e.plan=plan;}render();}catch(e){toast(e.message);}}
async function addFiles(files){if(busy||adding){toast('当前批次正在处理，请稍后添加。');return;}if(!files.length)return;revokeResult();adding=true;let total=[...entries.values()].reduce((n,e)=>n+e.file.size,0),added=0;
 try{for(const file of files){
 if(entries.size>=20){toast('每批最多 20 个文件，请分批处理。');break;}
 const ext=file.name.split('.').pop().toLowerCase();if(!SUPPORTED.includes(ext)){toast(file.name+'：未支持的文件扩展名');continue;}
 if(file.size===0||file.size>MAX_FILE){toast(file.name+'：文件为空或超过 64 MB');continue;}
 if(total+file.size>MAX_BATCH){toast('文件总计超过 128 MB，请分批处理。');break;}
 if([...entries.values()].some(e=>e.file.name===file.name&&e.file.size===file.size&&e.file.lastModified===file.lastModified)){toast(file.name+' 已在队列中');continue;}
 const key=String(++keySequence),entry={key,file,previewURLs:[],doc:null,error:null,plan:null};entries.set(key,entry);total+=file.size;added++;render();
 try{const buffer=await file.arrayBuffer();const result=await rpc('parse',{key,filename:file.name,buffer});if(!entries.has(key)){rpc('remove',{key});continue;}entry.doc=result.doc;
 for(const p of result.doc.previews){const url=URL.createObjectURL(new Blob([p.png],{type:'image/png'}));entry.previewURLs.push({url,label:p.name,caption:`${p.width}×${p.height}`});}
 if(result.doc.kppPreview){const url=URL.createObjectURL(new Blob([result.doc.kppPreview],{type:'image/png'}));entry.previewURLs.push({url,label:'Krita 预设图标，非笔尖',caption:'预设图标 · 非笔尖'});}
 }catch(e){entry.error=e.message;}await updatePlans();
 }}finally{adding=false;render();if(added)toast(`已导入 ${added} 个文件，文件始终留在本机。`);}}
function remove(key){if(busy)return;const e=entries.get(key);if(!e)return;for(const p of e.previewURLs)URL.revokeObjectURL(p.url);entries.delete(key);rpc('remove',{key});revokeResult();updatePlans();render();}
function clear(){if(busy||adding){toast('请等待当前读取完成。');return;}for(const e of entries.values()){for(const p of e.previewURLs)URL.revokeObjectURL(p.url);rpc('remove',{key:e.key});}entries.clear();revokeResult();render();}
async function demo(){if(busy||adding)return;try{const {files}=await rpc('demo');await addFiles(files.map(f=>new File([f.data],f.name,{lastModified:1})));}catch(e){toast(e.message);}}
async function convert(){if(busy||adding)return;const list=ready();if(!list.some(e=>e.plan?.ok))return;busy=true;revokeResult();render();$('convert').innerHTML='<span>正在转换…</span><span class="spinner"></span>';$('result-tag').textContent='本地处理中';$('result-empty').hidden=true;$('result-content').hidden=false;$('result-content').innerHTML='<div class="progress-block">正在生成笔尖和转换清单…<div class="progress-track"><span id="progress-fill"></span></div></div>';for(const input of document.querySelectorAll('input[name=target],#allow-lossy'))input.disabled=true;
 const selectedTarget=target;try{const result=await rpc('convert',{keys:list.map(e=>e.key),target,allowLossy},m=>{if($('progress-fill'))$('progress-fill').style.width=Math.max(10,m.done/m.total*90)+'%';});
 const zipURL=makeURL(result.buffer,'application/zip'),reportURL=makeURL(JSON.stringify(result.report,null,2),'application/json');const abrURL=result.direct?makeURL(result.direct,'application/octet-stream'):null;
 $('result-tag').textContent='转换完成';const names={abr:'ABR 采样笔尖',gbr:'GBR 位图笔尖',png:'PNG 笔尖素材',archive:'可逆存档'};const warningCount=result.report.files.reduce((n,f)=>n+(f.losses?.length||0),0);
 $('result-content').innerHTML=`<div class="result-success"><div class="success-banner">${icon('check')}<div><h3>${result.included} 个文件已处理完成</h3><p>${esc(names[selectedTarget])} · ${result.count} 个笔尖 · ${human(result.buffer.byteLength)}</p></div></div><div class="download-row"><a href="${zipURL}" class="btn btn-primary" download="BrushBridge-${selectedTarget}.zip">${icon('download')}下载全部产物</a>${abrURL?`<a href="${abrURL}" class="btn btn-secondary" download="BrushBridge.abr">单独下载 ABR</a>`:''}<a href="${reportURL}" class="text-btn" download="conversion-report.json">下载转换清单 ↗</a></div>${result.skipped||entries.size>list.length?`<p class="result-warning">${result.skipped+entries.size-list.length} 个文件未转换。请检查队列说明，或改用可逆存档。</p>`:''}${warningCount?`<p class="result-warning">含 ${warningCount} 项损失/近似说明，详细记录随产物一起下载。</p>`:''}<p class="download-info">${selectedTarget==='archive'?'原始字节已随包保留；请按清单 SHA-256 核验。':'已生成笔尖文件；未验证目标软件导入及完整笔触一致。'}<br>ZIP SHA-256：${esc(result.checksum)}</p></div>`;
 $('result-panel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'nearest'});
 }catch(e){$('result-tag').textContent='转换未完成';$('result-content').innerHTML=`<div class="export-error">${esc(e.message)}<p>文件仍在队列中，可调整格式后重新转换。</p></div>`;toast(e.message);}finally{busy=false;for(const input of document.querySelectorAll('input[name=target],#allow-lossy'))input.disabled=false;$('allow-lossy').disabled=target==='archive';$('convert').innerHTML='<span>开始转换</span>'+icon('arrow');render();}}
const targetNotes={abr:'导出为 ABR 采样笔尖。完整动态设置可能无法保留；尚未验证 CSP 导入。',gbr:'保留灰度覆盖率或 RGBA 像素，按笔尖生成 GBR。动态设置单独记录在清单中。',png:'同时导出原始通道 PNG 和透明预览。灰度原图为覆盖率：白色表示不透明。',archive:'保存原文件、解析参数、原始像素与 SHA-256。可逆存档不是跨软件的原生预设转换。'};
for(const input of document.querySelectorAll('input[name=target]'))input.onchange=()=>{if(busy)return;target=input.value;for(const label of document.querySelectorAll('.target-option'))label.classList.toggle('selected',label.contains(input));$('target-note').querySelector('p').textContent=targetNotes[target];$('allow-lossy').disabled=target==='archive';revokeResult();updatePlans();};
$('allow-lossy').onchange=e=>{allowLossy=e.target.checked;revokeResult();updatePlans();};
$('choose-files').onclick=e=>{e.stopPropagation();if(!busy&&!adding)$('file-input').click();};$('add-files').onclick=()=>{if(!busy&&!adding)$('file-input').click();};$('dropzone').onclick=e=>{if(e.target.closest('button'))return;if(!busy&&!adding)$('file-input').click();};$('dropzone').onkeydown=e=>{if(e.target!==$('dropzone'))return;if(e.key==='Enter'||e.key===' '){e.preventDefault();if(!busy&&!adding)$('file-input').click();}};$('file-input').onchange=e=>{addFiles([...e.target.files]);e.target.value='';};
for(const event of ['dragenter','dragover'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.add('dragover');});for(const event of ['dragleave','drop'])$('dropzone').addEventListener(event,e=>{e.preventDefault();$('dropzone').classList.remove('dragover');});$('dropzone').addEventListener('drop',e=>addFiles([...e.dataTransfer.files]));
// Prevent a file dropped outside the target from navigating away from the workbench.
window.addEventListener('dragover',e=>e.preventDefault());window.addEventListener('drop',e=>e.preventDefault());
$('clear-files').onclick=clear;$('convert').onclick=convert;for(const id of ['demo-main','demo-side'])$(id).onclick=demo;
const formatsHTML=`<p>四款软件、六种已解析格式。我们把“原始数据保留”和“目标引擎笔触一致”分开说明，避免误判兼容性。</p><div class="table-scroll"><table><thead><tr><th>来源软件</th><th>格式 / 版本</th><th>已实现</th><th>转换边界</th></tr></thead><tbody><tr><td>Photoshop</td><td>ABR 1 / 2 / 6.1 / 6.2</td><td>8 位 sampled，raw / RLE</td><td>不映射动态描述符、computed 或 16 位笔刷</td></tr><tr><td>GIMP</td><td>GBR 1 / 2</td><td>灰度覆盖率、RGBA、尺寸与间距</td><td>彩色转单通道 ABR 会丢颜色</td></tr><tr><td>GIMP</td><td>GIH</td><td>所有 GBR 帧、选择规则记录</td><td>拆分后不保留多帧选择行为</td></tr><tr><td>GIMP</td><td>VBR 1.0 / 1.5</td><td>参数解析；可选近似烘焙</td><td>固定尺寸基础形状，不复现 GIMP 渲染器</td></tr><tr><td>MyPaint</td><td>MYB JSON</td><td>完整参数、曲线；可选基础笔尖烘焙</td><td>不复现速度滤波、动态和混色</td></tr><tr><td>Krita</td><td>KPP / PNG preset</td><td>XML、参数、资源引用、图标</td><td>仅 auto_brush 可近似；外部资源不自动补齐</td></tr><tr><td>CSP</td><td>SUT / SUTG</td><td>原文件存档</td><td>尚未解码，不生成 SUT</td></tr><tr><td>Procreate</td><td>BRUSH / BRUSHSET / BRUSHLIBRARY</td><td>原文件存档</td><td>尚未解码，不生成原生预设</td></tr></tbody></table></div><h3>输出与保真</h3><p>ABR 输出为 v2 sampled 子集；GBR 保存单个栅格笔尖；PNG 包含原始通道与透明预览；ZIP 存档保存原始字节及清单。所有原生应用导入和跨引擎笔触一致性均未完成验证。</p><p>单文件上限 64 MB，每批最多 20 个，总输入 128 MB，输出最大 256 MB。推荐新版 Chrome、Edge、Firefox 或 Safari。</p>`;
const guideHTML=`<div class="guide-step"><b>01</b><div><h3>导入你的笔刷</h3><p>拖入文件或点击选择。也可以载入我们自行生成的六格式演示，不包含第三方笔刷素材。</p></div></div><div class="guide-step"><b>02</b><div><h3>选择目标格式</h3><p>迁入 Photoshop / CSP 可尝试 ABR；迁入 GIMP / Krita 可使用 GBR；只需要素材时选择 PNG。保存原始设置请选择可逆存档。</p></div></div><div class="guide-step"><b>03</b><div><h3>查看转换说明并下载</h3><p>存在功能差异时会列出原因。你可以选择“允许降级与近似烘焙”，再下载 ZIP、ABR 与转换清单。暂不支持的格式不会被静默冒充成功。</p></div></div><h3>近似烘焙是什么？</h3><p>对于 VBR、MYB 和不依赖外部笔尖的 Krita auto_brush，按基础半径、形状和硬度生成一个固定尺寸笔尖。MYB 的动态输入、Krita 的传感器/纹理/混色，以及源引擎的精确渲染不会保留。半径最大取 510 px。需要精确保留原文件时请用可逆存档。</p><h3>文件会被上传吗？</h3><p>不会。解析、解压、生成预览和打包都在浏览器 Web Worker 中完成。页面不接入分析服务，也不保存文件；刷新页面后队列会清空。</p><h3>覆盖哪些软件？</h3><p>已解析 Photoshop、GIMP、MyPaint、Krita 的六种格式。CSP 的 SUT 和 Procreate 原生格式暂时只能存档。不同绘画引擎的功能不完全相同，因此这里不承诺“所有笔刷无损互转”。</p><h3>公开源码</h3><p><a href="https://github.com/akhialomgir/brushbridge" target="_blank" rel="noopener noreferrer">在 GitHub 查看转换实现、测试与格式边界 ↗</a></p>`;
function showInfo(which){$('dialog-title').textContent=which==='formats'?'格式兼容与转换边界':'把笔刷带到新的画布';$('dialog-body').innerHTML=which==='formats'?formatsHTML:guideHTML;$('info-dialog').showModal();}
for(const id of ['formats-nav','formats-footer'])$(id).onclick=()=>showInfo('formats');for(const id of ['guide-nav','fidelity-help'])$(id).onclick=()=>showInfo('guide');$('close-dialog').onclick=()=>$('info-dialog').close();$('info-dialog').onclick=e=>{if(e.target===$('info-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}};
if(!window.isSecureContext||!crypto.subtle)toast('请通过 HTTPS 或 localhost 打开，转换器需要安全上下文。');
render();
