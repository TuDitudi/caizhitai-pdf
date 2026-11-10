import {openPdf,renderPage} from './engine';
import {cancelled,pageRange,type ToolFile,type Progress} from './tools';
import {canvasBlob,yieldToBrowser} from './office-common';
export type TablePage={page:number;rows:string[][];method:'text'|'ocr'|'image';image?:Uint8Array;width:number;height:number};
type Token={text:string;x:number;y:number;w:number;h:number};
// Infer columns from the densest repeated row, then keep empty cells in their
// geometric column. This is a draft for review, not an assertion of table semantics.
export function tokensToRows(tokens:Token[]):string[][]{
 const grouped:{y:number;h:number;tokens:Token[]}[]=[];
 for(const token of tokens.filter(t=>t.text.trim()).sort((a,b)=>a.y-b.y||a.x-b.x)){
  const row=grouped.find(r=>Math.abs(r.y-token.y)<=Math.max(2,Math.min(r.h,token.h)*.5));
  if(row)row.tokens.push(token);else grouped.push({y:token.y,h:token.h,tokens:[token]});
 }
 const rows=grouped.sort((a,b)=>a.y-b.y).map(row=>{
  const cells:Token[]=[];
  for(const t of row.tokens.sort((a,b)=>a.x-b.x)){
   const prev=cells[cells.length-1],gap=prev?t.x-(prev.x+prev.w):Infinity;
   if(prev&&gap<Math.max(3,Math.min(prev.h,t.h)*.8)){
    const space=gap>Math.min(prev.h,t.h)*.12&&!/[\u3400-\u9fff]$/.test(prev.text)&&!/^\s/.test(t.text)?' ':'';
    prev.text+=space+t.text;prev.w=Math.max(prev.w,t.x+t.w-prev.x);
   }else cells.push({...t});
  }
  return cells;
 });
 const max=Math.max(1,...rows.map(r=>r.length));if(max>100||rows.length>5000)throw new Error('此页表格过大，请分区裁剪后转换。');
 const reference=rows.filter(r=>r.length===max),boundaries:number[]=[];
 for(let i=1;i<max;i++){
  const points=reference.map(r=>(r[i-1].x+r[i-1].w+r[i].x)/2).sort((a,b)=>a-b);boundaries.push(points[Math.floor(points.length/2)]);
 }
 return rows.map(row=>{const output=Array(max).fill('');for(const cell of row){
  // Use start plus a small inset so full-width titles remain in column A.
  const pos=cell.x+Math.min(cell.w/2,cell.h*.5);let col=boundaries.findIndex(b=>pos<b);if(col<0)col=max-1;
  output[col]+=(output[col]?' ':'')+cell.text.trim();
 }return output;});
}
function abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
 if(!signal)return promise;
 return new Promise((resolve,reject)=>{const stop=()=>reject(new Error('操作已取消。'));signal.addEventListener('abort',stop,{once:true});promise.then(v=>{signal.removeEventListener('abort',stop);signal.aborted?stop():resolve(v);},e=>{signal.removeEventListener('abort',stop);reject(e);});if(signal.aborted)stop();});
}
export async function extractPdfTables(file:ToolFile,range:string,mode:'table'|'image',forceOcr:boolean,progress:Progress,signal?:AbortSignal):Promise<TablePage[]>{
 const indices=pageRange(range,file.pages);if(indices.length>(mode==='image'?200:100))throw new Error(`一次最多转换 ${mode==='image'?200:100} 页，请分批选择。`);
 const doc=await openPdf(file.bytes.slice());let worker:import('tesseract.js').Worker|undefined;let current=0;
 const stop=()=>{if(worker)void worker.terminate();};signal?.addEventListener('abort',stop);
 try{
  const pages:TablePage[]=[];
  for(let i=0;i<indices.length;i++){
   cancelled(signal);current=indices[i]+1;progress(`正在处理第 ${current} 页（${i+1}/${indices.length}）…`);
   const page=await doc.getPage(current),v=page.getViewport({scale:1});
   if(mode==='image'){
    const canvas=await renderPage(doc,current,0,1800);try{const blob=await canvasBlob(canvas,'image/jpeg',.92);pages.push({page:current,rows:[],method:'image',image:new Uint8Array(await blob.arrayBuffer()),width:canvas.width,height:canvas.height});}finally{canvas.width=canvas.height=1;}
   }else{
    const content=await page.getTextContent(),tokens:Token[]=[];
    for(const item of content.items){if(!('str' in item)||!item.str.trim())continue;const point=v.convertToViewportPoint(item.transform[4],item.transform[5]);
     const parts=Array.from(item.str.matchAll(/\S(?:.*?\S)?(?=\s{2,}|$)/g));
     for(const part of parts)tokens.push({text:part[0],x:point[0]+(part.index||0)/item.str.length*item.width,y:point[1],w:part[0].length/item.str.length*item.width,h:Math.max(5,item.height)});
    }
    let method:'text'|'ocr'='text';
    if(!tokens.length||forceOcr){
     method='ocr';tokens.length=0;
     if(!worker){
      progress('正在加载本机表格文字识别组件…');const {createWorker,PSM}=await import('tesseract.js');cancelled(signal);
      worker=await abortable(createWorker('chi_sim+eng',1,{workerPath:'/ocr/worker.min.js',corePath:'/ocr/core',langPath:'/ocr/lang',gzip:false,cacheMethod:'none',workerBlobURL:false,logger:m=>{if(!signal?.aborted&&m.status==='recognizing text')progress(`正在识别第 ${current} 页 · ${Math.round(m.progress*100)}%`);}}).then(w=>{if(signal?.aborted){void w.terminate();throw new Error('操作已取消。');}return w;}),signal);
      await worker!.setParameters({tessedit_pageseg_mode:PSM.SINGLE_BLOCK,preserve_interword_spaces:'1'});
     }
     const canvas=await renderPage(doc,current,0,Math.min(3000,Math.max(v.width,v.height)*3));
     try{
      const recognized=await abortable(worker!.recognize(canvas,{}, {blocks:true,text:true}),signal);cancelled(signal);
      for(const b of recognized.data.blocks||[])for(const para of b.paragraphs)for(const line of para.lines)for(const word of line.words){const box=word.bbox;tokens.push({text:word.text,x:box.x0,y:(box.y0+box.y1)/2,w:box.x1-box.x0,h:box.y1-box.y0});}
     }finally{canvas.width=canvas.height=1;}
    }
    const rows=tokensToRows(tokens);pages.push({page:current,rows:rows.length?rows:[['']],method,width:v.width,height:v.height});
   }
   await yieldToBrowser(signal);
  }
  return pages;
 }catch(error){if(signal?.aborted)throw new Error('操作已取消。');throw error;}
 finally{signal?.removeEventListener('abort',stop);if(worker)await worker.terminate().catch(()=>{});await doc.destroy();}
}
function numericValue(value:string):string|number{
 // Keep leading zeros, long identifiers, dates, formulas and percentages as text.
 if(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)&&value.replace(/[-.]/g,'').length<=15&&Number.isFinite(Number(value)))return Number(value);
 return value;
}
export async function tablesToSpreadsheet(pages:TablePage[],name:string,progress:Progress,signal?:AbortSignal):Promise<Blob>{
 if(!pages.length)throw new Error('请先转换并校对表格。');const {default:ExcelJS}=await import('exceljs');const book=new ExcelJS.Workbook();book.creator='裁纸台';book.title=name;
 for(const page of pages){
  cancelled(signal);progress(`正在生成工作表：原第 ${page.page} 页…`);const sheet=book.addWorksheet(`第${page.page}页`,{pageSetup:{paperSize:9,orientation:page.width>page.height?'landscape':'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0}});
  if(page.method==='image'){
   const id=book.addImage({buffer:page.image! as never,extension:'jpeg'}),scale=Math.min(1,1000/page.width),height=page.height*scale;
   sheet.addImage(id,{tl:{col:0,row:0},ext:{width:page.width*scale,height}});sheet.getColumn(1).width=Math.min(150,page.width*scale/7);sheet.getRow(Math.ceil(height/20)).height=15;
  }else{
   for(const values of page.rows){const row=sheet.addRow(values.map(numericValue));row.height=24;row.eachCell((cell,column)=>{const raw=values[column-1]||'';if(typeof cell.value==='number'&&raw.includes('.'))cell.numFmt='0.'+'0'.repeat(raw.split('.')[1].length);cell.font={name:'Microsoft YaHei',size:11};cell.alignment={vertical:'middle',wrapText:true};cell.border={bottom:{style:'hair',color:{argb:'FFE2E7ED'}}};});}
   const columns=Math.max(1,...page.rows.map(r=>r.length));for(let c=0;c<columns;c++){const width=Math.min(55,Math.max(12,...page.rows.map(r=>Array.from(r[c]||'').reduce((n,ch)=>n+(ch.charCodeAt(0)>255?2:1),0)+2)));sheet.getColumn(c+1).width=width;}
   sheet.views=[{state:'frozen',ySplit:1}];sheet.getRow(1).eachCell(cell=>{cell.font={...cell.font,bold:true};cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFEAF1FB'}};});
   sheet.getCell('A1').note=`来源：${name}，第 ${page.page} 页。${page.method==='ocr'?'扫描识别':'文字提取'}，已按位置尝试分列；请校对，原公式无法恢复。`;
  }
  await yieldToBrowser(signal);
 }
 let bytes:Uint8Array=new Uint8Array(await book.xlsx.writeBuffer());cancelled(signal);
 // ExcelJS 4.4 emits editAs on oneCellAnchor, where OOXML does not allow it.
 // Remove this attribute so Excel-compatible readers retain the embedded pages.
 if(pages.some(p=>p.method==='image')){
  const {unzipSync,zipSync,strFromU8,strToU8}=await import('fflate');const entries=unzipSync(bytes);
  for(const name of Object.keys(entries))if(/^xl\/drawings\/drawing\d+\.xml$/.test(name))entries[name]=strToU8(strFromU8(entries[name]).replace(/(<xdr:oneCellAnchor) editAs="[^"]*"/g,'$1'));
  bytes=zipSync(entries,{level:6});cancelled(signal);
 }
 return new Blob([bytes as BlobPart],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
