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
function refine(gray,quad,w,h,compact=false) {
  const data=gray.data,range=Math.min(w,h)*(compact ? .05 : .18);
  const startOffset=compact?range:18;
  const value=(x,y)=>data[Math.max(0,Math.min(h-1,Math.round(y)))*w+Math.max(0,Math.min(w-1,Math.round(x)))];
  const lines=quad.map((p,i)=>{
    const q=quad[(i+1)%4],a={x:p.x*w,y:p.y*h},b={x:q.x*w,y:q.y*h};
    const dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy),nx=-dy/length,ny=dx/length,samples=[];
    for(let n=1;n<=19;n++) {
      const t=n/20,x=a.x+dx*t,y=a.y+dy*t;let best=null;
      let previous=null;
      for(let offset=startOffset;offset>=-range;offset-=1) {
        const px=x+nx*offset,py=y+ny*offset;
        if(px<4||py<4||px>w-5||py>h-5)continue;
        const contrast=Math.abs(value(px+nx*4,py+ny*4)-value(px-nx*4,py-ny*4));
        if(compact){
          const score=contrast-Math.abs(offset)*.3;
          if(contrast>=24&&(!best||score>best.score))best={x:px,y:py,score};
          continue;
        }
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

function cardOutline(image, quad) {
  const {cols:w,rows:h,data}=image;
  const points=quad.map(p=>({x:p.x*w,y:p.y*h}));
  const sides=points.map((p,i)=>{
    const q=points[(i+1)%4],dx=q.x-p.x,dy=q.y-p.y,length=Math.hypot(dx,dy);
    return {p,dx,dy,length,nx:-dy/length,ny:dx/length};
  });
  const width=(sides[0].length+sides[2].length)/2,height=(sides[1].length+sides[3].length)/2;
  const short=Math.min(width,height),ratio=Math.max(width,height)/short;
  if(short<40||ratio<1.27||ratio>2.12)return null;
  const gap=Math.max(3,Math.min(18,short*.036));
  const sample=(x,y)=>{
    x=Math.round(x);y=Math.round(y);
    if(x<0||x>=w||y<0||y>=h)return null;
    const i=(y*w+x)*4;
    return [data[i],data[i+1],data[i+2]];
  };
  const distance=(a,b)=>(Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])+Math.abs(a[2]-b[2]))/3;
  function across(side,t) {
    const {p,dx,dy,nx,ny}=side,x=p.x+dx*t,y=p.y+dy*t;
    const inside=sample(x+nx*gap,y+ny*gap),outside=sample(x-nx*gap,y-ny*gap);
    return inside&&outside?{inside,outside}:null;
  }
  const supported=sides.filter(side=>{
    let matches=0;
    for(let n=2;n<=10;n++){
      const pair=across(side,n/12);
      if(pair&&distance(pair.inside,pair.outside)>=22)matches++;
    }
    return matches>=6;
  }).length;
  if(supported<3)return null;

  // A rounded corner starts with desk-colored pixels on its diagonal and
  // transitions to card stock. Verify both colors on the adjacent straight sides.
  const radii=points.map((corner,i)=>{
    const prev=points[(i+3)%4],next=points[(i+1)%4];
    const a=across(sides[i],.15),b=across(sides[(i+3)%4],.85);
    if(!a||!b||distance(a.inside,a.outside)<22||distance(b.inside,b.outside)<22)return 0;
    let outsideRun=0;
    for(let step=1;step<=10;step++){
      const offset=short*step*.003;
      const x=corner.x+offset*((next.x-corner.x)/sides[i].length+(prev.x-corner.x)/sides[(i+3)%4].length);
      const y=corner.y+offset*((next.y-corner.y)/sides[i].length+(prev.y-corner.y)/sides[(i+3)%4].length);
      const px=sample(x,y);
      if(!px)return 0;
      const stock=Math.min(distance(px,a.inside),distance(px,b.inside));
      const desk=Math.min(distance(px,a.outside),distance(px,b.outside));
      if(desk+9<stock){outsideRun=step;continue;}
      if(stock+9<desk&&outsideRun>=1)return Math.min(.07,(outsideRun+.5)*.003/(1-Math.SQRT1_2));
      if(outsideRun===0)return 0;
    }
    return 0;
  });
  const rounded=radii.filter(radius=>radius>=.018).length>=2;
  const border=rounded?sides.map(side=>{
    let thickness=0;
    for(let step=0;step<=5;step++){
      let matches=0;
      const offset=step*short*.003;
      for(let n=2;n<=10;n++){
        const t=n/12,pair=across(side,t);
        const px=sample(side.p.x+side.dx*t+side.nx*offset,side.p.y+side.dy*t+side.ny*offset);
        if(pair&&px&&distance(px,pair.outside)+9<distance(px,pair.inside))matches++;
      }
      if(matches<6)break;
      thickness=(step+.5)*.003;
    }
    return thickness;
  }):[];
  return {rounded,radii,border,short,width,height};
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
            if(area<w*h*.035)continue;
            cv.approxPolyDP(contour,approx,.018*cv.arcLength(contour,true),true);
            if(approx.rows!==4||!cv.isContourConvex(approx))continue;
            const quad=ordered(Array.from({length:4},(_,i)=>({x:approx.data32S[i*2]/w,y:approx.data32S[i*2+1]/h})));
            const touches=quad.filter(p=>p.x<.008||p.x>.992||p.y<.008||p.y>.992).length;
            const coverage=area/(w*h);
            if(coverage>.985)continue;
            const sides=quad.map((p,i)=>Math.hypot((p.x-quad[(i+1)%4].x)*w,(p.y-quad[(i+1)%4].y)*h));
            const compact=coverage<.3;
            if(Math.min(...sides)<Math.min(w,h)*(compact ? .10 : .16))continue;
            const outline=compact?cardOutline(image,quad):null;
            if(coverage<.15&&(!outline||touches))continue;
            const score=coverage*2.2-touches*.10+(variant===0?.08:0)+(outline?.rounded ? .13 : 0);
            if(!best||score>best.score)best={points:quad,score,touches,coverage,compact};
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
    if(best){
      const coarseCard=cardOutline(image,best.points);
      const refined=refine(blur,best.points,w,h,best.compact||Boolean(coarseCard));
      const outline=cardOutline(image,refined);
      if(outline?.rounded||!coloredBorder(refined)&&!interiorBorder(refined)){
        best.points=refined;
        best.card=outline;
      }else if(coarseCard?.rounded||best.compact&&coarseCard){
        best.card=coarseCard;
      }else best=null;
    }
    if(best){best.touches=best.points.filter(p=>p.x<.008||p.x>.992||p.y<.008||p.y>.992).length;}
    const review=best&&(best.touches||best.coverage<.3&&!best.card?.rounded);
    return best?{points:best.points,confidence:review?'review':'detected',warning:best.touches?'纸张或证件接近照片边缘，请检查是否拍全四角。':review?'已估算边缘，请核对四个角后导出。':''}:{points:fallback(),confidence:'manual',warning:'未可靠识别纸张边缘，请拖动四角框选；如纸角超出画面，请重新拍照。'};
  }finally{objects.reverse().forEach(o=>o.delete());}
}
function enhance(mat,mode,strength,card) {
  if(mode==='original')return;
  const cv=runtime,gray=new cv.Mat(),small=new cv.Mat(),light=new cv.Mat(),large=new cv.Mat(),out=new cv.Mat();
  const kernel=cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(17,17));
  try {
    cv.cvtColor(mat,gray,cv.COLOR_RGBA2GRAY);
    if(mode==='bw'&&!card) {
      cv.adaptiveThreshold(gray,out,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY,Math.min(51,Math.floor(Math.min(mat.cols,mat.rows)/2)*2-1),8+strength*.12);
      cv.cvtColor(out,mat,cv.COLOR_GRAY2RGBA);return;
    }
    const scale=Math.min(1,512/Math.max(mat.cols,mat.rows));
    cv.resize(gray,small,new cv.Size(Math.max(1,Math.round(mat.cols*scale)),Math.max(1,Math.round(mat.rows*scale))),0,0,cv.INTER_AREA);
    cv.dilate(small,light,kernel);cv.GaussianBlur(light,light,new cv.Size(31,31),0);cv.resize(light,large,new cv.Size(mat.cols,mat.rows),0,0,cv.INTER_LINEAR);
    const amount=strength/100, data=mat.data,illum=large.data;
    let stockFloor=80;
    if(card){
      // A dark emblem or portrait is not a shadow. Bound the amount of
      // compensation with a robust estimate from the whole card.
      const histogram=new Uint32Array(256);
      for(let i=0;i<small.data.length;i++)histogram[small.data[i]]++;
      let count=small.data.length*.75;
      for(let value=0;value<256;value++){
        count-=histogram[value];
        if(count<=0){stockFloor=Math.max(80,value*.86);break;}
      }
    }
    if(mode==='bw'){
      // Card security patterns become solid speckling under a hard threshold.
      // Correct local lighting, then compress light tones while retaining dark detail.
      const white=.94-amount*.21,black=.12+amount*.08;
      for(let i=0;i<illum.length;i++){
        const tone=gray.data[i]/Math.max(stockFloor,illum[i]);
        const value=255*Math.max(0,Math.min(1,(tone-black)/(white-black)));
        data[i*4]=data[i*4+1]=data[i*4+2]=value;
      }
      return;
    }
    for(let i=0;i<illum.length;i++) {
      const gain=1+amount*(Math.min(card?1.3:2.5,255/Math.max(stockFloor,illum[i]))-1);
      const contrast=1+amount*(card ? .05 : .13);
      for(let c=0;c<3;c++)data[i*4+c]=Math.max(0,Math.min(255,255-(255-data[i*4+c]*gain)*contrast));
    }
  }finally{gray.delete();small.delete();light.delete();large.delete();out.delete();kernel.delete();}
}

