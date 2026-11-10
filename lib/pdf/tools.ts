import { PDFDocument } from 'pdf-lib';
import { zip } from 'fflate';
import { openPdf, exportPdf } from './engine';
import { fullCrop, type Edit } from './geometry';

export type ToolFile = { id: string; name: string; bytes: Uint8Array; pages: number };
export type Progress = (message: string) => void;
export function cancelled(signal?:AbortSignal) { if(signal?.aborted)throw new Error('操作已取消。'); }
export async function readToolFile(file:File):Promise<ToolFile> {
 if(!file.name.toLowerCase().endsWith('.pdf'))throw new Error('请选择 PDF 文件。');
 if(file.size>200*1024*1024)throw new Error('单个文件不能超过 200 MB。');
 return inspectPdf(new Uint8Array(await file.arrayBuffer()),file.name);
}
export async function inspectPdf(bytes:Uint8Array,name:string):Promise<ToolFile> {
 try { const pdf=await PDFDocument.load(bytes,{updateMetadata:false});if(pdf.getPageCount()<1)throw new Error();return {id:crypto.randomUUID(),name,bytes,pages:pdf.getPageCount()}; }
 catch {throw new Error(`无法读取“${name}”。请确认文件完整；密码 PDF 请先解锁另存。`);}
}
export function pageRange(text:string,total:number):number[] {
 const input=text.trim().replace(/[，、]/g,',').replace(/[–—～~至]/g,'-');
 if(!input)return Array.from({length:total},(_,i)=>i);
 const result:number[]=[],seen=new Set<number>();
 for(const part of input.split(',')) {
  const match=part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if(!match)throw new Error(`页码“${part}”格式不正确，请用 1-3,5 这样的格式。`);
  const a=Number(match[1]),b=Number(match[2]||match[1]);
  if(a<1||b<1||a>total||b>total)throw new Error(`页码必须在 1 到 ${total} 之间。`);
  if(a>b)throw new Error(`范围 ${a}-${b} 的起始页不能大于结束页。`);
  for(let n=a;n<=b;n++){if(seen.has(n))throw new Error(`第 ${n} 页重复，请检查页码。`);seen.add(n);result.push(n-1);}
 }
 return result;
}
export function splitGroups(mode:string,value:string,every:number,total:number):number[][] {
 let groups:number[][]=[];
 if(mode==='custom') {
  if(!value.trim())throw new Error('请输入分组页码，例如 1-3;4-6。');
  const pieces=value.trim().split(/[;；\n]+/).map(x=>x.trim()).filter(Boolean);
  groups=pieces.map(x=>pageRange(x,total));
 } else {
  const step=mode==='each'?1:every;
  if(!Number.isInteger(step)||step<1||step>total)throw new Error(`每份页数必须是 1 到 ${total} 之间的整数。`);
  for(let start=0;start<total;start+=step)groups.push(Array.from({length:Math.min(step,total-start)},(_,i)=>start+i));
 }
 if(groups.length>500)throw new Error('一次最多生成 500 份文件，请使用更大的每份页数。');
 return groups;
}
export function safeStem(name:string){return name.replace(/\.pdf$/i,'').replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,90)||'文档';}
export async function enforcePdfLimit(bytes:Uint8Array,limit:number,progress:Progress,signal?:AbortSignal) {
 if(bytes.byteLength<=limit)return bytes;
 cancelled(signal);const doc=await openPdf(bytes.slice());
 try {
  const edits:Edit[]=[];
  for(let i=1;i<=doc.numPages;i++){cancelled(signal);const p=await doc.getPage(i),v=p.getViewport({scale:1});edits.push({id:i,source:i,width:v.width,height:v.height,rotation:0,crop:fullCrop(),paper:'crop',customW:210,customH:297,margin:0,scale:100,offsetX:0,offsetY:0});}
  // Keep original image quality for merge/split; if metadata overhead alone
  // exceeds the limit, stop instead of silently rasterizing the documents.
  const result=await exportPdf(doc,edits,{source:bytes,maxBytes:limit,allowCompression:false},progress);
  cancelled(signal);return result.bytes;
 } finally {await doc.destroy();}
}
export async function mergePdfs(files:ToolFile[],progress:Progress,signal?:AbortSignal) {
 if(files.length<2)throw new Error('请至少选择两个 PDF。');
 const out=await PDFDocument.create({updateMetadata:false});
 for(let i=0;i<files.length;i++){cancelled(signal);progress(`正在合并 ${i+1} / ${files.length}：${files[i].name}`);const src=await PDFDocument.load(files[i].bytes,{updateMetadata:false});const copied=await out.copyPages(src,src.getPageIndices());copied.forEach(p=>out.addPage(p));await new Promise(r=>setTimeout(r,0));}
 cancelled(signal);const bytes=await out.save({useObjectStreams:true,addDefaultPage:false,updateFieldAppearances:false});
 return enforcePdfLimit(bytes,files.reduce((n,f)=>n+f.bytes.byteLength,0),progress,signal);
}
export async function splitPdf(file:ToolFile,groups:number[][],progress:Progress,signal?:AbortSignal) {
 const src=await PDFDocument.load(file.bytes,{updateMetadata:false});const outputs:{name:string;bytes:Uint8Array}[]=[];let totalBytes=0;
 for(let i=0;i<groups.length;i++){
  cancelled(signal);progress(`正在生成第 ${i+1} / ${groups.length} 份…`);
  const out=await PDFDocument.create({updateMetadata:false});const pages=await out.copyPages(src,groups[i]);pages.forEach(p=>out.addPage(p));
  const raw=groups[i].length===file.pages&&groups[i].every((n,j)=>n===j)?file.bytes:await out.save({useObjectStreams:true,addDefaultPage:false,updateFieldAppearances:false});
  const bytes=await enforcePdfLimit(raw,file.bytes.byteLength,progress,signal);totalBytes+=bytes.byteLength;
  if(totalBytes>300*1024*1024)throw new Error('这些独立文件合计超过 300 MB，请减少本次分组数量。');
  const nums=groups[i].map(n=>n+1);const label=nums.length===1?`${nums[0]}`:`${nums[0]}-${nums[nums.length-1]}`;
  outputs.push({name:`${safeStem(file.name)}-${String(i+1).padStart(3,'0')}-页${label}.pdf`,bytes});
  await new Promise(r=>setTimeout(r,0));
 }
 cancelled(signal);return outputs;
}
export async function zipPdfs(files:{name:string;bytes:Uint8Array}[]) {
 const entries=Object.fromEntries(files.map(f=>[f.name,f.bytes]));
 return new Promise<Uint8Array>((resolve,reject)=>zip(entries,{level:0},(error,data)=>error?reject(error):resolve(data)));
}
export function downloadBytes(bytes:Uint8Array|Blob,name:string,type:string) {
 const blob=bytes instanceof Blob?bytes:new Blob([bytes as BlobPart],{type});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
