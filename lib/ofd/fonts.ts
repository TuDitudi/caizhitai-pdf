import type { FontInput, FontMatchRequest } from '@ofdrw/ofdrw-viewer-engine';
import { assetUrl } from '../pdf/asset-url';

const fontAssets = new Map<string, Promise<FontInput>>();

function loadFont(path: string): Promise<FontInput> {
  const cached = fontAssets.get(path);
  if (cached) return cached;
  const request = fetch(assetUrl(path)).then(async response => {
    if (!response.ok) throw new Error('OFD 字体加载失败，请刷新页面后重试。');
    return { data: await response.arrayBuffer() };
  }).catch((error: unknown) => {
    fontAssets.delete(path);
    throw error;
  });
  fontAssets.set(path, request);
  return request;
}

export function loadDefaultOfdFont() {
  return loadFont('office-assets/NotoSansSC-Regular.ttf');
}

const substituteFamilies = new Map([
  ['楷体', 'gkai00mp'], ['楷体gb2312', 'gkai00mp'], ['kaiti', 'gkai00mp'],
  ['kaitigb2312', 'gkai00mp'], ['stkaiti', 'gkai00mp'], ['kaitisc', 'gkai00mp'],
  ['宋体', 'gbsn00lp'], ['新宋体', 'gbsn00lp'], ['simsun', 'gbsn00lp'],
  ['nsimsun', 'gbsn00lp'], ['stsong', 'gbsn00lp'], ['songti', 'gbsn00lp'], ['songtisc', 'gbsn00lp'],
  ['couriernew', 'Inconsolata'], ['couriernewps', 'Inconsolata'], ['courier', 'Inconsolata'],
  ['timesnewroman', 'LiberationSerif'], ['timesnewromanps', 'LiberationSerif'], ['times', 'LiberationSerif'],
]);

export async function matchSubstituteOfdFont(request: FontMatchRequest): Promise<FontInput | null> {
  for (const name of [request.fontName, request.familyName]) {
    if (!name) continue;
    const normalized = name.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
    const base = normalized.replace(/(?:bolditalic|boldoblique|bold|italic|oblique|regular)?(?:mt)?$/, '');
    const family = substituteFamilies.get(base);
    if (!family) continue;
    // The OFD renderer prefers embedded fonts and keeps the document's explicit glyph positions.
    const bold = request.bold || /bold/.test(normalized);
    const italic = request.italic || /italic|oblique/.test(normalized);
    const style = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
    // Several OFD producers position Latin characters half an em apart, including in Courier New runs.
    // Use half-em outlines in those fixed-pitch runs so neighboring characters do not touch.
    const file = family === 'Inconsolata'
      ? `Inconsolata-${bold ? 'Bold' : 'Regular'}.ttf`
      : family === 'LiberationSerif' ? `LiberationSerif-${style}.ttf` : `${family}.ttf`;
    return loadFont(`ofd-assets/${file}`);
  }
  return null;
}
