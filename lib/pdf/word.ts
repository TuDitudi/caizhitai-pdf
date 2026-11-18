import { assetUrl } from './asset-url';
import { openPdf, renderPage } from './engine';
import { cancelled, pageRange, type ToolFile, type Progress } from './tools';
export type WordPage={page:number;text:string;width:number;height:number;method:'text'|'ocr'|'image';image?:Uint8Array;imageType?:'jpg'|'png';warning?:string};
export type WordOptions={range:string;mode:'editable'|'image'|'layout';forceOcr:boolean;language:'chi_sim+eng'|'eng'};
export function textLines(content:any,viewport:any):string {
 const rows:{y:number;items:{x:number;text:string;width:number;height:number}[]}[]=[];
 for(const item of content.items){if(!('str' in item)||!item.str.trim())continue;const point=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);const h=Math.abs(item.height)||12;let row=rows.find(r=>Math.abs(r.y-point[1])<Math.max(2,h*.3));if(!row){row={y:point[1],items:[]};rows.push(row);}row.items.push({x:point[0],text:item.str,width:item.width,height:h});}
 return rows.sort((a,b)=>a.y-b.y).map(r=>{const a=r.items.sort((a,b)=>a.x-b.x);return a.map((item,i)=>{if(!i)return item.text;const prev=a[i-1],gap=item.x-prev.x-prev.width;const needsSpace=gap>1&&!/\s$/.test(prev.text)&&!/^\s/.test(item.text);return (needsSpace?(gap>item.height*2?'    ':' '):'')+item.text;}).join('');}).join('\n');
}
function abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
 if(!signal)return promise;
 return new Promise((resolve,reject)=>{const stop=()=>reject(new Error('操作已取消。'));signal.addEventListener('abort',stop,{once:true});promise.then(value=>{signal.removeEventListener('abort',stop);if(signal.aborted)stop();else resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});if(signal.aborted)stop();});
}
export async function convertWordPages(file:ToolFile,options:WordOptions,progress:Progress,signal?:AbortSignal):Promise<WordPage[]> {
 const indices=pageRange(options.range,file.pages);const doc=await openPdf(file.bytes.slice());let worker:any=null;let currentPage=0;
 const abort=()=>{if(worker)void worker.terminate();};signal?.addEventListener('abort',abort);
 const pages:WordPage[]=[];
 try {
  for(let i=0;i<indices.length;i++){
   cancelled(signal);const n=indices[i]+1;currentPage=n;progress(`正在转换第 ${n} 页（${i+1} / ${indices.length}）…`);
   const page=await doc.getPage(n),v=page.getViewport({scale:1});
   let originalImage:Uint8Array|undefined;
   if(options.mode!=='editable'){
    const target=Math.min(4096,Math.max(v.width,v.height)*240/72);
    const canvas=await renderPage(doc,n,0,target);
    try {
     cancelled(signal);
     const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('页面图片生成失败')),'image/png'));
     originalImage=new Uint8Array(await blob.arrayBuffer());
    } finally {canvas.width=canvas.height=1;}
    cancelled(signal);
    if(options.mode==='image'){
     pages.push({page:n,text:'',width:v.width,height:v.height,method:'image',image:originalImage,imageType:'png'});continue;
    }
   }
   const preserve=(text:string):WordPage=>({page:n,text,width:v.width,height:v.height,method:'image',image:originalImage,imageType:'png'});
   try {
   const text=textLines(await page.getTextContent(),v);
   // Any real text layer remains editable; use explicit forced OCR for an
   // incomplete/incorrect existing OCR layer instead of discarding short pages.
   if(text.replace(/\s/g,'').length>0&&!options.forceOcr){pages.push(originalImage?preserve(text):{page:n,text,width:v.width,height:v.height,method:'text'});continue;}
   if(!worker){
    progress('正在加载本机文字识别组件…');const {createWorker}=await import('tesseract.js');cancelled(signal);
    worker=await abortable(createWorker(options.language,1,{workerPath:assetUrl('ocr/worker.min.js'),corePath:assetUrl('ocr/core'),langPath:assetUrl('ocr/lang'),gzip:false,cacheMethod:'none',workerBlobURL:false,logger:m=>{if(!signal?.aborted&&m.status==='recognizing text')progress(`正在识别第 ${currentPage} 页 · ${Math.round((m.progress||0)*100)}%`);}}).then(w=>{if(signal?.aborted){void w.terminate();throw new Error('操作已取消。');}return w;}),signal);
    if(signal?.aborted){await worker.terminate();cancelled(signal);}
   }
   const target=Math.min(3000,Math.max(v.width,v.height)*2.5);const canvas=await renderPage(doc,n,0,target);
   let recognized:any;
   try {cancelled(signal);recognized=await abortable(worker.recognize(canvas),signal);} finally {canvas.width=canvas.height=1;}
   cancelled(signal);
   const recognizedText=recognized.data.text.trim().replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g,'$1').replace(/[ \t]+([，。！？；：、])/g,'$1');
   pages.push(originalImage?preserve(recognizedText):{page:n,text:recognizedText,width:v.width,height:v.height,method:'ocr'});
   } catch(error) {
    cancelled(signal);
    if(!originalImage)throw error;
    pages.push({...preserve(''),warning:'此页文字提取失败，已完整保留原页面图片。'});
   }
  }
  cancelled(signal);return pages;
 } catch(error){if(signal?.aborted)throw new Error('操作已取消。');throw error;}
 finally{signal?.removeEventListener('abort',abort);if(worker)await worker.terminate().catch(()=>{});await doc.destroy();}
}
export async function makeWord(pages:WordPage[],name:string):Promise<Blob>{
 if(!pages.length)throw new Error('没有可导出的页面。');
 const {Document,Packer,Paragraph,TextRun,ImageRun,SectionType,HorizontalPositionRelativeFrom,VerticalPositionRelativeFrom,TextWrappingType,LineRuleType}=await import('docx');
 const sections=pages.map(p=>{
  if(p.method==='image'){
   if(!p.image)throw new Error(`第 ${p.page} 页缺少原貌图片，请重新转换。`);
   const scale=Math.min(1,31680/(Math.max(p.width,p.height)*20));
   const w=Math.max(1,Math.round(p.width*20*scale)),h=Math.max(1,Math.round(p.height*20*scale));
   return {properties:{type:SectionType.NEXT_PAGE,page:{size:{width:w,height:h},margin:{top:0,bottom:0,left:0,right:0,header:0,footer:0}}},children:[new Paragraph({spacing:{before:0,after:0,line:1,lineRule:LineRuleType.EXACT},children:[new ImageRun({type:p.imageType||'jpg',data:p.image,transformation:{width:w/15,height:h/15},floating:{horizontalPosition:{relative:HorizontalPositionRelativeFrom.PAGE,offset:0},verticalPosition:{relative:VerticalPositionRelativeFrom.PAGE,offset:0},wrap:{type:TextWrappingType.NONE},behindDocument:true,allowOverlap:true,layoutInCell:false},altText:{title:`原 PDF 第 ${p.page} 页`,description:'保留表格、图片、印章和原页面排版',name:`page-${p.page}`}})]})]};
  }
  const lines=p.text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').replace(/\r/g,'').split('\n');
  return {properties:{type:SectionType.NEXT_PAGE,page:{size:{width:11906,height:16838},margin:{top:1134,bottom:1134,left:1134,right:1134}}},children:lines.map(line=>new Paragraph({spacing:{after:70,line:276},children:[new TextRun({text:line,font:{ascii:'Arial',hAnsi:'Arial',eastAsia:'Songti SC',cs:'Arial'},size:22})]}))};
 });
 const appendix=pages.filter(p=>p.method==='image'&&(p.text.trim()||p.warning));
 if(appendix.length){
  sections.push({properties:{type:SectionType.NEXT_PAGE,page:{size:{width:11906,height:16838},margin:{top:1134,bottom:1134,left:1134,right:1134}}},children:[
   new Paragraph({children:[new TextRun({text:'可编辑文字附录',bold:true,size:28})]}),
   new Paragraph({children:[new TextRun({text:'以下文字供复制和修改，扫描识别结果请对照前面的原貌页校对。'})]}),
   ...appendix.flatMap(p=>[
    new Paragraph({children:[new TextRun({text:`原 PDF 第 ${p.page} 页`,bold:true})]}),
    ...((p.text||p.warning||'').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g,'').replace(/\r/g,'').split('\n').map(line=>new Paragraph({children:[new TextRun({text:line})]})))
   ])
  ]});
 }
 return Packer.toBlob(new Document({title:name,creator:'裁纸台',styles:{default:{document:{run:{font:{ascii:'Arial',hAnsi:'Arial',eastAsia:'Songti SC',cs:'Arial'},size:22}}}},sections}));
}
