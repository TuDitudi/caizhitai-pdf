import { PDFDocument, PDFDict, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { assetUrl } from './asset-url';

export type FontAsset = {
  id: string; originalName: string; family: string; cssFamily: string; data?: Uint8Array;
  source: 'embedded' | 'subset' | 'provided' | 'local' | 'missing' | 'ocr';
  full: boolean; editableEmbedding: boolean; reason: string; weight: number; italic: boolean;
  ascent: number; descent: number; units: number; characters: Set<number>;
};
type Font = { familyName: string; fullName: string; postscriptName: string; subfamilyName: string; unitsPerEm: number; ascent: number; descent: number; characterSet: number[]; numGlyphs: number; glyphForCodePoint: (n:number)=>{id:number;advanceWidth:number;bbox?:{minY:number;maxY:number};path?:{commands:{command:string;args:number[]}[]}}; layout:(text:string)=>{advanceWidth:number}; fonts?: Font[] };
const parsed = new WeakMap<FontAsset,Font>();
const faces = new WeakMap<FontAsset,FontFace>();
const clean = (name:string) => name.replace(/^[A-Z]{6}\+/,'').replace(/[\x00-\x1f]/g,'');
export function fontKey(name:string) { return clean(name).toLowerCase().replace(/[\s_\-]/g,'').replace(/(?:regular|bolditalic|bold|italic|psmt|mt)$/g,''); }
function names(name:string) {
  const keys=[fontKey(name)];const aliases:Record<string,string[]>={simsun:['宋体'],nsimsun:['新宋体'],simhei:['黑体'],fangsong:['仿宋','仿宋gb2312'],fangsonggb2312:['仿宋','fangsong'],kaiti:['楷体','楷体gb2312'],kaitigb2312:['楷体','kaiti']};
  for(const [key,values]of Object.entries(aliases))if(keys.includes(key)||values.some(v=>keys.includes(fontKey(v))))keys.push(key,...values.map(fontKey));
  return new Set(keys);
}
function matches(asset:FontAsset,font:Font) {
  const expected=names(asset.originalName),family=names(asset.family);
  return [font.familyName,font.fullName,font.postscriptName].some(n=>[...names(n||'')].some(k=>expected.has(k)||family.has(k)));
}
function table(data:Uint8Array,tag:string) {
  const v=new DataView(data.buffer,data.byteOffset,data.byteLength);if(data.length<12)return undefined;
  const start=String.fromCharCode(...data.slice(0,4))==='ttcf'?v.getUint32(12):0;
  if(start+12>data.length)return undefined;const count=v.getUint16(start+4);
  for(let i=0;i<count;i++){const at=start+12+i*16;if(at+16>data.length)return undefined;if(String.fromCharCode(...data.slice(at,at+4))===tag){const offset=v.getUint32(at+8),length=v.getUint32(at+12);if(offset+length<=data.length)return data.slice(offset,offset+length);}}
}
function checksum(data:Uint8Array) {let result=0;for(let i=0;i<data.length;i+=4){let word=0;for(let j=0;j<4;j++)word=(word*256+(data[i+j]||0))>>>0;result=(result+word)>>>0;}return result;}
function packFont(data:Uint8Array,changes:Map<string,Uint8Array>,index=0) {
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength),ttc=String.fromCharCode(...data.slice(0,4))==='ttcf';
  const start=ttc?view.getUint32(12+index*4):0,entries=new Map<string,Uint8Array>();
  if(start+12>data.length)throw new Error('字体文件损坏。');
  const n=view.getUint16(start+4);if(n>256||start+12+n*16>data.length)throw new Error('字体目录无效。');
  for(let i=0;i<n;i++){const at=start+12+i*16,tag=String.fromCharCode(...data.slice(at,at+4)),offset=view.getUint32(at+8),length=view.getUint32(at+12);if(offset+length>data.length)throw new Error('字体数据不完整。');if(tag!=='DSIG')entries.set(tag,data.slice(offset,offset+length));}
  for(const [key,value] of changes)entries.set(key,value);
  const head=entries.get('head');if(head&&head.length>=12)head.fill(0,8,12);
  const keys=[...entries.keys()].sort(),size=12+keys.length*16+[...entries.values()].reduce((s,b)=>s+Math.ceil(b.length/4)*4,0),out=new Uint8Array(size),v=new DataView(out.buffer);
  out.set(data.slice(start,start+4));v.setUint16(4,keys.length);const power=2**Math.floor(Math.log2(keys.length));v.setUint16(6,power*16);v.setUint16(8,Math.log2(power));v.setUint16(10,keys.length*16-power*16);
  let offset=12+keys.length*16,headOffset=0;
  keys.forEach((tag,i)=>{const bytes=entries.get(tag)!,at=12+i*16;out.set(new TextEncoder().encode(tag),at);v.setUint32(at+4,checksum(bytes));v.setUint32(at+8,offset);v.setUint32(at+12,bytes.length);out.set(bytes,offset);if(tag==='head')headOffset=offset;offset+=Math.ceil(bytes.length/4)*4;});
  if(headOffset)v.setUint32(headOffset+8,(0xb1b0afba-checksum(out))>>>0);
  return out;
}
function cmap(mapping:Map<number,number>) {
  const entries=[...mapping].filter(([n,g])=>n>=32&&n<=0x10ffff&&g>0).sort((a,b)=>a[0]-b[0]);const groups:number[][]=[];
  for(const [code,glyph]of entries){const last=groups[groups.length-1];if(last&&code===last[1]+1&&glyph===last[2]+code-last[0])last[1]=code;else groups.push([code,code,glyph]);}
  const size=16+groups.length*12,out=new Uint8Array(20+size),v=new DataView(out.buffer);v.setUint16(2,2);v.setUint16(4,0);v.setUint16(6,4);v.setUint32(8,20);v.setUint16(12,3);v.setUint16(14,10);v.setUint32(16,20);v.setUint16(20,12);v.setUint32(24,size);v.setUint32(32,groups.length);
  groups.forEach((g,i)=>g.forEach((value,j)=>v.setUint32(36+i*12+j*4,value)));return out;
}
async function parse(data:Uint8Array) {const kit=await import('@pdf-lib/fontkit');return kit.default.create(data) as unknown as Font;}
function details(data:Uint8Array,font:Font) {
  const os2=table(data,'OS/2'),v=os2?new DataView(os2.buffer,os2.byteOffset,os2.byteLength):undefined,flags=v&&os2!.length>=10?v.getUint16(8):2;
  const editableEmbedding=!(flags&2)&&!(flags&0x200)&&(!(flags&0x0c)||!!(flags&8));
  return {weight:v&&os2!.length>=6?v.getUint16(4):/bold/i.test(font.subfamilyName||'')?700:400,italic:/italic|oblique/i.test(font.subfamilyName||''),editableEmbedding,
    units:font.unitsPerEm,ascent:font.ascent/font.unitsPerEm,descent:font.descent/font.unitsPerEm,characters:new Set(font.characterSet)};
}
async function assetFrom(data:Uint8Array,originalName:string,source:FontAsset['source'],full:boolean):Promise<FontAsset> {
  const font=await parse(data);const id='czt_'+crypto.randomUUID().replace(/-/g,'');
  const asset:FontAsset={id,originalName:clean(originalName),family:font.familyName||clean(originalName),cssFamily:id,data,source,full,reason:'',...details(data,font)};
  if(!asset.editableEmbedding)asset.reason='这份字体不允许可编辑嵌入，请提供允许可编辑嵌入的对应完整原字体。';
  parsed.set(asset,font);return asset;
}
export async function registerFont(asset:FontAsset) {
  if(faces.has(asset))return;
  if(!asset.data)return;
  const face=new FontFace(asset.cssFamily,asset.data.slice().buffer,{weight:String(asset.weight),style:asset.italic?'italic':'normal',ascentOverride:'100%',descentOverride:'0%',lineGapOverride:'0%'});
  await face.load();document.fonts.add(face);faces.set(asset,face);
}
export function releaseFont(asset:FontAsset) {const face=faces.get(asset);if(face){document.fonts.delete(face);faces.delete(asset);}}
export function missingGlyphs(asset:FontAsset|undefined,text:string) {return [...new Set([...text].filter(c=>!/[\s\u200b\u200d\ufe0f]/.test(c)&&(!asset||!asset.characters.has(c.codePointAt(0)!))))].join('');}
export function inkTop(asset:FontAsset,text:string) {const font=parsed.get(asset);if(!font)return asset.ascent;const bounds=[...text].map(c=>font.glyphForCodePoint(c.codePointAt(0)!).bbox?.maxY).filter((n):n is number=>typeof n==='number'&&Number.isFinite(n));return bounds.length?Math.max(...bounds)/font.unitsPerEm:asset.ascent;}
export function inkBottom(asset:FontAsset,text:string) {const font=parsed.get(asset);if(!font)return asset.descent;const bounds=[...text].map(c=>font.glyphForCodePoint(c.codePointAt(0)!).bbox?.minY).filter((n):n is number=>typeof n==='number'&&Number.isFinite(n));return bounds.length?Math.min(...bounds)/font.unitsPerEm:asset.descent;}
export function textWidth(asset:FontAsset,text:string,size:number) {const font=parsed.get(asset);return font?[...text].reduce((sum,c)=>sum+font.glyphForCodePoint(c.codePointAt(0)!).advanceWidth,0)/font.unitsPerEm*size:[...text].length*size;}
export function emptyFont(id:string,name:string,ocr=false):FontAsset {return{id,originalName:name,family:name,cssFamily:'',source:ocr?'ocr':'missing',full:false,editableEmbedding:false,reason:ocr?'扫描图片不包含字体文件，请指定原文字使用的完整字体。':'PDF 未提供可用的原字体，请补充字体文件。',weight:400,italic:false,ascent:.85,descent:-.2,units:1000,characters:new Set()};}

