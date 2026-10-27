/* BrushBridge — original browser implementation. No external dependencies. */
export const MAX_FILE = 64 * 1024 * 1024;
export const MAX_BATCH = 128 * 1024 * 1024;
export const SUPPORTED = ['gbr','gih','vbr','myb','kpp','abr','sut','sutg','brush','brushset','brushlibrary'];
const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', {fatal:true});
const text = b => utf8.decode(b);
export const bytes = s => encoder.encode(s);
export const json = x => bytes(JSON.stringify(x,null,2)+'\n');
export function concat(parts) { const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let pos=0;for(const p of parts){out.set(p,pos);pos+=p.length;}return out; }
function check(ok,msg) { if(!ok) throw new Error(msg); }
export function dimensions(w,h,c=1) {check(Number.isInteger(w)&&Number.isInteger(h)&&w>0&&h>0&&w<=32767&&h<=32767&&w*h*c<=32*1024*1024,'笔尖尺寸无效或超过 32 MB 像素限制');}
export class Reader {
 constructor(data){this.b=data;this.v=new DataView(data.buffer,data.byteOffset,data.byteLength);this.p=0;}
 take(n){check(Number.isSafeInteger(n)&&n>=0&&this.p+n<=this.b.length,'文件被截断或长度字段无效（偏移 '+this.p+'）');const b=this.b.subarray(this.p,this.p+n);this.p+=n;return b;}
 u8(){return this.take(1)[0];}u16(){this.take(2);return this.v.getUint16(this.p-2);}u32(){this.take(4);return this.v.getUint32(this.p-4);}i32(){this.take(4);return this.v.getInt32(this.p-4);}left(){return this.b.length-this.p;}
}
export function be(n,size=4){const b=new Uint8Array(size),v=new DataView(b.buffer);if(size===2)v.setUint16(0,n);else v.setUint32(0,n);return b;}
let crcTable;
export function crc32(b){if(!crcTable)crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});let c=0xffffffff;for(const v of b)c=crcTable[(c^v)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export async function hash(b){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),x=>x.toString(16).padStart(2,'0')).join('');}
export async function inflate(b,limit=64*1024*1024){
 check(typeof DecompressionStream!=='undefined','浏览器缺少解压能力，请使用新版 Chrome、Edge、Firefox 或 Safari');
 const reader=new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();let size=0;const chunks=[];
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new Error('解压后的数据超过安全限制');}chunks.push(value);}}finally{reader.releaseLock();}
 return concat(chunks);
}
async function deflate(b){return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());}
function tip(name,w,h,mode,pixels,extra={}){dimensions(w,h,mode==='RGBA'?4:1);check(pixels.length===w*h*(mode==='RGBA'?4:1),'笔尖像素数量不正确');return {name,width:w,height:h,mode,pixels,...extra};}
function gbr(r){const start=r.p;const size=r.u32(),version=r.u32(),w=r.u32(),h=r.u32(),c=r.u32();check([1,2].includes(version),'仅支持 GBR v1/v2，暂不支持浮点 GBR v3');check([1,4].includes(c),'不支持此 GBR 通道数');const min=version===2?28:20;check(size>min&&size<=65536,'GBR 文件头无效');let spacing=null;if(version===2){check(r.u32()===0x47494d50,'GBR magic 不正确');spacing=r.u32();}const name=r.take(size-min);check(name.at(-1)===0,'GBR 名称缺少终止符');dimensions(w,h,c);return tip(text(name.subarray(0,-1)),w,h,c===4?'RGBA':'L',r.take(w*h*c),{spacing,version,offset:start});}
export function writeGBR(t){const name=concat([bytes(t.name),new Uint8Array(1)]);const spacing=t.spacing??25;check(Number.isInteger(spacing)&&spacing>=0&&spacing<=0xffffffff,'GBR 间距无法表达');return concat([[28+name.length,2,t.width,t.height,t.mode==='RGBA'?4:1,0x47494d50,spacing].map(n=>be(n)).reduce((a,b)=>concat([a,b]),new Uint8Array()),name,t.pixels]);}
export function unpackRow(b,width){const r=new Reader(b),out=new Uint8Array(width);let pos=0;while(r.left()){const n=r.u8();if(n===128)continue;const count=n<128?n+1:257-n;check(pos+count<=width,'ABR RLE 行越界');if(n<128)out.set(r.take(count),pos);else out.fill(r.u8(),pos,pos+count);pos+=count;}check(pos===width,'ABR RLE 行长度不符');return out;}
function abrPixels(r,w,h,depth,compression){dimensions(w,h);check(depth===8,'仅支持 8 位 ABR，不会自动压缩 16 位精度');if(compression===0)return r.take(w*h);check(compression===1,'不支持此 ABR 压缩方式');const lengths=Array.from({length:h},()=>r.u16());const out=new Uint8Array(w*h);for(let y=0;y<h;y++)out.set(unpackRow(r.take(lengths[y]),w),y*w);return out;}
function abr(b){const r=new Reader(b),version=r.u16(),second=r.u16(),tips=[],sections=[],skipped=[];let cumulative=0;
 function add(t){cumulative+=t.pixels.length;check(cumulative<=MAX_BATCH,'解码后的 ABR 总像素超过 128 MB');tips.push(t);check(tips.length<=2048,'ABR 笔尖数量超过 2048');}
 function sample(rec,name,spacing){const top=rec.i32(),left=rec.i32(),bottom=rec.i32(),right=rec.i32(),depth=rec.u16(),compression=rec.u8();return tip(name,right-left,bottom-top,'L',abrPixels(rec,right-left,bottom-top,depth,compression),{spacing,compression,bounds:[top,left,bottom,right]});}
 if(version===1||version===2){check(second<=2048,'ABR 数量超过 2048');for(let i=0;i<second;i++){const kind=r.u16(),len=r.u32(),rec=new Reader(r.take(len));if(kind!==2){skipped.push({index:i,type:kind});continue;}rec.take(4);const spacing=rec.u16();let name=`笔尖 ${i+1}`;if(version===2){const units=rec.u32();name=new TextDecoder('utf-16be',{fatal:true}).decode(rec.take(units*2)).replace(/\0+$/,'')||name;}rec.take(9);add(sample(rec,name,spacing));}check(!r.left(),'ABR 存在未识别的尾部数据');}
 else if(version===6&&[1,2].includes(second)){while(r.left()){check(text(r.take(4))==='8BIM','ABR 区块签名无效');const tag=text(r.take(4)),size=r.u32(),offset=r.p,data=r.take(size);sections.push({tag,offset,bytes:size});if(tag!=='samp')continue;const s=new Reader(data);while(s.left()){const n=s.u32(),rec=new Reader(s.take(n));s.take((-n)&3);rec.take(37);rec.take(second===1?10:264);add(sample(rec,`笔尖 ${tips.length+1}`,null));}}}
 else throw new Error(`暂不支持 ABR ${version}.${second}，请选择可逆存档以保留原文件`);
 const losses=['ABR 动态描述符尚未映射，导出的是采样笔尖。'];if(skipped.length)losses.push(`${skipped.length} 个计算式/未知笔刷未生成位图。`);
 return {format:'abr',software:'Photoshop',name:'Photoshop 笔刷集',tips,metadata:{version,subversion:version===6?second:null,sections,skipped},losses};
}
export async function pngChunks(b){const sig=[137,80,78,71,13,10,26,10];check(sig.every((x,i)=>b[i]===x),'PNG 签名无效');const r=new Reader(b.subarray(8)),chunks=[];while(r.left()){const n=r.u32(),tag=text(r.take(4)),data=r.take(n),crc=r.u32();check(crc32(concat([bytes(tag),data]))===crc,'PNG CRC 校验失败');chunks.push({tag,data});if(tag==='IEND'){check(!r.left(),'PNG 尾部数据无效');return chunks;}}throw new Error('PNG 缺少 IEND');}
function splitZero(b){const i=b.indexOf(0);check(i>=0,'PNG 文本块字段无效');return [b.subarray(0,i),b.subarray(i+1)];}
export function attributes(s){const out={};for(const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))out[m[1]]=m[2]??m[3];return out;}
function xmlText(s){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,(_,c)=>c).replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');}
export async function readKPP(b){const chunks=await pngChunks(b),texts={};let w,h;for(const {tag,data:d} of chunks){if(tag==='IHDR'){const r=new Reader(d);w=r.u32();h=r.u32();}if(tag==='tEXt'){const [k,v]=splitZero(d);texts[text(k)]=new TextDecoder('latin1').decode(v);}if(tag==='zTXt'){const[k,v]=splitZero(d);check(v[0]===0,'KPP 文本压缩方式无效');texts[text(k)]=text(await inflate(v.subarray(1),16*1024*1024));}if(tag==='iTXt'){const[k,rest]=splitZero(d);check([0,1].includes(rest[0])&&rest[1]===0,'PNG iTXt 无效');const[,a]=splitZero(rest.subarray(2));const[,v]=splitZero(a);texts[text(k)]=text(rest[0]?await inflate(v,16*1024*1024):v);}}
 check(texts.preset,'这是一张 PNG，但没有 Krita 预设元数据');const xml=texts.preset;check(!/<!ENTITY/i.test(xml),'不支持含实体定义的 XML');const root=xml.match(/<Preset\s+([^>]+)>/);check(root,'KPP preset XML 无效');const attrs=attributes(root[1]),params={};for(const m of xml.matchAll(/<param\s+([^>]+)>([\s\S]*?)<\/param>/g)){const a=attributes(m[1]);if(a.name)params[a.name]=xmlText(m[2]);}
 const refs=[...new Set([params.requiredBrushFile,...(params.requiredBrushFilesList||'').split(';')].filter(Boolean))];
 return {format:'kpp',software:'Krita',name:attrs.name||'Krita 预设',tips:[],metadata:{engine:attrs.paintopid,parameters:params,parameterCount:Object.keys(params).length,referencedResources:refs,pngText:texts,previewSize:[w,h]},preview:b,losses:['KPP 中的 PNG 是预设图标，不是笔尖。','引擎设置、传感器与混色行为未转换。',...(refs.length?['引用了外部笔尖：'+refs.join('、')+'；请用可逆存档保留预设。']:[])]};
}
function vbr(b){const lines=text(b).trimEnd().split(/\r?\n/),v=lines[1];check(lines[0]==='GIMP-VBR'&&['1.0','1.5'].includes(v)&&lines.length===(v==='1.0'?8:10),'VBR 版本或字段数量不支持');let shape='circle',spikes=2,n;if(v==='1.5'){shape=lines[3];spikes=Number(lines[6]);n=[lines[4],lines[5],...lines.slice(7)].map(Number);}else n=lines.slice(3).map(Number);const[spacing,radius,hardness,aspect,angle]=n;check(n.every(Number.isFinite)&&radius>0&&radius<=4096&&aspect>=1&&aspect<=1000&&hardness>=0&&hardness<=1&&Number.isInteger(spikes)&&spikes>=2&&spikes<=20&&['circle','square','diamond'].includes(shape),'VBR 参数超出支持范围');return {format:'vbr',software:'GIMP',name:lines[2],tips:[],metadata:{version:v,shape,spacing,radius,hardness,aspect,angle,spikes},losses:['参数笔刷需烘焙为固定尺寸；解析式缩放与原引擎边缘算法无法保留。']};}
export async function parseBrush(b,filename){check(b instanceof Uint8Array&&b.length>0&&b.length<=MAX_FILE,'文件为空或超过单文件 64 MB 限制');const ext=(filename.split('.').pop()||'').toLowerCase();let doc;
 if(bytes('GIMP-VBR').every((x,i)=>b[i]===x))doc=vbr(b);
 else if(ext==='gbr'||(b.length>=24&&b[20]===71&&b[21]===73&&b[22]===77&&b[23]===80)){const r=new Reader(b),t=gbr(r);check(!r.left(),'GBR 包含未支持的附加数据');doc={format:'gbr',software:'GIMP',name:t.name,tips:[t],metadata:{version:t.version},losses:[]};}
 else if(ext==='gih'){const r=new Reader(b);const line=()=>{const end=b.indexOf(10,r.p);check(end>=0&&end-r.p<65536,'GIH 文件头无效');return text(r.take(end-r.p+1).subarray(0,-1)).replace(/\r$/,'');};const name=line(),header=line(),[countText,...fields]=header.split(/\s+/),count=Number(countText);check(Number.isInteger(count)&&count>0&&count<=1024,'GIH 单元数量超出支持范围');const params={};for(const f of fields){const i=f.indexOf(':');check(i>0,'GIH 参数无效');params[f.slice(0,i)]=f.slice(i+1);}const tips=[];let total=0;for(let i=0;i<count;i++){const t=gbr(r);total+=t.pixels.length;check(total<=MAX_BATCH,'GIH 解码像素超过限制');tips.push(t);}check(!r.left(),'GIH 存在未识别尾部数据');doc={format:'gih',software:'GIMP',name,tips,metadata:{header,cellCount:count,pipeParameters:params},losses:['多帧笔尖将拆为独立素材；原有随机/压力/顺序选帧规则不进入目标预设。']};}
 else if(ext==='kpp'||b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71)doc=await readKPP(b);
 else if(ext==='myb'){const m=JSON.parse(text(b));check(m&&typeof m.settings==='object'&&m.settings&&!Array.isArray(m.settings),'仅支持包含 settings 的 JSON MyPaint 笔刷');for(const v of Object.values(m.settings))check(v&&Number.isFinite(v.base_value)&&v.inputs&&typeof v.inputs==='object','MYB 设置字段无效');doc={format:'myb',software:'MyPaint',name:filename.replace(/\.myb$/i,''),tips:[],metadata:m,losses:['MyPaint 动态曲线、速度滤波、取色与混色行为无法转换。']};}
 else if(ext==='abr'||b[0]===0&&[1,2,6].includes(b[1]))doc=abr(b);
 else if(['sut','sutg','brush','brushset','brushlibrary'].includes(ext)){doc={format:ext,software:ext.startsWith('sut')?'CSP':'Procreate',name:filename,tips:[],metadata:{decoded:false,originalBytes:b.length},losses:['此原生格式尚未解码，目前仅支持原文件可逆存档。'],opaque:true};}
 else throw new Error('未识别此笔刷格式。支持 GBR、GIH、VBR、MYB、KPP、ABR；SUT 与 Procreate 格式目前仅存档。');
 doc.filename=filename;doc.sourceHash=await hash(b);doc.source=b;return doc;
}
export function bake(doc){
 if(doc.tips.length)return doc.tips;
 let m,name=doc.name+' · 近似烘焙';
 if(doc.format==='vbr')m=doc.metadata;
 else if(doc.format==='myb'){const s=doc.metadata.settings,val=(k,d)=>s[k]?.base_value??d;const radius=Math.exp(val('radius_logarithmic',2));check(Number.isFinite(radius)&&radius>0&&radius<=4096,'MYB 基础半径超出烘焙范围');m={radius:Math.max(1,radius),hardness:Math.max(0,Math.min(1,val('hardness',0.8))),aspect:Math.max(1,Math.min(20,val('elliptical_dab_ratio',1))),angle:val('elliptical_dab_angle',0),spikes:2,shape:'circle',spacing:25};}
 else if(doc.format==='kpp'){const xml=doc.metadata.parameters.brush_definition||'',a=attributes(xml.match(/<Brush\b([^>]*)/)?.[1]||''),mask=attributes(xml.match(/<MaskGenerator\b([^>]*)/)?.[1]||'');check(a.type==='auto_brush'&&mask.diameter,'此 KPP 依赖位图/外部资源，不能从图标生成笔尖；请选择可逆存档');check(!doc.metadata.referencedResources.length,'KPP 外部笔尖资源未解决');m={radius:Number(mask.diameter)/2,hardness:0.5,aspect:1/Math.max(0.05,Number(mask.ratio)||1),angle:(Number(a.angle)||0)*180/Math.PI,shape:mask.type==='rectangle'?'square':'circle',spikes:2,spacing:Math.round((Number(a.spacing)||0.25)*100)};}
 else throw new Error('此格式没有可烘焙的参数笔尖，请选择可逆存档');
 check([m.radius,m.hardness,m.aspect,m.angle,m.spikes].every(Number.isFinite),'烘焙参数包含无效数值');
 // Deliberately approximate, 4x supersampling at one fixed resolution. Not a native renderer.
 const radius=Math.min(510,Math.max(1,m.radius)),size=Math.max(4,Math.ceil(radius*2)+4);dimensions(size,size);const data=new Uint8Array(size*size),angle=m.angle*Math.PI/180,co=Math.cos(angle),si=Math.sin(angle);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){let sum=0;for(const dy of [0.25,0.75])for(const dx of [0.25,0.75]){const xx=x+dx-size/2,yy=y+dy-size/2,u=(xx*co+yy*si)/radius,v=(-xx*si+yy*co)*m.aspect/radius;let d=m.shape==='square'?Math.max(Math.abs(u),Math.abs(v)):m.shape==='diamond'?Math.abs(u)+Math.abs(v):Math.hypot(u,v);if(m.spikes>2)d/=0.7+0.3*Math.cos(m.spikes*Math.atan2(v,u));sum+=d>=1?0:d<=m.hardness?1:(1-d)/Math.max(0.001,1-m.hardness);}data[y*size+x]=Math.round(255*sum/4);}
 return [tip(name,size,size,'L',data,{spacing:Math.max(1,Math.min(1000,Math.round(m.spacing||25))),approximate:true})];
}
export async function writePNG(t,preview=false){const channels=preview||t.mode==='RGBA'?4:1;let pixels=t.pixels;if(preview&&t.mode==='L'){pixels=new Uint8Array(t.width*t.height*4);for(let i=0;i<t.pixels.length;i++)pixels[i*4+3]=t.pixels[i];}const stride=t.width*channels,scan=new Uint8Array((stride+1)*t.height);for(let y=0;y<t.height;y++)scan.set(pixels.subarray(y*stride,(y+1)*stride),y*(stride+1)+1);const ihdr=concat([be(t.width),be(t.height),new Uint8Array([8,channels===4?6:0,0,0,0])]);const chunk=(tag,b)=>concat([be(b.length),bytes(tag),b,be(crc32(concat([bytes(tag),b])))]);return concat([new Uint8Array([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',await deflate(scan)),chunk('IEND',new Uint8Array())]);}
export async function annotatePNG(png,preset){const ch=await pngChunks(png),out=[png.subarray(0,8)];const data=concat([bytes('preset'),new Uint8Array([0,0]),await deflate(bytes(preset))]);const chunk=(tag,b)=>concat([be(b.length),bytes(tag),b,be(crc32(concat([bytes(tag),b])))]);for(const c of ch){if(c.tag==='IEND')out.push(chunk('zTXt',data));out.push(chunk(c.tag,c.data));}return concat(out);}
function utf16(s){const b=new Uint8Array((s.length+1)*2),v=new DataView(b.buffer);for(let i=0;i<s.length;i++)v.setUint16(i*2,s.charCodeAt(i));return b;}
export function writeABR(tips,allowLossy=false){check(tips.length>0&&tips.length<=2048,'没有可导出的笔尖，或数量超过 2048');const records=[],losses=[];for(const t of tips){let pixels=t.pixels;if(t.mode==='RGBA'){check(allowLossy,'彩色笔尖转 ABR 会丢失颜色，请允许降级或选择 PNG/GBR');pixels=new Uint8Array(t.width*t.height);for(let i=0;i<pixels.length;i++)pixels[i]=t.pixels[i*4+3];losses.push(t.name+'：丢弃颜色，仅保留 alpha。');}let spacing=t.spacing;if(!Number.isInteger(spacing)||spacing<1||spacing>1000){check(allowLossy,'间距未知或无法表达，请允许降级以使用 25% 间距');spacing=25;losses.push(t.name+'：间距使用 25%。');}const name=utf16(t.name);const bounds=concat([be(0,2),be(0,2),be(t.height,2),be(t.width,2),be(0),be(0),be(t.height),be(t.width)]);const body=concat([be(0),be(spacing,2),be(name.length/2),name,new Uint8Array([1]),bounds,be(8,2),new Uint8Array([0]),pixels]);records.push(concat([be(2,2),be(body.length),body]));}return {data:concat([be(2,2),be(tips.length,2),...records]),losses};}
export function safeName(name){return name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,100)||'brush';}
function serialTip(t){const {pixels,...row}=t;return row;}
export function assess(doc,target,allowLossy){
 if(target==='archive')return {ok:true,label:'原文件可逆保留',losses:[],tips:doc.tips};
 if(doc.opaque)return {ok:false,label:'当前仅支持存档',losses:doc.losses,tips:[]};
 let tips=doc.tips,losses=[...doc.losses];if(!tips.length){if(!allowLossy)return {ok:false,label:'需要允许近似烘焙',losses,tips:[]};try{tips=bake(doc);losses.push('按基础参数近似烘焙单个笔尖；动态行为未保留，半径最大取 510 px。');}catch(e){return {ok:false,label:e.message,losses,tips:[]};}}
 if(target==='abr'){if(doc.losses.length&&!allowLossy)return {ok:false,label:'存在行为损失，需允许降级',losses,tips};try{const out=writeABR(tips,allowLossy);losses.push(...out.losses);}catch(e){return {ok:false,label:e.message,losses,tips};}}
 if(target==='gbr'&&tips.some(t=>t.spacing==null))losses.push('GBR 间距缺失时使用 25%；源信息仍保存在清单。');
 return {ok:true,label:losses.length?'可转换 · 包含损失说明':'笔尖像素可保留',losses,tips};
}
export async function buildOutput(docs,target,allowLossy,progress=()=>{}){
 const files=[],report={schema:'brushbridge-web/1',target,createdAt:new Date().toISOString(),applicationImportVerified:false,strokeEquivalenceVerified:false,files:[]};let count=0;
 for(let index=0;index<docs.length;index++){
 const doc=docs[index],plan=assess(doc,target,allowLossy);if(!plan.ok){report.files.push({source:doc.filename,status:'skipped',reason:plan.label});continue;}const dir=String(index+1).padStart(2,'0')+'-'+safeName(doc.filename),rows=[];
 if(target==='archive')files.push({name:dir+'/original/'+safeName(doc.filename),data:doc.source});
 for(let i=0;i<plan.tips.length;i++){const t=plan.tips[i],base=dir+'/tips/'+String(i+1).padStart(3,'0')+'-'+safeName(t.name);const row={...serialTip(t),sha256:await hash(t.pixels),coverageConvention:t.mode==='L'?'0 transparent, 255 opaque':'straight RGBA'};rows.push(row);
 if(target==='png'||target==='archive'){files.push({name:base+'.png',data:await writePNG(t)});files.push({name:base+'-preview.png',data:await writePNG(t,true)});}
 if(target==='gbr'||target==='archive')files.push({name:base+'.gbr',data:writeGBR(t)});
 if(target==='archive')files.push({name:base+'.raw',data:t.pixels});
 count++;}
 const entry={source:doc.filename,sourceSha256:doc.sourceHash,format:doc.format,status:'included',tips:rows,losses:plan.losses,unmappedFeatures:doc.losses,metadata:doc.metadata};report.files.push(entry);
 files.push({name:dir+'/manifest.json',data:json(entry)});
 if(target==='archive'&&doc.format==='kpp')files.push({name:dir+'/preset.xml',data:bytes(doc.metadata.pngText.preset)});
 progress(index+1,docs.length);
 }
 const included=docs.filter(d=>assess(d,target,allowLossy).ok);check(included.length>0,'没有符合当前设置的文件，请调整格式或改用可逆存档');
 if(target==='abr'){const plans=included.map(d=>assess(d,target,allowLossy)),allTips=plans.flatMap(p=>p.tips),abr=writeABR(allTips,allowLossy);const parsed=abr.data;files.push({name:'BrushBridge.abr',data:parsed});report.outputSha256=await hash(parsed);}
 files.push({name:'conversion-report.json',data:json(report)});files.push({name:'使用说明.txt',data:bytes('BrushBridge 笔刷转换\n\nABR 是采样笔尖子集；未验证目标应用导入或完整笔触一致。\nPNG 灰度文件保存覆盖率（白=不透明），preview 文件是黑墨水加透明度的展示图。\nGBR 保存笔尖，不包含原引擎的全部动态行为。\n近似烘焙只创建基础形状，不能重现原引擎笔触。\narchive 中的 original 目录保存原始字节；请对照清单 SHA-256 核验。\n部分文件可能因不支持而跳过，请查看 conversion-report.json。\n')});
 return {files,report,count,included:included.length,skipped:docs.length-included.length};
}
export async function makeDemos(){
 function dot(name,seed=1){const w=96,h=96,pixels=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const d=Math.hypot((x-47.5)/45,(y-47.5)/45),grain=(Math.sin(x*12.9898+y*78.233+seed)*43758.5453)%1;pixels[y*w+x]=Math.round(Math.max(0,1-d)**0.6*(0.5+0.5*Math.abs(grain))*255);}return tip(name,w,h,'L',pixels,{spacing:12});}
 const t=dot('Grain pencil'),gbrData=writeGBR(t),abrData=writeABR([t]).data;
 const gihData=concat([bytes('Scatter trio\n3 ncells:3 dim:1 rank0:3 sel0:random\n'),...Array.from({length:3},(_,i)=>writeGBR(dot('Scatter '+(i+1),i*17+4)))]);
 const myb=json({version:3,comment:'Original procedural demonstration',settings:{radius_logarithmic:{base_value:3.2,inputs:{}},hardness:{base_value:0.6,inputs:{}},opaque:{base_value:0.8,inputs:{pressure:[[0,0],[1,1]]}},smudge:{base_value:0,inputs:{}}}});
 const preset='<Preset name="Round Ink" paintopid="paintbrush"><param name="brush_definition" type="string"><![CDATA[<Brush type="auto_brush" spacing="0.15" angle="0"><MaskGenerator diameter="48" ratio="1" type="circle"/></Brush>]]></param><param name="SizeSensor" type="string"><![CDATA[<params id="pressure"><curve>0,0;1,1;</curve></params>]]></param></Preset>';
 const kpp=await annotatePNG(await writePNG(t,true),preset);
 return [{name:'Grain-Pencil.gbr',data:gbrData},{name:'Scatter-Trio.gih',data:gihData},{name:'Soft-Round.vbr',data:bytes('GIMP-VBR\n1.0\nSoft Round\n15\n32\n0.65\n1\n0\n')},{name:'Soft-Paint.myb',data:myb},{name:'Round-Ink.kpp',data:kpp},{name:'Grain-Collection.abr',data:abrData}];
}
