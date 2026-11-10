'use client';
import { useState, useRef, useEffect, useEffectEvent, useSyncExternalStore, type PointerEvent } from 'react';
import { Crop, Upload, Download, RotateCw, Undo2, Redo2, Plus, Minus, ChevronUp, ChevronDown, Trash2, X, Check, SlidersHorizontal, FileText, Expand, Move, ArrowRight, BookOpen, Maximize2, MessageSquareText } from 'lucide-react';
import { dimensions, fullCrop, layout, marginCrop, MM, rotateEdit, type Edit } from '../lib/pdf/geometry';
import { openPdf, renderPage, demoPdf, exportPdf } from '../lib/pdf/engine';
import { fileSize, byteLimit, checkSize } from '../lib/pdf/export';
import PdfTools, {type ToolTab} from '../components/pdf-tools';
import { ToolDirectory, ToolNav, WorkspaceSearch, toolFromHash, toolHref, toolLabel } from '../components/tool-navigation';
import { ToolFilePanel, ToolHeading } from '../components/tool-workspace';
import './navigation.css';
import './workspace.css';

function subscribeToToolRoute(onChange: () => void) {
 window.addEventListener('hashchange', onChange);
 return () => window.removeEventListener('hashchange', onChange);
}
const readToolRoute = () => toolFromHash(window.location.hash);
const homeRoute = () => null;
const copy = (a:Edit[]) => structuredClone(a);
const clamp = (n:number, a:number, b:number) => Math.max(a,Math.min(b,n));
function NumberField({label,value,onChange,min=0,max=1000,unit='mm'}:{label:string;value:number;onChange:(n:number)=>void;min?:number;max?:number;unit?:string}) {
 return <label className="number-field"><span>{label}</span><div><input aria-label={label} type="number" min={min} max={max} step="0.1" value={Math.round(value*10)/10} onChange={e=>{if(e.target.value!==''&&Number.isFinite(e.target.valueAsNumber))onChange(clamp(e.target.valueAsNumber,min,max));}}/><small>{unit}</small></div></label>;
}
function Thumbnail({doc,edit,selected,onClick,index}:{doc:any;edit:Edit;selected:boolean;onClick:()=>void;index:number}) {
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{let live=true;renderPage(doc,edit.source,edit.rotation,180).then(c=>{if(live&&ref.current){ref.current.width=c.width;ref.current.height=c.height;ref.current.getContext('2d')!.drawImage(c,0,0);}c.width=1;}).catch(()=>{});return()=>{live=false;};},[doc,edit.source,edit.rotation]);
 return <button className={`thumb ${selected?'selected':''}`} onClick={onClick} aria-label={`选择第 ${index+1} 页`} aria-current={selected?'page':undefined}><div className="thumb-paper"><canvas ref={ref}/><div className="thumb-crop" style={{left:`${edit.crop.x*100}%`,top:`${edit.crop.y*100}%`,width:`${edit.crop.w*100}%`,height:`${edit.crop.h*100}%`}}/></div><span><b>{String(index+1).padStart(2,'0')}</b>{selected&&<span className="selected-dot"/>}</span></button>;
}
export default function Home({ feedbackUrl }: { feedbackUrl?: string } = {}) {
 const route=useSyncExternalStore(subscribeToToolRoute,readToolRoute,homeRoute);
 const [tool,setTool]=useState<ToolTab|null>(null),[toolBusy,setToolBusy]=useState(false);
 const firstScreen=useRef(true);
 const [doc,setDoc]=useState<any>(null),[edits,setEdits]=useState<Edit[]>([]),[active,setActive]=useState(0),[name,setName]=useState(''),[busy,setBusy]=useState(''),[toast,setToast]=useState(''),[error,setError]=useState(''),[mode,setMode]=useState<'crop'|'layout'>('crop'),[raw,setRaw]=useState<HTMLCanvasElement|null>(null),[rendering,setRendering]=useState(false),[modal,setModal]=useState(false),[help,setHelp]=useState(false),[allowCompression,setAllowCompression]=useState(true),[originalSize,setOriginalSize]=useState(0),[scope,setScope]=useState('all'),[zoom,setZoom]=useState(1),[dragOver,setDragOver]=useState(false),[historyTick,setHistoryTick]=useState(0);
 const settings=useRef<HTMLElement>(null);
 const input=useRef<HTMLInputElement>(null),paper=useRef<HTMLDivElement>(null),view=useRef<HTMLCanvasElement>(null),history=useRef<Edit[][]>([]),future=useRef<Edit[][]>([]),editsRef=useRef(edits),gesture=useRef<any>(null),busyRef=useRef(false),docRef=useRef<any>(null),sourceBytes=useRef<Uint8Array|null>(null);
 editsRef.current=edits; const e=edits.find(p=>p.id===active)||edits[0],idx=edits.indexOf(e),d=e?dimensions(e):{w:595,h:842},l=e?layout(e):null;
 function remember(previous:Edit[]){history.current.push(copy(previous));if(history.current.length>60)history.current.shift();future.current=[];setHistoryTick(t=>t+1);}
 function commit(next:Edit[]){if(JSON.stringify(next)===JSON.stringify(editsRef.current))return;remember(editsRef.current);setEdits(next);}
 function patch(p:Partial<Edit>){if(e)commit(edits.map(a=>a.id===e.id?{...a,...p}:a));}
 function undo(){const previous=history.current.pop();if(!previous)return;future.current.push(copy(editsRef.current));setEdits(previous);setHistoryTick(t=>t+1);}
 function redo(){const next=future.current.pop();if(!next)return;history.current.push(copy(editsRef.current));setEdits(next);setHistoryTick(t=>t+1);}
 useEffect(()=>{if(!modal&&!help)return;const before=document.activeElement as HTMLElement;const handler=(ev:KeyboardEvent)=>{if(ev.key==='Escape'){setModal(false);setHelp(false);}if(ev.key==='Tab'){const nodes=Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button:not(:disabled), [role="dialog"] select, [role="dialog"] a'));const first=nodes[0],last=nodes[nodes.length-1];if(ev.shiftKey&&document.activeElement===first){ev.preventDefault();last?.focus();}else if(!ev.shiftKey&&document.activeElement===last){ev.preventDefault();first?.focus();}}};window.addEventListener('keydown',handler);return()=>{window.removeEventListener('keydown',handler);before?.focus();};},[modal,help]);
 useEffect(()=>{if(toast){const t=setTimeout(()=>setToast(''),5000);return()=>clearTimeout(t);}},[toast]);
 useEffect(()=>{const handler=(ev:KeyboardEvent)=>{const tag=(ev.target as HTMLElement).tagName;if(['INPUT','SELECT','TEXTAREA'].includes(tag)||tool!=='crop'||busy||modal||help)return;if((ev.ctrlKey||ev.metaKey)&&ev.key.toLowerCase()==='z'){ev.preventDefault();ev.shiftKey?redo():undo();}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);});
 useEffect(()=>{const handler=(ev:BeforeUnloadEvent)=>{if(history.current.length){ev.preventDefault();ev.returnValue='';}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[]);
 async function load(data:Uint8Array,fileName:string){
  let next:any;const preserved=data.slice();
  try{setBusy('正在读取 PDF…');setError('');next=await openPdf(data);const items:Edit[]=[];
   for(let i=1;i<=next.numPages;i++){setBusy(`正在读取第 ${i} / ${next.numPages} 页…`);const page=await next.getPage(i),v=page.getViewport({scale:1});items.push({id:i,source:i,width:v.width,height:v.height,rotation:0,crop:fullCrop(),paper:'crop',customW:210,customH:297,margin:0,scale:100,offsetX:0,offsetY:0});}
   const old=docRef.current;sourceBytes.current=preserved;setOriginalSize(preserved.byteLength);docRef.current=next;setDoc(next);setEdits(items);setActive(1);setName(fileName);setMode('crop');setZoom(1);history.current=[];future.current=[];setHistoryTick(t=>t+1);if(old)await old.destroy();
  }catch(err:any){if(next&&next!==docRef.current)await next.destroy();setError(err?.name==='PasswordException'?'这个 PDF 设有密码，请先在阅读器中解锁并另存，再导入。':'无法打开这个 PDF。请确认文件完整，并尝试在阅读器中另存后重新导入。');}
  finally{setBusy('');busyRef.current=false;}
 }
 async function selectFile(file?:File){if(!file||busyRef.current)return;if(!file.name.toLowerCase().endsWith('.pdf')){setError('请选择 .pdf 文件。');return;}if(file.size>200*1024*1024){setError('当前支持 200 MB 以内的 PDF，请先拆分较大的文件。');return;}if(edits.length&&history.current.length&&!window.confirm('打开新的 PDF 会替换当前未导出的编辑，继续吗？'))return;busyRef.current=true;setBusy('正在打开文件…');try{await load(new Uint8Array(await file.arrayBuffer()),file.name);}catch{setError('文件读取失败，请重试。');setBusy('');busyRef.current=false;}}
 async function demo(){if(busyRef.current)return;busyRef.current=true;setBusy('正在准备示例扫描件…');try{await load(await demoPdf(),'扫描手记 · 示例.pdf');}catch{setBusy('');busyRef.current=false;setError('示例生成失败，请重新尝试。');}}
 useEffect(()=>{let live=true;setRaw(null);if(!doc||!e)return;setRendering(true);renderPage(doc,e.source,e.rotation,1800).then(c=>{if(live){setRaw(c);setRendering(false);}}).catch(()=>{if(live){setError('页面预览失败，请重新导入文件。');setRendering(false);}});return()=>{live=false;};},[doc,e?.source,e?.rotation]);
 useEffect(()=>{if(!raw||!e||!view.current)return;const c=view.current,ctx=c.getContext('2d')!;if(mode==='crop'){c.width=raw.width;c.height=raw.height;ctx.drawImage(raw,0,0);}else{const ll=layout(e),ratio=1400/Math.max(ll.w,ll.h);c.width=Math.ceil(ll.w*ratio);c.height=Math.ceil(ll.h*ratio);ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);const a=e.crop;ctx.drawImage(raw,raw.width*a.x,raw.height*a.y,raw.width*a.w,raw.height*a.h,ll.x*ratio,ll.y*ratio,ll.iw*ratio,ll.ih*ratio);}},[raw,e,mode]);
 function start(ev:PointerEvent<HTMLDivElement>,handle:string){if(!e||!raw||rendering)return;ev.preventDefault();ev.stopPropagation();ev.currentTarget.setPointerCapture(ev.pointerId);const rect=paper.current!.getBoundingClientRect();gesture.current={handle,x:ev.clientX,y:ev.clientY,rect,c:{...e.crop},before:copy(edits),id:e.id,offsetX:e.offsetX,offsetY:e.offsetY};}
 function move(ev:PointerEvent<HTMLDivElement>){const g=gesture.current;if(!g)return;const dx=(ev.clientX-g.x)/g.rect.width,dy=(ev.clientY-g.y)/g.rect.height;if(g.handle==='content'){const ll=layout(e);setEdits(g.before.map((a:Edit)=>a.id===g.id?{...a,offsetX:clamp(g.offsetX+dx*ll.w/MM,-500,500),offsetY:clamp(g.offsetY+dy*ll.h/MM,-500,500)}:a));return;}const c=g.c;let x=c.x,y=c.y,r=c.x+c.w,b=c.y+c.h;const h=g.handle;if(h==='move'){x=clamp(c.x+dx,0,1-c.w);y=clamp(c.y+dy,0,1-c.h);r=x+c.w;b=y+c.h;}else{if(h.includes('w'))x=clamp(c.x+dx,0,r-.01);if(h.includes('e'))r=clamp(r+dx,x+.01,1);if(h.includes('n'))y=clamp(c.y+dy,0,b-.01);if(h.includes('s'))b=clamp(b+dy,y+.01,1);}setEdits(g.before.map((a:Edit)=>a.id===g.id?{...a,crop:{x,y,w:r-x,h:b-y}}:a));}
 function end(){const g=gesture.current;if(g){if(JSON.stringify(g.before)!==JSON.stringify(editsRef.current))remember(g.before);gesture.current=null;}}
 function movePage(delta:number){const a=[...edits];[a[idx],a[idx+delta]]=[a[idx+delta],a[idx]];commit(a);}
 function applyAll(){if(!e)return;commit(edits.map(a=>({...a,crop:{...e.crop},paper:e.paper,customW:e.customW,customH:e.customH,margin:e.margin,scale:e.scale,offsetX:e.offsetX,offsetY:e.offsetY})));setToast('已将裁剪比例与排版设置应用到全部页面；各页旋转角度保留。');}
 async function download(){if(!doc||busyRef.current)return;busyRef.current=true;setModal(false);setError('');try{const limit=byteLimit(originalSize);const result=await exportPdf(doc,scope==='current'?[e]:edits,{source:sourceBytes.current!,maxBytes:limit,allowCompression},setBusy);checkSize(result.bytes,limit);const blob=new Blob([result.bytes as BlobPart],{type:'application/pdf'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${name.replace(/\.pdf$/i,'')}-已裁剪.pdf`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);setToast(`已导出 ${fileSize(result.bytes.byteLength)}（原文件 ${fileSize(originalSize)}）。${result.method==='original'?'保留原始清晰度。':'已压缩图像，请检查文字清晰度。'}`);}catch(err:any){setError(err?.message||'导出失败，请选择“仅当前页”后重试。');}finally{setBusy('');busyRef.current=false;}}
 const showTool=useEffectEvent(async (next:ToolTab|null)=>{
  if(busyRef.current)return;
  setError('');setToast('');setDragOver(false);setModal(false);setHelp(false);setTool(next);
  if(next!=='crop'||!sourceBytes.current)return;
  busyRef.current=true;setBusy('正在恢复编辑预览…');
  try{const previous=docRef.current;const renewed=await openPdf(sourceBytes.current.slice());docRef.current=renewed;setDoc(renewed);if(previous)await previous.destroy();}
  catch{setError('预览恢复失败，请重新打开原文件。');}
  finally{setBusy('');busyRef.current=false;}
 });
 useEffect(()=>{if(route!==tool&&!busy&&!toolBusy)void showTool(route);},[route,tool,busy,toolBusy]);
 useEffect(()=>{
  document.title=tool?`${toolLabel(tool)} · 裁纸台`:'裁纸台 · PDF 工具导航';
  if(firstScreen.current){firstScreen.current=false;return;}
  window.scrollTo(0,0);
  document.getElementById(tool?'tool-workbench':'tool-directory')?.focus({preventScroll:true});
 },[tool]);
 const navigationLocked=toolBusy||!!busy;
 const ratio=e?(mode==='crop'?d.w/d.h:l!.w/l!.h):.707;
 return <main className={`app${tool==='crop'?' crop-page':tool?'':' directory-page'}${dragOver?' is-dragging':''}`} onDragOver={ev=>{if(tool==='crop'&&ev.dataTransfer.types.includes('Files')){ev.preventDefault();setDragOver(true);}}} onDragLeave={ev=>{if(!ev.currentTarget.contains(ev.relatedTarget as Node))setDragOver(false);}} onDrop={ev=>{ev.preventDefault();setDragOver(false);if(tool==='crop')selectFile(ev.dataTransfer.files[0]);}}>
 <header className="app-header">
  <div className={`topbar${feedbackUrl ? ' has-feedback' : ''}`}>
   <div className="tool-brand-row">
    <a className="brand" href={toolHref(null)} aria-label="裁纸台首页" aria-disabled={navigationLocked||undefined} tabIndex={navigationLocked?-1:undefined} onClick={event=>{if(navigationLocked)event.preventDefault();}}><span className="brand-icon"><Crop size={22}/></span><span className="brand-name">裁纸台</span></a>
    {tool&&<a className="tool-home-link" href={toolHref(null)} aria-disabled={navigationLocked||undefined} tabIndex={navigationLocked?-1:undefined} onClick={event=>{if(navigationLocked)event.preventDefault();}}>全部工具</a>}
   </div>
   {tool&&<WorkspaceSearch key={tool} disabled={navigationLocked}/>}
   {feedbackUrl && (
    <a className="feedback-link" href={feedbackUrl} target="_blank" rel="noopener noreferrer" title="在新标签页打开腾讯问卷">
     <MessageSquareText size={16} aria-hidden="true"/>意见与反馈
    </a>
   )}
   {tool==='crop'&&doc&&<div className="top-actions">
    <button className="icon-button help-button" title="使用帮助" aria-label="使用帮助" onClick={()=>setHelp(true)}><BookOpen size={19}/></button>
    <button className="button" disabled={!!busy} onClick={()=>input.current?.click()}><Upload size={16}/><span>打开新文件</span></button>
    <button className="button primary" disabled={!e||!!busy} onClick={()=>setModal(true)}><Download size={16}/>导出 PDF</button>
   </div>}
  </div>
  {tool&&<ToolNav key={tool} active={tool} disabled={navigationLocked}/>}
 </header>
 <input type="file" ref={input} accept=".pdf,application/pdf" hidden onChange={ev=>{selectFile(ev.target.files?.[0]);ev.target.value='';}}/>
 {!tool&&<ToolDirectory/>}
 <div className="tool-workbench" hidden={!tool} tabIndex={-1} id="tool-workbench" role="region" aria-label={tool?toolLabel(tool):undefined}>
 <PdfTools active={tool??'crop'} current={sourceBytes.current?{name,bytes:sourceBytes.current}:null} onBusy={setToolBusy}/>
 <div className={`workspace ${doc?'crop-workspace':'crop-start'}`} style={{display:tool==='crop'?undefined:'none'}}>
 {!doc?<div className="pdf-tools crop-intro">
  <ToolHeading tool="crop" description="拖动裁剪框或输入边距，调整扫描件和 PDF 的页面版式。" />
  <div className="tool-grid">
   <ToolFilePanel title="导入要裁剪的 PDF" hint="可拖入 PDF，支持多页文件，最大 200 MB。"
    action="选择 PDF 文件" onChoose={()=>input.current?.click()} disabled={!!busy}
    onReuse={demo} reuseLabel="先用示例试试看" />
   <aside className="crop-guide">
    <h3>裁剪步骤</h3>
    <ol>
     <li><Crop size={18} aria-hidden="true" /><div><strong>选定保留范围</strong><p>拖动蓝框，或输入要裁去的边距。</p></div></li>
     <li><Expand size={18} aria-hidden="true" /><div><strong>调整页面大小</strong><p>可切换纸张、缩放内容，或添加留白。</p></div></li>
     <li><Download size={18} aria-hidden="true" /><div><strong>导出 PDF</strong><p>可导出当前页或全部页面，文件不超过原大小。</p></div></li>
    </ol>
   </aside>
  </div>
 </div>:<>
 <aside className="pages-panel">
  <div className="panel-heading"><h2>文档页面</h2><span className="count">{edits.length}</span></div>
  <div className="file-label" title={name}><FileText size={15}/><span>{name}</span></div>
  <div className="thumbnails">{edits.map((a,i)=><Thumbnail key={a.id} doc={doc} edit={a} selected={a.id===e.id} onClick={()=>setActive(a.id)} index={i}/>)}</div>
  <div className="page-actions"><button title="页面上移" aria-label="页面上移" disabled={idx<=0} onClick={()=>movePage(-1)}><ChevronUp size={17}/></button><button title="页面下移" aria-label="页面下移" disabled={idx>=edits.length-1} onClick={()=>movePage(1)}><ChevronDown size={17}/></button><button title="删除当前页" aria-label="删除当前页" disabled={edits.length<=1} onClick={()=>{commit(edits.filter(a=>a.id!==e.id));setActive(edits[idx===edits.length-1?idx-1:idx+1].id);}}><Trash2 size={16}/></button></div>
 </aside>
 <section className="editor"><div className="toolbar"><div className="segmented"><button className={mode==='crop'?'active':''} onClick={()=>setMode('crop')}><Crop size={16}/>裁剪边框</button><button className={mode==='layout'?'active':''} onClick={()=>setMode('layout')}><Expand size={16}/>缩放排版</button></div><div className="tools"><button title="撤销 (⌘/Ctrl Z)" aria-label="撤销" disabled={!history.current.length||!!busy} onClick={undo}><Undo2 size={17}/></button><button title="重做" aria-label="重做" disabled={!future.current.length||!!busy} onClick={redo}><Redo2 size={17}/></button><span className="divider"/><button title="顺时针旋转 90°" aria-label="顺时针旋转 90 度" disabled={!e} onClick={()=>commit(edits.map(a=>a.id===e.id?rotateEdit(a):a))}><RotateCw size={17}/></button></div></div>
 <button type="button" className="crop-settings-jump" onClick={()=>{settings.current?.scrollIntoView({block:'start'});settings.current?.focus({preventScroll:true});}}><SlidersHorizontal size={15} aria-hidden="true" />{mode==='crop'?'查看裁剪设置':'查看排版设置'}</button>
 <div className="stage">
 <div className="canvas-label"><span>第 {idx+1} 页 / 共 {edits.length} 页</span><span>{mode==='crop'?'蓝框内的内容将被保留':'导出效果预览'}</span></div><div className="paper-space"><div ref={paper} className={`paper ${mode==='layout'?'layout-paper':''}`} style={{aspectRatio:ratio,width:`min(${zoom*100}%, calc(var(--paper-height) * ${ratio} * ${zoom}))`,minWidth:zoom>1?`min(${zoom*100}%, calc(var(--paper-height) * ${ratio} * ${zoom}))`:undefined}} onPointerDown={mode==='layout'?(ev)=>start(ev,'content'):undefined} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}><canvas ref={view} style={{visibility:raw?'visible':'hidden'}}/>{rendering&&<div className="rendering">正在绘制页面…</div>}{raw&&mode==='crop'&&<div className="crop-overlay"><div className="crop-box" style={{left:`${e.crop.x*100}%`,top:`${e.crop.y*100}%`,width:`${e.crop.w*100}%`,height:`${e.crop.h*100}%`}} onPointerDown={ev=>start(ev,'move')}><div className="crop-grid"/><span className="crop-size">{(d.w*e.crop.w/MM).toFixed(1)} × {(d.h*e.crop.h/MM).toFixed(1)} mm</span>{['nw','n','ne','e','se','s','sw','w'].map(h=><div key={h} className={`handle handle-${h}`} onPointerDown={ev=>start(ev,h)}/>)}</div></div>}</div></div><div className="canvas-tip">{mode==='crop'?<Crop size={14}/>:<Move size={14}/>}<span>{mode==='crop'?'拖动角点或边线裁剪 · 拖动选框移动区域':'拖动纸面移动内容 · 右侧调整大小与留白'}</span></div>
 </div><footer className="editor-footer"><span><span className="status-dot"/>编辑仅保存在当前窗口</span><div className="zoom"><button aria-label="缩小预览" disabled={!doc||zoom<=.5} onClick={()=>setZoom(clamp(zoom-.25,.5,2))}><Minus size={14}/></button><button onClick={()=>setZoom(1)} disabled={!doc} title="适合窗口">{Math.round(zoom*100)}%</button><button aria-label="放大预览" disabled={!doc||zoom>=2} onClick={()=>setZoom(clamp(zoom+.25,.5,2))}><Plus size={14}/></button></div></footer></section>
 <aside className="settings" ref={settings} tabIndex={-1}><div className="panel-heading"><h2>{mode==='crop'?'裁剪设置':'排版设置'}</h2><SlidersHorizontal size={17}/></div><div className="settings-body"><div className="settings-intro"><span className="step-icon">{mode==='crop'?<Crop size={20}/>:<Expand size={20}/>}</span><h3>{mode==='crop'?'留下你需要的区域':'给内容合适的空间'}</h3><p>{mode==='crop'?'拖动蓝色边框，也可以输入精确数值。':'裁剪后的内容会等比缩放，不会拉伸变形。'}</p></div>
 <fieldset disabled={!e||!!busy}>{mode==='crop'?<><div className="section-label">裁去的边距 <span>毫米</span></div><div className="number-grid">{(['top','bottom','left','right'] as const).map((s,i)=><NumberField key={s} label={['上边','下边','左边','右边'][i]} value={e?({top:e.crop.y*d.h,bottom:(1-e.crop.y-e.crop.h)*d.h,left:e.crop.x*d.w,right:(1-e.crop.x-e.crop.w)*d.w}[s])/MM:0} max={(s==='top'||s==='bottom'?d.h:d.w)/MM} onChange={n=>patch({crop:marginCrop(e,s,n)})}/>)}</div><button className="button full subtle" onClick={()=>patch({crop:fullCrop()})}><Maximize2 size={15}/>恢复完整页面</button><div className="measure"><span>保留区域</span><strong>{e?`${(d.w*e.crop.w/MM).toFixed(1)} × ${(d.h*e.crop.h/MM).toFixed(1)}`:'— × —'} <small>mm</small></strong></div><div className="note"><span className="note-dot"/>裁剪后可切换到「缩放排版」，将扫描内容放大、缩小或放到 A4 纸上。</div><button className="button full" onClick={()=>setMode('layout')}>下一步：调整大小 <ArrowRight size={15}/></button></>:<><label className="select-field">输出纸张<select value={e?.paper||'crop'} onChange={ev=>patch({paper:ev.target.value})}><option value="crop">随裁剪区域大小</option><option value="original">原始纸张大小</option><option value="a4">A4 纵向 · 210 × 297 mm</option><option value="a4-landscape">A4 横向 · 297 × 210 mm</option><option value="custom">自定义尺寸</option></select></label>{e?.paper==='custom'&&<div className="number-grid"><NumberField label="纸张宽度" value={e.customW} min={10} max={1000} onChange={n=>patch({customW:n})}/><NumberField label="纸张高度" value={e.customH} min={10} max={1000} onChange={n=>patch({customH:n})}/></div>}<div className="slider-label"><label htmlFor="scale">内容缩放</label><strong>{e?.scale||100}%</strong></div><input id="scale" className="range" type="range" min="10" max="200" value={e?.scale||100} onChange={ev=>patch({scale:Number(ev.target.value)})}/><div className="range-labels"><span>10%</span><span>适合纸张 100%</span><span>200%</span></div><NumberField label="四周留白" value={e?.margin||0} max={e?Math.max(0,Math.floor(Math.min(l!.w,l!.h)/MM/2)-1):100} onChange={n=>patch({margin:n})}/><div className="section-label">内容位置 <span>相对居中</span></div><div className="number-grid"><NumberField label="水平偏移" value={e?.offsetX||0} min={-500} max={500} onChange={n=>patch({offsetX:n})}/><NumberField label="垂直偏移" value={e?.offsetY||0} min={-500} max={500} onChange={n=>patch({offsetY:n})}/></div><button className="button full subtle" onClick={()=>patch({scale:100,offsetX:0,offsetY:0})}><Expand size={15}/>适合纸张并居中</button>{l?.clipped&&<div className="warning">部分内容超出纸张边界，导出时会被切掉。请缩小或移动内容。</div>}<div className="measure"><span>导出纸张尺寸</span><strong>{l?`${(l.w/MM).toFixed(1)} × ${(l.h/MM).toFixed(1)}`:'— × —'} <small>mm</small></strong></div></>}
 <div className="batch"><button className="button full" disabled={!e||edits.length<2} onClick={applyAll}>应用到全部 {edits.length||''} 页</button><p>同步裁剪比例与排版设置，适合尺寸和版式相近的扫描页。</p></div></fieldset></div><div className="settings-foot"><Check size={14}/> 可随时撤销，原始文件保持完整</div></aside></>}
 </div>
 </div>
 {toast&&<div className="toast" role="status"><Check size={17}/>{toast}<button aria-label="关闭提示" onClick={()=>setToast('')}><X size={14}/></button></div>}{error&&<div className="error-toast" role="alert">{error}<button aria-label="关闭错误提示" onClick={()=>setError('')}><X size={16}/></button></div>}
 {busy&&<div className="scrim busy" role="status" aria-live="polite"><div className="busy-card"><div className="spinner"/><h3>{busy}</h3><p>文件正在本机处理，请保持页面打开。</p></div></div>}{dragOver&&<div className="drop-overlay"><Upload size={38}/><h2>松开鼠标，打开 PDF</h2><p>文件只会在本机处理</p></div>}
 {modal&&<div className="scrim" onClick={()=>setModal(false)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="export-title" onClick={ev=>ev.stopPropagation()}><button className="modal-close" aria-label="关闭导出设置" onClick={()=>setModal(false)}><X size={20}/></button><span className="modal-icon"><Download size={25}/></span><h2 id="export-title">把整理好的文档带走</h2><p>生成一份新的 PDF，原文件不受影响。</p><label className="select-field">导出范围<select value={scope} onChange={ev=>setScope(ev.target.value)}><option value="all">全部页面（{edits.length} 页）</option><option value="current">仅当前页（第 {idx+1} 页）</option></select></label><div className="size-summary"><span>原文件大小</span><strong>{fileSize(originalSize)}</strong></div><p className="size-note">导出上限自动等于原文件大小，按实际字节数检查。超限文件不会下载。</p><label className="compression-option"><input type="checkbox" checked={allowCompression} onChange={ev=>setAllowCompression(ev.target.checked)}/><span>超限时压缩图像<small>仅在保留原图无法满足上限时启用，可能降低文字清晰度。取消勾选则超限时停止。</small></span></label><div className="note">优先保留原图与文字，直接裁剪和缩放，不重新生成高清图片。原图模式仅隐藏框外内容，不适合隐私脱敏。压缩模式会生成图像 PDF，不保留文字／OCR 层；表单、链接和签名不保证保留。</div>{(scope==='current'?[e]:edits).some(a=>layout(a).clipped)&&<div className="warning">有页面的内容超出纸张，超出部分会在导出时切掉。</div>}<button className="button primary full large" autoFocus onClick={download}><Download size={17}/>下载 PDF</button></section></div>}
 {help&&<div className="scrim" onClick={()=>setHelp(false)}><section className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={ev=>ev.stopPropagation()}><button className="modal-close" aria-label="关闭帮助" onClick={()=>setHelp(false)}><X size={20}/></button><h2 id="help-title">三步，整理一份扫描件</h2><ol><li><strong>打开文件，裁掉边框</strong><p>拖入 PDF，选择一页。拖动蓝框的角点或边线，也可输入要裁去的毫米数。</p></li><li><strong>调整扫描内容的大小</strong><p>切换「缩放排版」，选择 A4 或自定义纸张。用滑块缩放内容，在纸面上拖动调整位置。</p></li><li><strong>检查各页，导出 PDF</strong><p>左侧切换、排序或删除页面。版式相近时可应用到全部页。确认预览后导出，文件大小不超过原文件。</p></li></ol><p className="note">编辑记录仅保留在当前窗口，关闭前请导出。此工具面向扫描件，不编辑图像中的文字。页面内容由 <a href="https://mozilla.github.io/pdf.js/" target="_blank" rel="noreferrer">PDF.js</a> 显示，由 <a href="https://pdf-lib.js.org/" target="_blank" rel="noreferrer">pdf-lib</a> 生成文件。</p><button className="button primary full" autoFocus onClick={()=>setHelp(false)}>开始整理</button></section></div>}
 </main>;
}
