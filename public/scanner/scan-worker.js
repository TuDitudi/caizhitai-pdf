/* Browser-local document detection, perspective correction and scan enhancement. */
let runtime;
let loading;
function ready() {
  if (!loading) loading = new Promise((resolve, reject) => {
    try {
      importScripts('opencv-4.13.0.js');
      runtime = self.cv;
      if (runtime.calledRun && runtime.Mat) return resolve();
      const previous = runtime.onRuntimeInitialized;
      runtime.onRuntimeInitialized = () => { previous?.(); resolve(); };
      runtime.onAbort = () => reject(new Error('扫描组件加载失败，请刷新后重试。'));
    } catch (error) { reject(error); }
  });
  return loading;
}
const fallback = () => [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
function ordered(points) {
  const center = points.reduce((p,q)=>({x:p.x+q.x/4,y:p.y+q.y/4}),{x:0,y:0});
  points.sort((a,b)=>Math.atan2(a.y-center.y,a.x-center.x)-Math.atan2(b.y-center.y,b.x-center.x));
  const start = points.reduce((best,p,i)=>p.x+p.y<points[best].x+points[best].y?i:best,0);
  return points.slice(start).concat(points.slice(0,start));
}
async function raster(blob, edge, pixelLimit = 1600000) {
  const bitmap = await createImageBitmap(blob);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40000000 || Math.max(bitmap.width,bitmap.height)>24000) throw new Error('照片超过 4000 万像素，请缩小后重试。');
    const scale = Math.min(1, edge/Math.max(bitmap.width,bitmap.height),Math.sqrt(pixelLimit/(bitmap.width*bitmap.height)));
    const canvas = new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    return canvas;
  } finally { bitmap.close(); }
}
// Refine the coarse quadrilateral against long, consistent outer paper edges.
// Searching mostly outwards prevents the printed table border becoming the crop.
function refine(gray,quad,w,h) {
  const data=gray.data,range=Math.min(w,h)*.18;
  const value=(x,y)=>data[Math.max(0,Math.min(h-1,Math.round(y)))*w+Math.max(0,Math.min(w-1,Math.round(x)))];
  const lines=quad.map((p,i)=>{
    const q=quad[(i+1)%4],a={x:p.x*w,y:p.y*h},b={x:q.x*w,y:q.y*h};
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length,samples=[];
    for(let n=1;n<=19;n++) {
      const t=n/20,x=a.x+dx*t,y=a.y+dy*t;let best=null;
      let previous=null;
      for(let offset=18;offset>=-range;offset-=1) {
        const px=x+nx*offset,py=y+ny*offset;
        if(px<4||py<4||px>w-5||py>h-5)continue;
        const contrast=Math.abs(value(px+nx*4,py+ny*4)-value(px-nx*4,py-ny*4));
        if(previous&&previous.score>=16&&contrast<previous.score-1){best=previous;break;}
        previous={x:px,y:py,score:contrast};
      }
      if(best)samples.push(best);
    }
    let inliers=[];
    for(let j=0;j<samples.length;j++)for(let k=j+1;k<samples.length;k++) {
      const u=samples[j],v=samples[k],vx=v.x-u.x,vy=v.y-u.y,l=Math.hypot(vx,vy);
      if(l<length*.35||Math.abs((vx*dx+vy*dy)/(l*length))<.96)continue;
      const group=samples.filter(r=>Math.abs(vx*(r.y-u.y)-vy*(r.x-u.x))/l<3.5);
      if(group.length>inliers.length)inliers=group;
    }
    if(inliers.length<8)return{a,b};
    const center=inliers.reduce((c,p)=>({x:c.x+p.x/inliers.length,y:c.y+p.y/inliers.length}),{x:0,y:0});
    let xx=0,yy=0,xy=0;for(const p of inliers){xx+=(p.x-center.x)**2;yy+=(p.y-center.y)**2;xy+=(p.x-center.x)*(p.y-center.y);}
    const angle=.5*Math.atan2(2*xy,xx-yy),vx=Math.cos(angle),vy=Math.sin(angle);
    return{a:center,b:{x:center.x+vx,y:center.y+vy}};
  });
  const points=lines.map((line,i)=>{
    const previous=lines[(i+3)%4],a=previous.a,b=previous.b,c=line.a,d=line.b;
    const dx=b.x-a.x,dy=b.y-a.y,ex=d.x-c.x,ey=d.y-c.y,det=dx*ey-dy*ex;
    if(Math.abs(det)<.000001)return quad[i];
    const t=((c.x-a.x)*ey-(c.y-a.y)*ex)/det;
    const point={x:Math.max(0,Math.min(1,(a.x+t*dx)/w)),y:Math.max(0,Math.min(1,(a.y+t*dy)/h))};
    return Math.hypot(point.x-quad[i].x,point.y-quad[i].y)<.18?point:quad[i];
  });
  const area=p=>Math.abs(p.reduce((s,q,i)=>s+q.x*p[(i+1)%4].y-q.y*p[(i+1)%4].x,0))/2;
  const convex=points.every((p,i)=>{const q=points[(i+1)%4],r=points[(i+2)%4];return(q.x-p.x)*(r.y-q.y)-(q.y-p.y)*(r.x-q.x)>.0001;});
  return convex&&area(points)>area(quad)*.92?points:quad;
}
function detect(canvas) {
  const cv=runtime, w=canvas.width,h=canvas.height;
  const objects=[];const keep=x=>(objects.push(x),x);
  const image=keep(cv.matFromImageData(canvas.getContext('2d').getImageData(0,0,w,h)));
  const gray=keep(new cv.Mat()),blur=keep(new cv.Mat()),mask=keep(new cv.Mat()),closed=keep(new cv.Mat());
  const kernel=keep(cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(5,5)));
  let best=null;
  try {
    cv.cvtColor(image,gray,cv.COLOR_RGBA2GRAY);cv.GaussianBlur(gray,blur,new cv.Size(5,5),0);
    for(let pass=0;pass<6;pass++) {
      if(pass===3){for(let i=0;i<w*h;i++)gray.data[i]=Math.max(image.data[i*4],image.data[i*4+1],image.data[i*4+2]);cv.GaussianBlur(gray,blur,new cv.Size(5,5),0);}
      const variant=pass%3;
      if(variant===0)cv.Canny(blur,mask,30,100);
      else cv.threshold(blur,mask,variant===1?0:170,255,variant===1?cv.THRESH_BINARY+cv.THRESH_OTSU:cv.THRESH_BINARY);
      cv.morphologyEx(mask,closed,cv.MORPH_CLOSE,kernel);
      const contours=new cv.MatVector(),hierarchy=new cv.Mat();
      try {
        cv.findContours(closed,contours,hierarchy,cv.RETR_LIST,cv.CHAIN_APPROX_SIMPLE);
        for(let i=0;i<contours.size();i++) {
          const contour=contours.get(i),approx=new cv.Mat();
          try {
            const area=Math.abs(cv.contourArea(contour));
            if(area<w*h*.15)continue;
            cv.approxPolyDP(contour,approx,.018*cv.arcLength(contour,true),true);
            if(approx.rows!==4||!cv.isContourConvex(approx))continue;
            const quad=ordered(Array.from({length:4},(_,i)=>({x:approx.data32S[i*2]/w,y:approx.data32S[i*2+1]/h})));
            const touches=quad.filter(p=>p.x<.008||p.x>.992||p.y<.008||p.y>.992).length;
            const coverage=area/(w*h);
            if(coverage>.985)continue;
            const sides=quad.map((p,i)=>Math.hypot((p.x-quad[(i+1)%4].x)*w,(p.y-quad[(i+1)%4].y)*h));
            if(Math.min(...sides)<Math.min(w,h)*.16)continue;
            const score=coverage*2.2-touches*.10+(variant===0?.08:0);
            if(!best||score>best.score)best={points:quad,score,touches,coverage};
          }finally{contour.delete();approx.delete();}
        }
      }finally{contours.delete();hierarchy.delete();}
    }
    const interiorBorder=points=>points.filter((p,i)=>{
      const q=points[(i+1)%4],dx=(q.x-p.x)*w,dy=(q.y-p.y)*h,length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length,differences=[];
      for(let n=2;n<18;n++){const t=n/20,x=(p.x+(q.x-p.x)*t)*w,y=(p.y+(q.y-p.y)*t)*h;
        const inside={x:Math.round(x+nx*12),y:Math.round(y+ny*12)},outside={x:Math.round(x-nx*12),y:Math.round(y-ny*12)};
        if([inside,outside].some(p=>p.x<0||p.y<0||p.x>=w||p.y>=h))continue;
        const a=(inside.y*w+inside.x)*4,b=(outside.y*w+outside.x)*4;
        differences.push((Math.abs(image.data[a]-image.data[b])+Math.abs(image.data[a+1]-image.data[b+1])+Math.abs(image.data[a+2]-image.data[b+2]))/3);
      }
      differences.sort((a,b)=>a-b);return differences.length>=8&&differences[Math.floor(differences.length/2)]<12;
    }).length>=3;
    const coloredBorder=points=>points.filter((p,i)=>{
      const q=points[(i+1)%4],dx=(q.x-p.x)*w,dy=(q.y-p.y)*h,length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length;let colored=0;
      for(let n=1;n<20;n++){const t=n/20;let red=false;for(let offset=-7;offset<=7;offset++){
        const x=Math.min(w-1,Math.max(0,Math.round((p.x+(q.x-p.x)*t)*w+nx*offset))),y=Math.min(h-1,Math.max(0,Math.round((p.y+(q.y-p.y)*t)*h+ny*offset))),k=(y*w+x)*4;
        if(image.data[k]>image.data[k+1]+12&&image.data[k]>image.data[k+2]+12)red=true;
      }if(red)colored++;}return colored>7;
    }).length>=2;
    if(best){best.points=refine(blur,best.points,w,h);if(coloredBorder(best.points)||interiorBorder(best.points))best=null;}
    if(best){best.touches=best.points.filter(p=>p.x<.008||p.x>.992||p.y<.008||p.y>.992).length;}
    return best?{points:best.points,confidence:best.touches||best.coverage<.3?'review':'detected',warning:best.touches?'纸张接近照片边缘，请检查是否拍全四角。':best.coverage<.3?'已估算纸张边缘，请核对四个角后导出。':''}:{points:fallback(),confidence:'manual',warning:'未可靠识别纸张边缘，请拖动四角框选；如纸角超出画面，请重新拍照。'};
  }finally{objects.reverse().forEach(o=>o.delete());}
}
function enhance(mat,mode,strength) {
  if(mode==='original')return;
  const cv=runtime,gray=new cv.Mat(),small=new cv.Mat(),light=new cv.Mat(),large=new cv.Mat(),out=new cv.Mat();
  const kernel=cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(17,17));
  try {
    cv.cvtColor(mat,gray,cv.COLOR_RGBA2GRAY);
    if(mode==='bw') {
      cv.adaptiveThreshold(gray,out,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY,Math.min(51,Math.floor(Math.min(mat.cols,mat.rows)/2)*2-1),8+strength*.12);
      cv.cvtColor(out,mat,cv.COLOR_GRAY2RGBA);return;
    }
    const scale=Math.min(1,512/Math.max(mat.cols,mat.rows));
    cv.resize(gray,small,new cv.Size(Math.max(1,Math.round(mat.cols*scale)),Math.max(1,Math.round(mat.rows*scale))),0,0,cv.INTER_AREA);
    cv.dilate(small,light,kernel);cv.GaussianBlur(light,light,new cv.Size(31,31),0);cv.resize(light,large,new cv.Size(mat.cols,mat.rows),0,0,cv.INTER_LINEAR);
    const amount=strength/100, data=mat.data,illum=large.data;
    for(let i=0;i<illum.length;i++) {
      const gain=1+amount*(Math.min(2.5,255/Math.max(80,illum[i]))-1);
      for(let c=0;c<3;c++)data[i*4+c]=Math.max(0,Math.min(255,255-(255-data[i*4+c]*gain)*(1+amount*.13)));
    }
  }finally{gray.delete();small.delete();light.delete();large.delete();out.delete();kernel.delete();}
}
async function render(payload) {
  const cv=runtime,canvas=await raster(payload.blob,8000,12000000),w=canvas.width,h=canvas.height;
  const points=payload.points.map(p=>({x:p.x*w,y:p.y*h}));
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const nativeW=Math.max(distance(points[0],points[1]),distance(points[3],points[2]));
  const nativeH=Math.max(distance(points[0],points[3]),distance(points[1],points[2]));
  const ratio=payload.paper==='a5'?148/210:payload.paper==='a4'?210/297:payload.paper==='a4-landscape'?297/210:nativeW/nativeH;
  const edge=Math.min(payload.edge,Math.max(nativeW,nativeH));
  const width=Math.max(32,Math.round(ratio>1?edge:edge*ratio)),height=Math.max(32,Math.round(ratio>1?edge/ratio:edge));
  const src=cv.matFromImageData(canvas.getContext('2d').getImageData(0,0,w,h)),dst=new cv.Mat();
  const from=cv.matFromArray(4,1,cv.CV_32FC2,points.flatMap(p=>[p.x,p.y]));
  const to=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,width-1,0,width-1,height-1,0,height-1]);
  const matrix=cv.getPerspectiveTransform(from,to);
  try {
    cv.warpPerspective(src,dst,matrix,new cv.Size(width,height),cv.INTER_CUBIC,cv.BORDER_REPLICATE);
    enhance(dst,payload.mode,payload.strength);
    if(payload.rotation)cv.rotate(dst,dst,[null,cv.ROTATE_90_CLOCKWISE,cv.ROTATE_180,cv.ROTATE_90_COUNTERCLOCKWISE][payload.rotation/90]);
    canvas.width=dst.cols;canvas.height=dst.rows;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(dst.data),dst.cols,dst.rows),0,0);
    return {blob:await canvas.convertToBlob({type:'image/jpeg',quality:payload.quality??.94}),width:dst.cols,height:dst.rows};
  }finally{src.delete();dst.delete();from.delete();to.delete();matrix.delete();canvas.width=canvas.height=1;}
}
let queue=Promise.resolve();
self.onmessage=event=>{
 const {id,type,payload}=event.data;
 queue=queue.then(async()=>{
  try {
   self.postMessage({id,progress:'正在加载扫描组件'});await ready();
   if(type==='detect') {
    self.postMessage({id,progress:'正在识别纸张四角'});
    const canvas=await raster(payload.blob,1280);
    try {const result=detect(canvas);result.preview=await canvas.convertToBlob({type:'image/jpeg',quality:.94});self.postMessage({id,result});}
    finally{canvas.width=canvas.height=1;}
   }else if(type==='render') {self.postMessage({id,progress:'正在拉正纸张并生成扫描效果'});self.postMessage({id,result:await render(payload)});}
   else throw new Error('未知扫描任务。');
  }catch(error){self.postMessage({id,error:error instanceof Error?error.message:'照片处理失败，请尝试减小照片后重试。'});}
 });
};
