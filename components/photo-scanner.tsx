'use client';

import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Camera, Download, ImagePlus, RotateCw, ScanLine, Trash2, X } from 'lucide-react';
import { ToolHeading } from './tool-workspace';
import { scanPreviewKey, useScanPreviews } from './use-scan-previews';
import { downloadBytes, safeStem } from '../lib/pdf/tools';
import { fileSize } from '../lib/pdf/export';
import { ScanWorker, copyQuad, fullQuad, importScanPhoto, renderScan, scanPdf, validQuad, type Detection, type Point, type Quad, type ScanPhoto, type ScanSettings } from '../lib/scanner/client';

const ACCEPT = '.jpg,.jpeg,.png,.webp,.heic,.heif,image/jpeg,image/png,image/webp,image/heic,image/heif';
const CORNERS = ['左上角','右上角','右下角','左下角'];
const EDGES = ['上边','右边','下边','左边'];
function useBlobUrl(blob?: Blob) {
  const [url,setUrl]=useState('');
  useEffect(()=>{if(!blob){setUrl('');return;}const url=URL.createObjectURL(blob);setUrl(url);return()=>URL.revokeObjectURL(url);},[blob]);
  return url;
}
function CornerEditor({photo,disabled,onChange}:{photo:ScanPhoto;disabled:boolean;onChange:(points:Quad)=>void}) {
  const url=useBlobUrl(photo.preview), frame=useRef<HTMLDivElement>(null),image=useRef<HTMLImageElement>(null),magnifier=useRef<HTMLCanvasElement>(null);
  const gesture=useRef<{index:number;edge:boolean;x:number;y:number;rect:DOMRect;points:Quad}|null>(null);
  const [focus,setFocus]=useState<Point|null>(null),[zoom,setZoom]=useState(1);
  useEffect(()=>{
    if(!focus||!magnifier.current||!image.current?.complete)return;
    const ctx=magnifier.current.getContext('2d')!,img=image.current;
    ctx.fillStyle='#fff';ctx.fillRect(0,0,120,120);
    ctx.drawImage(img,focus.x*img.naturalWidth-35,focus.y*img.naturalHeight-35,70,70,0,0,120,120);
    ctx.strokeStyle='#176bdf';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(48,60);ctx.lineTo(72,60);ctx.moveTo(60,48);ctx.lineTo(60,72);ctx.stroke();
  },[focus]);
  function start(event:PointerEvent<HTMLElement|SVGElement>,index:number,edge=false) {
    if(disabled||!frame.current)return;
    event.preventDefault();event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current={index,edge,x:event.clientX,y:event.clientY,rect:frame.current.getBoundingClientRect(),points:copyQuad(photo.points)};
    setFocus(photo.points[index]);
  }
  function shift(points:Quad,index:number,edge:boolean,dx:number,dy:number) {
    const indices=edge?[index,(index+1)%4]:[index];
    dx=Math.max(...indices.map(i=>-points[i].x),Math.min(dx,...indices.map(i=>1-points[i].x)));
    dy=Math.max(...indices.map(i=>-points[i].y),Math.min(dy,...indices.map(i=>1-points[i].y)));
    const next=points.map((p,i)=>indices.includes(i)?{x:p.x+dx,y:p.y+dy}:{...p}) as Quad;
    if(validQuad(next)){onChange(next);setFocus(next[index]);}
  }
  function move(event:PointerEvent) {
    const g=gesture.current;if(!g)return;
    shift(g.points,g.index,g.edge,(event.clientX-g.x)/g.rect.width,(event.clientY-g.y)/g.rect.height);
  }
  function keyboard(event:KeyboardEvent,index:number,edge:boolean) {
    const directions:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
    const direction=directions[event.key];if(!direction||disabled)return;
    event.preventDefault();const step=event.shiftKey?.01:.002;
    shift(photo.points,index,edge,direction[0]*step,direction[1]*step);
  }
  const polygon=photo.points.map(p=>`${p.x*1000},${p.y*1000}`).join(' ');
  return <div className="scan-edge-editor">
    <div className="scan-editor-caption"><span>拖动四角或边线纠正纸张边框</span><label>放大<input aria-label={`放大 ${photo.name}`} type="range" min="1" max="2" step=".1" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/></label></div>
    <div className="scan-crop-scroll"><div className="scan-crop-padding" style={{width:`${zoom*100}%`}}>
      <div className="scan-crop-frame" ref={frame} style={{aspectRatio:`${photo.width}/${photo.height}`}} onPointerMove={move} onPointerUp={()=>{gesture.current=null;setFocus(null);}} onPointerCancel={()=>{gesture.current=null;setFocus(null);}}>
        {url&&<img ref={image} src={url} alt={`${photo.name} 原照片与纸张四角`} draggable={false}/>}
        <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true"><path d={`M0 0H1000V1000H0Z M${photo.points.map(p=>`${p.x*1000} ${p.y*1000}`).join('L')}Z`} fillRule="evenodd"/><polygon points={polygon}/>{photo.points.map((p,i)=>{const q=photo.points[(i+1)%4];return <line key={i} className="scan-drag-edge" x1={p.x*1000} y1={p.y*1000} x2={q.x*1000} y2={q.y*1000} onPointerDown={e=>start(e,i,true)}/>;})}</svg>
        {photo.points.map((p,index)=><button key={index} className="scan-corner" style={{left:`${p.x*100}%`,top:`${p.y*100}%`}} aria-label={`调整${CORNERS[index]}`} disabled={disabled}
          onPointerDown={e=>start(e,index)} onKeyDown={e=>keyboard(e,index,false)} onBlur={()=>{if(!gesture.current)setFocus(null);}}><span/></button>)}
        {photo.points.map((p,index)=>{const q=photo.points[(index+1)%4];return <button key={index} className={`scan-edge scan-edge-${index}`} style={{left:`${(p.x+q.x)*50}%`,top:`${(p.y+q.y)*50}%`}} aria-label={`移动${EDGES[index]}`} disabled={disabled}
          onPointerDown={e=>start(e,index,true)} onKeyDown={e=>keyboard(e,index,true)} onBlur={()=>{if(!gesture.current)setFocus(null);}}/>;})}
        {focus&&<canvas ref={magnifier} width={120} height={120} className="scan-magnifier" aria-label="角点放大镜" style={{left:`${Math.max(15,Math.min(85,focus.x*100))}%`,top:`${focus.y>.25?Math.max(3,focus.y*100-24):Math.min(72,focus.y*100+12)}%`}}/>}
      </div>
    </div></div>
  </div>;
}
function PhotoCard({photo,index,total,disabled,rendering,previewError,retry,update,detect,remove,move}:{photo:ScanPhoto;index:number;total:number;disabled:boolean;rendering:boolean;previewError?:string;retry:()=>void;update:(patch:Partial<ScanPhoto>)=>void;detect:()=>void;remove:()=>void;move:(offset:number)=>void}) {
  const resultUrl=useBlobUrl(photo.result?.blob);
  const settings=(patch:Partial<ScanSettings>)=>update({settings:{...photo.settings,...patch},dirty:true});
  return <article className="scan-photo" aria-label={`扫描第 ${index+1} 页`}>
    <header className="scan-photo-heading"><div><h3>第 {index+1} 页 <span>{photo.name}</span></h3><p>{photo.width} × {photo.height} 像素{photo.confidence==='detected'?'，已自动识别边框':'，请核对四角位置'}</p></div>
      <div className="scan-page-actions"><button className="button" aria-label={`上移第 ${index+1} 页`} disabled={disabled||index===0} onClick={()=>move(-1)}><ArrowUp size={16}/></button><button className="button" aria-label={`下移第 ${index+1} 页`} disabled={disabled||index===total-1} onClick={()=>move(1)}><ArrowDown size={16}/></button><button className="button" aria-label={`删除第 ${index+1} 页`} disabled={disabled} onClick={remove}><Trash2 size={16}/></button></div>
    </header>
    {photo.warning&&<p className="scan-warning" role="status">{photo.warning}</p>}
    <div className="scan-photo-workspace"><section className="scan-original"><h4>照片与边框</h4><CornerEditor photo={photo} disabled={disabled} onChange={points=>update({points,dirty:true})}/>
      <div className="scan-crop-actions"><button className="button" disabled={disabled} onClick={detect}><ScanLine size={16}/>重新识别</button><button className="button" disabled={disabled} onClick={()=>update({points:copyQuad(photo.initial),dirty:true})}>恢复识别框</button><button className="button" disabled={disabled} onClick={()=>update({points:fullQuad(),dirty:true})}>使用整张照片</button></div>
    </section><section className="scan-result"><div className="scan-result-heading"><h4>扫描效果</h4><span>{previewError?'预览生成失败':photo.dirty||!photo.result?(rendering?'正在自动更新…':'等待自动更新…'):photo.needsReview?'预览已更新，请核对边框':'预览已更新'}</span></div>
      <div className={`scan-result-paper${photo.dirty?' scan-result-stale':''}`} aria-busy={photo.dirty||!photo.result}>
        {resultUrl?<img src={resultUrl} width={photo.result?.width} height={photo.result?.height} alt={`第 ${index+1} 页扫描预览`} loading="lazy"/>:<div className="scan-result-empty"><ScanLine size={32}/><p>正在自动生成扫描效果</p></div>}
        {photo.dirty&&photo.result&&!previewError&&<span className="scan-preview-notice" role="status">正在自动更新预览…</span>}
      </div>
      {previewError&&<div className="scan-preview-error" role="alert"><span>{previewError}</span><button className="button" disabled={disabled} onClick={retry}>重试预览</button></div>}
      <fieldset disabled={disabled} className="scan-page-settings"><div className="scan-mode-choices" aria-label="扫描模式">{([{id:'color',label:'彩色扫描'},{id:'bw',label:'黑白文档'},{id:'original',label:'原色保留'}] as const).map(mode=><button key={mode.id} aria-pressed={photo.settings.mode===mode.id} onClick={()=>settings({mode:mode.id})}>{mode.label}</button>)}</div>
        <div className="scan-setting-row"><label>纸张比例<select aria-label={`第 ${index+1} 页纸张比例`} value={photo.settings.paper} onChange={e=>settings({paper:e.target.value as ScanSettings['paper']})}><option value="auto">自动比例（估算）</option><option value="a4">A4 纵向</option><option value="a4-landscape">A4 横向</option><option value="a5">A5 纵向</option></select></label><button className="button" onClick={()=>settings({rotation:(photo.settings.rotation+90)%360})}><RotateCw size={16}/>旋转结果</button></div>
        {photo.settings.mode!=='original'&&<label className="scan-strength">增强程度 <input aria-label={`第 ${index+1} 页增强程度`} type="range" min="0" max="100" value={photo.settings.strength} onChange={e=>settings({strength:Number(e.target.value)})}/><span>{photo.settings.strength}%</span></label>}
        <p className="scan-settings-note">彩色扫描保留格线、照片和印章颜色。黑白模式请核对浅色字与细线。</p>
      </fieldset>
    </section></div>
  </article>;
}
export default function PhotoScanner({active,onBusy}:{active:boolean;onBusy:(busy:boolean)=>void}) {
  const [photos,setPhotos]=useState<ScanPhoto[]>([]),[busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [name,setName]=useState('拍照扫描'),[quality,setQuality]=useState(3508),[limit,setLimit]=useState(true);
  const input=useRef<HTMLInputElement>(null),camera=useRef<HTMLInputElement>(null),controller=useRef<AbortController|null>(null),worker=useRef<ScanWorker|null>(null);
  if(!worker.current)worker.current=new ScanWorker();
  useEffect(()=>()=>{controller.current?.abort();worker.current?.dispose();},[]);
  useEffect(()=>{if(!active)worker.current?.dispose();},[active]);
  const {rendering,failures,retry}=useScanPreviews(photos,setPhotos,active&&!busy);
  const pending=photos.filter(p=>p.dirty||!p.result).length,totalSize=photos.reduce((sum,p)=>sum+p.originalSize,0);
  async function task(action:(signal:AbortSignal)=>Promise<void>) {
    if(controller.current)return;const job=new AbortController();controller.current=job;setBusy('正在准备');setError('');setMessage('');onBusy(true);
    try{await action(job.signal);}catch(error){setError(job.signal.aborted?'已取消，已完成的页面仍保留。':error instanceof Error?error.message:'扫描失败，请重试。');}
    finally{controller.current=null;setBusy('');onBusy(false);}
  }
  function update(id:string,patch:Partial<ScanPhoto>) {setPhotos(previous=>previous.map(p=>p.id===id?{...p,...patch}:p));setMessage('');}
  async function preview(photo:ScanPhoto,signal:AbortSignal) {const result=await renderScan(photo,worker.current!,1200,setBusy,signal,.94,true);if(!signal.aborted)update(photo.id,{result,dirty:false});return result;}
  async function add(files:File[]) {
    if(!files.length)return;
    await task(async signal=>{
      if(photos.length+files.length>30||totalSize+files.reduce((n,f)=>n+f.size,0)>200*1024*1024)throw new Error('每次最多 30 张照片，原文件合计不超过 200 MB。');
      for(let i=0;i<files.length;i++) {
        const progress=(text:string)=>setBusy(`第 ${i+1} / ${files.length} 张：${text}`);
        const photo=await importScanPhoto(files[i],worker.current!,progress,signal);if(signal.aborted)return;
        setPhotos(previous=>[...previous,photo]);
        await preview(photo,signal);
      }
      setMessage('已生成扫描预览。请核对纸张四角、浅色文字和格线，再导出 PDF。');
    });
  }
  async function redetect(photo:ScanPhoto) {await task(async signal=>{const result=await worker.current!.call<Detection>('detect',{blob:photo.source},setBusy,signal);if(signal.aborted)return;update(photo.id,{points:copyQuad(result.points),initial:copyQuad(result.points),confidence:result.confidence,warning:result.warning,dirty:true,needsReview:result.confidence!=='detected'});});}
  async function exportPdf() {await task(async signal=>{const result=await scanPdf(photos,worker.current!,quality,limit,setBusy,signal);if(signal.aborted)return;downloadBytes(result.bytes,`${safeStem(name||'拍照扫描')}.pdf`,'application/pdf');setMessage(`已导出 ${photos.length} 页扫描 PDF，${fileSize(result.bytes.byteLength)}。${result.optimized?'已优化图片编码，保持所选分辨率。':''}`);});}
  return <section className="pdf-tools scanner-tool" hidden={!active}>
    <ToolHeading tool="photo-scan" description="拍照或选择照片，上传即生成扫描预览，调整边框、模式和增强程度时自动更新。"/>
    <input ref={input} type="file" accept={ACCEPT} multiple aria-label="选择扫描照片" hidden onChange={e=>{void add(Array.from(e.target.files||[]));e.target.value='';}}/>
    <input ref={camera} type="file" accept="image/*,.heic,.heif" capture="environment" aria-label="拍照扫描纸张" hidden onChange={e=>{void add(Array.from(e.target.files||[]));e.target.value='';}}/>
    <div className="scan-toolbar"><div className="scan-import-buttons"><button className="button primary" disabled={!!busy} onClick={()=>camera.current?.click()}><Camera size={18}/>拍照</button><button className="button" disabled={!!busy} onClick={()=>input.current?.click()}><ImagePlus size={18}/>{photos.length?'添加照片':'选择照片'}</button></div>
      <span className="scan-total">{photos.length?`${photos.length} 页，${pending?`${pending} 页预览自动更新中`:'可导出'}`:'支持 JPG、PNG、WebP、HEIC'}</span>
      <div className="scan-export-buttons">
      <button className="button primary" disabled={!!busy||!photos.length||pending>0} onClick={exportPdf}><Download size={18}/>导出扫描 PDF</button></div>
    </div>
    {!photos.length?<div className="scan-empty" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!busy)void add(Array.from(e.dataTransfer.files));}}><div className="scan-empty-paper" aria-hidden="true"><span/><span/><span/><span/><i/><i/><i/></div><h3>让照片成为一页扫描件</h3><p>把平整纸张拍完整，尽量让四个角都出现在照片里。</p><button className="button" disabled={!!busy} onClick={()=>input.current?.click()}>选择照片或拖到这里</button><small>照片在浏览器内处理，不上传到服务器。</small></div>:<>
      <div className="scan-export-settings"><label>文件名<input aria-label="扫描 PDF 文件名" value={name} disabled={!!busy} onChange={e=>setName(e.target.value)}/></label><label>清晰度<select aria-label="扫描 PDF 清晰度" value={quality} disabled={!!busy} onChange={e=>setQuality(Number(e.target.value))}><option value={3508}>高清（长边最多 3508 像素）</option><option value={2400}>标准（长边最多 2400 像素）</option></select></label><label className="scan-size-limit"><input type="checkbox" checked={limit} disabled={!!busy} onChange={e=>setLimit(e.target.checked)}/><span>不超过原照片合计大小<small>原照片合计 {fileSize(totalSize)}；无法满足时停止导出</small></span></label></div>
      <div className="scan-photo-list" aria-label="连续扫描页面">{photos.map((photo,index)=><PhotoCard key={photo.id} photo={photo} index={index} total={photos.length} disabled={!!busy} rendering={rendering===photo.id} previewError={failures[photo.id]?.key===scanPreviewKey(photo)?failures[photo.id].message:undefined} retry={()=>retry(photo.id)} update={patch=>update(photo.id,patch)} detect={()=>void redetect(photo)} remove={()=>{setPhotos(previous=>previous.filter(p=>p.id!==photo.id));setMessage('');}} move={offset=>setPhotos(previous=>{const next=[...previous];[next[index],next[index+offset]]=[next[index+offset],next[index]];return next;})}/>)}</div>
    </>}
    {busy&&<div className="tool-progress scan-progress" role="status"><div className="spinner"/><span>{busy}</span><button onClick={()=>controller.current?.abort()}>取消</button></div>}
    {error&&<div className="tool-result error" role="alert">{error}<button aria-label="关闭扫描错误" onClick={()=>setError('')}><X size={16}/></button></div>}
    {message&&<p className="tool-result" role="status">{message}</p>}
  </section>;
}
