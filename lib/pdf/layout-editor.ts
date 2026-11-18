import { openPdf, pdfEngine } from './engine';
import { assetUrl } from './asset-url';
import { canvasBlob, yieldToBrowser } from './office-common';
import { emptyFont, pdfFontAsset, rawPdfFonts, textWidth, inkTop, missingGlyphs, releaseFont, type FontAsset } from './original-font';
import { cancelled, pageRange, type Progress, type ToolFile } from './tools';

export type EditableText = {
  id: string;
  original: string;
  fontId: string;
  baseline: number;
  tracking: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
  angle: number;
  color: string;
  background: string;
  source: 'pdf' | 'ocr';
  originalSize?: number;
  originalBox?: {x:number;y:number;width:number;height:number;angle:number};
};
export type EditablePage = {
  page: number;
  width: number;
  height: number;
  image: Blob;
  background?: Blob;
  blocks: EditableText[];
  fonts: Record<string, FontAsset>;
  warning?: string;
};

function paperColor(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  const context = canvas.getContext('2d')!;
  const colors = new Map<string, number>();
  for (const [px, py] of [[x - 2, y], [x + w + 2, y], [x, y - 2], [x + w, y + h + 2]]) {
    const point = context.getImageData(Math.max(0, Math.min(canvas.width - 1, Math.round(px))), Math.max(0, Math.min(canvas.height - 1, Math.round(py))), 1, 1).data;
    const color = `#${[...point.slice(0, 3)].map(n => n.toString(16).padStart(2, '0')).join('')}`;
    colors.set(color, (colors.get(color) || 0) + 1);
  }
  return [...colors].sort((a, b) => b[1] - a[1])[0][0];
}

function scanTextColor(canvas: HTMLCanvasElement, block: EditableText, scale: number) {
  const x=Math.max(0,Math.floor(block.x*scale)),y=Math.max(0,Math.floor(block.y*scale));
  const w=Math.min(canvas.width-x,Math.ceil(block.width*scale)),h=Math.min(canvas.height-y,Math.ceil(block.height*scale));
  if(w<=0||h<=0)return '#202020';
  const data=canvas.getContext('2d')!.getImageData(x,y,w,h).data,colors=new Map<string,{n:number;r:number;g:number;b:number}>();
  for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2];if((r+g+b)/3>210||Math.min(r,g,b)>175)continue;
    const key=[r,g,b].map(n=>Math.round(n/32)).join(',');const value=colors.get(key)||{n:0,r:0,g:0,b:0};value.n++;value.r+=r;value.g+=g;value.b+=b;colors.set(key,value);
  }
  const best=[...colors.values()].sort((a,b)=>b.n-a.n)[0];return best?'#'+[best.r,best.g,best.b].map(n=>Math.round(n/best.n).toString(16).padStart(2,'0')).join(''):'#202020';
}

