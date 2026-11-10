import { assetUrl } from './asset-url';
import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
import { cancelled } from './tools';

export const officeStem = (name: string) => name.replace(/\.(pdf|pptx?|xlsx?|xlsm)$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0,90) || '转换文档';
export async function readOfficeBytes(file: File, extensions: string[]) {
  if (!extensions.some(ext => file.name.toLowerCase().endsWith('.'+ext))) throw new Error(`请选择 ${extensions.map(e=>'.'+e).join('、')} 文件。`);
  if (file.size > 80*1024*1024) throw new Error('单个 Office 文件不能超过 80 MB，请精简文件后重试。');
  return new Uint8Array(await file.arrayBuffer());
}
export function yieldToBrowser(signal?: AbortSignal) {
  return new Promise<void>(resolve=>setTimeout(resolve,0)).then(()=>cancelled(signal));
}
export function canvasBlob(canvas: HTMLCanvasElement, type='image/png', quality=.92) {
  return new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('页面图像生成失败。')),type,quality));
}
export async function blobDataUrl(blob: Blob) {
  return new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=()=>reject(new Error('图片读取失败。'));r.readAsDataURL(blob);});
}
export async function blobImage(blob: Blob): Promise<HTMLImageElement> {
  const url=URL.createObjectURL(blob),image=new Image();
  try { image.src=url;await image.decode();return image; } finally { URL.revokeObjectURL(url); }
}
let fontBytes: Promise<Uint8Array> | undefined;
export async function embedOfficeFont(pdf: PDFDocument, text: string): Promise<PDFFont> {
  if (!/[^\x20-\x7e\r\n\t]/.test(text)) return pdf.embedFont(StandardFonts.Helvetica);
  const kit=await import('@pdf-lib/fontkit');pdf.registerFontkit(kit.default);
  if (!fontBytes) fontBytes=fetch(assetUrl('office-assets/NotoSansSC-Regular.ttf')).then(async response=>{
    if(!response.ok)throw new Error('中文字体加载失败，请检查网络后重试。');return new Uint8Array(await response.arrayBuffer());
  }).catch(error=>{fontBytes=undefined;throw error;});
  return pdf.embedFont(await fontBytes,{subset:true});
}
export function wrapText(text:string,font:PDFFont,size:number,width:number):string[] {
  const lines:string[]=[];
  for(const paragraph of text.replace(/\r/g,'').split('\n')){
    let current='';
    for(const char of paragraph){
      if(current&&font.widthOfTextAtSize(current+char,size)>width){lines.push(current);current=char;}else current+=char;
    }
    lines.push(current);
  }
  return lines;
}