export async function rawPdfFonts(bytes:Uint8Array) {
  const document=await PDFDocument.load(bytes.slice()),result=new Map<string,Uint8Array>();
  const visited=new WeakSet<PDFDict>();
  function visit(value:PDFDict){
    if(visited.has(value))return;visited.add(value);
    const descendants=value.lookupMaybe(PDFName.of('DescendantFonts'),PDFArray);if(descendants)for(let i=0;i<descendants.size();i++){const child=descendants.lookupMaybe(i,PDFDict);if(child)visit(child);}
    const descriptor=value.lookupMaybe(PDFName.of('FontDescriptor'),PDFDict);if(!descriptor)return;
    const name=descriptor.lookupMaybe(PDFName.of('FontName'),PDFName)?.decodeText()||value.lookupMaybe(PDFName.of('BaseFont'),PDFName)?.decodeText();if(!name)return;
    for(const key of ['FontFile2','FontFile3']){const ref=descriptor.get(PDFName.of(key)),stream=ref?document.context.lookup(ref):undefined;if(stream instanceof PDFRawStream){try{const data=decodePDFRawStream(stream).decode();if(data.length<100*1024*1024)result.set(name,data);}catch{}break;}}
  }
  for(const page of document.getPages()){const resources=page.node.Resources(),fonts=resources?.lookupMaybe(PDFName.of('Font'),PDFDict);if(fonts)for(const key of fonts.keys()){const font=fonts.lookupMaybe(key,PDFDict);if(font)visit(font);}}
  return result;
}
let officeFont:Promise<Uint8Array>|undefined;
export async function pdfFontAsset(face:any,glyphs:Map<string,string>,raw:Map<string,Uint8Array>):Promise<FontAsset> {
  if(!face.data||face.missingFile)return emptyFont(face.loadedName,clean(face.name||'未知字体'));
  const name=face.name||face.loadedName,original=raw.get(name)||[...raw].find(([n])=>fontKey(n)===fontKey(name))?.[1];
  if(original)try{const font=await parse(original);if(!font.fonts&&[...glyphs.keys()].every(c=>[...c].length===1&&font.glyphForCodePoint(c.codePointAt(0)!).id)){
    const asset=await assetFrom(original,name,/^[A-Z]{6}\+/.test(name)?'subset':'embedded',!/^[A-Z]{6}\+/.test(name));if(asset.full){await registerFont(asset);return asset;}
  }}catch{}
  const converted=face.data.slice() as Uint8Array,font=await parse(converted),mapping=new Map<number,number>();
  const toUnicode=face.toUnicode?._map||face.toUnicode||{},toChar=face.toFontChar||[];
  for(const [code,value]of Object.entries(toUnicode))if(typeof value==='string'&&[...value].length===1&&toChar[Number(code)]!==undefined){const glyph=font.glyphForCodePoint(toChar[Number(code)]);if(glyph.id)mapping.set(value.codePointAt(0)!,glyph.id);}
  for(const [unicode,character]of glyphs)if([...unicode].length===1){const glyph=font.glyphForCodePoint(character.codePointAt(0)!);if(glyph.id)mapping.set(unicode.codePointAt(0)!,glyph.id);}
  const fixed=packFont(converted,new Map([['cmap',cmap(mapping)]]));
  let asset=await assetFrom(fixed,name,'subset',false);
  // The app already ships this exact full font. Never use it for other families.
  if(/notosanssc/i.test(name.replace(/[\s_-]/g,''))){
    try{officeFont??=fetch(assetUrl('office-assets/NotoSansSC-Regular.ttf')).then(async r=>{if(!r.ok)throw new Error('字体加载失败');return new Uint8Array(await r.arrayBuffer());});const bytes=await officeFont,full=await parse(bytes);if(matches(asset,full)&&[...asset.characters].slice(0,40).every(n=>!parsed.get(asset)!.glyphForCodePoint(n).id||outline(parsed.get(asset)!,String.fromCodePoint(n))===outline(full,String.fromCodePoint(n))))asset=await assetFrom(bytes,name,'embedded',true);}catch{}
  }
  await registerFont(asset);return asset;
}
function outline(font:Font,char:string) {const glyph=font.glyphForCodePoint(char.codePointAt(0)!);return JSON.stringify(glyph.path?.commands.map(c=>[c.command,...c.args.map(n=>Math.round(n/font.unitsPerEm*10000))]));}
export async function completeFont(asset:FontAsset,file:File):Promise<FontAsset> {
  if(file.size>100*1024*1024)throw new Error('字体超过 100 MB，请选择独立的 TTF 或 OTF 字体文件。');
  const bytes=new Uint8Array(await file.arrayBuffer()),collection=await parse(bytes),fonts=collection.fonts||[collection];
  const candidates=fonts.map((font,index)=>({font,index})).filter(({font})=>asset.source==='ocr'||matches(asset,font));
  if(!candidates.length)throw new Error(`所选字体与“${asset.originalName}”不匹配，未替换原字体。`);
  candidates.sort((a,b)=>{const score=(f:Font)=>Math.abs((/black|heavy/i.test(f.subfamilyName)?900:/semibold|demibold/i.test(f.subfamilyName)?600:/bold/i.test(f.subfamilyName)?700:/thin/i.test(f.subfamilyName)?100:/light/i.test(f.subfamilyName)?300:/medium/i.test(f.subfamilyName)?500:400)-asset.weight)+((/italic|oblique/i.test(f.subfamilyName))!==asset.italic?1000:0);return score(a.font)-score(b.font);});
  const chosen=candidates[0],data=collection.fonts?packFont(bytes,new Map(),chosen.index):bytes;
  const result=await assetFrom(data,asset.originalName,'provided',true);
  const old=parsed.get(asset),next=parsed.get(result)!;
  if(old&&asset.source!=='ocr'){
    const test=[...asset.characters].filter(n=>n>=32).slice(0,40).map(n=>String.fromCodePoint(n));
    const comparable=test.filter(c=>old.glyphForCodePoint(c.codePointAt(0)!).id&&next.glyphForCodePoint(c.codePointAt(0)!).id);
    if(comparable.length&&comparable.some(c=>outline(old,c)!==outline(next,c)))throw new Error('字体名称相近，但字形与 PDF 内的原字体不一致，未应用。请提供同版本的完整原字体。');
  }
  await registerFont(result);return result;
}
