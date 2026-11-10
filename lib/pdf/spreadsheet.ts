import { PDFDocument, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } from 'pdf-lib';
import type { Workbook as ExcelBook } from 'exceljs';
import { cancelled, type Progress } from './tools';
import { embedOfficeFont, readOfficeBytes, wrapText, yieldToBrowser } from './office-common';

export type SheetCell={row:number;col:number;text:string;bold:boolean;color:string;fill?:string;size:number;align:'left'|'center'|'right';border:boolean};
export type SheetImage={bytes:Uint8Array;type:'png'|'jpeg';col:number;row:number;width:number;height:number};
export type SheetData={name:string;hidden:boolean;rows:number;cols:number;cells:SheetCell[];widths:number[];heights:number[];hiddenRows:boolean[];hiddenCols:boolean[];merges:{r1:number;c1:number;r2:number;c2:number}[];images:SheetImage[]};
export type SpreadsheetFile={name:string;size:number;sheets:SheetData[];warnings:string[]};
export type SpreadsheetPdfOptions={sheets:string[];paper:'a4'|'a4-landscape'|'a3-landscape';grid:boolean;repeatHeader:boolean};
function color(value:unknown,fallback:string){const v=value as {argb?:string;theme?:number}|undefined;return v?.argb?('#'+v.argb.slice(-6)):v?.theme===0?'#ffffff':fallback;}
function toRgb(value:string){const h=value.replace('#','');return rgb(parseInt(h.slice(0,2),16)/255,parseInt(h.slice(2,4),16)/255,parseInt(h.slice(4,6),16)/255);}
export async function readSpreadsheet(file:File,signal?:AbortSignal):Promise<SpreadsheetFile>{
  const bytes=await readOfficeBytes(file,['xlsx','xls','xlsm']);cancelled(signal);
  let hasCharts=false;
  if(bytes[0]===80&&bytes[1]===75){
    const {safeUnzipSync}=await import('@web-ppt/core/zip');
    safeUnzipSync(bytes,{limits:{maxEntries:20000,maxEntryBytes:80*1024*1024,maxTotalBytes:250*1024*1024},filter:f=>{if(/^xl\/charts\/chart\d+\.xml$/.test(f.name))hasCharts=true;return false;}});
  }
  const XLSX=await import('xlsx');
  if(/\.xls$/i.test(file.name)){const cp=await import('xlsx/dist/cpexcel.full.mjs');XLSX.set_cptable(cp);}
  const book=XLSX.read(bytes,{type:'array',cellStyles:true,cellFormula:true,cellDates:false,bookVBA:false});cancelled(signal);
  let styled:ExcelBook|undefined;
  const warnings:string[]=[];
  if(!/\.xls$/i.test(file.name)){
    const {default:ExcelJS}=await import('exceljs');styled=new ExcelJS.Workbook();
    try{await styled.xlsx.load(bytes as never);}catch{styled=undefined;warnings.push('部分样式无法读取，本次采用基础表格样式。');}
  }else warnings.push('旧版 XLS 采用基础表格样式；建议另存为 XLSX 以保留更多格式。');
  if(hasCharts)warnings.push('此文件包含图表，当前转换保留单元格与嵌入图片，图表不导出。请先核对预览。');
  let missing=0,total=0;
  const sheets:SheetData[]=[];
  for(let at=0;at<book.SheetNames.length;at++){
    cancelled(signal);const name=book.SheetNames[at],source=book.Sheets[name],style=styled?.getWorksheet(name);
    const cells:SheetCell[]=[];let rows=0,cols=0;
    for(const address of Object.keys(source)){
      if(address.startsWith('!'))continue;
      const cell=source[address];if(cell.v===undefined&&!cell.f)continue;
      const pos=XLSX.utils.decode_cell(address);if(pos.r>=5000||pos.c>=100)throw new Error(`“${name}”超出 5000 行或 100 列，请先缩小表格范围。`);
      if(++total>100000)throw new Error('单次最多处理 10 万个非空单元格，请拆分工作簿。');
      rows=Math.max(rows,pos.r+1);cols=Math.max(cols,pos.c+1);
      let text:string;
      if(cell.f&&(cell.v===undefined||cell.t==='z')){missing++;text=`[未保存公式结果：=${cell.f}]`;}
      else text=cell.w??XLSX.utils.format_cell(cell);
      const st=style?.getCell(address),f=st?.fill as {type?:string;pattern?:string;fgColor?:unknown}|undefined;
      cells.push({row:pos.r,col:pos.c,text:String(text),bold:!!st?.font?.bold,color:color(st?.font?.color,'#202b38'),fill:f?.type==='pattern'&&f.pattern==='solid'?color(f.fgColor,'#ffffff'):undefined,size:Math.max(6,Math.min(40,st?.font?.size||11)),align:st?.alignment?.horizontal==='center'?'center':st?.alignment?.horizontal==='right'||(!st?.alignment?.horizontal&&cell.t==='n')?'right':'left',border:!!st?.border&&Object.values(st.border).some(Boolean)});
    }
    const columnSize=(i:number)=>Math.max(12,Math.min(500,((style?.getColumn(i+1).width??source['!cols']?.[i]?.wch??10)*7+5)*.75));
    const rowSize=(i:number)=>Math.max(12,Math.min(600,style?.getRow(i+1).height??source['!rows']?.[i]?.hpt??17));
    const position=(index:number,size:(i:number)=>number)=>{let n=0;for(let i=0;i<Math.floor(index);i++)n+=size(i);return n+(index-Math.floor(index))*size(Math.floor(index));};
    const colPosition=(i:number)=>position(i,columnSize),rowPosition=(i:number)=>position(i,rowSize);
    const images:SheetImage[]=[];
    for(const item of style?.getImages()||[]){
      const media=styled!.getImage(Number(item.imageId));if(!media||!['png','jpeg'].includes(media.extension))continue;
      const range=item.range as typeof item.range & {ext?:{width:number;height:number}};
      const col=range.tl.col,row=range.tl.row;if(!Number.isFinite(col+row)||col<0||row<0||col>=100||row>=5000)throw new Error('图片位置超出可处理的表格范围。');
      const width=range.ext?.width?range.ext.width*.75:Math.max(20,colPosition(range.br?.col??col+1)-colPosition(col));
      const height=range.ext?.height?range.ext.height*.75:Math.max(20,rowPosition(range.br?.row??row+1)-rowPosition(row));
      const data=media.buffer?new Uint8Array(media.buffer):media.base64?Uint8Array.from(atob(media.base64.replace(/^data:[^,]+,/,'')),c=>c.charCodeAt(0)):null;
      if(data){images.push({bytes:data,type:media.extension as 'png'|'jpeg',col,row,width,height});let endRow=Math.floor(row)+1,endCol=Math.floor(col)+1;while(endRow<5000&&rowPosition(endRow)<rowPosition(row)+height)endRow++;while(endCol<100&&colPosition(endCol)<colPosition(col)+width)endCol++;rows=Math.max(rows,endRow);cols=Math.max(cols,endCol);}
    }
    if(!rows||!cols)continue;
    const merges=(source['!merges']||[]).filter(m=>m.s.r<rows&&m.s.c<cols).map(m=>({r1:m.s.r,c1:m.s.c,r2:Math.min(m.e.r,4999),c2:Math.min(m.e.c,99)}));
    for(const m of merges){rows=Math.max(rows,m.r2+1);cols=Math.max(cols,m.c2+1);}
    const widths=Array.from({length:cols},(_,i)=>Math.max(12,Math.min(500,((style?.getColumn(i+1).width??source['!cols']?.[i]?.wch??10)*7+5)*.75)));
    const heights=Array.from({length:rows},(_,i)=>Math.max(12,Math.min(600,style?.getRow(i+1).height??source['!rows']?.[i]?.hpt??17)));
    const hiddenRows=Array.from({length:rows},(_,i)=>!!(style?.getRow(i+1).hidden||source['!rows']?.[i]?.hidden));
    const hiddenCols=Array.from({length:cols},(_,i)=>!!(style?.getColumn(i+1).hidden||source['!cols']?.[i]?.hidden));
    sheets.push({name,hidden:!!book.Workbook?.Sheets?.[at]?.Hidden,rows,cols,cells,widths,heights,hiddenRows,hiddenCols,merges,images});await yieldToBrowser(signal);
  }
  if(!sheets.length)throw new Error('工作簿没有可转换的单元格。');
  if(missing)warnings.push(`${missing} 个公式没有保存计算结果，预览中已明确标记。请在 Excel 中重新计算并保存后再转换。`);
  return {name:file.name,size:file.size,sheets,warnings};
}

