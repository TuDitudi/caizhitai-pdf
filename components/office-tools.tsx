'use client';
/* eslint-disable @next/next/no-img-element */
import {useEffect,useRef,useState,useMemo} from 'react';
import {Download,FileText,X,Check} from 'lucide-react';
import { ToolFilePanel, ToolHeading, ToolNotes, ToolSettingsHeading } from './tool-workspace';
import {openPdf,renderPage} from '../lib/pdf/engine';
import {fileSize} from '../lib/pdf/export';
import {inspectEpubFile} from '../lib/pdf/epub-converter';
import {cancelled,downloadBytes,pageRange,type ToolFile} from '../lib/pdf/tools';
import {officeStem} from '../lib/pdf/office-common';
import {readPresentation,slidePreview,presentationToPdf,pdfToPresentation,type SlideFile} from '../lib/pdf/presentation';
import {readSpreadsheet,spreadsheetToPdf,type SpreadsheetFile,type SpreadsheetPdfOptions} from '../lib/pdf/spreadsheet';
import {extractPdfTables,tablesToSpreadsheet,type TablePage} from '../lib/pdf/pdf-spreadsheet';
const labels={'ppt-to-pdf':'PPT 转 PDF','pdf-to-ppt':'PDF 转 PPT','excel-to-pdf':'Excel 转 PDF','pdf-to-excel':'PDF 转 Excel'};
type Kind=keyof typeof labels;
type Props={active:string;current:{name:string;bytes:Uint8Array}|null;onBusy:(busy:boolean)=>void};
type Result={data:Blob|Uint8Array;name:string;mime:string};
function BlobPreview({blob,alt}:{blob:Blob;alt:string}){const[url,setUrl]=useState('');useEffect(()=>{const u=URL.createObjectURL(blob);setUrl(u);return()=>URL.revokeObjectURL(u);},[blob]);return <img src={url||undefined} alt={alt}/>;}
function PdfPreview({bytes,page}:{bytes:Uint8Array;page:number}){
 const canvas=useRef<HTMLCanvasElement>(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;let doc:Awaited<ReturnType<typeof openPdf>>|undefined;setError('');
 void(async()=>{try{doc=await openPdf(bytes.slice());if(!live){await doc.destroy();return;}const c=await renderPage(doc,page,0,1000);if(live&&canvas.current){canvas.current.width=c.width;canvas.current.height=c.height;canvas.current.getContext('2d')!.drawImage(c,0,0);}c.width=c.height=1;}catch(e){if(live)setError(e instanceof Error?e.message:'预览失败');}})();
 return()=>{live=false;if(doc)void doc.destroy();};},[bytes,page]);
 return error?<p role="alert">{error}</p>:<canvas ref={canvas} aria-label={`第 ${page} 页预览`}/>;
}
function SingleOfficeTool({kind,visible,current,onBusy}:Props&{kind:Kind;visible:boolean}){
 const isPpt=kind==='ppt-to-pdf',isSheet=kind==='excel-to-pdf',isTables=kind==='pdf-to-excel';
 const [slides,setSlides]=useState<SlideFile|null>(null),[sheet,setSheet]=useState<SpreadsheetFile|null>(null),[pdf,setPdf]=useState<ToolFile|null>(null);
 const [range,setRange]=useState(''),[preview,setPreview]=useState(0),[slideBlob,setSlideBlob]=useState<Blob|null>(null),[previewError,setPreviewError]=useState('');
 const [darkText,setDarkText]=useState(false);
 const [dpi,setDpi]=useState(150),[layout,setLayout]=useState<'source'|'wide'|'standard'>('source');
 const [sheetOptions,setSheetOptions]=useState<SpreadsheetPdfOptions>({sheets:[],paper:'a4-landscape',grid:true,repeatHeader:true});
 const [tableMode,setTableMode]=useState<'table'|'image'>('table'),[forceOcr,setForceOcr]=useState(false),[tables,setTables]=useState<TablePage[]>([]),[rowOffset,setRowOffset]=useState(0);
 const [result,setResult]=useState<Result|null>(null),[resultPdf,setResultPdf]=useState<ToolFile|null>(null),[resultPage,setResultPage]=useState(1);
 const [busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
 const input=useRef<HTMLInputElement>(null),abort=useRef<AbortController|null>(null),lock=useRef(false);
 const source=isPpt?slides:isSheet?sheet:pdf,count=isPpt?slides?.presentation.slides.length:pdf?.pages;
 useEffect(()=>()=>{slides?.presentation.dispose?.();},[slides]);
 useEffect(()=>{if(!visible||!isPpt||!slides)return;const ctl=new AbortController();setSlideBlob(null);setPreviewError('');void slidePreview(slides,preview,1200,ctl.signal,darkText).then(b=>{if(!ctl.signal.aborted)setSlideBlob(b);}).catch(e=>{if(!ctl.signal.aborted)setPreviewError(e.message);});return()=>ctl.abort();},[slides,preview,visible,isPpt,darkText]);
 useEffect(()=>()=>abort.current?.abort(),[]);
 function invalidate(){setResult(null);setResultPdf(null);setTables([]);setMessage('');setRowOffset(0);}
 async function task(fn:(signal:AbortSignal)=>Promise<void>){if(lock.current)return;lock.current=true;abort.current=new AbortController();setBusy('正在准备…');setError('');setMessage('');onBusy(true);try{await fn(abort.current.signal);}catch(e){setError(e instanceof Error?e.message:'转换失败，请检查文件后重试。');}finally{setBusy('');lock.current=false;abort.current=null;onBusy(false);}}
 async function load(file?:File){if(!file)return;await task(async signal=>{setBusy('正在读取文件…');invalidate();
 if(isPpt){setSlides(await readPresentation(file,signal));setDarkText(false);}else if(isSheet){const next=await readSpreadsheet(file,signal);cancelled(signal);setSheet(next);setSheetOptions(o=>({...o,sheets:next.sheets.filter(s=>!s.hidden).map(s=>s.name)}));}else{
 if(!/\.pdf$/i.test(file.name))throw new Error('请选择 PDF 文件。');if(file.size>200*1024*1024)throw new Error('PDF 不能超过 200 MB。');const next=await inspectEpubFile(new Uint8Array(await file.arrayBuffer()),file.name);cancelled(signal);setPdf(next);}
 setRange('');setPreview(0);setResultPage(1);});}
 async function useCurrent(){if(current)await load(new File([current.bytes as BlobPart],current.name,{type:'application/pdf'}));}
 async function convert(){if(!source)return;await task(async signal=>{invalidate();let data:Blob|Uint8Array;
 if(isTables){const next=await extractPdfTables(pdf!,range,tableMode,forceOcr,setBusy,signal);cancelled(signal);setTables(next);setPreview(0);setMessage(tableMode==='table'?`已提取 ${next.length} 页，请校对分列和文字后下载。`:`已准备 ${next.length} 页图片，可下载 Excel。`);return;}
 if(isPpt)data=await presentationToPdf(slides!,range,dpi,setBusy,signal,darkText);
 else if(isSheet)data=await spreadsheetToPdf(sheet!,sheetOptions,setBusy,signal);
 else data=await pdfToPresentation(pdf!,range,layout,setBusy,signal);
 cancelled(signal);const isOutputPdf=isPpt||isSheet;const name=officeStem(source.name)+(isOutputPdf?'.pdf':'.pptx');
 if(isOutputPdf){setResultPdf(await inspectEpubFile(data as Uint8Array,name));setResultPage(1);}cancelled(signal);
 setResult({data,name,mime:isOutputPdf?'application/pdf':'application/vnd.openxmlformats-officedocument.presentationml.presentation'});setMessage('转换完成，请核对预览后下载。');});}
 async function download(){if(isTables){await task(async signal=>{const blob=await tablesToSpreadsheet(tables,pdf!.name,setBusy,signal);downloadBytes(blob,officeStem(pdf!.name)+'.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');setMessage(`Excel 已下载，${fileSize(blob.size)}。`);});}else if(result){downloadBytes(result.data,result.name,result.mime);setMessage(`已下载 ${result.name}。`);}}
 let rangeError='';if(count)try{pageRange(range,count);}catch(e){rangeError=(e as Error).message;}
 const accept=isPpt?'.ppt,.pptx':isSheet?'.xls,.xlsx,.xlsm':'.pdf';
 const selectedSheet=sheet?.sheets[preview]||sheet?.sheets[0],selectedTable=tables[preview]||tables[0];
 const sheetCells=useMemo(()=>new Map(selectedSheet?.cells.map(c=>[`${c.row}:${c.col}`,c])),[selectedSheet]);
 return <section className="pdf-tools office-tools" data-office={kind} style={{display:visible?undefined:'none'}}>
 <ToolHeading tool={kind} />
  <div className="tool-grid" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();e.stopPropagation();if(!busy)void load(e.dataTransfer.files[0]);}}>
   <ToolFilePanel title={isPpt?'导入演示文稿':isSheet?'导入工作簿':'导入来源 PDF'}
    hint={isPpt?'可拖入 PPT 或 PPTX 文件。':isSheet?'可拖入 XLS、XLSX 或 XLSM 文件。':'可拖入文字版或扫描版 PDF。'}
    action={source?'更换文件':isPpt?'选择 PPT':isSheet?'选择 Excel':'选择 PDF'} loaded={!!source} disabled={!!busy}
    onChoose={()=>input.current?.click()} onReuse={!isPpt&&!isSheet&&current?useCurrent:undefined}>
    <input ref={input} aria-label={`选择${labels[kind]}文件`} type="file" accept={accept} hidden onChange={e=>{void load(e.target.files?.[0]);e.target.value='';}}/>
   </ToolFilePanel>
   <aside className="tool-options"><fieldset disabled={!!busy}><ToolSettingsHeading>{isSheet?'PDF 排版设置':isPpt?'幻灯片导出设置':isTables?'表格提取设置':'幻灯片生成设置'}</ToolSettingsHeading>
 {!isSheet&&<label className="select-field">转换页码<input aria-label="Office 转换页码" value={range} placeholder="全部页，或 1-3,5" onChange={e=>{setRange(e.target.value);invalidate();}}/></label>}{rangeError&&<p className="inline-error">{rangeError}</p>}
 {isPpt?<><label className="select-field">清晰度<select value={dpi} onChange={e=>{setDpi(Number(e.target.value));invalidate();}}><option value={150}>标准 · 150 DPI</option><option value={200}>清晰 · 200 DPI</option></select></label><label className="compression-option"><input type="checkbox" checked={darkText} onChange={e=>{setDarkText(e.target.checked);invalidate();}}/><span>增强文字对比度<small>改为深色文字和白色背景，适合旧版 PPT 文字不可见时。</small></span></label></>:
 isSheet?<><label className="select-field">纸张<select value={sheetOptions.paper} onChange={e=>{setSheetOptions(o=>({...o,paper:e.target.value as SpreadsheetPdfOptions['paper']}));invalidate();}}><option value="a4-landscape">A4 横向</option><option value="a4">A4 纵向</option><option value="a3-landscape">A3 横向</option></select></label><div className="office-sheet-checks"><strong>导出工作表</strong>{sheet?.sheets.map(s=><label key={s.name}><input type="checkbox" checked={sheetOptions.sheets.includes(s.name)} onChange={e=>{setSheetOptions(o=>({...o,sheets:e.target.checked?[...o.sheets,s.name]:o.sheets.filter(n=>n!==s.name)}));invalidate();}}/>{s.name}{s.hidden?'（隐藏）':''}</label>)}</div><label className="compression-option"><input type="checkbox" checked={sheetOptions.grid} onChange={e=>{setSheetOptions(o=>({...o,grid:e.target.checked}));invalidate();}}/><span>显示表格边框</span></label><label className="compression-option"><input type="checkbox" checked={sheetOptions.repeatHeader} onChange={e=>{setSheetOptions(o=>({...o,repeatHeader:e.target.checked}));invalidate();}}/><span>跨页重复首行</span></label></>:
 isTables?<><label className="select-field">转换方式<select aria-label="转换方式" value={tableMode} onChange={e=>{setTableMode(e.target.value as 'table'|'image');invalidate();}}><option value="table">可编辑表格（扫描页自动识别）</option><option value="image">页面图片（保留原貌）</option></select></label>{tableMode==='table'&&<label className="compression-option"><input type="checkbox" checked={forceOcr} onChange={e=>{setForceOcr(e.target.checked);invalidate();}}/><span>重新识别全部页面<small>原文字层错乱或缺失时使用。</small></span></label>}</>:
 <><label className="select-field">幻灯片尺寸<select value={layout} onChange={e=>{setLayout(e.target.value as typeof layout);invalidate();}}><option value="source">跟随首个选中页面</option><option value="wide">宽屏 16:9</option><option value="standard">标准 4:3</option></select></label></>}
  <ToolNotes>{isPpt?<p className="note">导出静态页面图片。支持 PPT/PPTX；字体、复杂效果可能与 PowerPoint 不同，动画、音视频不导出，请先核对预览。</p>:isSheet?<p className="note">按宽度缩放、按行分页。公式使用文件保存的计算结果；缺失结果会提示。支持常用单元格样式、合并和 PNG/JPEG 图片，图表、宏和复杂条件格式不导出。</p>:isTables?<p className="note">{tableMode==='table'?'每页生成一个工作表。扫描页识别较慢，可能有错字和分列偏差，请先校对；数字可用于计算，编号前导零按文本保留。':'每页图片放入一个工作表，可调整图片大小；图片中的原文字、单元格不可直接编辑。'}</p>:<p className="note">输出 PPTX，每个 PDF 页面作为一张图片。可移动、缩放图片和添加内容，原文字无法作为独立文本框编辑。</p>}<p className="note">格式互转后的体积可能变化；裁剪 PDF 的“不超过原文件大小”规则继续保留。</p></ToolNotes>
    <button className={result||tables.length ? 'button full' : 'button primary full'} disabled={!source||!!rangeError||(isSheet&&!sheetOptions.sheets.length)} onClick={convert}>{result||tables.length?'重新转换':'开始转换'}</button>
 <button className="button primary full word-download" disabled={isTables?!tables.length:!result} onClick={download}><Download size={16}/>下载{isPpt||isSheet?' PDF':isTables?' Excel':' PPTX'}</button>
 </fieldset></aside>
   <div className="tool-main tool-content" hidden={!source} aria-label="文件和预览">
 {source?<><div className="selected-tool-file"><FileText size={28}/><div><strong>{source.name}</strong><span>{isSheet?`${sheet!.sheets.length} 个工作表`:`${count} 页`} · {fileSize(isPpt?slides!.size:isSheet?sheet!.size:pdf!.bytes.length)}</span></div><span className="file-ready">已载入</span></div>
 {isSheet&&sheet?.warnings.map((w,i)=><p className="office-warning" key={i}>{w}</p>)}
 <div className="office-preview-bar"><h3>{resultPdf?'导出 PDF 预览':isTables&&tables.length?'结果校对':'源文件预览'}</h3>
 {resultPdf?<select aria-label="导出 PDF 预览页" value={resultPage} onChange={e=>setResultPage(Number(e.target.value))}>{Array.from({length:resultPdf.pages},(_,i)=><option key={i} value={i+1}>第 {i+1} 页 / {resultPdf.pages}</option>)}</select>:
 <select aria-label="Office 预览页" value={preview} disabled={!!busy} onChange={e=>{setPreview(Number(e.target.value));setRowOffset(0);}}>{isSheet?sheet?.sheets.map((s,i)=><option key={i} value={i}>{s.name}</option>):isTables&&tables.length?tables.map((t,i)=><option key={i} value={i}>原第 {t.page} 页 · {t.method==='ocr'?'扫描识别':t.method==='image'?'页面图片':'文字提取'}</option>):Array.from({length:count||0},(_,i)=><option key={i} value={i}>第 {i+1} 页</option>)}</select>}
 </div>
 {resultPdf?<div className="conversion-page-preview"><PdfPreview bytes={resultPdf.bytes} page={resultPage}/></div>:
 isPpt?<div className="conversion-page-preview">{previewError?<p role="alert">{previewError}</p>:slideBlob?<BlobPreview blob={slideBlob} alt="幻灯片预览"/>:<p>正在绘制幻灯片…</p>}</div>:
 isSheet&&selectedSheet?<><div className="office-table-wrap"><table className="office-table"><tbody>{Array.from({length:Math.min(100,selectedSheet.rows)},(_,r)=><tr key={r}>{Array.from({length:Math.min(30,selectedSheet.cols)},(_,c)=>{const cell=sheetCells.get(`${r}:${c}`);return <td key={c} style={{background:cell?.fill,color:cell?.color,fontWeight:cell?.bold?600:400}}>{cell?.text||''}</td>;})}</tr>)}</tbody></table></div><p className="preview-caption">源表预览前 100 行、30 列；转换按所选工作表完整分页。合并单元格及图片请查看转换后的 PDF。</p></>:
 isTables&&selectedTable&&selectedTable.method!=='image'?<><div className="office-table-wrap"><table className="office-table editable"><thead><tr><th>行</th>{Array.from({length:Math.max(1,...selectedTable.rows.map(r=>r.length))},(_,i)=><th key={i}>列 {i+1}</th>)}</tr></thead><tbody>{selectedTable.rows.slice(rowOffset,rowOffset+100).map((row,r)=><tr key={r}><th>{rowOffset+r+1}</th>{row.map((value,c)=><td key={c}><textarea aria-label={`第 ${rowOffset+r+1} 行第 ${c+1} 列`} value={value} disabled={!!busy} onChange={e=>setTables(previous=>previous.map((p,i)=>i!==preview?p:{...p,rows:p.rows.map((values,ri)=>ri===rowOffset+r?values.map((s,ci)=>ci===c?e.target.value:s):values)}))}/></td>)}</tr>)}</tbody></table></div><div className="office-preview-bar"><span>共 {selectedTable.rows.length} 行 · 可直接修改单元格</span><button className="button" disabled={rowOffset===0} onClick={()=>setRowOffset(Math.max(0,rowOffset-100))}>前 100 行</button><button className="button" disabled={rowOffset+100>=selectedTable.rows.length} onClick={()=>setRowOffset(rowOffset+100)}>后 100 行</button></div><p className="preview-caption">按文字位置尝试分列，不恢复原公式；复杂合并、多栏及扫描错字需要校对。全空结果可改用“页面图片”。</p></>:
 pdf&&visible?<div className="conversion-page-preview"><PdfPreview bytes={pdf.bytes} page={selectedTable?.page||preview+1}/></div>:null}
 </>:null}
    </div>
  </div>
 {busy&&<div className="tool-progress" role="status"><div className="spinner"/><span>{busy}</span><button onClick={()=>{abort.current?.abort();setBusy('正在取消…');}}>取消</button></div>}
 {error&&<div className="tool-result error" role="alert">{error}<button aria-label="关闭 Office 错误" onClick={()=>setError('')}><X size={15}/></button></div>}
 {message&&<div className="tool-result" role="status"><Check size={17}/>{message}</div>}
 </section>;
}
export default function OfficeTools(props:Props){return <>{(Object.keys(labels) as Kind[]).map(kind=><SingleOfficeTool key={kind} {...props} kind={kind} visible={props.active===kind}/>)}</>;}
