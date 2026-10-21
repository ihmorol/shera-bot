import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { startRuntimeNode } from './source/apps/user-runtime/src/main.ts';

const runtime = await startRuntimeNode({port: 0, dbPath: fileURLToPath(new URL('./smoke-data/runtime.db', import.meta.url))});
const server = createServer();
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as {port:number}).port;
await new Promise<void>(r => server.close(() => r()));
const runtimeOrigin = `http://127.0.0.1:${runtime.port}`;
const webOrigin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [fileURLToPath(new URL('./source/apps/web/node_modules/next/dist/bin/next', import.meta.url)), 'start', '-H', '127.0.0.1', '-p', String(port)], {
 cwd: fileURLToPath(new URL('./source/apps/web/', import.meta.url)),
 env: {...process.env, RUNTIME_LOCAL_API_URL: runtimeOrigin}, windowsHide:true, stdio:'ignore'
});
try {
 let login: Response | undefined;
 const deadline = Date.now() + 20000;
 while (Date.now() < deadline) {
  try { login = await fetch(`${webOrigin}/login`); if(login.ok) break; } catch {}
  await new Promise(r => setTimeout(r, 200));
 }
 assert(login?.ok, 'built web server starts');
 const html = await login.text();
 assert.match(html, /<button[^>]*disabled[^>]*>Sign in with Google<\/button>/);
 console.log('OBSERVED B01: built /login serves a disabled Google sign-in button');
 const internal = await fetch(`${runtimeOrigin}/internal/v1/registration`, {method:'POST', headers:{'content-type':'application/json'}, body:'{}'});
 assert.equal(internal.status, 404);
 console.log('OBSERVED B05: real runtime bootstrap returns HTTP 404 for POST /internal/v1/registration');
 const request = await fetch(`${webOrigin}/api/runtime/v1/conversations/commands`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({type:'conversation.create', workspace_id:'ws-audit-anonymous', idempotency_key:'release-audit-anonymous-create', payload:{title:'Disposable audit probe'}})});
 assert.equal(request.status, 200, await request.text());
 console.log('OBSERVED B02: built web proxy accepts unauthenticated conversation.create with caller-chosen workspace_id (HTTP 200)');
 console.log('PASS: all three source findings reproduced through real boot/HTTP surfaces against disposable audit data');
} finally {
 const exited = new Promise(r => child.once('exit', r));
 child.kill();
 await exited;
 await runtime.stop();
}