function visibleTextColor(original: HTMLCanvasElement, background: HTMLCanvasElement, block: EditableText, scale: number) {
  const c = Math.cos(block.angle), s = Math.sin(block.angle);
  const corners = [[0, 0], [block.width, 0], [0, block.height], [block.width, block.height]];
  const xs = corners.map(([x, y]) => (block.x + x * c - y * s) * scale);
  const ys = corners.map(([x, y]) => (block.y + x * s + y * c) * scale);
  const x = Math.max(0, Math.floor(Math.min(...xs))), y = Math.max(0, Math.floor(Math.min(...ys)));
  const width = Math.min(original.width - x, Math.ceil(Math.max(...xs)) - x);
  const height = Math.min(original.height - y, Math.ceil(Math.max(...ys)) - y);
  if (width <= 0 || height <= 0) return undefined;
  const a = original.getContext('2d')!.getImageData(x, y, width, height).data;
  const b = background.getContext('2d')!.getImageData(x, y, width, height).data;
  let strongest = 30, color: string | undefined;
  for (let i = 0; i < a.length; i += 4) {
    const difference = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (difference > strongest) {
      strongest = difference;
      color = `#${[a[i], a[i + 1], a[i + 2]].map(n => n.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return color;
}

export async function recognizeLayout(file: ToolFile, range: string, language: 'chi_sim+eng' | 'eng', progress: Progress, signal: AbortSignal): Promise<EditablePage[]> {
  const indices = pageRange(range, file.pages);
  const pdf = await openPdf(file.bytes.slice(), { fontExtraProperties: true });
  const rawFonts = await rawPdfFonts(file.bytes);
  const fontAssets: Record<string, FontAsset> = {};
  const engine = await pdfEngine();
  let worker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>> | undefined;
  const stop = () => { void worker?.terminate(); };
  signal.addEventListener('abort', stop);
  const pages: EditablePage[] = [];
  let completed=false;
  try {
    for (const index of indices) {
      cancelled(signal);
      progress(`正在识别第 ${index + 1} 页（${pages.length + 1} / ${indices.length}）`);
      const page = await pdf.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2400 / Math.max(base.width, base.height), 200 / 72);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvasContext: canvas.getContext('2d')!, canvas, viewport, background: '#ffffff' }).promise;
        cancelled(signal);
        const result: EditablePage = { page: index + 1, width: base.width, height: base.height, image: await canvasBlob(canvas), blocks: [], fonts: {} };
        const content = await page.getTextContent();
        const operators = await page.getOperatorList();
        const glyphMaps = new Map<string, Map<string,string>>();
        let selectedFont = ''; const stack: string[] = [];
        for (let i=0;i<operators.fnArray.length;i++) {
          const op=operators.fnArray[i],args=operators.argsArray[i];
          if(op===engine.OPS.save)stack.push(selectedFont);
          else if(op===engine.OPS.restore)selectedFont=stack.pop()||'';
          else if(op===engine.OPS.setFont)selectedFont=args[0];
          else if([engine.OPS.showText,engine.OPS.showSpacedText,engine.OPS.nextLineShowText,engine.OPS.nextLineSetSpacingShowText].includes(op)) {
            const map=glyphMaps.get(selectedFont)||new Map<string,string>();
            for(const glyph of args.flat())if(glyph&&typeof glyph==='object'&&glyph.unicode&&glyph.fontChar)map.set(glyph.unicode,glyph.fontChar);
            glyphMaps.set(selectedFont,map);
          }
        }
        for (const item of content.items) if ('fontName' in item && !result.fonts[item.fontName]) {
          if (!fontAssets[item.fontName]) {
            let face: {name?:string}|undefined;
            try { face=page.commonObjs.get(item.fontName);fontAssets[item.fontName]=await pdfFontAsset(face,glyphMaps.get(item.fontName)||new Map(),rawFonts); }
            catch { fontAssets[item.fontName]=emptyFont(item.fontName,face?.name||content.styles[item.fontName]?.fontFamily||'未知原字体'); }
          }
          result.fonts[item.fontName]=fontAssets[item.fontName];
        }
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue;
          const transform = engine.Util.transform(base.transform, item.transform);
          const size = Math.hypot(transform[2], transform[3]);
          const angle = Math.atan2(transform[1], transform[0]);
          const ascent = result.fonts[item.fontName]?.data ? inkTop(result.fonts[item.fontName],item.str) : content.styles[item.fontName]?.ascent ?? 0.85;
          result.blocks.push({ id: `${index}-${result.blocks.length}`, original: item.str, text: item.str, fontId: item.fontName, baseline: size*ascent, tracking: 0,
            x: transform[4] + Math.sin(angle) * size * ascent,
            y: transform[5] - Math.cos(angle) * size * ascent,
            width: Math.max(item.width, size * 0.3), height: size*1.15, size, angle,
            color: '#202020', background: '#ffffff', source: 'pdf' });
          const block=result.blocks[result.blocks.length-1],asset=result.fonts[item.fontName];
          if(asset?.data&&[...item.str].length>1)block.tracking=(block.width-textWidth(asset,item.str,size))/([...item.str].length-1);
        }
        if (result.blocks.length) {
          // Render graphics without text. Modified text regions can recover the
          // actual page background instead of covering table lines with white.
          const textOps = new Set([engine.OPS.showText, engine.OPS.showSpacedText, engine.OPS.nextLineShowText, engine.OPS.nextLineSetSpacingShowText]);
          const background = document.createElement('canvas');
          background.width = canvas.width;
          background.height = canvas.height;
          try {
            await page.render({ canvas: background, canvasContext: background.getContext('2d')!, viewport, background: '#ffffff', operationsFilter: i => !textOps.has(operators.fnArray[i]) }).promise;
            // Scanned PDFs may already contain an invisible OCR text layer.
            // Its visible glyphs belong to the image and need the scan edit path.
            for (const block of result.blocks) {
              const color = visibleTextColor(canvas, background, block, scale);
              if (color) block.color = color;
              else {
                block.source = 'ocr';
                block.fontId='scan-font';
                result.fonts['scan-font'] ??= emptyFont('scan-font','扫描页原字体',true);
                block.background = paperColor(canvas, block.x * scale, block.y * scale, block.width * scale, block.height * scale);
                block.color = scanTextColor(canvas,block,scale);
              }
            }
            result.background = await canvasBlob(background);
          } finally { background.width = background.height = 1; }
        } else {
          try {
            if (!worker) {
              progress('正在加载扫描文字识别组件');
              const { createWorker } = await import('tesseract.js');
              worker = await createWorker(language, 1, { workerPath: assetUrl('ocr/worker.min.js'), corePath: assetUrl('ocr/core'), langPath: assetUrl('ocr/lang'), gzip: false, cacheMethod: 'none', workerBlobURL: false });
              cancelled(signal);
            }
            const recognized = await worker.recognize(canvas, {}, { blocks: true, text: true });
            for (const block of recognized.data.blocks || []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
              const text = line.text.trim().replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,'$1');
              if (!text) continue;
              const { x0, y0, x1, y1 } = line.bbox;
              result.blocks.push({ id: `${index}-${result.blocks.length}`, original: text, text, fontId:'scan-font', baseline:(y1-y0)/scale*.85, tracking:0,
                x: x0 / scale, y: y0 / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale,
                size: (y1 - y0) / scale, angle: 0, color: '#202020', background: paperColor(canvas, x0, y0, x1 - x0, y1 - y0), source: 'ocr' });
            }
            result.fonts['scan-font'] ??= emptyFont('scan-font','扫描页原字体',true);
            if (!result.blocks.length) result.warning = '这页未识别到文字，原页面已保留。';
          } catch (error) {
            cancelled(signal);
            result.warning = '这页文字识别失败，原页面已保留，可重新识别。';
          }
        }
        for(const b of result.blocks){if(b.source==='ocr')b.color=scanTextColor(canvas,b,scale);b.originalSize=b.size;b.originalBox={x:b.x,y:b.y,width:b.width,height:b.height,angle:b.angle};}
        pages.push(result);
      } finally { canvas.width = canvas.height = 1; }
      await yieldToBrowser(signal);
    }
    completed=true;return pages;
  } finally {
    if(!completed)Object.values(fontAssets).forEach(releaseFont);
    signal.removeEventListener('abort', stop);
    await worker?.terminate().catch(() => {});
    await pdf.destroy();
  }
}

export function changedText(block: EditableText) {
  return block.text !== block.original || (block.originalSize !== undefined && block.size !== block.originalSize) || (!!block.originalBox && (block.width !== block.originalBox.width || block.height !== block.originalBox.height));
}

function eraseScanText(context: CanvasRenderingContext2D, image: ImageBitmap, block: EditableText, scale: number) {
  const box=block.originalBox||block,c=Math.cos(box.angle),s=Math.sin(box.angle);
  const corners=[[0,0],[box.width,0],[0,box.height],[box.width,box.height]];
  const xs=corners.map(([x,y])=>(box.x+x*c-y*s)*scale),ys=corners.map(([x,y])=>(box.y+x*s+y*c)*scale);
  const x=Math.max(0,Math.floor(Math.min(...xs)) - 2),y=Math.max(0,Math.floor(Math.min(...ys)) - 2);
  const w=Math.min(image.width-x,Math.ceil(Math.max(...xs))-x+2),h=Math.min(image.height-y,Math.ceil(Math.max(...ys))-y+2);
  if(w<=0||h<=0)return;
  const tile=document.createElement('canvas');tile.width=w;tile.height=h;const target=tile.getContext('2d')!;target.drawImage(image,-x,-y);
  const pixels=target.getImageData(0,0,w,h),paper=block.background.match(/[a-f\d]{2}/gi)!.map(n=>parseInt(n,16));
  // Match the recognized ink hue so black text does not erase red stamps.
  // Coincident artwork of the same color is ambiguous and needs review.
  const ink=block.color.match(/[a-f\d]{2}/gi)!.map(n=>parseInt(n,16)),spread=Math.max(...ink)-Math.min(...ink);
  const hue=(rgb:number[])=>{const min=Math.min(...rgb),span=Math.max(...rgb)-min;return rgb.map(n=>(n-min)/(span||1));},wanted=hue(ink);
  for(let i=0;i<pixels.data.length;i+=4){const a=pixels.data,rgb=[a[i],a[i+1],a[i+2]],span=Math.max(...rgb)-Math.min(...rgb);const match=spread<45?span<45:span>30&&hue(rgb).reduce((sum,n,j)=>sum+Math.abs(n-wanted[j]),0)<.4;if(match){a[i]=paper[0];a[i+1]=paper[1];a[i+2]=paper[2];}}
  target.putImageData(pixels,0,0);context.drawImage(tile,x/scale,y/scale,w/scale,h/scale);tile.width=tile.height=1;
}

// Paint only changed regions with available original glyphs. Missing glyphs
// leave the original image visible rather than silently showing another font.
export function paintEditedBackground(page: EditablePage, canvas: HTMLCanvasElement, image: ImageBitmap, background?: ImageBitmap) {
  if(canvas.width!==image.width)canvas.width=image.width;
  if(canvas.height!==image.height)canvas.height=image.height;
  const context=canvas.getContext('2d')!,scale=canvas.width/page.width;
  context.resetTransform();context.drawImage(image,0,0);
  for(const block of page.blocks.filter(b=>changedText(b)&&!missingGlyphs(page.fonts[b.fontId],b.text))) {
    const box=block.originalBox||block;
    context.save();context.scale(scale,scale);context.translate(box.x,box.y);context.rotate(box.angle);context.beginPath();context.rect(-.6,-.6,box.width+1.2,box.height+1.2);context.clip();context.rotate(-box.angle);context.translate(-box.x,-box.y);
    if(background&&block.source==='pdf')context.drawImage(background,0,0,page.width,page.height);
    else eraseScanText(context,image,block,scale);
    context.restore();
  }
}
export async function editedBackground(page: EditablePage) {
  const image=await createImageBitmap(page.image),background=page.background?await createImageBitmap(page.background):undefined;
  const canvas=document.createElement('canvas');
  try{paintEditedBackground(page,canvas,image,background);return await canvasBlob(canvas);}
  finally{image.close();background?.close();canvas.width=canvas.height=1;}
}
