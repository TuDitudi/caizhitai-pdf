export type Crop = { x: number; y: number; w: number; h: number };
export type Edit = { id: number; source: number; width: number; height: number; rotation: number; crop: Crop; paper: string; customW: number; customH: number; margin: number; scale: number; offsetX: number; offsetY: number };
export const MM = 72 / 25.4;
export const fullCrop = (): Crop => ({ x: 0, y: 0, w: 1, h: 1 });
export function dimensions(e: Edit) { return e.rotation % 180 ? { w: e.height, h: e.width } : { w: e.width, h: e.height }; }
export function layout(e: Edit) {
  const d = dimensions(e), cw = d.w * e.crop.w, ch = d.h * e.crop.h;
  let w = cw, h = ch;
  if (e.paper === 'original') { w = d.w; h = d.h; }
  if (e.paper === 'a4') { w = 210 * MM; h = 297 * MM; }
  if (e.paper === 'a4-landscape') { w = 297 * MM; h = 210 * MM; }
  if (e.paper === 'custom') { w = e.customW * MM; h = e.customH * MM; }
  const m = Math.min(e.margin * MM, w / 2 - 1, h / 2 - 1);
  const fit = Math.min((w - 2 * m) / cw, (h - 2 * m) / ch);
  const iw = cw * fit * e.scale / 100, ih = ch * fit * e.scale / 100;
  const x = (w - iw) / 2 + e.offsetX * MM, y = (h - ih) / 2 + e.offsetY * MM;
  return { w, h, cw, ch, iw, ih, x, y, clipped: x < -0.1 || y < -0.1 || x + iw > w + 0.1 || y + ih > h + 0.1 };
}
export function rotateEdit(e: Edit): Edit { const c = e.crop; return { ...e, rotation: (e.rotation + 90) % 360, crop: { x: 1-c.y-c.h, y: c.x, w: c.h, h: c.w } }; }
export function marginCrop(e: Edit, side: string, mm: number): Crop {
  const d = dimensions(e), c = e.crop, min = .01;
  const a = mm * MM / (side === 'left' || side === 'right' ? d.w : d.h);
  if(side === 'left') { const x = Math.max(0,Math.min(c.x+c.w-min,a)); return {...c,x,w:c.x+c.w-x}; }
  if(side === 'right') return {...c,w: Math.max(min,Math.min(1-c.x,1-c.x-a))};
  if(side === 'top') { const y = Math.max(0,Math.min(c.y+c.h-min,a)); return {...c,y,h:c.y+c.h-y}; }
  return {...c,h:Math.max(min,Math.min(1-c.y,1-c.y-a))};
}
