import { missingGlyphs, textWidth, type FontAsset } from './original-font';
import type { EditablePage, EditableText } from './layout-editor';

const cache=new WeakMap<EditableText,{font:FontAsset;lines:{text:string;width:number}[]}>();
export function blockLines(block:EditableText,font:FontAsset) {
  const cached=cache.get(block);if(cached?.font===font)return cached.lines;
  const lines:{text:string;width:number}[]=[];
  for(const paragraph of block.text.replace(/\r/g,'').split('\n')){
    if(!paragraph){lines.push({text:'',width:0});continue;}
    let current='';
    let width=0;
    for(const char of paragraph){const advance=textWidth(font,char,block.size),nextWidth=width+advance+(current?block.tracking:0);if(current&&nextWidth>block.width+.2){lines.push({text:current,width});current=char;width=advance;}else{current+=char;width=nextWidth;}}
    lines.push({text:current,width});
  }
  cache.set(block,{font,lines});return lines;
}
export function usedFonts(pages:EditablePage[]) {
  const fonts=new Map<string,FontAsset>();for(const page of pages)for(const block of page.blocks){const font=page.fonts[block.fontId];if(font)fonts.set(block.fontId,font);}return fonts;
}
export function wordProblems(pages:EditablePage[]) {
  const problems:string[]=[];
  for(const [id,font]of usedFonts(pages)) {
    const content=pages.flatMap(p=>p.blocks.filter(b=>b.fontId===id)).map(b=>b.text).join('');
    if(!content.trim())continue;
    if(!font.data||!font.full)problems.push(`“${font.originalName}”需要补充完整原字体，确保在 Word 中新增文字时不换字体。`);
    else if(!font.editableEmbedding)problems.push(`“${font.originalName}”不支持可编辑嵌入。`);
    const missing=missingGlyphs(font,content);if(missing)problems.push(`“${font.originalName}”缺少字形：${missing.slice(0,20)}`);
  }
  for(const page of pages)for(const block of page.blocks){const font=page.fonts[block.fontId];if(!font||missingGlyphs(font,block.text))continue;const lines=blockLines(block,font);if(lines.length*block.size*1.15>block.height+.5)problems.push(`第 ${page.page} 页文字超出原文字框，请增大文字框高度或缩短内容。`);}
  return [...new Set(problems)];
}
