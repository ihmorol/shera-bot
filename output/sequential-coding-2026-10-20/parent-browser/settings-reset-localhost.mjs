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
function launch(file,args,name,cwd=root){
 const child=spawn(file,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const log=createWriteStream(resolve(dir,name+'.log'));child.stdout.pipe(log);child.stderr.pipe(log);children.push(child);return child;
}
async function ready(url){for(let i=0;i<100;i++){try{const r=await fetch(url);if(r.ok)return await r.json().catch(()=>null);}catch{}await new Promise(r=>setTimeout(r,150));}throw Error('Not ready: '+url);}
let ws;
const fixture=await startFixture();
process.env.CONTROL_PLANE_URL=fixture.origin;
process.env.SHERA_WEB_ORIGIN='http://localhost:3177';
try {
 const req=createRequire(resolve(root,'apps/web/package.json'));
 launch(process.execPath,[req.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','3177'],'web',resolve(root,'apps/web'));
 await ready('http://localhost:3177/login');
 launch('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-address=127.0.0.1','--remote-debugging-port=9227','--user-data-dir='+profile,'about:blank'],'chrome');
 const version=await ready('http://127.0.0.1:9227/json/version');
 const tabs=await (await fetch('http://127.0.0.1:9227/json/list')).json();
 ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail;});
 let id=0;const pending=new Map();
 ws.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);if(msg.error)p?.reject(Error(JSON.stringify(msg.error)));else p?.resolve(msg.result);}};
 function cdp(method,params={}){return new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});ws.send(JSON.stringify({id:key,method,params}));});}
 const inspect=async(expression)=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await cdp('Page.enable');await cdp('Runtime.enable');
 await cdp('Network.enable');
 await cdp('Network.setCookie',{name:'authjs.session-token',value:fixture.sessionToken,url:'http://localhost:3177',httpOnly:true,sameSite:'Lax'});
 const results={browser:version.Browser,label:'Real seeded session and runtime; browser settings reset probe'};
 await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await cdp('Page.navigate',{url:'http://localhost:3177/app/settings/agents/researcher'});
 const field='textarea[aria-label="Your instructions"]';
 for(let i=0;i<100;i++){if(await inspect('!!document.querySelector('+JSON.stringify(field)+')'))break;await new Promise(r=>setTimeout(r,100));}
 if(!await inspect('!!document.querySelector('+JSON.stringify(field)+')'))throw Error('Settings editor did not load');
 const snapshot=()=>inspect('(async()=>{const r=await fetch("/api/runtime/v1/agents/agent_researcher/settings?workspace_id='+fixture.workspaceId+'");if(!r.ok)throw Error("settings "+r.status);return r.json()})()');
 const initial=await snapshot();results.original=initial.entries.find(e=>e.key==='user_instructions').value;
 const draft='Parent browser reset regression';
 await inspect('document.querySelector('+JSON.stringify(field)+').focus()');
 await cdp('Input.insertText',{text:draft});
 async function clickText(section,text){
  const point=await inspect('(()=>{const s=document.querySelector('+JSON.stringify(section)+');const b=[...s.querySelectorAll("button")].find(b=>b.textContent.trim()==='+JSON.stringify(text)+');if(!b)throw Error("Missing button");b.scrollIntoView({block:"center",behavior:"instant"});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
 }
 const section='section[data-setting-key="user_instructions"]';
 console.log('Draft before save:',await inspect('document.querySelector('+JSON.stringify(field)+').value'));
 await clickText(section,'Save');
 for(let i=0;i<100;i++){const v=(await snapshot()).entries.find(e=>e.key==='user_instructions').value;if(v===draft)break;await new Promise(r=>setTimeout(r,100));}
 results.saved=(await snapshot()).entries.find(e=>e.key==='user_instructions').value;
 if(results.saved!==draft){console.log(await inspect('document.body.innerText'));throw Error('Instructions save failed');}
 await clickText(section,'Reset to default');await clickText(section,'Confirm reset');
 for(let i=0;i<100;i++){const v=(await snapshot()).entries.find(e=>e.key==='user_instructions').value;if(v===results.original)break;await new Promise(r=>setTimeout(r,100));}
 results.persistedAfterReset=(await snapshot()).entries.find(e=>e.key==='user_instructions').value;
 for(let i=0;i<30;i++){if(await inspect('document.querySelector('+JSON.stringify(field)+').value===' +JSON.stringify(results.original??'')))break;await new Promise(r=>setTimeout(r,100));}
 results.editorAfterReset=await inspect('document.querySelector('+JSON.stringify(field)+').value');
 results.resetEditorMatchesAuthoritative=results.editorAfterReset===(results.persistedAfterReset??'');
 const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(resolve(dir,'settings-reset.png'),Buffer.from(shot.data,'base64'));
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
 results.reducedMotion=await inspect("matchMedia('(prefers-reduced-motion: reduce)').matches");
 await writeFile(resolve(dir,'settings-reset-localhost-results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
} catch(error) {console.error(error);process.exitCode=1;} finally {if(ws?.readyState===1){ws.send(JSON.stringify({id:999999,method:'Browser.close'}));await new Promise(ok=>{ws.addEventListener('close',ok,{once:true});setTimeout(ok,2000);});}ws?.close();for(const child of children.reverse()){if(child.exitCode===null)child.kill();await new Promise(ok=>{if(child.exitCode!==null)ok();else {child.once('exit',ok);setTimeout(ok,3000);}});}await fixture.close();try{await rm(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});}catch(error){console.error('Owned browser profile cleanup failed:',error.message);process.exitCode=1;}}
