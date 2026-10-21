import { startFixture } from './real-fixture.mjs';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root=process.cwd(), dir=resolve(root,'output/sequential-coding-2026-10-20/parent-browser');
await mkdir(dir,{recursive:true});
const children=[];
const profile=resolve(dir,'chrome-auth-'+crypto.randomUUID());
const liveFrames=[],liveUrls=[];
function launch(file,args,name,cwd=root){
 const child=spawn(file,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const log=createWriteStream(resolve(dir,name+'.log'));child.stdout.pipe(log);child.stderr.pipe(log);children.push(child);return child;
}
async function ready(url){for(let i=0;i<100;i++){try{const r=await fetch(url);if(r.ok)return await r.json().catch(()=>null);}catch{}await new Promise(r=>setTimeout(r,150));}throw Error('Not ready: '+url);}
let ws;
const fixture=await startFixture();
process.env.CONTROL_PLANE_URL=fixture.origin;
process.env.SHERA_WEB_ORIGIN='http://127.0.0.1:3177';
try {
 const req=createRequire(resolve(root,'apps/web/package.json'));
 launch(process.execPath,[req.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','3177'],'web',resolve(root,'apps/web'));
 await ready('http://127.0.0.1:3177/login');
 launch('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9227','--user-data-dir='+profile,'about:blank'],'chrome');
 const version=await ready('http://127.0.0.1:9227/json/version');
 const tabs=await (await fetch('http://127.0.0.1:9227/json/list')).json();
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail;});
 let id=0;const pending=new Map();
 ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.method==='Network.webSocketCreated')liveUrls.push(msg.params.url);if(msg.method==='Network.webSocketFrameReceived')liveFrames.push(msg.params.response.payloadData);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);if(msg.error)p?.reject(Error(JSON.stringify(msg.error)));else p?.resolve(msg.result);}};
 function cdp(method,params={}){return new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}));});}
 const inspect=async(expression)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await cdp('Page.enable');await cdp('Runtime.enable');
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:"globalThis.__qaSockets=[];const OriginalWebSocket=globalThis.WebSocket;globalThis.WebSocket=new Proxy(OriginalWebSocket,{construct(Target,args){const socket=Reflect.construct(Target,args);globalThis.__qaSockets.push(socket);return socket;}});"});
 await cdp('Network.enable');
 await cdp('Network.setCookie',{name:'authjs.session-token',value:fixture.sessionToken,url:'http://127.0.0.1:3177',httpOnly:true,sameSite:'Lax'});
 const results={browser:version.Browser,label:'Real CP/PostgreSQL/SQLite/runtime; seeded disposable session; fake container engine; no live provider',widths:[]};
 for(const width of [360,768,1440]){
  await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width===360});
  await cdp('Page.navigate',{url:'http://127.0.0.1:3177/app/agent/researcher'});
  let body='';
  for(let i=0;i<100;i++){body=await inspect("(document.body?.innerText??String())");if(body.includes('The Researcher investigates') && body.includes('This conversation started in your workspace'))break;await new Promise(r=>setTimeout(r,100));}
  const state=await inspect(`(()=>{const t=document.querySelector('textarea');return {heading:document.querySelector('h1')?.textContent.trim(),overflow:document.documentElement.scrollWidth>innerWidth,composer:t?{disabled:t.disabled,label:t.getAttribute('aria-label'),placeholder:t.placeholder}:null,body:(document.body?.innerText??String()).slice(-6000),links:[...document.querySelectorAll('a[href^="/app/agent/"]')].map(a=>({href:a.getAttribute('href'),text:a.innerText.trim()}))};})()`);
  const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(resolve(dir,'authenticated-'+width+'.png'),Buffer.from(shot.data,'base64'));
  if(state.heading!=='Researcher'||state.overflow||!state.body.includes('This conversation started in your workspace'))throw Error('Agent page not ready or overflowed: '+JSON.stringify(state));
  results.widths.push({width,...state});
 }
 const message='Sequential parent review message';
 for(let i=0;i<100;i++){if(await inspect("!!document.querySelector('textarea[aria-label=\"Message Researcher\"]:not(:disabled)')"))break;await new Promise(r=>setTimeout(r,100));}
 if(!await inspect("!!document.querySelector('textarea[aria-label=\"Message Researcher\"]:not(:disabled)')"))throw Error('Live composer is unavailable');
 await inspect("document.querySelector('textarea[aria-label=\"Message Researcher\"]').focus()");
 await cdp('Input.insertText',{text:message});
 await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
 for(let i=0;i<100;i++){if(liveFrames.some(f=>f.includes('message.appended')&&f.includes(message)))break;await new Promise(r=>setTimeout(r,100));}
 if(!liveFrames.some(f=>f.includes('message.appended')&&f.includes(message)))throw Error('No authoritative live message frame');
 await cdp('Page.reload');
 for(let i=0;i<100;i++){if(await inspect('(document.body?.innerText??String()).includes('+JSON.stringify(message)+')'))break;await new Promise(r=>setTimeout(r,100));}
 results.persistedMessageCount=await inspect('(document.body?.innerText??String()).split('+JSON.stringify(message)+').length-1');
 if(results.persistedMessageCount!==1)throw Error('Reload history missing or duplicated');
 const opens=liveUrls.length, frameStart=liveFrames.length;
 await inspect('globalThis.__qaSockets.forEach(socket=>socket.close())');
 for(let i=0;i<100;i++){if(liveUrls.length>opens&&liveFrames.slice(frameStart).some(f=>f.includes('replayed')))break;await new Promise(r=>setTimeout(r,100));}
 results.reconnected=liveUrls.length>opens&&liveFrames.slice(frameStart).some(f=>f.includes('replayed'));
 results.messageCountAfterReconnect=await inspect('(document.body?.innerText??String()).split('+JSON.stringify(message)+').length-1');
 if(results.messageCountAfterReconnect!==1)throw Error('Reconnect duplicated or lost the message');
 results.liveUrls=liveUrls;
 if(!results.reconnected||!liveUrls.every(url=>url.startsWith('ws://127.0.0.1:3177/api/runtime/live?')))throw Error('Reconnect or same-origin route failed');
 results.streamFrames=liveFrames.filter(f=>f.includes('message.appended')||f.includes('replayed')).map(f=>JSON.parse(f.slice(f.indexOf('['))));
 const after=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(resolve(dir,'live-message-after-reconnect.png'),Buffer.from(after.data,'base64'));
 const beforeLogout=await inspect('globalThis.__qaSockets.filter(s=>s.readyState===1).length');
 if(beforeLogout<1)throw Error('No open stream before signout');
 await inspect('(async()=>{const r=await fetch("/api/control/api/auth/csrf");const {csrfToken}=await r.json();await fetch("/api/control/api/auth/signout",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({csrfToken,callbackUrl:location.origin+"/login"}),redirect:"manual"});return true;})()');
 for(let i=0;i<50;i++){if(await inspect('globalThis.__qaSockets.every(s=>s.readyState!==1)'))break;await new Promise(r=>setTimeout(r,100));}
 results.openStreamsAfterLogout=await inspect('globalThis.__qaSockets.filter(s=>s.readyState===1).length');
 results.sessionStatusAfterLogout=await inspect('(async()=>{const r=await fetch("/api/control/api/session");return r.status;})()');
 if(results.openStreamsAfterLogout!==0||results.sessionStatusAfterLogout!==401)throw Error('Signout did not revoke live session');
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 results.reducedMotion=await inspect("matchMedia('(prefers-reduced-motion: reduce)').matches");
 await writeFile(resolve(dir,'live-results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
} catch(error) {console.error(error);process.exitCode=1;} finally {if(ws?.readyState===1){ws.send(JSON.stringify({id:999999,method:'Browser.close'}));await new Promise(ok=>{ws.addEventListener('close',ok,{once:true});setTimeout(ok,2000);});}ws?.close();for(const child of children.reverse()){if(child.exitCode===null)child.kill();await new Promise(ok=>{if(child.exitCode!==null)ok();else {child.once('exit',ok);setTimeout(ok,3000);}});}await fixture.close();try{await rm(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});}catch(error){console.error('Owned browser profile cleanup failed:',error.message);process.exitCode=1;}}
