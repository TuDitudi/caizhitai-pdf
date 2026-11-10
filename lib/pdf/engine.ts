import { PDFDocument } from 'pdf-lib';
import { dimensions, layout, type Edit } from './geometry';
import { originalPdf, checkSize, fileSize, type ExportOptions, type ExportResult } from './export';
let engine: Promise<typeof import('pdfjs-dist')>;
export function pdfEngine() {
  if (!engine) engine = import('pdfjs-dist').then(p => { p.GlobalWorkerOptions.workerSrc='/pdf-assets/pdf.worker.min.mjs'; return p; });
  return engine;
}
export async function openPdf(data: Uint8Array) {
  const p = await pdfEngine();
  return p.getDocument({ data, cMapUrl:'/pdf-assets/cmaps/', cMapPacked:true, standardFontDataUrl:'/pdf-assets/standard_fonts/', wasmUrl:'/pdf-assets/wasm/', isEvalSupported:false }).promise;
}
export async function renderPage(doc: any, source: number, rotation: number, target: number) {
  const page = await doc.getPage(source), base = page.getViewport({scale:1,rotation:(page.rotate+rotation)%360});
  const viewport = page.getViewport({scale:target/Math.max(base.width,base.height),rotation:(page.rotate+rotation)%360});
  const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({canvasContext:canvas.getContext('2d'),viewport,background:'#ffffff'}).promise;
  return canvas;
}
export function cropCanvas(canvas: HTMLCanvasElement, e: Edit) {
  const out = document.createElement('canvas'), c=e.crop;
  out.width=Math.max(1,Math.round(canvas.width*c.w)); out.height=Math.max(1,Math.round(canvas.height*c.h));
  out.getContext('2d')!.drawImage(canvas,canvas.width*c.x,canvas.height*c.y,canvas.width*c.w,canvas.height*c.h,0,0,out.width,out.height);
  return out;
}
async function imageBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('图像生成失败')), type, quality));
}
async function fitImage(canvas: HTMLCanvasElement, budget: number) {
  // Keep resolution first; only reduce it when JPEG quality alone cannot fit.
  for (const scale of [1, .8, .6, .45, .32, .22]) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(canvas.width * scale)); c.height = Math.max(1, Math.round(canvas.height * scale));
    const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0,0,c.width,c.height); g.drawImage(canvas,0,0,c.width,c.height);
    const png = await imageBlob(c, 'image/png');
    if (png.size <= budget) { c.width = c.height = 1; return {blob:png, png:true}; }
    const best = await imageBlob(c, 'image/jpeg', .93);
    if (best.size <= budget) { c.width = c.height = 1; return {blob:best, png:false}; }
    let lo = .48, hi = .93, candidate = await imageBlob(c, 'image/jpeg', lo);
    if (candidate.size <= budget) {
      for (let i=0; i<5; i++) { const q=(lo+hi)/2, b=await imageBlob(c,'image/jpeg',q); if(b.size<=budget){candidate=b;lo=q;}else hi=q; }
      c.width=c.height=1; return {blob:candidate,png:false};
    }
    c.width=c.height=1;
  }
  throw new Error('在当前体积上限内无法保留足够清晰的页面，已停止导出。请减少导出页数后重试。');
}
export async function exportPdf(doc:any, edits:Edit[], options:ExportOptions, progress:(s:string)=>void): Promise<ExportResult> {
  const maxBytes=Math.floor(Math.min(options.maxBytes, options.source.byteLength));
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error('文件大小上限无效。');
  let original:Uint8Array|undefined;
  try { original=await originalPdf(doc,edits,options.source,progress); }
  catch (err) { if(!options.allowCompression) throw new Error('无法在保留原始内容的模式下处理此文件。可启用“超限时压缩图像”后重试。'); }
  if(original && original.byteLength<=maxBytes) return {bytes:original,method:'original',capped:false};
  if(!options.allowCompression) { if(original)checkSize(original,maxBytes); throw new Error('未生成满足体积上限的文件。'); }
  const out=await PDFDocument.create({updateMetadata:false});let capped=false;
  // Reserve space for all PDF objects before allocating encoded-image budgets.
  let remaining = maxBytes - 4096 - edits.length * 1600;
  if(remaining < edits.length*2000) throw new Error('体积上限过小，无法容纳这些页面。请减少导出页数后重试。');
  for(let i=0;i<edits.length;i++) {
    progress(`正在压缩到 ${fileSize(maxBytes)} 以内 · 第 ${i+1} / ${edits.length} 页…`);
    const e=edits[i],d=dimensions(e),l=layout(e);
    const needed=Math.max(l.iw/e.crop.w,l.ih/e.crop.h)*200/72;
    const sourceMax=Math.sqrt(20_000_000/(Math.min(d.w,d.h)/Math.max(d.w,d.h)));
    const target=Math.min(needed,sourceMax,12000);if(target<needed)capped=true;
    const raw=await renderPage(doc,e.source,e.rotation,target),cropped=cropCanvas(raw,e);
    raw.width=raw.height=1;
    const result=await fitImage(cropped,Math.floor(remaining/(edits.length-i)));
    cropped.width=cropped.height=1;remaining-=result.blob.size;
    const bytes=await result.blob.arrayBuffer();
    const img=result.png?await out.embedPng(bytes):await out.embedJpg(bytes);
    out.addPage([l.w,l.h]).drawImage(img,{x:l.x,y:l.h-l.y-l.ih,width:l.iw,height:l.ih});
    await new Promise(r=>setTimeout(r,0));
  }
  const bytes=await out.save({useObjectStreams:true,addDefaultPage:false});
  checkSize(bytes,maxBytes); // Never download an oversized result, even if overhead estimates miss.
  return {bytes,method:'compressed',capped};
}
export async function demoPdf() {
  const doc=await PDFDocument.create();
  for(let n=1;n<=2;n++) {
    const c=document.createElement('canvas');c.width=1000;c.height=1414;const g=c.getContext('2d')!;
    g.fillStyle='#394148';g.fillRect(0,0,1000,1414);g.fillStyle='#f7f6f2';g.fillRect(47,57,906,1300);
    g.fillStyle='#223542';g.font='bold 48px serif';g.fillText(n===1?'城市漫步 · 观察手记':'让每一页，恰到好处',110,184);
    g.font='22px sans-serif';g.fillStyle='#6b757d';g.fillText('扫描文档示例     /     2026 年 11 月',110,235);
    g.strokeStyle='#697780';g.beginPath();g.moveTo(110,276);g.lineTo(885,276);g.stroke();
    g.font='30px serif';g.fillStyle='#39454d';
    const lines=n===1?['一页记录，也值得好好整理。','','午后的光落在纸上，留下柔和的边界。','我们把沿途的发现收进笔记，也把那些','值得停留的片刻，慢慢保存下来。','','扫描时留下的黑边，可以轻轻裁去。','留出合适的空白，文字便有了呼吸。']:['这是一份可以放心试用的示例文件。','','先拖动蓝色边框，留下需要的区域。','再切换到「缩放排版」，选择纸张大小。','缩小内容、调整位置，让版面更整齐。','','每一页都可以单独处理，','也可以把当前设置应用到全部页面。'];
    lines.forEach((s,i)=>g.fillText(s,110,350+i*58));
    g.fillStyle='#e2e7e6';g.fillRect(110,930,775,230);g.fillStyle='#526b70';g.font='24px sans-serif';g.fillText('纸张、文字，以及恰到好处的留白。',150,1050);
    g.fillStyle='#8a9396';g.font='20px sans-serif';g.fillText(`示例扫描件 · 第 ${n} 页`,110,1270);
    const image=await doc.embedPng(c.toDataURL('image/png'));doc.addPage([595.28,841.89]).drawImage(image,{x:0,y:0,width:595.28,height:841.89});
  }
  return doc.save();
}
