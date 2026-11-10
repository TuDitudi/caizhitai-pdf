import {strToU8, zip, type Zippable} from 'fflate';
import type {WordPage} from './word';
import {cancelled} from './tools';

export const EPUB_LANGUAGES = [
 { tag: 'zh-CN', label: '简体中文' },
 { tag: 'zh-Hant', label: '繁體中文' },
 { tag: 'en', label: '英语' },
 { tag: 'ja', label: '日语' },
 { tag: 'ko', label: '韩语' },
 { tag: 'fr', label: '法语' },
 { tag: 'de', label: '德语' },
 { tag: 'es', label: '西班牙语' },
 { tag: 'pt', label: '葡萄牙语' },
 { tag: 'ru', label: '俄语' },
 { tag: 'und', label: '未指定' },
] as const;

export type EpubLanguage = (typeof EPUB_LANGUAGES)[number]['tag'];
export type EpubOptions={title:string;author:string;language:EpubLanguage;joinLines:boolean;cover?:WordPage|null};
function xml(value:string):string {
 return Array.from(value).filter(c=>{const n=c.codePointAt(0)!;return n===9||n===10||n===13||(n>=32&&n<=0xd7ff)||(n>=0xe000&&n<=0xfffd)||(n>=0x10000&&n<=0x10ffff);}).join('').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
}
function paragraphs(text:string,joinLines:boolean):string[] {
 const normalized=text.replace(/\r\n?/g,'\n').trim();
 if(!normalized)return ['（本页未识别到文字，可在导出前手动补充。）'];
 if(!joinLines)return normalized.split(/\n/).filter(s=>s.trim());
 return normalized.split(/\n\s*\n/).map(block=>block.trim().split('\n').map(s=>s.trim()).reduce((a,b)=>{
  if(!a)return b;
  return a+(/[\u3400-\u9fff，。！？；：、]$/.test(a)&&/^[\u3400-\u9fff，。！？；：、]/.test(b)?'':' ')+b;
 },''));
}
export async function makeEpub(pages:WordPage[],options:EpubOptions,signal?:AbortSignal):Promise<Blob> {
 cancelled(signal);
 if(!pages.length)throw new Error('没有可导出的页面。');
 if(!options.title.trim())throw new Error('请填写电子书书名。');
 const title=xml(options.title.trim()),author=xml(options.author.trim()),language=xml(options.language);
 const id=`urn:uuid:${crypto.randomUUID()}`,modified=new Date().toISOString().replace(/\.\d{3}Z$/,'Z');
 const cover=options.cover===undefined?(pages[0].method==='image'?pages[0]:null):options.cover;
 if(cover&&!cover.image?.byteLength)throw new Error('封面图片缺失，请重新生成。');
 const coverIndex=cover?pages.findIndex(p=>p.method==='image'&&p.page===cover.page):-1;
 const coverHref=coverIndex>=0?`page-${coverIndex+1}.xhtml`:'cover.xhtml';
 const coverId=coverIndex>=0?`image-${coverIndex+1}`:'cover-image';
 const fixed=pages.every(p=>p.method==='image');
 // EPUB requires this exact, uncompressed entry first, without a ZIP extra field.
 const files:Zippable={mimetype:[strToU8('application/epub+zip'),{level:0}]};
 const add=(name:string,text:string)=>{files[name]=strToU8(text);};
 add('META-INF/container.xml','<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
 const manifest:string[]=[],spine:string[]=[],links:string[]=[],navPoints:string[]=[];
 function imagePage(p:WordPage,label:string,src:string,isCover:boolean) {
  const width=Math.max(1,Math.round(p.width)),height=Math.max(1,Math.round(p.height));
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}" xml:lang="${language}"><head><title>${label}</title><meta name="viewport" content="width=${width}, height=${height}"/><link rel="stylesheet" type="text/css" href="style.css"/></head><body class="image-page"><section epub:type="${isCover?'cover':'chapter'}" aria-label="${label}"><img src="${src}" alt="${label}"/></section></body></html>`;
 }
 if(cover&&coverIndex<0){
  files['EPUB/images/cover.jpg']=[cover.image!,{level:0}];
  manifest.push('<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>','<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
  add('EPUB/cover.xhtml',imagePage(cover,'封面','images/cover.jpg',true));
  spine.push('<itemref idref="cover" properties="rendition:layout-pre-paginated"/>');
  links.push('<li><a href="cover.xhtml">封面</a></li>');
  navPoints.push('<navPoint id="nav-cover" playOrder="1"><navLabel><text>封面</text></navLabel><content src="cover.xhtml"/></navPoint>');
 }
 const offset=navPoints.length;
 for(let i=0;i<pages.length;i++){
  cancelled(signal);const p=pages[i],chapter=`page-${i+1}`,label=`原第 ${p.page} 页`;
  let content:string;
  if(p.method==='image'){
   if(!p.image?.byteLength)throw new Error(`第 ${p.page} 页图片缺失，请重新转换。`);
   files[`EPUB/images/${chapter}.jpg`]=[p.image,{level:0}];
   manifest.push(`<item id="image-${i+1}" href="images/${chapter}.jpg" media-type="image/jpeg"${cover&&i===coverIndex?' properties="cover-image"':''}/>`);
   content=imagePage(p,label,`images/${chapter}.jpg`,!!cover&&i===coverIndex);
  }else{
   const body=paragraphs(p.text,options.joinLines).map(text=>`<p>${xml(text)}</p>`).join('\n');
   content=`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}" xml:lang="${language}"><head><title>${label}</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><section epub:type="chapter"><h1>${label}</h1>${body}</section></body></html>`;
  }
  add(`EPUB/${chapter}.xhtml`,content);
  manifest.push(`<item id="${chapter}" href="${chapter}.xhtml" media-type="application/xhtml+xml"/>`);
  spine.push(`<itemref idref="${chapter}"${!fixed&&p.method==='image'?' properties="rendition:layout-pre-paginated"':''}/>`);
  links.push(`<li><a href="${chapter}.xhtml">${label}</a></li>`);
  navPoints.push(`<navPoint id="nav-${i+1}" playOrder="${i+1+offset}"><navLabel><text>${label}</text></navLabel><content src="${chapter}.xhtml"/></navPoint>`);
 }
 add('EPUB/style.css','html{height:100%;}body{font-family:serif;line-height:1.7;margin:1.2em;}h1{font-size:1.25em;margin:0 0 1.4em;}p{margin:0 0 .9em;overflow-wrap:break-word;}img{display:block;max-width:100%;height:auto;margin:0 auto;}.image-page{margin:0;padding:0;width:100%;height:100%;line-height:0;}.image-page section{width:100%;height:100%;}.image-page img{width:100%;height:100%;object-fit:contain;}nav ol{padding-left:1.5em;}nav li{margin:.6em 0;}');
 const landmarks=cover?`<nav epub:type="landmarks" hidden="hidden"><h2>导航</h2><ol><li><a epub:type="cover" href="${coverHref}">封面</a></li></ol></nav>`:'';
 add('EPUB/nav.xhtml',`<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}" xml:lang="${language}"><head><title>${title} — 目录</title><link rel="stylesheet" type="text/css" href="style.css"/></head><body><nav epub:type="toc" id="toc"><h1>${title}</h1><ol>${links.join('')}</ol></nav>${landmarks}</body></html>`);
 add('EPUB/toc.ncx',`<?xml version="1.0" encoding="UTF-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${language}"><head><meta name="dtb:uid" content="${id}"/><meta name="dtb:depth" content="1"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head><docTitle><text>${title}</text></docTitle><navMap>${navPoints.join('')}</navMap></ncx>`);
 const coverMeta=cover?`<meta name="cover" content="${coverId}"/>`:'';
 const layoutMeta=`<meta property="rendition:layout">${fixed?'pre-paginated':'reflowable'}</meta><meta property="rendition:spread">none</meta>`;
 const guide=cover?`<guide><reference type="cover" title="封面" href="${coverHref}"/></guide>`:'';
 add('EPUB/package.opf',`<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${language}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${id}</dc:identifier><dc:title>${title}</dc:title><dc:language>${language}</dc:language>${author?`<dc:creator>${author}</dc:creator>`:''}<meta property="dcterms:modified">${modified}</meta>${coverMeta}${layoutMeta}</metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>${manifest.join('')}</manifest><spine toc="ncx">${spine.join('')}</spine>${guide}</package>`);
 return new Promise((resolve,reject)=>{
  const stop=()=>{terminate();reject(new Error('操作已取消。'));};
  const terminate=zip(files,{level:6},(error,bytes)=>{signal?.removeEventListener('abort',stop);if(signal?.aborted)reject(new Error('操作已取消。'));else if(error)reject(error);else resolve(new Blob([bytes as BlobPart],{type:'application/epub+zip'}));});
  signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 });
}
