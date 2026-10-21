import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {writeFileSync,openSync} from 'node:fs';
import {resolve} from 'node:path';
const token=randomBytes(32).toString('hex');
const out=resolve('output/implementation-2026-10-20');
const log=openSync(`${out}/entrypoint.log`,'a');
const child=spawn(process.execPath,['--experimental-transform-types','apps/user-runtime/src/entrypoint.ts'],{
 windowsHide:true,stdio:['ignore',log,log],env:{...process.env,RUNTIME_PORT:'0',RUNTIME_DB_PATH:`${out}/runtime-smoke/runtime.db`,RUNTIME_DEFAULT_WORKSPACE_ID:'ws_smoke',SHERA_ACCOUNT_ID:'smoke',SHERA_INTERNAL_PORT:'3178',SHERA_INTERNAL_CHANNEL_CREDENTIAL_SHA256:createHash('sha256').update(token).digest('hex')}
});
try {
 let ready=false;
 for(let i=0;i<50;i++) {
  try {const res=await fetch('http://127.0.0.1:3178/internal/v1/health',{headers:{authorization:`Bearer ${token}`}});if(res.ok){ready=true;break;}} catch {}
  if(child.exitCode!==null) throw new Error(`runtime exited ${child.exitCode}`);
  await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(ready,'entrypoint starts authenticated health listener');
 const denied=await fetch('http://127.0.0.1:3178/internal/v1/health');
 assert.equal(denied.status,401);
 writeFileSync(`${out}/entrypoint-smoke.json`,JSON.stringify({entrypoint:'apps/user-runtime/src/entrypoint.ts',authenticatedHealth:200,anonymousHealth:denied.status},null,2));
 console.log('Real entrypoint: authenticated health 200; anonymous health 401');
} finally { child.kill(); }