function cleanCardBorder(mat,card) {
  const {cols:w,rows:h,data}=mat;
  const unitX=w*card.short/card.width,unitY=h*card.short/card.height;
  const [top,right,bottom,left]=card.border;
  const band=Math.ceil(Math.max(...card.radii,...card.border)*Math.max(unitX,unitY));
  function clean(x,y){
    const horizontal=Math.min(x,w-1-x)/unitX,vertical=Math.min(y,h-1-y)/unitY;
    const corner=y<h/2?(x<w/2?0:1):(x<w/2?3:2);
    const radius=card.radii[corner];
    const inCorner=horizontal<radius&&vertical<radius;
    const outside=x<left*unitX||w-1-x<right*unitX||y<top*unitY||h-1-y<bottom*unitY||
      (inCorner&&Math.hypot(radius-horizontal,radius-vertical)>radius);
    if(outside){const i=(y*w+x)*4;data[i]=data[i+1]=data[i+2]=255;}
  }
  for(let y=0;y<h;y++){
    if(y<band||y>=h-band){for(let x=0;x<w;x++)clean(x,y);}
    else for(let x=0;x<Math.min(band,w/2);x++){clean(x,y);clean(w-1-x,y);}
  }
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
    const outline=payload.mode==='original'?null:cardOutline(src,payload.points);
    const card=outline?.rounded?outline:null;
    cv.warpPerspective(src,dst,matrix,new cv.Size(width,height),cv.INTER_CUBIC,cv.BORDER_REPLICATE);
    enhance(dst,payload.mode,payload.strength,card);
    if(card)cleanCardBorder(dst,card);
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
