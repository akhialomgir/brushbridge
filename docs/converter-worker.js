import {parseBrush,makeDemos,writePNG,buildOutput,assess,hash} from './engine.js';
import {zip} from './zip.js';
const docs=new Map();
const send=(id,type,data)=>postMessage({id,type,...data});
self.onmessage=async({data:m})=>{try{
 if(m.type==='parse'){
 const doc=await parseBrush(new Uint8Array(m.buffer),m.filename);docs.set(m.key,doc);
 const previews=[];for(const t of doc.tips.slice(0,8)){const scale=Math.min(1,180/Math.max(t.width,t.height));let thumb=t;if(scale<1){const w=Math.max(1,Math.round(t.width*scale)),h=Math.max(1,Math.round(t.height*scale)),c=t.mode==='RGBA'?4:1,pixels=new Uint8Array(w*h*c);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const from=(Math.min(t.height-1,Math.floor(y/scale))*t.width+Math.min(t.width-1,Math.floor(x/scale)))*c;pixels.set(t.pixels.subarray(from,from+c),(y*w+x)*c);}thumb={...t,width:w,height:h,pixels};}previews.push({name:t.name,width:t.width,height:t.height,mode:t.mode,png:await writePNG(thumb,true)});}
 const {source,tips,preview,...publicDoc}=doc;
 send(m.id,'parsed',{key:m.key,doc:{...publicDoc,tipCount:tips.length,previews,kppPreview:preview||null}});
 }else if(m.type==='plan'){send(m.id,'plan',{plans:m.keys.map(key=>{const doc=docs.get(key);if(!doc)return {key,ok:false,label:'文件未就绪'};const p=assess(doc,m.target,m.allowLossy);return {key,ok:p.ok,label:p.label,losses:p.losses,tipCount:p.tips.length};})});}
 else if(m.type==='convert'){
 const list=m.keys.map(k=>docs.get(k));if(list.some(x=>!x))throw new Error('部分文件已失效，请重新导入');
 const out=await buildOutput(list,m.target,m.allowLossy,(done,total)=>send(m.id,'progress',{done,total}));
 const data=zip(out.files);const checksum=await hash(data);
 const direct=out.files.find(f=>f.name==='BrushBridge.abr');
 send(m.id,'converted',{buffer:data.buffer,report:out.report,count:out.count,included:out.included,skipped:out.skipped,checksum,direct:direct?direct.data:null});
 }else if(m.type==='demo'){send(m.id,'demo',{files:await makeDemos()});}
 else if(m.type==='remove'){docs.delete(m.key);send(m.id,'removed',{});}
 }catch(e){send(m.id,'error',{message:e.message||String(e)});}};
