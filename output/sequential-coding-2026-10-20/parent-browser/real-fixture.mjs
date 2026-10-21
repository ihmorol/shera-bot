import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createControlPlaneApp } from '../../../apps/control-plane/src/index.ts';
import { startTestCluster } from '../../../apps/control-plane/test/helpers/pg-cluster.ts';
import { controlAccounts, controlOauthAccounts, controlSessions } from '../../../apps/control-plane/src/db/schema.ts';
import { FakeContainerBackend } from '../../../packages/test-kit/src/fake-container-backend.ts';
import { startRuntimeNode } from '../../../apps/user-runtime/src/main.ts';

// QA only: actual control plane, session validation and managed runtime;
// the account/session are seeded and container lifecycle is explicitly fake.
export async function startFixture() {
 const dir=resolve('output/sequential-coding-2026-10-20/parent-browser/run-'+randomUUID());
 await mkdir(dir,{recursive:true});
 const cluster=await startTestCluster('parent-browser');
 const accountId=randomUUID(), sessionToken=randomBytes(32).toString('hex');
 let runtime,cp,server;
 const fake=new FakeContainerBackend({endpointFor:()=>runtime?`http://127.0.0.1:${runtime.managementPort}`:null});
 const backend={
  async provisionRuntime(input,secrets){
   if(!runtime) runtime=await startRuntimeNode({host:'127.0.0.1',port:0,dbPath:resolve(dir,'runtime.db'),management:{host:'127.0.0.1',port:0,accountId:input.account_id,credentialSha256:createHash('sha256').update(secrets.internal_channel_token).digest('hex')}});
   return fake.provisionRuntime(input,secrets);
  },
  resumeRuntime:fake.resumeRuntime.bind(fake),stopRuntime:fake.stopRuntime.bind(fake),getRuntimeStatus:fake.getRuntimeStatus.bind(fake),
 };
 const close=async()=>{
  if(server)await new Promise((ok,fail)=>server.close(e=>e?fail(e):ok()));
  await cp?.close();await runtime?.stop();await cluster.stop();
  // Only this invocation's UUID child directory, created above.
  await rm(dir,{recursive:true,force:true});
 };
 try {
  cp=await createControlPlaneApp({databaseUrl:cluster.connectionString,runtimeBackend:backend,env:{...process.env,AUTH_SECRET:randomBytes(32).toString('hex'),GOOGLE_CLIENT_ID:randomUUID(),GOOGLE_CLIENT_SECRET:randomBytes(32).toString('hex'),AUTH_URL:'http://127.0.0.1:3177',AUTH_TRUST_HOST:'true',SHERA_WEB_ORIGIN:'http://127.0.0.1:3177'},logSink:()=>{}});
  await cp.db.insert(controlAccounts).values({id:accountId,name:'Browser QA',email:'browser-qa@example.invalid'});
  await cp.db.insert(controlOauthAccounts).values({userId:accountId,type:'oidc',provider:'google',providerAccountId:'browser-qa-'+randomUUID()});
  await cp.db.insert(controlSessions).values({sessionToken,userId:accountId,expires:new Date(Date.now()+10*60*1000)});
  server=createServer(cp.app);
  cp.liveTransport?.attach(server);
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(3178,'127.0.0.1',ok);});
  const cookie='authjs.session-token='+sessionToken;
  const session=await fetch('http://127.0.0.1:3178/api/session',{headers:{cookie}});
  if(!session.ok)throw Error('Seeded QA session refused: '+session.status+' '+await session.text());
  const projection=await session.json();
  const provision=await fetch('http://127.0.0.1:3178/api/runtime/provision',{method:'POST',headers:{cookie}});
  if(!provision.ok)throw Error('QA provision failed: '+provision.status+' '+await provision.text());
  return {origin:'http://127.0.0.1:3178',cookie,accountId,workspaceId:projection.workspace_id,sessionToken,close};
 } catch(e){await close();throw e;}
}
