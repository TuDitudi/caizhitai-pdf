// Reproduce the self-hosted scanner assets from the pinned upstream releases.
// node scripts/prepare-scanner-assets.mjs /path/opencv.js /path/heic-to-package
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const [cvPath, heicPackage] = process.argv.slice(2);
if (!cvPath || !heicPackage) throw new Error('Provide OpenCV 4.13.0 opencv.js and extracted heic-to 1.6.7 package');
const upstream = await readFile(cvPath, 'utf8');
if (createHash('sha256').update(upstream).digest('hex') !== '63366510248adf3a7eddf3e793dd825404efb7df3749f4d6f8557c7fa4ca8aa0') throw new Error('Unexpected OpenCV build');
let source = upstream;
function replaceFunction(name, next, body) {
 const a = source.indexOf('function ' + name + '('), b = source.indexOf(next, a);
 if (a < 0 || b < a) throw new Error('OpenCV binding changed: ' + name);
 source = source.slice(0, a) + body + source.slice(b);
}
// The upstream build generates bindings with Function(). Equivalent closures
// preserve the embind conversions/destructors without enabling unsafe-eval.
replaceFunction('createNamedFunction', 'function extendError', `function createNamedFunction(name,body){var fn=function(){return body.apply(this,arguments)};Object.defineProperty(fn,"name",{value:makeLegalFunctionName(name)});return fn}`);
replaceFunction('craftInvokerFunction', 'function heap32VectorToArray', `function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){
 var isMethod=argTypes[1]!==null&&classType!==null;
 var needsStack=argTypes.slice(1).some(function(t){return t!==null&&t.destructorFunction===undefined});
 return function(){
  if(arguments.length!==argTypes.length-2)throwBindingError(humanName+" called with incorrect argument count");
  var destructors=needsStack?[]:null,wired=[],self;
  if(isMethod){self=argTypes[1].toWireType(destructors,this);wired.push(self)}
  for(var i=0;i<arguments.length;i++)wired.push(argTypes[i+2].toWireType(destructors,arguments[i]));
  var rv=cppInvokerFunc.apply(null,[cppTargetFunc].concat(wired));
  if(needsStack)runDestructors(destructors);
  else{for(var i=isMethod?1:2;i<argTypes.length;i++)if(argTypes[i].destructorFunction!==null)argTypes[i].destructorFunction(wired[i-(isMethod?1:2)])}
  if(argTypes[0].name!=="void")return argTypes[0].fromWireType(rv);
 }
}`);
const dynStart = source.indexOf('function makeDynCaller(dynCall){'), dynEnd = source.indexOf('var fp;', dynStart);
if (dynStart < 0 || dynEnd < dynStart) throw new Error('Missing dynCall binding');
source = source.slice(0,dynStart) + 'function makeDynCaller(dynCall){return function(){return dynCall.apply(null,[rawFunction].concat(Array.prototype.slice.call(arguments)))}}' + source.slice(dynEnd);
replaceFunction('__emval_get_method_caller', 'function __emval_get_property', `function __emval_get_method_caller(argCount,argTypes){var types=__emval_lookupTypes(argCount,argTypes),retType=types[0];return __emval_addMethodCaller(function(handle,name,destructors,args){var values=[],offset=0;for(var i=1;i<types.length;i++){values.push(types[i].readValueFromPointer(args+offset));offset+=types[i].argPackAdvance}var rv=handle[name].apply(handle,values);for(var i=1;i<types.length;i++)if(types[i].deleteObject)types[i].deleteObject(values[i-1]);if(!retType.isVoid)return retType.toWireType(destructors,rv)})}`);
if (/new Function|new_\(Function/.test(source)) throw new Error('Dynamic binding remains');
await writeFile('public/scanner/opencv-4.13.0.js', '/* OpenCV 4.13.0, Apache-2.0. CSP closure adaptations: scripts/prepare-scanner-assets.mjs. */\n'+source);
const heic = await readFile(heicPackage+'/dist/csp/heic-to.js','utf8');
if (createHash('sha256').update(heic).digest('hex') !== 'e0a515585872c319c601c33551925c9d5fee31746caf0311291ed7e6364c592c') throw new Error('Unexpected HEIC decoder build');
const literal = heic.match(/let t=('(?:\\.|[^'\\])*'),e=new Blob/);
if (!literal) throw new Error('HEIC worker layout changed');
let worker = vm.runInNewContext(literal[1], Object.create(null), {timeout:1000});
const allocation = '$6=new ImageData(P,a6);';
if (!worker.includes(allocation)) throw new Error('HEIC allocation changed');
worker = worker.replace(allocation, '$6=(P*a6>40000000||Math.max(P,a6)>24000)?(()=>{throw new Error("Image exceeds 40 megapixels")})():new ImageData(P,a6);');
const post = 'postMessage({id:p1,imageData:M1,error:""})';
if (!worker.includes(post)) throw new Error('HEIC transfer changed');
worker = worker.replace(post,'postMessage({id:p1,imageData:M1,error:""},[M1.data.buffer])');
await writeFile('public/scanner/heic-decoder-1.6.7.js','/* heic-to 1.6.7 CSP worker, LGPL-3.0-or-later. Added pixel guard and transferable output; see NOTICE.md. */\n'+worker);
await copyFile(heicPackage+'/LICENSE','public/scanner/LICENSE-heic-to.txt');
