import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root=process.cwd(), dir=resolve(root,'output/sequential-coding-2026-10-20/parent-browser');
await mkdir(dir,{recursive:true});
const children=[];
function launch(file,args,name,cwd=root){
 const child=spawn(file,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const log=createWriteStream(resolve(dir,name+'.log'));child.stdout.pipe(log);child.stderr.pipe(log);children.push(child);return child;
}
async function ready(url){for(let i=0;i<100;i++){try{const r=await fetch(url);if(r.ok)return await r.json().catch(()=>null);}catch{}await new Promise(r=>setTimeout(r,150));}throw Error('Not ready: '+url);}
let ws;
try {
 const req=createRequire(resolve(root,'apps/web/package.json'));
 launch(process.execPath,[req.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','3177'],'web',resolve(root,'apps/web'));
 await ready('http://127.0.0.1:3177/login');
 launch('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9227','--user-data-dir='+resolve(dir,'chrome-profile'),'about:blank'],'chrome');
 const version=await ready('http://127.0.0.1:9227/json/version');
 const tabs=await (await fetch('http://127.0.0.1:9227/json/list')).json();
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail;});
 let id=0;const pending=new Map();
 ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);if(msg.error)p?.reject(Error(JSON.stringify(msg.error)));else p?.resolve(msg.result);}};
 function cdp(method,params={}){return new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}));});}
 const inspect=async(expression)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await cdp('Page.enable');await cdp('Runtime.enable');
 const results={browser:version.Browser,label:'Real browser against built website; unauthenticated login only',widths:[]};
 for(const width of [360,768,1440]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===360});
  await cdp('Page.navigate',{url:'http://127.0.0.1:3177/login'});
  for(let i=0;i<60;i++){if(await inspect("document.readyState==='complete' && !!document.querySelector('main h1')"))break;await new Promise(r=>setTimeout(r,100));}
  const state=await inspect(`(()=>{const a=[...document.querySelectorAll('main a')].find(a=>a.textContent.includes('Sign in with Google'));const b=a.getBoundingClientRect();return {heading:document.querySelector('main h1')?.textContent.trim(),link:a?.getAttribute('href'),overflow:document.documentElement.scrollWidth>innerWidth,button:{x:b.x,width:b.width,height:b.height},background:getComputedStyle(document.body).backgroundColor};})()`);
  if(state.heading!=='Sign in to Shera Bot'||state.overflow||state.button.width<=0||state.button.height<=0)throw Error(JSON.stringify(state));
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  state.keyboardFocus=await inspect("document.activeElement?.textContent?.trim()");
  if(!state.keyboardFocus?.includes('Sign in with Google')) {await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});state.keyboardFocus=await inspect("document.activeElement?.textContent?.trim()");} if(!state.keyboardFocus?.includes('Sign in with Google'))throw Error('Sign-in link not reached by keyboard: '+state.keyboardFocus);
  const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(resolve(dir,'login-'+width+'.png'),Buffer.from(shot.data,'base64'));
  results.widths.push({width,...state});
 }
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 results.reducedMotion=await inspect("matchMedia('(prefers-reduced-motion: reduce)').matches");
 await writeFile(resolve(dir,'results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
} finally {ws?.close();for(const child of children.reverse())child.kill();}
