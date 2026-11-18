import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { editedBackground, type EditablePage, type EditableText } from './layout-editor';
import { blockLines, usedFonts, wordProblems } from './layout-text';
import { textWidth, type FontAsset } from './original-font';
import { cancelled, type Progress } from './tools';

const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL='http://schemas.openxmlformats.org/package/2006/relationships';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const number=(n:number)=>Number(n.toFixed(4));
function xml(text:string) {const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.getElementsByTagName('parsererror').length)throw new Error('Word 文档结构生成失败。');return doc;}
function obfuscate(data:Uint8Array,key:string) {const bytes=key.replace(/[{}-]/g,'').match(/../g)!.map(n=>parseInt(n,16)).reverse(),copy=data.slice();for(let i=0;i<Math.min(32,copy.length);i++)copy[i]^=bytes[i%16];return copy;}
function paragraphs(block:EditableText,font:FontAsset) {
  const spacing=Math.round(block.tracking*20),size=Math.round(block.size*2),family=escape(font.family),color=block.color.replace('#','').toUpperCase();
  return blockLines(block,font).map(line=>`<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${Math.round(block.size*1.15*20)}" w:lineRule="exact"/><w:ind w:left="0" w:right="0" w:firstLine="0"/><w:contextualSpacing w:val="0"/><w:widowControl w:val="0"/><w:snapToGrid w:val="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}" w:eastAsia="${family}" w:cs="${family}"/><w:b w:val="${font.weight>=600?1:0}"/><w:bCs w:val="${font.weight>=600?1:0}"/><w:i w:val="${font.italic?1:0}"/><w:iCs w:val="${font.italic?1:0}"/><w:color w:val="${color}"/><w:spacing w:val="${spacing}"/><w:kern w:val="1000"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr><w:t xml:space="preserve">${escape(line.text)}</w:t></w:r></w:p>`).join('');
}
function textBox(block:EditableText,font:FontAsset,index:number) {
  const baseline=block.size*(1.15+font.ascent+font.descent)/2;
  // Give Word enough advance width for its half-point font-size rounding.
  // Some readers ignore negative CJK tracking, so a frame must not rewrap a line.
  const roundedSize=Math.round(block.size*2)/2;
  const w=Math.max(block.width,...blockLines(block,font).map(line=>textWidth(font,line.text,roundedSize)+Math.max(0,block.tracking)*[...line.text].length))+2;
  const offset=block.baseline-baseline,h=Math.max(block.height,block.size*1.5);
  const originX=block.x-Math.sin(block.angle)*offset,originY=block.y+Math.cos(block.angle)*offset;
  const x=originX+Math.cos(block.angle)*w/2-Math.sin(block.angle)*h/2-w/2;
  const y=originY+Math.sin(block.angle)*w/2+Math.cos(block.angle)*h/2-h/2;
  const rotation=block.angle*180/Math.PI;
  return `<w:r xmlns:w="${W}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><w:pict>${index===0?'<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>':''}<v:shape id="czt_text_${index}" o:spid="_x0000_s${index+1025}" type="#_x0000_t202" style="position:absolute;margin-left:${number(x)}pt;margin-top:${number(y)}pt;width:${number(w)}pt;height:${number(Math.max(block.height,block.size*1.5))}pt;z-index:${index+100};mso-position-horizontal-relative:page;mso-position-vertical-relative:page;mso-wrap-style:none;rotation:${number(rotation)}" filled="f" stroked="f"><v:textbox inset="0,0,0,0" style="mso-fit-shape-to-text:t;mso-wrap-style:none"><w:txbxContent>${paragraphs(block,font)}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`;
}
export async function exportLayoutWord(pages:EditablePage[],name:string,progress:Progress,signal:AbortSignal) {
  if(!pages.length)throw new Error('请先识别 PDF 页面。');
  const problems=wordProblems(pages);if(problems.length)throw new Error(problems[0]);
  const {Document,Packer,Paragraph,TextRun,ImageRun,SectionType,HorizontalPositionRelativeFrom,VerticalPositionRelativeFrom,TextWrappingType,LineRuleType}=await import('docx');
  const sections=[];
  for(const page of pages){
    cancelled(signal);progress(`正在构建 Word 第 ${page.page} 页`);
    if(Math.max(page.width,page.height)>1584)throw new Error('页面超过 Word 的 22 英寸限制，请先调整纸张大小。');
    const erased={...page,blocks:page.blocks.map(b=>({...b,text:'',original:b.original||' '}))};
    const background=await editedBackground(erased);
    sections.push({properties:{type:SectionType.NEXT_PAGE,page:{size:{width:Math.round(page.width*20),height:Math.round(page.height*20)},margin:{top:0,bottom:0,left:0,right:0,header:0,footer:0}}},children:[new Paragraph({spacing:{before:0,after:0,line:1,lineRule:LineRuleType.EXACT},children:[new TextRun({text:'',size:2}),new ImageRun({type:'png',data:new Uint8Array(await background.arrayBuffer()),transformation:{width:page.width*96/72,height:page.height*96/72},floating:{horizontalPosition:{relative:HorizontalPositionRelativeFrom.PAGE,offset:0},verticalPosition:{relative:VerticalPositionRelativeFrom.PAGE,offset:0},wrap:{type:TextWrappingType.NONE},behindDocument:true,allowOverlap:true,layoutInCell:false},altText:{title:`第 ${page.page} 页图形背景`,description:'保留原 PDF 表格线、印章和图片，文字以可编辑文本框单独保存',name:`page-${page.page}`}})]})]});
  }
  const document=new Document({title:name,creator:'裁纸台',styles:{default:{document:{run:{size:2}}}},sections});
  const archive=unzipSync(new Uint8Array(await(await Packer.toBlob(document)).arrayBuffer()));
  const main=xml(strFromU8(archive['word/document.xml']));
  main.documentElement.setAttribute('xmlns:v','urn:schemas-microsoft-com:vml');main.documentElement.setAttribute('xmlns:o','urn:schemas-microsoft-com:office:office');
  const anchors=[...main.getElementsByTagNameNS(W,'p')].filter(p=>p.getElementsByTagNameNS(W,'drawing').length>0);
  if(anchors.length!==pages.length)throw new Error('Word 分页结构异常，未导出。');
  let shape=0;
  for(let i=0;i<pages.length;i++)for(const block of pages[i].blocks){if(!block.text)continue;const font=pages[i].fonts[block.fontId];const fragment=xml(textBox(block,font,shape++));anchors[i].append(main.importNode(fragment.documentElement,true));}
  archive['word/document.xml']=strToU8(new XMLSerializer().serializeToString(main));
  const fonts=new Map<string,{font:FontAsset;hash:string;key:string;part:string;rel:string}[]>();
  let index=0;
  for(const font of new Set(usedFonts(pages).values())){
    cancelled(signal);if(!font.data)continue;
    const digest=await crypto.subtle.digest('SHA-256',font.data.slice().buffer),hash=Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
    const list=fonts.get(font.family)||[];const previous=list.find(f=>(f.font.weight>=600)===(font.weight>=600)&&f.font.italic===font.italic);
    if(previous){if(previous.hash!==hash)throw new Error(`“${font.family}”存在不同字形版本，请统一完整原字体后导出。`);continue;}
    const key='{'+crypto.randomUUID().toUpperCase()+'}',part=`fonts/font_${index}.odttf`,rel=`rIdCztFont${index++}`;
    archive['word/'+part]=obfuscate(font.data,key);list.push({font,hash,key,part,rel});fonts.set(font.family,list);
  }
  const fontTable=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts xmlns:w="${W}" xmlns:r="${R}">${[...fonts].map(([family,list])=>`<w:font w:name="${escape(family)}"><w:family w:val="auto"/><w:pitch w:val="variable"/>${list.sort((a,b)=>(a.font.italic?2:0)+(a.font.weight>=600?1:0)-(b.font.italic?2:0)-(b.font.weight>=600?1:0)).map(({font,key,rel})=>`<w:embed${font.weight>=600?'Bold':''}${font.italic?'Italic':font.weight>=600?'':'Regular'} r:id="${rel}" w:fontKey="${key}" w:subsetted="0"/>`).join('')}</w:font>`).join('')}</w:fonts>`;
  archive['word/fontTable.xml']=strToU8(fontTable);
  archive['word/_rels/fontTable.xml.rels']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL}">${[...fonts.values()].flat().map(f=>`<Relationship Id="${f.rel}" Type="${R}/font" Target="${f.part}"/>`).join('')}</Relationships>`);
  const rels=xml(strFromU8(archive['word/_rels/document.xml.rels']));
  if(![...rels.documentElement.children].some(e=>e.getAttribute('Type')===R+'/fontTable')){const element=rels.createElementNS(REL,'Relationship');element.setAttribute('Id','rIdCztFontTable');element.setAttribute('Type',R+'/fontTable');element.setAttribute('Target','fontTable.xml');rels.documentElement.append(element);}
  archive['word/_rels/document.xml.rels']=strToU8(new XMLSerializer().serializeToString(rels));
  const types=xml(strFromU8(archive['[Content_Types].xml'])),ns=types.documentElement.namespaceURI!;
  if(![...types.documentElement.children].some(e=>e.getAttribute('Extension')==='odttf')){const element=types.createElementNS(ns,'Default');element.setAttribute('Extension','odttf');element.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.obfuscatedFont');types.documentElement.append(element);}
  if(![...types.documentElement.children].some(e=>e.getAttribute('PartName')==='/word/fontTable.xml')){const element=types.createElementNS(ns,'Override');element.setAttribute('PartName','/word/fontTable.xml');element.setAttribute('ContentType','application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml');types.documentElement.append(element);}
  archive['[Content_Types].xml']=strToU8(new XMLSerializer().serializeToString(types));
  const settings=xml(strFromU8(archive['word/settings.xml']));
  const earlySettings=new Set(['writeProtection','view','zoom','removePersonalInformation','removeDateAndTime','doNotDisplayPageBoundaries','displayBackgroundShape','printPostScriptOverText','printFractionalCharacterWidth','printFormsData','embedTrueTypeFonts','embedSystemFonts','saveSubsetFonts']);
  const afterFonts=[...settings.documentElement.children].find(e=>!earlySettings.has(e.localName));
  for(const tag of ['embedTrueTypeFonts','embedSystemFonts','saveSubsetFonts']){for(const old of [...settings.getElementsByTagNameNS(W,tag)])old.remove();const e=settings.createElementNS(W,'w:'+tag);e.setAttributeNS(W,'w:val',tag==='saveSubsetFonts'?'0':'1');settings.documentElement.insertBefore(e,afterFonts||null);}
  archive['word/settings.xml']=strToU8(new XMLSerializer().serializeToString(settings));
  cancelled(signal);return zipSync(archive,{level:6});
}
