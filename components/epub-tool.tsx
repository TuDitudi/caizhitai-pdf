'use client';
/* Local blob previews must not pass PDF content through a server image optimizer. */
/* eslint-disable @next/next/no-img-element */
import {useEffect,useRef,useState} from 'react';
import {BookOpen,Check,Download,FileText,Plus,ShieldCheck,X} from 'lucide-react';
import {type WordPage} from '../lib/pdf/word';
import {EpubConverter,inspectEpubFile} from '../lib/pdf/epub-converter';
import {makeEpub} from '../lib/pdf/epub';
import {cancelled,downloadBytes,pageRange,safeStem,type ToolFile} from '../lib/pdf/tools';
import {fileSize} from '../lib/pdf/export';

type Props={active:boolean;current:{name:string;bytes:Uint8Array}|null;onBusy:(busy:boolean)=>void};
function PageImage({page}:{page:WordPage}){
 const element=useRef<HTMLImageElement>(null);
 useEffect(()=>{if(!page.image)return;const u=URL.createObjectURL(new Blob([page.image as BlobPart],{type:'image/jpeg'}));if(element.current)element.current.src=u;return()=>URL.revokeObjectURL(u);},[page.image]);
 return <img ref={element} alt={`原第 ${page.page} 页外观`}/>;
}
export default function EpubTool({active,current,onBusy}:Props){
 const [file,setFile]=useState<ToolFile|null>(null),[pages,setPages]=useState<WordPage[]>([]),[selected,setSelected]=useState(0);
 const [mode,setMode]=useState<'auto'|'editable'|'image'>('auto'),[range,setRange]=useState(''),[forceOcr,setForceOcr]=useState(false),[ocrLanguage,setOcrLanguage]=useState<'chi_sim+eng'|'eng'>('chi_sim+eng');
 const [title,setTitle]=useState(''),[author,setAuthor]=useState(''),[language,setLanguage]=useState<'zh-CN'|'en'>('zh-CN'),[joinLines,setJoinLines]=useState(true),[includeCover,setIncludeCover]=useState(true);
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
 const input=useRef<HTMLInputElement>(null),lock=useRef(false),controller=useRef<AbortController|null>(null),converter=useRef<EpubConverter|null>(null);
 const packed=useRef<{pages:WordPage[];settings:string;blob:Blob}|null>(null);
 useEffect(()=>()=>{controller.current?.abort();converter.current?.dispose();},[]);
 function invalidate(){packed.current=null;setPages([]);setSelected(0);setMessage('');setError('');}
 async function task(fn:(signal:AbortSignal)=>Promise<void>){
  if(lock.current)return;lock.current=true;const abort=new AbortController();controller.current=abort;setBusy('正在准备…');setError('');setMessage('');onBusy(true);
  try{await fn(abort.signal);}catch(e:unknown){setError(e instanceof Error?e.message:'转换失败，请检查文件后重试。');}
  finally{setBusy('');lock.current=false;controller.current=null;onBusy(false);}
 }
 function acceptFile(next:ToolFile){converter.current?.dispose();converter.current=new EpubConverter(next);setFile(next);setTitle(safeStem(next.name));setRange('');setMode('auto');setForceOcr(false);invalidate();}
 async function addFile(next?:File){if(!next)return;await task(async signal=>{if(next.size>200*1024*1024)throw new Error('单个文件不能超过 200 MB。');const parsed=await inspectEpubFile(new Uint8Array(await next.arrayBuffer()),next.name);cancelled(signal);acceptFile(parsed);});}
 async function selectCurrent(){if(!current)return;await task(async signal=>{const parsed=await inspectEpubFile(current.bytes,current.name);cancelled(signal);acceptFile(parsed);});}
 let rangeError='';if(file){try{pageRange(range,file.pages);}catch(e:unknown){rangeError=e instanceof Error?e.message:'页码设置无效。';}}
 async function convert(refresh=false){if(!file||!converter.current)return;await task(async signal=>{
  invalidate();const result=await converter.current!.convert({range,mode,forceOcr,language:ocrLanguage},setBusy,signal,refresh);cancelled(signal);setPages(result.pages);setSelected(0);
  const elapsed=(result.elapsedMs/1000).toFixed(1),reused=result.reused?`已复用 ${result.reused} 页。`:'';
  const images=result.pages.filter(p=>p.method==='image'&&!p.warning).length,missing=result.pages.filter(p=>p.warning).length;
  setMessage(`已完成 ${result.pages.length} 页，用时 ${elapsed} 秒。${reused}${images?`${images} 页保留原图。`:''}${missing?`${missing} 页无法读取，已保留缺页提示。`:''}${images+missing===result.pages.length?'可下载 EPUB。':'文字页请校对后下载 EPUB。'}`);
 });}
 async function download(){if(!pages.length)return;await task(async signal=>{
  setBusy('正在生成 EPUB 电子书…');const settings=JSON.stringify({title,author,language,joinLines,includeCover});const cached=packed.current;
  let blob:Blob;
  if(cached?.pages===pages&&cached.settings===settings)blob=cached.blob;
  else{
   let cover:WordPage|null=null;
   if(includeCover){
    cover=pages[0].method==='image'?pages[0]:(await converter.current!.convert({range:String(pages[0].page),mode:'image',forceOcr:false,language:ocrLanguage},()=>setBusy('正在生成首页封面…'),signal)).pages[0];
   }
   cancelled(signal);blob=await makeEpub(pages,{title,author,language,joinLines,cover},signal);
  }
  cancelled(signal);packed.current={pages,settings,blob};
  downloadBytes(blob,`${safeStem(title)}.epub`,'application/epub+zip');setMessage(`EPUB 已下载，${fileSize(blob.size)}，包含 ${pages.length} 个页面章节${pages.some(p=>p.warning)?`（其中 ${pages.filter(p=>p.warning).length} 页是缺页提示）`:''}。`);
 });}
 const page=pages[selected];
 return <section className="pdf-tools epub-tool" style={{display:active?undefined:'none'}}>
  <div className="tool-title"><div><h2>PDF 转 EPUB</h2><p>把 PDF 变成电子书，在阅读器里随时阅读。</p></div><span><ShieldCheck size={15}/>全部在本机处理</span></div>
  <div className="tool-grid"><div className="tool-main" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();e.stopPropagation();if(!busy)void addFile(e.dataTransfer.files[0]);}}>
   <div className="tool-filebar"><input ref={input} aria-label="选择 EPUB 来源 PDF" type="file" accept=".pdf,application/pdf" hidden onChange={e=>{void addFile(e.target.files?.[0]);e.target.value='';}}/><button className="button" disabled={!!busy} onClick={()=>input.current?.click()}><Plus size={16}/>{file?'更换 PDF':'选择 PDF'}</button>{current&&<button className="button" disabled={!!busy} onClick={selectCurrent}>使用编辑器的原始文件</button>}<span>也可把 PDF 拖到这里</span></div>
   {file?<><div className="selected-tool-file"><FileText size={29}/><div><strong>{file.name}</strong><span>{file.pages} 页 · {fileSize(file.bytes.byteLength)}</span></div><span className="file-ready">已载入</span></div>
    <div className="word-preview"><div className="preview-heading"><h3>{page&&page.method!=='image'?'文字校对':'页面预览'}</h3>{pages.length>0&&<select aria-label="EPUB 预览页码" value={selected} disabled={!!busy} onChange={e=>setSelected(Number(e.target.value))}>{pages.map((p,i)=><option key={p.page} value={i}>原第 {p.page} 页{p.warning?' · 原文件损坏':p.method==='ocr'?' · 文字识别':p.method==='image'?' · 原图':''}</option>)}</select>}</div>
     {page?page.method!=='image'?<><textarea aria-label="校对 EPUB 文字" className="word-text" value={page.text} disabled={!!busy} onChange={e=>{const text=e.target.value;converter.current?.updateText(page,text,{range,mode,forceOcr,language:ocrLanguage});packed.current=null;setPages(pages.map((p,i)=>i===selected?{...p,text}:p));}}/><p className="preview-caption">可修改错字、用空行分段。每个源页面生成一个章节，并加入电子书目录。</p>{!page.text.trim()&&<p className="inline-hint">这一页没有提取到文字，可在这里补充，或选择页面图片模式。</p>}</>:<div className="word-image"><PageImage page={page}/></div>:<div className="preview-placeholder"><BookOpen size={30}/><p>{mode==='editable'?'转换完成后，可逐页校对电子书文字。':'转换完成后，可逐页预览文字或原图。'}</p></div>}
    </div></>:<div className="tool-empty"><BookOpen size={46}/><h3>给 PDF 一种新的读法</h3><p>文字版和扫描版都支持，转换后下载 .epub 文件。</p></div>}
  </div><aside className="tool-options"><fieldset disabled={!!busy}>
   <h3>电子书设置</h3>
   <label className="select-field">书名<input aria-label="EPUB 书名" maxLength={200} value={title} placeholder="默认使用 PDF 文件名" onChange={e=>setTitle(e.target.value)}/></label>
   <label className="select-field">作者（可选）<input aria-label="EPUB 作者" maxLength={150} value={author} onChange={e=>setAuthor(e.target.value)}/></label>
   <label className="select-field">电子书语言<select value={language} onChange={e=>setLanguage(e.target.value as 'zh-CN'|'en')}><option value="zh-CN">简体中文</option><option value="en">英文</option></select></label>
   <label className="select-field">阅读方式<select aria-label="EPUB 阅读方式" value={mode} onChange={e=>{setMode(e.target.value as 'auto'|'editable'|'image');invalidate();}}><option value="auto">自动（文字重排，扫描页保留原图）</option><option value="editable">文字重排（可调整阅读字号）</option><option value="image">页面图片（保留原页面外观）</option></select></label>
   <label className="compression-option"><input aria-label="使用所选首页作为封面" type="checkbox" checked={includeCover} onChange={e=>setIncludeCover(e.target.checked)}/><span>使用所选首页作为封面<small>在阅读器书架上显示首页缩略图。</small></span></label>
   <label className="select-field">转换页码<input aria-label="EPUB 转换页码" placeholder="全部页，或 1-3,5" value={range} onChange={e=>{setRange(e.target.value);invalidate();}}/></label>
   {rangeError&&<p className="inline-error">{rangeError}</p>}
   {mode==='editable'&&<><label className="select-field">扫描识别语言<select value={ocrLanguage} onChange={e=>{setOcrLanguage(e.target.value as 'chi_sim+eng'|'eng');invalidate();}}><option value="chi_sim+eng">简体中文 + 英文</option><option value="eng">英文</option></select></label><label className="compression-option"><input type="checkbox" checked={forceOcr} onChange={e=>{setForceOcr(e.target.checked);invalidate();}}/><span>所有页面重新识别<small>原有文字缺失或错乱时使用。</small></span></label><label className="compression-option epub-join"><input type="checkbox" checked={joinLines} onChange={e=>setJoinLines(e.target.checked)}/><span>合并段落内换行<small>空行保留分段；诗歌、列表可取消勾选。</small></span></label></>}
   <p className="note">{mode==='auto'?'自动模式保留扫描页和漫画原图，避免识别错字；有文字层的页面可调整阅读字号。若要提取扫描件文字，请选择文字重排。':mode==='editable'?'扫描页会进行文字识别。竖排繁体字、日文和漫画可能出现大量错字或丢失插图，建议改用自动或页面图片模式。':'保留每页原貌，使用固定版式阅读，适合漫画和复杂排版。图片中的文字不能调整字号或搜索。'}</p>
   {pages.some(p=>p.warning)&&<p className="inline-error" role="status">原 PDF 的第 {pages.filter(p=>p.warning).map(p=>p.page).join('、')} 页无法读取，已保留缺页提示。这些页未恢复，需完整原文件才能补全。</p>}
   <p className="note">再次转换会优先复用已完成的页面，取消后也可继续。扫描识别组件会保存在浏览器中，文件内容仅保留在当前窗口。</p>
   <p className="note">输出 EPUB 3，按源页生成目录。文件体积与 PDF 不同，不保证小于原文件。</p>
   <button className="button full" disabled={!file||!!rangeError} onClick={()=>convert()}><BookOpen size={16}/>{pages.length?'重新转换 EPUB':'开始转换 EPUB'}</button>
   {pages.length>0&&<button className="epub-reprocess" disabled={!file||!!rangeError} onClick={()=>convert(true)}>重新处理所选页（清除这些页的校对内容）</button>}
   <button className="button primary full word-download" disabled={!pages.length||!title.trim()} onClick={download}><Download size={16}/>下载 EPUB</button>
  </fieldset><div className="tool-foot"><ShieldCheck size={14}/>无需上传，本机处理</div></aside></div>
  {busy&&<div className="tool-progress" role="status"><div className="spinner"/><span>{busy}</span><button onClick={()=>{controller.current?.abort();setBusy('正在取消…');}}>取消</button></div>}
  {error&&<div className="tool-result error" role="alert">{error}<button aria-label="关闭 EPUB 错误" onClick={()=>setError('')}><X size={15}/></button></div>}
  {message&&<div className="tool-result" role="status"><Check size={17}/>{message}<button aria-label="关闭 EPUB 提示" onClick={()=>setMessage('')}><X size={15}/></button></div>}
 </section>;
}