export async function spreadsheetToPdf(file:SpreadsheetFile,options:SpreadsheetPdfOptions,progress:Progress,signal?:AbortSignal):Promise<Uint8Array>{
  const sheets=file.sheets.filter(s=>options.sheets.includes(s.name));if(!sheets.length)throw new Error('请至少选择一个工作表。');
  const pdf=await PDFDocument.create();progress('正在准备字体与表格分页…');
  const font=await embedOfficeFont(pdf,sheets.map(s=>s.name+s.cells.map(c=>c.text).join('')).join(''));cancelled(signal);
  const charset=new Set(font.getCharacterSet());
  const clean=(text:string)=>Array.from(text).map(c=>c==='\n'||c==='\r'||c==='\t'||charset.has(c.codePointAt(0)!)?c:'□').join('').replace(/\t/g,' ');
  const dimensions=options.paper==='a4'?[595.28,841.89]:options.paper==='a4-landscape'?[841.89,595.28]:[1190.55,841.89];
  let count=0;
  for(const sheet of sheets){
    const [pw,ph]=dimensions,margin=30,top=48,bottom=30;
    const widths=sheet.widths.map((w,i)=>sheet.hiddenCols[i]?0:w),xs=[0];for(const w of widths)xs.push(xs[xs.length-1]+w);
    if(xs[xs.length-1]<=0)continue;
    const scale=Math.min(1,(pw-margin*2)/xs[xs.length-1]);
    const heights=sheet.heights.map((h,i)=>sheet.hiddenRows[i]?0:h),lines=new Map<SheetCell,string[]>();
    for(const cell of sheet.cells){
      if(sheet.hiddenRows[cell.row]||sheet.hiddenCols[cell.col])continue;
      const m=sheet.merges.find(m=>m.r1===cell.row&&m.c1===cell.col);const end=m?m.c2:cell.col;
      const width=xs[end+1]-xs[cell.col]-7;if(width<=0)continue;
      const wrapped=wrapText(clean(cell.text),font,cell.size,width);lines.set(cell,wrapped);
      if(!m||m.r1===m.r2)heights[cell.row]=Math.max(heights[cell.row],wrapped.length*cell.size*1.25+7);
      else {const current=heights.slice(m.r1,m.r2+1).reduce((a,b)=>a+b,0),extra=Math.max(0,wrapped.length*cell.size*1.25+7-current);heights[m.r2]+=extra;}
    }
    const ys=[0];for(const h of heights)ys.push(ys[ys.length-1]+h);
    const firstRow=heights.findIndex(h=>h>0);if(firstRow<0)continue;
    const headEnd=Math.max(firstRow,...sheet.merges.filter(m=>m.r1===firstRow).map(m=>m.r2));
    const headerHeight=ys[headEnd+1]-ys[firstRow];
    const available=(ph-top-bottom)/scale;
    let start=firstRow,part=0;
    while(start<sheet.rows){
      cancelled(signal);if(++count>500)throw new Error('结果超过 500 页，请减少工作表或调整纸张方向。');
      const repeat=options.repeatHeader&&part>0?headerHeight:0;let end=start,height=repeat;
      while(end<sheet.rows&&height+heights[end]<=available){height+=heights[end];end++;}
      // Keep vertical merged cells on one page rather than silently cutting them.
      for(const m of sheet.merges)if(m.r1>=start&&m.r1<end&&m.r2>=end)end=Math.min(end,m.r1);
      if(end<=start)throw new Error(`“${sheet.name}”有过高的行或跨页合并单元格，请调整源表行高、合并范围或改用纵向纸张。`);
      const page=pdf.addPage(dimensions as [number,number]);page.drawText(clean(sheet.name),{x:margin,y:ph-26,size:10,font,color:rgb(.25,.3,.35)});
      const drawRows=(rStart:number,rEnd:number,offset:number)=>{
        for(const cell of sheet.cells){
          if(cell.row<rStart||cell.row>=rEnd||!widths[cell.col]||!heights[cell.row])continue;
          const merged=sheet.merges.find(m=>cell.row>=m.r1&&cell.row<=m.r2&&cell.col>=m.c1&&cell.col<=m.c2);
          if(merged&&(cell.row!==merged.r1||cell.col!==merged.c1))continue;
          const cEnd=merged?merged.c2:cell.col,rLast=merged?merged.r2:cell.row;
          const x=margin+xs[cell.col]*scale,yTop=ph-top-(ys[cell.row]-ys[rStart]+offset)*scale;
          const w=(xs[cEnd+1]-xs[cell.col])*scale,h=(ys[rLast+1]-ys[cell.row])*scale;
          if(cell.fill)page.drawRectangle({x,y:yTop-h,width:w,height:h,color:toRgb(cell.fill)});
          if(options.grid||cell.border)page.drawRectangle({x,y:yTop-h,width:w,height:h,borderColor:rgb(.72,.76,.8),borderWidth:.4});
          const rows=lines.get(cell)||[];const fontSize=cell.size*scale;
          rows.forEach((line,i)=>{const tw=font.widthOfTextAtSize(line,fontSize);const tx=cell.align==='right'?x+w-tw-3*scale:cell.align==='center'?x+(w-tw)/2:x+3*scale;
            page.drawText(line,{x:Math.max(x,tx),y:yTop-(cell.size*1.1+i*cell.size*1.25+3)*scale,size:fontSize,font,color:toRgb(cell.color)});
          });
        }
      };
      if(repeat)drawRows(firstRow,headEnd+1,0);
      drawRows(start,end,repeat);
      const pointAt=(list:number[],index:number)=>{const base=Math.floor(index);return(list[Math.min(base,list.length-1)]||0)+(index-base)*((list[base+1]||list[base])-(list[base]||0));};
      for(const image of sheet.images){
        const iy=pointAt(ys,image.row);if(iy+image.height<=ys[start]||iy>=ys[end])continue;
        const embed=image.type==='png'?await pdf.embedPng(image.bytes):await pdf.embedJpg(image.bytes);
        page.pushOperators(pushGraphicsState(),rectangle(margin,ph-top-(repeat+ys[end]-ys[start])*scale,pw-2*margin,(ys[end]-ys[start])*scale),clip(),endPath());
        page.drawImage(embed,{x:margin+pointAt(xs,image.col)*scale,y:ph-top-(repeat+iy-ys[start]+image.height)*scale,width:image.width*scale,height:image.height*scale});page.pushOperators(popGraphicsState());
      }
      page.drawText(String(++part),{x:pw-margin-18,y:14,size:8,font});progress(`正在排版“${sheet.name}” · 已生成 ${count} 页…`);start=end;await yieldToBrowser(signal);
    }
  }
  if(!pdf.getPageCount())throw new Error('所选工作表的行列均已隐藏，没有可导出的内容。');
  cancelled(signal);return pdf.save();
}
