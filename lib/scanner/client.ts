import { PDFDocument } from 'pdf-lib';
import { assetUrl } from '../pdf/asset-url';
import { readImageFile } from '../pdf/images';
import { cancelled, type Progress } from '../pdf/tools';

export type Point = { x: number; y: number };
export type Quad = [Point, Point, Point, Point];
export type ScanSettings = { paper: 'auto' | 'a4' | 'a4-landscape' | 'a5'; mode: 'color' | 'bw' | 'original'; strength: number; rotation: number };
export type ScanResult = { blob: Blob; width: number; height: number };
export type Detection = { points: Quad; confidence: 'detected' | 'review' | 'manual'; warning: string; preview: Blob };
export type ScanPhoto = { id: string; name: string; originalSize: number; source: File; width: number; height: number; preview: Blob; points: Quad; initial: Quad; confidence: Detection['confidence']; warning: string; settings: ScanSettings; result?: ScanResult; dirty: boolean; needsReview: boolean };
export const copyQuad = (points: Quad): Quad => points.map(p => ({ ...p })) as Quad;
export const fullQuad = (): Quad => [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
export function validQuad(points: Quad) {
  if (points.length !== 4 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) return false;
  const crosses = points.map((p, i) => {
    const q = points[(i+1)%4], r = points[(i+2)%4];
    return (q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x);
  });
  const area = Math.abs(points.reduce((s,p,i) => s+p.x*points[(i+1)%4].y-p.y*points[(i+1)%4].x, 0))/2;
  return crosses.every(n => n > .0001) && area > .012;
}
export class ScanWorker {
  private worker?: Worker;
  private serial = 0;
  private pending = false;
  dispose() { this.worker?.terminate(); this.worker = undefined; }
  async call<T>(type: 'detect' | 'render', payload: unknown, progress: Progress, signal: AbortSignal): Promise<T> {
    cancelled(signal);
    if (this.pending) throw new Error('正在处理另一张照片，请稍候。');
    this.pending = true;
    try {
      this.worker ??= new Worker(assetUrl('scanner/scan-worker.js?v=2'));
      const worker = this.worker, id = ++this.serial;
      return await new Promise<T>((resolve, reject) => {
        const finish = (error?: Error, value?: T) => {
          clearTimeout(timer); signal.removeEventListener('abort', abort);
          worker.removeEventListener('message', receive); worker.removeEventListener('error', fail);
          if (error) reject(error); else resolve(value!);
        };
        const abort = () => { this.dispose(); finish(new Error('已取消扫描。')); };
        const fail = () => { this.dispose(); finish(new Error('扫描组件运行失败。请减少照片尺寸后重试。')); };
        const receive = (event: MessageEvent) => {
          if (event.data.id !== id) return;
          if (event.data.progress) progress(event.data.progress);
          else if (event.data.error) finish(new Error(event.data.error));
          else finish(undefined, event.data.result);
        };
        const timer = window.setTimeout(() => { this.dispose(); finish(new Error('照片处理超时，请减少尺寸后重试。')); }, 120000);
        worker.addEventListener('message', receive); worker.addEventListener('error', fail); signal.addEventListener('abort', abort, { once: true });
        worker.postMessage({ id, type, payload });
      });
    } finally { this.pending = false; }
  }
}
async function decodeHeic(file: File, progress: Progress, signal: AbortSignal) {
  progress('正在读取 HEIC 手机照片'); cancelled(signal);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch {
    const worker = new Worker(assetUrl('scanner/heic-decoder-1.6.7.js'));
    try {
      const buffer = await file.arrayBuffer(); cancelled(signal);
      const data = await new Promise<ImageData>((resolve, reject) => {
        const finish = (error?: Error, value?: ImageData) => { clearTimeout(timer); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(value!); };
        const abort = () => { worker.terminate(); finish(new Error('已取消读取照片。')); };
        const timer = window.setTimeout(() => { worker.terminate(); finish(new Error('HEIC 读取超时，请尝试较小的照片。')); }, 120000);
        signal.addEventListener('abort', abort, { once: true });
        worker.onmessage = event => event.data.error ? finish(new Error('HEIC 照片无法读取，请尝试导出为 JPG 后重试。')) : finish(undefined, event.data.imageData);
        worker.onerror = () => finish(new Error('HEIC 解码组件加载失败，请刷新后重试。'));
        worker.postMessage({ id: 1, buffer }, [buffer]);
      });
      cancelled(signal); bitmap = await createImageBitmap(data);
    } finally { worker.terminate(); }
  }
  try {
    if (bitmap.width * bitmap.height > 40000000 || Math.max(bitmap.width,bitmap.height)>24000) throw new Error('照片超过 4000 万像素，请缩小后重试。');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    try { canvas.getContext('2d')!.drawImage(bitmap,0,0); return await canvas.convertToBlob({type:'image/png'}); }
    finally { canvas.width=canvas.height=1; }
  } finally { bitmap.close(); }
}
export async function importScanPhoto(file: File, worker: ScanWorker, progress: Progress, signal: AbortSignal): Promise<ScanPhoto> {
  if (file.size > 50*1024*1024) throw new Error(`“${file.name}”超过 50 MB，请缩小后重试。`);
  const header = new TextDecoder().decode(await file.slice(0,16).arrayBuffer());
  const heic = /\.hei[cf]$/i.test(file.name) || /^image\/hei[cf]/i.test(file.type) || header.slice(4,8)==='ftyp' && /heic|heix|hevc|hevx|mif1|msf1/.test(header.slice(8));
  const normalized = heic ? new File([await decodeHeic(file,progress,signal)],file.name.replace(/\.[^.]+$/,'')+'.png',{type:'image/png'}) : file;
  cancelled(signal);
  const image = await readImageFile(normalized,signal);
  const detected = await worker.call<Detection>('detect',{blob:normalized},progress,signal);
  if (!validQuad(detected.points)) throw new Error('未能生成有效边框，请重新选择照片。');
  return { id: image.id, name: file.name, originalSize: file.size, source: normalized, width: image.width, height: image.height, ...detected, initial: copyQuad(detected.points),
    settings:{paper:'auto',mode:'color',strength:85,rotation:0},dirty:true,needsReview:detected.confidence!=='detected' };
}
export function renderScan(photo: ScanPhoto, worker: ScanWorker, edge: number, progress: Progress, signal: AbortSignal, quality = .94, preview = false) {
  if (!validQuad(photo.points)) throw new Error('四角边框无效，请重新调整。');
  // Interactive previews use the already decoded, smaller detection image.
  // PDF export retains the original source and its full resolution.
  return worker.call<ScanResult>('render',{blob:preview?photo.preview:photo.source,points:photo.points,...photo.settings,edge,quality},progress,signal);
}
export async function scanPdf(photos: ScanPhoto[], worker: ScanWorker, edge: number, limitSize: boolean, progress: Progress, signal: AbortSignal) {
  if (!photos.length) throw new Error('请先添加照片。');
  const limit = photos.reduce((sum,p)=>sum+p.originalSize,0);
  const results: ScanResult[] = [];
  for (let i=0;i<photos.length;i++) { progress(`正在生成高清扫描页 ${i+1} / ${photos.length}`); results.push(await renderScan(photos[i],worker,edge,progress,signal)); }
  const qualities = limitSize ? [.94,.88,.82] : [.94];
  for (let attempt=0;attempt<qualities.length;attempt++) {
    cancelled(signal);
    const pdf = await PDFDocument.create({updateMetadata:false});
    for (let i=0;i<photos.length;i++) {
      cancelled(signal);progress(`正在生成 PDF ${i+1} / ${photos.length}${attempt?'（优化体积）':''}`);
      let blob = results[i].blob;
      if (attempt) {
        const bitmap = await createImageBitmap(blob), canvas = new OffscreenCanvas(bitmap.width,bitmap.height);
        try { canvas.getContext('2d')!.drawImage(bitmap,0,0); blob = await canvas.convertToBlob({type:'image/jpeg',quality:qualities[attempt]}); }
        finally { bitmap.close();canvas.width=canvas.height=1; }
      }
      const photo = photos[i], result = results[i], image = await pdf.embedJpg(await blob.arrayBuffer());
      let w: number, h: number;
      if (photo.settings.paper==='auto') { const scale=841.89/Math.max(result.width,result.height);w=result.width*scale;h=result.height*scale; }
      else { w=photo.settings.paper==='a5'?419.53:photo.settings.paper==='a4-landscape'?841.89:595.28;h=photo.settings.paper==='a5'?595.28:photo.settings.paper==='a4-landscape'?595.28:841.89;if(photo.settings.rotation%180)[w,h]=[h,w]; }
      pdf.addPage([w,h]).drawImage(image,{x:0,y:0,width:w,height:h});await pdf.flush();
    }
    const bytes=await pdf.save({useObjectStreams:true,addDefaultPage:false});cancelled(signal);
    if (!limitSize || bytes.byteLength<=limit) return {bytes,optimized:attempt>0};
  }
  throw new Error('在保留当前分辨率的情况下，无法把 PDF 控制在原照片合计大小内。可选择“标准”清晰度，或关闭体积限制后保留高清导出。');
}
