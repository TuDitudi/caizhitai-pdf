import type { Presentation } from '@web-ppt/core';
import { PDFDocument } from 'pdf-lib';
import { openPdf, renderPage } from './engine';
import { cancelled, pageRange, type Progress, type ToolFile } from './tools';
import { blobDataUrl, blobImage, canvasBlob, readOfficeBytes, yieldToBrowser } from './office-common';

export type SlideFile={name:string;size:number;presentation:Presentation};
export async function readPresentation(file:File, signal?:AbortSignal):Promise<SlideFile>{
  const bytes=await readOfficeBytes(file,['ppt','pptx']);cancelled(signal);
  const {parse}=await import('@web-ppt/core');
  const presentation=await parse(bytes,{zip:{maxTotalBytes:250*1024*1024,maxEntryBytes:80*1024*1024,maxEntries:15000}});
  if(signal?.aborted){presentation.dispose?.();cancelled(signal);}
  if(!presentation.slides.length||presentation.slides.length>500){presentation.dispose?.();throw new Error('演示文稿需包含 1–500 页。');}
  return {name:file.name,size:file.size,presentation};
}
// Never fetch links from uploaded Office documents. Only local embedded assets
// are inlined; generated SVG is decoded as an image, never inserted as HTML.
async function localSvg(source:string,darkText=false):Promise<string>{
  const xml=new DOMParser().parseFromString(source,'image/svg+xml');
  if(xml.querySelector('parsererror'))throw new Error('幻灯片图形格式异常。');
  xml.querySelectorAll('script,foreignObject').forEach(e=>e.remove());
  if(darkText)xml.querySelectorAll('text,tspan').forEach(e=>{e.setAttribute('fill','#202b38');(e as SVGElement).style.fill='#202b38';});
  const cache=new Map<string,Promise<string>>();
  function inline(url:string){
    if(!cache.has(url))cache.set(url,fetch(url).then(r=>{if(!r.ok)throw new Error('嵌入图片读取失败。');return r.blob();}).then(blobDataUrl));
    return cache.get(url)!;
  }
  for(const node of Array.from(xml.querySelectorAll('*'))){
    for(const attr of Array.from(node.attributes)){
      if(/^on/i.test(attr.name)){node.removeAttribute(attr.name);continue;}
      if(attr.localName==='href'){
        if(node.localName==='a'){node.removeAttributeNode(attr);continue;}
        if(attr.value.startsWith('blob:'))attr.value=await inline(attr.value);
        else if(!attr.value.startsWith('#')&&!/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(attr.value))throw new Error('演示文稿包含外部图片链接。请先在 PowerPoint 中将图片嵌入文件后重试。');
      }
    }
  }
  let result=new XMLSerializer().serializeToString(xml);
  for(const match of Array.from(result.matchAll(/url\(['"]?(blob:[^'"\s)]+)['"]?\)/g)))result=result.replace(match[0],`url('${await inline(match[1])}')`);
  if(/url\(\s*['"]?(?:https?:|\/\/|file:)/i.test(result))throw new Error('文件含外部字体或图片链接，请嵌入资源后重试。');
  return result;
}
export async function slidePreview(file:SlideFile,index:number,width=1300,signal?:AbortSignal,darkText=false):Promise<Blob>{
  cancelled(signal);
  const {renderSlideToSvg,staticHidden}=await import('@web-ppt/core');
  const pres=file.presentation,slide=pres.slides[index];
  if(!slide)throw new Error('幻灯片页码无效。');
  const svg=await localSvg(renderSlideToSvg(pres,darkText?{...slide,background:{type:'solid',color:'#ffffff'}}:slide,{textMode:'svg',hiddenElements:[...staticHidden(slide)],includeNotes:false}),darkText);cancelled(signal);
  const image=await blobImage(new Blob([svg],{type:'image/svg+xml'}));cancelled(signal);
  const scale=Math.min(width/pres.width,Math.sqrt(8_000_000/(pres.width*pres.height)));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(pres.width*scale));canvas.height=Math.max(1,Math.round(pres.height*scale));
  try{const ctx=canvas.getContext('2d');if(!ctx)throw new Error('设备无法绘制幻灯片。');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
    // An inherited legacy color can make all parsed text invisible. Do not
    // report a successful blank conversion; let the user explicitly opt in
    // to a contrasting rendition, or resave the source in PowerPoint.
    if(svg.includes('<text')){
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let visible=false;
      for(let i=4;i<pixels.length;i+=16)if(Math.abs(pixels[i]-pixels[0])+Math.abs(pixels[i+1]-pixels[1])+Math.abs(pixels[i+2]-pixels[2])>24){visible=true;break;}
      if(!visible)throw new Error(`第 ${index+1} 页的文字与背景同色，无法正确显示。请勾选“增强文字对比度”，或在 PowerPoint 中另存为 PPTX 后重试。`);
    }
    return await canvasBlob(canvas);}
  finally{canvas.width=canvas.height=1;}
}
export async function presentationToPdf(file:SlideFile,range:string,dpi:number,progress:Progress,signal?:AbortSignal,darkText=false){
  const indices=pageRange(range,file.presentation.slides.length);if(indices.length>250)throw new Error('一次最多导出 250 页，请分批设置页码。');
  const pdf=await PDFDocument.create();const {width,height}=file.presentation;
  for(let i=0;i<indices.length;i++){
    cancelled(signal);progress(`正在转换幻灯片 ${i+1} / ${indices.length}…`);
    const blob=await slidePreview(file,indices[i],width*dpi/96,signal,darkText);const image=await pdf.embedPng(await blob.arrayBuffer());
    const page=pdf.addPage([width*.75,height*.75]);page.drawImage(image,{x:0,y:0,width:page.getWidth(),height:page.getHeight()});await yieldToBrowser(signal);
  }
  return pdf.save();
}
export async function pdfToPresentation(file:ToolFile,range:string,layout:'source'|'wide'|'standard',progress:Progress,signal?:AbortSignal):Promise<Blob>{
  const indices=pageRange(range,file.pages);if(indices.length>200)throw new Error('一次最多转换 200 页，请分批选择。');
  const doc=await openPdf(file.bytes.slice());
  try{
    const {default:PptxGenJS}=await import('pptxgenjs');const ppt=new PptxGenJS();
    const first=await doc.getPage(indices[0]+1),v=first.getViewport({scale:1});
    const w=layout==='wide'?13.333:layout==='standard'?10:Math.min(30,v.width/72),h=layout==='wide'?7.5:layout==='standard'?7.5:w*v.height/v.width;
    if(h>50||h<.1||w<.1)throw new Error('原页面比例过于特殊，请选择 16:9 或 4:3 幻灯片。');
    ppt.defineLayout({name:'PDF',width:w,height:h});ppt.layout='PDF';ppt.author='裁纸台';ppt.title=file.name;
    for(let i=0;i<indices.length;i++){
      cancelled(signal);progress(`正在生成幻灯片 ${i+1} / ${indices.length}…`);
      const canvas=await renderPage(doc,indices[i]+1,0,2200);
      try{
        const data=await blobDataUrl(await canvasBlob(canvas,'image/jpeg',.94));const s=Math.min(w/canvas.width,h/canvas.height),iw=canvas.width*s,ih=canvas.height*s;
        const slide=ppt.addSlide();slide.background={color:'FFFFFF'};slide.addImage({data,x:(w-iw)/2,y:(h-ih)/2,w:iw,h:ih});slide.addNotes(`来源：${file.name}，原第 ${indices[i]+1} 页。页面以图片保留，原文字不作为独立文本框。`);
      }finally{canvas.width=canvas.height=1;}
      await yieldToBrowser(signal);
    }
    progress('正在打包 PPTX…');const result=await ppt.write({outputType:'blob',compression:true});cancelled(signal);return result as Blob;
  }finally{await doc.destroy();}
}
