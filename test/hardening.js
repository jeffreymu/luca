import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server.js";

const check=(name,value)=>{assert.ok(value,name);console.log(`  ✓ ${name}`);},tmp=mkdtempSync(path.join(os.tmpdir(),"lucapi-hardening-")),repo=path.join(tmp,"repo"),dbPath=path.join(tmp,"shared.db");
execFileSync("git",["init","-b","main",repo]);execFileSync("git",["config","user.email","hardening@test.local"],{cwd:repo});execFileSync("git",["config","user.name","LucaPi Test"],{cwd:repo});
const app1=createApp({dbPath}),app2=createApp({dbPath}),server=app1.server;await new Promise((r)=>server.listen(0,r));const base=`http://127.0.0.1:${server.address().port}`;
const api=async(p,o={})=>{const r=await fetch(base+p,{headers:{"content-type":"application/json"},...o,body:o.body?JSON.stringify(o.body):undefined});return{status:r.status,body:await r.json().catch(()=>({}))};};
try{
  console.log("\nLucaPi hardening integration test\n");
  const ws=await api("/api/workspaces",{method:"POST",body:{name:"Shared workers",repoPath:repo}}),workspaceId=ws.body.workspace.id;
  const flow=await api("/api/workflows",{method:"POST",body:{workspaceId,name:"Once",definition:{autoRun:false,steps:[{type:"card.create",title:"Exactly once"}]}}}),job=await api(`/api/workflows/${flow.body.id}/trigger`,{method:"POST"});
  let current=job.body;for(let i=0;i<100&&["PENDING","RUNNING"].includes(current.status);i++){await new Promise((r)=>setTimeout(r,50));current=(await api(`/api/jobs/${current.id}`)).body;}
  const state=await api(`/api/state?workspaceId=${workspaceId}`);check("multiple workers atomically execute one durable job once",current.status==="COMPLETED"&&state.body.cards.filter((c)=>c.title==="Exactly once").length===1&&current.worker_id);
  const failed=app1.store.createJob({type:"unknown",workspaceId,maxAttempts:1});for(let i=0;i<100;i++){await new Promise((r)=>setTimeout(r,30));if(app1.store.getJob(failed.id).status==="FAILED")break;}await app1.worker.stop();await app2.worker.stop();const retried=await api(`/api/jobs/${failed.id}/retry`,{method:"POST"});check("dead-letter job can be explicitly retried",retried.status===200&&retried.body.status==="PENDING"&&retried.body.attempts===0);app1.store.cancelJob(failed.id);
  const expiring=app1.store.createJob({type:"unknown",workspaceId,maxAttempts:3}),firstClaim=app1.store.claimJob(1,"crashed-worker");await new Promise((r)=>setTimeout(r,5));const recovered=app2.store.claimJob(1000,"recovery-worker");check("expired job lease is recovered by another worker",firstClaim.id===expiring.id&&recovered.id===expiring.id&&recovered.worker_id==="recovery-worker");app2.store.cancelJob(expiring.id);
} finally {server.close();await app1.worker.stop();await app2.worker.stop();}

process.env.LUCAPI_SECRET_KEY="integration-secret";const encryptedPath=path.join(tmp,"encrypted.db"),encrypted=createApp({dbPath:encryptedPath,startWorker:false}),encryptedServer=encrypted.server;await new Promise((r)=>encryptedServer.listen(0,r));const encryptedBase=`http://127.0.0.1:${encryptedServer.address().port}`;
try{
  await fetch(`${encryptedBase}/api/providers`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Encrypted",baseUrl:"http://example.test/v1",apiKey:"super-secret-key",model:"test",setActive:true})});const encryptedWorkspace=await fetch(`${encryptedBase}/api/workspaces`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Encrypted scans",repoPath:repo})}).then((r)=>r.json());await fetch(`${encryptedBase}/api/scan-profiles`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workspaceId:encryptedWorkspace.workspace.id,name:"Sonar",hook:"manual",scanners:["sonarqube"],config:{sonarqube:{serverUrl:"https://sonar.example.test",projectKey:"x",token:"sonar-super-secret"}}})});
  const rawDb=new DatabaseSync(encryptedPath),raw=rawDb.prepare("SELECT api_key FROM providers").get().api_key,scanConfig=rawDb.prepare("SELECT config FROM scan_profiles").get().config;check("configured secret key encrypts credentials at rest",raw.startsWith("enc:v1:")&&!raw.includes("super-secret-key")&&scanConfig.includes("enc:v1:")&&!scanConfig.includes("sonar-super-secret"));
} finally {encryptedServer.close();await encrypted.worker.stop();delete process.env.LUCAPI_SECRET_KEY;}
console.log("\nHardening checks passed ✅\n");
