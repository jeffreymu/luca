import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./git.js";

async function walk(root, dir, files, limit=1000) {
  for(const e of await readdir(dir,{withFileTypes:true})) {
    if(files.length>=limit || [".git","node_modules","target",".next",".lucapi"].includes(e.name)) continue;
    const p=path.join(dir,e.name); if(e.isDirectory()) await walk(root,p,files,limit); else files.push(path.relative(root,p));
  }
}
export async function analyzeRepository(repoPath) {
  const files=[]; await walk(repoPath,repoPath,files);
  let packageInfo=null;
  try { const pkg=JSON.parse(await readFile(path.join(repoPath,"package.json"),"utf8")); packageInfo={name:pkg.name,scripts:pkg.scripts??{},dependencies:Object.keys(pkg.dependencies??{})}; } catch {}
  const extensions={}; for(const f of files){const ext=path.extname(f)||"(none)";extensions[ext]=(extensions[ext]||0)+1;}
  let commits=[]; try { commits=(await runGit(["log","-10","--format=%h|%s|%an|%aI"],repoPath)).stdout.trim().split("\n").filter(Boolean).map((l)=>{const [hash,subject,author,date]=l.split("|");return{hash,subject,author,date};}); } catch {}
  return {repoPath,fileCount:files.length,files,extensions,package:packageInfo,recentCommits:commits};
}
