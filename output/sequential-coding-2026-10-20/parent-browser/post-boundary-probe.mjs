import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startFixture} from './real-fixture.mjs';
const f=await startFixture(), req=createRequire(resolve('apps/web/package.json'));
const server=spawn(process.execPath,[req.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','3177'],{cwd:resolve('apps/web'),windowsHide:true,stdio:'ignore',env:{...process.env,CONTROL_PLANE_URL:f.origin,SHERA_WEB_ORIGIN:'http://127.0.0.1:3177'}});
try {
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3177/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const results=[];
 for(const origin of [null,'http://127.0.0.1:3177','http://localhost:3177']){
  const body={type:'agent_settings.update_instructions',command_id:'cmd_'+randomUUID(),idempotency_key:'idem_'+randomUUID(),workspace_id:f.workspaceId,agent_id:'agent_researcher',issued_at:new Date().toISOString(),actor:{type:'user',id:f.accountId},user_instructions:'Parent web boundary probe'};
  const r=await fetch('http://127.0.0.1:3177/api/runtime/v1/agents/agent_researcher/settings/commands',{method:'POST',headers:{cookie:f.cookie,'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
  results.push({origin,status:r.status,body:await r.json()});
 }
 console.log(JSON.stringify(results,null,2));await writeFile('output/sequential-coding-2026-10-20/parent-browser/web-post-'+(process.argv[2]??'before')+'-task-4.json',JSON.stringify(results,null,2)+'\n');
}finally {server.kill();await new Promise(ok=>{if(server.exitCode!==null)ok();else{server.once('exit',ok);setTimeout(ok,2000);}});await f.close();}
