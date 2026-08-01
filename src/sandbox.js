import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

function docker(args, timeout=120_000){return new Promise((resolve,reject)=>execFile("docker",args,{timeout,maxBuffer:4*1024*1024},(err,stdout,stderr)=>err?reject(new Error(String(stderr||err.message).trim())):resolve(String(stdout).trim())));}
export class DockerSandboxManager {
  async available(){try{await docker(["info","--format","{{.ServerVersion}}"],10_000);return true;}catch{return false;}}
  async create({repoPath,image="node:22-alpine",network=false,memory="1g",labels={}}){
    if(!repoPath)throw new Error("repoPath required");
    const id=`lucapi-${randomUUID().slice(0,8)}`;
    const args=["run","-d","--name",id,"--label","lucapi.sandbox=true",...Object.entries(labels).flatMap(([k,v])=>["--label",`lucapi.${k}=${v}`]),"--workdir","/workspace","--memory",memory,"--cpus","2","-v",`${repoPath}:/workspace`];
    if(!network)args.push("--network","none");args.push(image,"sh","-c","while true; do sleep 3600; done");
    const containerId=await docker(args);return{id,containerId,image,repoPath,network,memory,status:"running"};
  }
  async list(){const out=await docker(["ps","-a","--filter","label=lucapi.sandbox=true","--format","{{json .}}"]);return out?out.split("\n").map((l)=>JSON.parse(l)):[];}
  async inspect(id){return JSON.parse(await docker(["inspect",id]))[0];}
  async remove(id){await docker(["rm","-f",id]);return{ok:true};}
  async execute(id,{command,args=[]}){const stdout=await docker(["exec","--workdir","/workspace",id,command,...args]);return{exitCode:0,stdout};}
  async prune(){const containers=await this.list(),removed=[];for(const c of containers){if(c.State!=="running"){await this.remove(c.Names);removed.push(c.Names);}}return{removed};}
}
