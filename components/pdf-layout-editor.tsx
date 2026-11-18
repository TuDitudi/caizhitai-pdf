'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Download, FilePenLine, FileUp, ScanText, Undo2, X, Type } from 'lucide-react';
import { ToolHeading } from './tool-workspace';
import { downloadBytes, inspectPdf, readToolFile, safeStem, type ToolFile } from '../lib/pdf/tools';
import { changedText, paintEditedBackground, recognizeLayout, type EditablePage } from '../lib/pdf/layout-editor';
import { completeFont, inkTop, inkBottom, textWidth, missingGlyphs, releaseFont, type FontAsset } from '../lib/pdf/original-font';
import { blockLines, usedFonts, wordProblems } from '../lib/pdf/layout-text';
import { exportLayoutWord } from '../lib/pdf/layout-word';

type Selection = { page: number; block: string };
type Props = { active: boolean; current: { name: string; bytes: Uint8Array } | null; onBusy: (busy: boolean) => void };

function DocumentPage({page,selected,disabled,select,edit}:{page:EditablePage;selected:string|undefined;disabled:boolean;select:(id:string)=>void;edit:(id:string,text:string)=>void}) {
  const paper=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null),backdrop=useRef<{image:ImageBitmap;background?:ImageBitmap}|null>(null);
  const [width,setWidth]=useState(0),[ready,setReady]=useState(0),[error,setError]=useState('');
  useEffect(()=>{const observer=new ResizeObserver(entries=>setWidth(entries[0].contentRect.width));if(paper.current)observer.observe(paper.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    let live=true;let loaded:{image:ImageBitmap;background?:ImageBitmap}|undefined;
    void(async()=>{try{const [image,background]=await Promise.all([createImageBitmap(page.image),page.background?createImageBitmap(page.background):undefined]);loaded={image,background};if(!live){image.close();background?.close();return;}backdrop.current=loaded;setReady(n=>n+1);setError('');}catch{if(live)setError('页面预览载入失败，请重新识别。');}})();
    return()=>{live=false;if(loaded){loaded.image.close();loaded.background?.close();}backdrop.current=null;};
  },[page.image,page.background]);
  useLayoutEffect(()=>{if(canvas.current&&backdrop.current)paintEditedBackground(page,canvas.current,backdrop.current.image,backdrop.current.background);},[page,ready]);
  const scale=width/page.width;
  return <article className="layout-document-page" aria-label={`第 ${page.page} 页`}><header><span>第 {page.page} 页</span><span>{page.blocks.length} 处可编辑文字{page.warning?'，请核对':''}</span></header>
    {page.warning&&<p className="layout-page-warning" role="status">{page.warning}</p>}{error&&<p className="layout-page-warning" role="alert">{error}</p>}
    <div ref={paper} className="layout-paper" style={{aspectRatio:`${page.width}/${page.height}`}}>
      <canvas ref={canvas} className="layout-page-image" aria-label={`第 ${page.page} 页原版式背景`}/>
      {width>0&&page.blocks.map(block=>{
        const font=page.fonts[block.fontId],active=selected===block.id,dirty=changedText(block),missing=missingGlyphs(font,block.text),lines=font&&!missing?blockLines(block,font):[];
        const position={left:block.x*scale,top:block.y*scale,width:block.width*scale,height:block.height*scale,transform:`rotate(${block.angle}rad)`};
        const typography={fontFamily:font?.cssFamily||'inherit',fontSize:block.size*scale,fontWeight:font?.weight||400,fontStyle:font?.italic?'italic':'normal',letterSpacing:block.tracking*scale,lineHeight:'1.15',color:'transparent',caretColor:block.color,background:'transparent'};
        return <div className="layout-block" style={position} key={block.id}>
          {dirty&&!missing&&font?.data&&<svg className="layout-edited-ink" viewBox={`0 0 ${block.width} ${block.height}`} aria-hidden="true" style={{fontFamily:font.cssFamily,fontSize:block.size,fontWeight:font.weight,fontStyle:font.italic?'italic':'normal',letterSpacing:block.tracking,fill:block.color,fontKerning:'none'}}>
            {lines.map((line,index)=><text key={index} x={0} y={block.baseline+index*block.size*1.15} xmlSpace="preserve">{line.text}</text>)}
          </svg>}
          {active?<textarea autoFocus className="layout-text-block editing" aria-label={`编辑第 ${page.page} 页文字 ${block.id}`} value={block.text} disabled={disabled} spellCheck={false}
            style={{...typography,top:(block.baseline-block.size*1.075)*scale,height:Math.max(block.height,block.size*1.448)*scale}} onChange={e=>edit(block.id,e.target.value)}/>:<button className="layout-text-block" disabled={disabled} aria-label={`编辑文字：${block.text||'已删除'}`} onClick={()=>select(block.id)} style={{background:'transparent'}}/>}
        </div>;
      })}
    </div>
  </article>;
}
export default function PdfLayoutEditor({active,current,onBusy}:Props) {
  const [file,setFile]=useState<ToolFile|null>(null),[pages,setPages]=useState<EditablePage[]>([]),[selection,setSelection]=useState<Selection|null>(null);
  const [range,setRange]=useState(''),[language,setLanguage]=useState<'chi_sim+eng'|'eng'>('chi_sim+eng');
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[message,setMessage]=useState('');
  const input=useRef<HTMLInputElement>(null),fontInput=useRef<HTMLInputElement>(null),controller=useRef<AbortController|null>(null),undo=useRef<EditablePage[][]>([]),fontPool=useRef(new Set<FontAsset>());
  const page=pages.find(p=>p.page===selection?.page),block=page?.blocks.find(b=>b.id===selection?.block),font=block&&page?.fonts[block.fontId];
  const fonts=usedFonts(pages),problems=wordProblems(pages),count=pages.reduce((sum,p)=>sum+p.blocks.filter(changedText).length,0);
  const missing=block?missingGlyphs(font,block.text):'';
  useEffect(()=>()=>{controller.current?.abort();fontPool.current.forEach(releaseFont);},[]);
  async function task(action:(signal:AbortSignal)=>Promise<void>) {
    if(controller.current)return;const job=new AbortController();controller.current=job;setBusy('正在准备');setError('');setMessage('');onBusy(true);
    try{await action(job.signal);}catch(error){setError(job.signal.aborted?'已取消，可重新识别。':error instanceof Error?error.message:'处理失败，请重试。');}
    finally{controller.current=null;setBusy('');onBusy(false);}
  }
  function load(next:ToolFile){fontPool.current.forEach(releaseFont);fontPool.current.clear();setFile(next);setPages([]);setSelection(null);setRange('');undo.current=[];}
  async function upload(files:File[]){if(files[0])await task(async()=>load(await readToolFile(files[0])));}
  async function recognize(){
    if(!file)return;if(count&&!window.confirm('重新识别会清除当前修改，是否继续？'))return;
    await task(async signal=>{const result=await recognizeLayout(file,range,language,setBusy,signal);if(signal.aborted){for(const p of result)Object.values(p.fonts).forEach(releaseFont);return;}fontPool.current.forEach(releaseFont);fontPool.current.clear();for(const p of result)for(const f of Object.values(p.fonts))fontPool.current.add(f);setPages(result);setSelection(null);undo.current=[];setMessage('识别完成。可连续滚动并点击文字编辑；导出的 Word 保留可编辑文字框。');});
  }
  function edit(pageNumber:number,id:string,text:string){
    if(busy)return;text=text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');undo.current=[...undo.current.slice(-79),pages];setPages(pages.map(p=>p.page===pageNumber?{...p,blocks:p.blocks.map(b=>b.id===id?{...b,text}:b)}:p));setMessage('');
  }
  function geometry(patch:{width?:number;height?:number;size?:number}){
    if(!block||!selection||busy)return;undo.current=[...undo.current.slice(-79),pages];setPages(pages.map(p=>p.page===selection.page?{...p,blocks:p.blocks.map(b=>b.id===block.id?{...b,...patch}:b)}:p));
  }
  async function applyFonts(files:File[],signal:AbortSignal){
    const replacements=new Map<string,FontAsset>();let lastError='未找到与 PDF 匹配的完整原字体。';
    if(files.length>16||files.reduce((s,f)=>s+f.size,0)>200*1024*1024)throw new Error('每次最多 16 个字体文件，合计不超过 200 MB。');
    for(const [id,old]of fonts)for(const file of files){
      if(signal.aborted)return;setBusy(`正在核对原字体 ${old.originalName}`);
      try{const replacement=await completeFont(old,file);fontPool.current.add(replacement);replacements.set(id,replacement);break;}catch(error){lastError=error instanceof Error?error.message:lastError;}
    }
    if(!replacements.size)throw new Error(lastError);
    undo.current=[...undo.current.slice(-79),pages];
    setPages(pages.map(p=>({...p,fonts:{...p.fonts,...Object.fromEntries(replacements)},blocks:p.blocks.map(b=>{
      const replacement=replacements.get(b.fontId);if(!replacement)return b;
      if(b.source==='ocr'){
        const size=Math.max(1,Math.min(200,(b.originalBox?.height||b.height)/Math.max(.2,inkTop(replacement,b.original)-inkBottom(replacement,b.original))));
        return {...b,size,baseline:inkTop(replacement,b.original)*size,height:Math.max(b.height,size*1.15),tracking:[...b.original].length>1?(b.width-textWidth(replacement,b.original,size))/([...b.original].length-1):0};
      }
      const top=inkTop(replacement,b.original)*b.size,delta=b.baseline-top;
      return {...b,x:b.x-Math.sin(b.angle)*delta,y:b.y+Math.cos(b.angle)*delta,baseline:top};
    })})));
    setMessage(`已补齐 ${replacements.size} 种原字体。字号、颜色和原位置保留；完整字体将嵌入 Word。`);
  }
  async function localFonts(){await task(async signal=>{
    type LocalFont={postscriptName:string;family:string;fullName:string;blob:()=>Promise<Blob>};
    const query=(window as unknown as {queryLocalFonts?:()=>Promise<LocalFont[]>}).queryLocalFonts;
    if(!query)throw new Error('当前浏览器不支持读取本机字体，请使用“选择原字体文件”。');
    const {fontKey}=await import('../lib/pdf/original-font');let available:LocalFont[];
    try{available=await query();}catch{throw new Error('未获得本机字体读取权限。可改用“选择原字体文件”。');}
    const wanted=[...fonts.values()].filter(f=>!f.full||!f.editableEmbedding),files:File[]=[];
    for(const local of available)if(wanted.some(f=>[local.postscriptName,local.family,local.fullName].some(n=>fontKey(n)===fontKey(f.originalName)||fontKey(n)===fontKey(f.family)))){if(signal.aborted)return;files.push(new File([await local.blob()],local.postscriptName+'.ttf'));}
    if(!files.length)throw new Error('本机未找到对应原字体，请选择完整的 TTF、OTF 或 TTC 字体文件。');
    await applyFonts(files,signal);
  });}
  async function download(){if(!file||!pages.length)return;await task(async signal=>{const bytes=await exportLayoutWord(pages,file.name,setBusy,signal);if(signal.aborted)return;downloadBytes(bytes,`${safeStem(file.name)}-可编辑.docx`,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');setMessage(`已导出 ${pages.length} 页 Word，文字可继续编辑，包含 ${count} 处网页文字修改。`);});}
  return <section className="pdf-tools layout-editor" hidden={!active}>
    <ToolHeading tool="word" description="连续预览并编辑，保留原字体与版式，导出可继续编辑的 Word 文档。"/>
    <input ref={input} type="file" accept=".pdf,application/pdf" aria-label="选择编辑 PDF" hidden onChange={e=>{void upload(Array.from(e.target.files||[]));e.target.value='';}}/>
    <input ref={fontInput} type="file" accept=".ttf,.otf,.ttc" multiple aria-label="选择完整原字体" hidden onChange={e=>{const files=Array.from(e.target.files||[]);e.target.value='';if(files.length)void task(signal=>applyFonts(files,signal));}}/>
    <div className="layout-toolbar"><button className="button" disabled={!!busy} onClick={()=>input.current?.click()}><FileUp size={17}/>{file?'更换 PDF':'选择 PDF'}</button>
      {file&&<span className="layout-filename" title={file.name}>{file.name}<small>{file.pages} 页{pages.length?`，已修改 ${count} 处`:''}</small></span>}
      <div className="layout-toolbar-actions">{pages.length>0&&<button className="button" disabled={!!busy||!undo.current.length} onClick={()=>{const previous=undo.current.pop();if(previous)setPages(previous);}}><Undo2 size={16}/>撤销</button>}
        <button className="button" disabled={!file||!!busy} onClick={recognize}><ScanText size={17}/>{pages.length?'重新识别':'识别可编辑文字'}</button>
        <button className="button primary" disabled={!pages.length||!!busy||problems.length>0} onClick={download}><Download size={17}/>导出 Word（DOCX）</button></div>
    </div>
    {!pages.length?<div className="layout-start" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!busy)void upload(Array.from(e.dataTransfer.files));}}>
      <div className="layout-start-paper"><FilePenLine size={38}/><h3>{file?'文件已准备好':'把 PDF 拖到这里'}</h3><p>识别后可直接改字，再导出可编辑的 Word。</p>{!file&&<button className="button primary" disabled={!!busy} onClick={()=>input.current?.click()}>选择 PDF</button>}{current&&<button className="button" disabled={!!busy} onClick={()=>void task(async()=>load(await inspectPdf(current.bytes,current.name)))}>使用编辑器的原始文件</button>}</div>
      <div className="layout-import-settings"><label>识别页码<input aria-label="识别页码" placeholder="全部页，或 1-3,5" value={range} disabled={!!busy} onChange={e=>setRange(e.target.value)}/></label><label>扫描识别语言<select aria-label="扫描识别语言" value={language} disabled={!!busy} onChange={e=>setLanguage(e.target.value as typeof language)}><option value="chi_sim+eng">简体中文 + 英文</option><option value="eng">英文</option></select></label><p>文字版读取原字体。扫描图片无法可靠判断字体，识别后需指定完整原字体。</p></div>
    </div>:<>
      <details className="layout-font-manager" open={problems.length>0||undefined}><summary><Type size={17}/>{problems.length?'需要补齐字体或调整文字框后导出':'原字体已保留，可导出 Word'}</summary><div className="layout-font-body">
        <p>PDF 常只保存已用字形。为避免改字时换字体，请补齐完整原字体；不匹配的字形不会自动替换。完整字体会增加 Word 体积。</p>
        <ul>{[...fonts].map(([id,f])=><li key={id}><strong>{f.originalName}</strong><span>{f.full&&f.editableEmbedding?'完整字体，可编辑嵌入':f.source==='subset'?'PDF 字体子集，需补齐完整字体':f.reason||'需补齐原字体'}</span></li>)}</ul>
        <div className="layout-font-actions"><button className="button" disabled={!!busy} onClick={localFonts}>从本机补齐原字体</button><button className="button" disabled={!!busy} onClick={()=>fontInput.current?.click()}>选择原字体文件</button><small>TTF、OTF、TTC；仅在浏览器中读取</small></div>
        {problems.length>0&&<p className="layout-font-warning" role="status">{problems[0]}</p>}
      </div></details>
      <div className="layout-workspace"><div className="layout-pages" aria-label="连续页面预览">{pages.map(p=><DocumentPage key={p.page} page={p} disabled={!!busy} selected={selection?.page===p.page?selection.block:undefined} select={id=>setSelection({page:p.page,block:id})} edit={(id,text)=>edit(p.page,id,text)}/>)}</div>
        <aside className="layout-inspector" aria-label="文字编辑面板"><h3>{block?`第 ${selection!.page} 页文字`:'点击文字开始编辑'}</h3>{block?<>
          <label>文字内容<textarea aria-label="当前选中文字" value={block.text} disabled={!!busy} onChange={e=>edit(selection!.page,block.id,e.target.value)}/></label>
          <div className="layout-font-selection"><strong>{font?.originalName||'原字体待补齐'}</strong><span>{block.size.toFixed(2).replace(/\.00$/,'')} 磅，{font?.weight&&font.weight>=600?'粗体':'常规'}{font?.italic?'，斜体':''}</span></div>
          {missing&&<p className="layout-font-warning" role="status">缺少字形：{missing.slice(0,20)}。页面暂保留原字形，请补齐完整字体后查看修改。</p>}
          <button className="button" disabled={!!busy||!changedText(block)} onClick={()=>edit(selection!.page,block.id,block.original)}>恢复这段原文</button>
          <p>保留原字体与字号，不自动缩小。长文字可在下方增大文字框。</p>
          <details className="layout-box-settings"><summary>文字框与字号</summary><label>字号（磅）<input aria-label="当前文字字号" type="number" min="1" max="200" step=".5" value={block.size} disabled={!!busy} onChange={e=>geometry({size:Math.max(1,Math.min(200,Number(e.target.value)||1))})}/></label><label>文字框宽度（毫米）<input aria-label="当前文字框宽度" type="number" min="1" step="1" value={Number((block.width*25.4/72).toFixed(2))} disabled={!!busy} onChange={e=>geometry({width:Math.max(1,Number(e.target.value)||1)*72/25.4})}/></label><label>文字框高度（毫米）<input aria-label="当前文字框高度" type="number" min="1" step="1" value={Number((block.height*25.4/72).toFixed(2))} disabled={!!busy} onChange={e=>geometry({height:Math.max(1,Number(e.target.value)||1)*72/25.4})}/></label></details>
          {block.source==='ocr'&&<p>扫描文字的字体需人工指定。原文字与印章、花纹重叠时，请核对背景修复效果。</p>}
        </>:<p>连续向下滚动，点击页面中的文字可修改。Word 中对应位置也保留可编辑文字框。</p>}
          <div className="layout-document-summary"><span>预览页数<strong>{pages.length}</strong></span><span>修改处数<strong>{count}</strong></span></div>
        </aside></div>
    </>}
    {busy&&<div className="tool-progress" role="status"><div className="spinner"/><span>{busy}</span><button onClick={()=>controller.current?.abort()}>取消</button></div>}
    {error&&<div className="tool-result error" role="alert">{error}<button aria-label="关闭错误" onClick={()=>setError('')}><X size={16}/></button></div>}{message&&<p className="tool-result" role="status">{message}</p>}
  </section>;
}
