'use client';
import {useState,useRef,useEffect} from 'react';
import {FileText,ArrowUp,ArrowDown,Trash2,Download,Check,Scissors,Files,X} from 'lucide-react';
import { ToolFilePanel, ToolHeading, ToolNotes, ToolSettingsHeading } from './tool-workspace';
import {readToolFile,inspectPdf,splitGroups,safeStem,mergePdfs,splitPdf,zipPdfs,downloadBytes,type ToolFile} from '../lib/pdf/tools';
import EpubTool from './epub-tool';
import PdfLayoutEditor from './pdf-layout-editor';
import PhotoScanner from './photo-scanner';
import ImageTools from './image-tools';
import OfficeTools from './office-tools';
import OfdTool from './ofd-tool';
import {fileSize} from '../lib/pdf/export';
export type ToolTab='ofd-to-pdf'|'photo-scan'|'crop'|'word'|'merge'|'split'|'epub'|'images-to-pdf'|'pdf-to-images'|'ppt-to-pdf'|'pdf-to-ppt'|'excel-to-pdf'|'pdf-to-excel';
type Props={active:ToolTab;current:{name:string;bytes:Uint8Array}|null;onBusy:(busy:boolean)=>void};
export default function PdfTools({active,current,onBusy}:Props){
 const [merge,setMerge]=useState<ToolFile[]>([]),[split,setSplit]=useState<ToolFile|null>(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState('');
 const [splitMode,setSplitMode]=useState('custom'),[ranges,setRanges]=useState(''),[every,setEvery]=useState('2');
 const [outputName,setOutputName]=useState('合并文档');
 const input=useRef<HTMLInputElement>(null),lock=useRef(false),abort=useRef<AbortController|null>(null);
 useEffect(()=>{setError('');setMessage('');},[active]);
 async function task(fn:(signal:AbortSignal)=>Promise<void>){if(lock.current)return;lock.current=true;abort.current=new AbortController();setError('');setMessage('');setBusy('正在准备…');onBusy(true);try{await fn(abort.current.signal);}catch(e:any){setError(e?.message||'处理失败，请检查文件后重试。');}finally{setBusy('');lock.current=false;abort.current=null;onBusy(false);}}
 async function addFiles(files:File[]){if(!files.length)return;await task(async()=>{setBusy('正在读取文件…');const chosen=active==='merge'?files:files.slice(0,1);const parsed:ToolFile[]=[];for(const f of chosen)parsed.push(await readToolFile(f));if(active==='merge'){const next=[...merge,...parsed];if(next.length>100||next.reduce((n,f)=>n+f.bytes.byteLength,0)>200*1024*1024)throw new Error('合并最多 100 个文件，总大小不能超过 200 MB。');setMerge(next);}else{setSplit(parsed[0]);setRanges('');}});}
 async function useCurrent(){if(!current)return;await task(async()=>{const file=await inspectPdf(current.bytes,current.name);if(active==='merge'){const next=[...merge,file];if(next.length>100||next.reduce((n,f)=>n+f.bytes.byteLength,0)>200*1024*1024)throw new Error('合并文件的数量或总大小超过上限。');setMerge(next);}else{setSplit(file);setRanges('');}});}
 const selectedFile=split;
 let groups:number[][]=[],rangeError='';
 if(split){try{groups=splitGroups(splitMode,ranges,Number(every),split.pages);}catch(e:any){rangeError=e.message;}}
 async function doMerge(){await task(async signal=>{const bytes=await mergePdfs(merge,setBusy,signal);if(signal.aborted)throw new Error('操作已取消。');downloadBytes(bytes,`${safeStem(outputName||'合并文档')}.pdf`,'application/pdf');setMessage(`已合并 ${merge.length} 个文件，共 ${merge.reduce((n,f)=>n+f.pages,0)} 页，${fileSize(bytes.byteLength)}。`);});}
 async function doSplit(){if(!split)return;await task(async signal=>{const g=splitGroups(splitMode,ranges,Number(every),split.pages);const results=await splitPdf(split,g,setBusy,signal);if(results.length===1)downloadBytes(results[0].bytes,results[0].name,'application/pdf');else{setBusy('正在打包分割后的文件…');const bytes=await zipPdfs(results);if(signal.aborted)throw new Error('操作已取消。');downloadBytes(bytes,`${safeStem(split.name)}-分割结果.zip`,'application/zip');}setMessage(`已生成 ${results.length} 份 PDF${results.length>1?'，已打包为 ZIP':''}。`);});}
 return <><OfdTool active={active==='ofd-to-pdf'} onBusy={onBusy}/><PhotoScanner active={active==='photo-scan'} onBusy={onBusy}/><PdfLayoutEditor active={active==='word'} current={current} onBusy={onBusy}/><OfficeTools active={active} current={current} onBusy={onBusy}/><ImageTools active={active} current={current} onBusy={onBusy}/><EpubTool active={active==='epub'} current={current} onBusy={onBusy}/><section className="pdf-tools" style={{display:['merge','split'].includes(active)?undefined:'none'}}>
 <ToolHeading tool={active} />
  <div className="tool-grid" onDragOver={ev=>ev.preventDefault()} onDrop={ev=>{ev.preventDefault();ev.stopPropagation();if(!busy)void addFiles(Array.from(ev.dataTransfer.files));}}>
   <ToolFilePanel title={active==='merge'?'导入要合并的 PDF':'导入来源 PDF'} hint={active==='merge'?'可拖入多份 PDF，添加后可调整文件顺序。':'拖入 PDF 后，按指定页码或固定页数分割。'}
    action={active==='merge'?'添加 PDF 文件':selectedFile?'更换 PDF':'选择 PDF'} loaded={Boolean(active==='merge'?merge.length:selectedFile)} disabled={!!busy} onChoose={()=>input.current?.click()} onReuse={current?useCurrent:undefined}>
    <input ref={input} aria-label={active==='merge'?'选择要合并的 PDF':'选择工具 PDF'} type="file" accept=".pdf,application/pdf" multiple={active==='merge'} hidden onChange={ev=>{void addFiles(Array.from(ev.target.files||[]));ev.target.value='';}}/>
   </ToolFilePanel>
   <aside className="tool-options"><fieldset disabled={!!busy}>
 {active==='merge'?<><ToolSettingsHeading>合并设置</ToolSettingsHeading><label className="select-field">输出文件名<input aria-label="合并文件名" value={outputName} onChange={ev=>setOutputName(ev.target.value)}/></label><div className="tool-summary"><span>文件数量<strong>{merge.length} 份</strong></span><span>总页数<strong>{merge.reduce((n,f)=>n+f.pages,0)} 页</strong></span><span>原文件合计<strong>{fileSize(merge.reduce((n,f)=>n+f.bytes.byteLength,0))}</strong></span></div><ToolNotes><p className="note">按左侧从上到下的顺序合并。保留原始图像清晰度，合并结果不超过输入文件的合计大小；超限会停止。</p></ToolNotes>
    <button className="button primary full" disabled={merge.length<2} onClick={doMerge}><Files size={16}/>合并并下载</button></>:<><ToolSettingsHeading>分割设置</ToolSettingsHeading><label className="select-field">分割方式<select value={splitMode} onChange={ev=>setSplitMode(ev.target.value)}><option value="custom">按指定页码分组</option><option value="each">每页保存一份</option><option value="every">每隔几页保存一份</option></select></label>{splitMode==='custom'?<label className="select-field">分组页码<textarea aria-label="分组页码" value={ranges} placeholder="例如：1-3;4-6;7,9" onChange={ev=>setRanges(ev.target.value)}/><small>分号或换行分成不同文件；逗号选择不连续页。例如 1-3,5;6-8。</small></label>:splitMode==='every'?<label className="select-field">每份页数<input aria-label="每份页数" type="number" min="1" max={split?.pages||9999} value={every} onChange={ev=>setEvery(ev.target.value)}/></label>:null}<ToolNotes><p className="note">一份结果直接下载 PDF，多份结果自动打包 ZIP。页码从 1 开始，未指定的页面不会输出。</p><p className="note">每份 PDF 不超过原文件大小。独立文件可能重复保存图片和字体，因此分割后的合计体积可能增加。</p></ToolNotes>
    <button className="button primary full" disabled={!split||!!rangeError} onClick={doSplit}><Scissors size={16}/>分割并下载</button></>}
 </fieldset></aside>
   <div className="tool-main tool-content" hidden={!(active==='merge'?merge.length:selectedFile)} aria-label="文件和预览">
 {active==='merge'?<>{merge.length?<div className="merge-list">{merge.map((f,i)=><div className="merge-row" key={f.id}><span className="file-order">{String(i+1).padStart(2,'0')}</span><FileText size={25}/><div className="merge-file"><strong title={f.name}>{f.name}</strong><span>{f.pages} 页 · {fileSize(f.bytes.byteLength)}</span></div><div className="merge-controls"><button aria-label={`上移文件 ${i+1}`} disabled={!!busy||i===0} onClick={()=>{const a=[...merge];[a[i-1],a[i]]=[a[i],a[i-1]];setMerge(a);}}><ArrowUp size={16}/></button><button aria-label={`下移文件 ${i+1}`} disabled={!!busy||i===merge.length-1} onClick={()=>{const a=[...merge];[a[i+1],a[i]]=[a[i],a[i+1]];setMerge(a);}}><ArrowDown size={16}/></button><button aria-label={`删除文件 ${i+1}`} disabled={!!busy} onClick={()=>setMerge(merge.filter(x=>x.id!==f.id))}><Trash2 size={16}/></button></div></div>)}</div>:null}</>:<>{selectedFile?<div className="selected-tool-file"><FileText size={29}/><div><strong>{selectedFile.name}</strong><span>{selectedFile.pages} 页 · {fileSize(selectedFile.bytes.byteLength)}</span></div><span className="file-ready">已载入</span></div>:null}
 {active==='split'&&split&&<div className="split-preview"><h3>分割结果预览 <span>{groups.length} 份</span></h3>{rangeError?<p className="inline-hint">{rangeError}</p>:<div className="split-groups">{groups.map((g,i)=><div key={i}><FileText size={20}/><div><strong>文件 {i+1}</strong><span>第 {g.map(n=>n+1).join('、')} 页</span></div><small>{g.length} 页</small></div>)}</div>}</div>}

 </>}
    </div>
  </div>
 {busy&&<div className="tool-progress" role="status"><div className="spinner"/><span>{busy}</span><button onClick={()=>{abort.current?.abort();setBusy('正在取消…');}}>取消</button></div>}{error&&<div className="tool-result error" role="alert">{error}<button aria-label="关闭工具错误" onClick={()=>setError('')}><X size={15}/></button></div>}{message&&<div className="tool-result" role="status"><Check size={17}/>{message}<button aria-label="关闭工具提示" onClick={()=>setMessage('')}><X size={15}/></button></div>}
 </section></>;
}
