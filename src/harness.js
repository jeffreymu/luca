import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

async function exists(p){try{await access(p);return true;}catch{return false;}}
async function files(dir,suffix=""){try{return (await readdir(dir)).filter((f)=>!suffix||f.endsWith(suffix));}catch{return[];}}
export async function inspectHarness(repoPath){
  let scripts={};try{scripts=JSON.parse(await readFile(path.join(repoPath,"package.json"),"utf8")).scripts??{};}catch{}
  const workflows=await files(path.join(repoPath,".github","workflows"),".yml");
  const workflowsYaml=await files(path.join(repoPath,".github","workflows"),".yaml");
  const codeownersCandidates=["CODEOWNERS",".github/CODEOWNERS","docs/CODEOWNERS"],codeowners=codeownersCandidates.find((p)=>false)||null;
  let codeownersPath=null;for(const p of codeownersCandidates)if(await exists(path.join(repoPath,p))){codeownersPath=p;break;}
  const instructions=[];for(const p of ["AGENTS.md","CLAUDE.md","CONTRIBUTING.md","README.md"])if(await exists(path.join(repoPath,p)))instructions.push(p);
  const adrs=(await files(path.join(repoPath,"docs","adr"),".md")).map((f)=>`docs/adr/${f}`);
  const validationCommands=[];if(scripts.test)validationCommands.push("npm test");if(scripts.lint)validationCommands.push("npm run lint");if(scripts.typecheck)validationCommands.push("npm run typecheck");if(await exists(path.join(repoPath,"Cargo.toml")))validationCommands.push("cargo test");
  const signals={packageScripts:scripts,validationCommands,githubActions:[...workflows,...workflowsYaml],codeowners:codeownersPath,instructions,designDecisions:adrs};
  const checks=[validationCommands.length>0,signals.githubActions.length>0,Boolean(codeownersPath),instructions.length>0,adrs.length>0];
  return {...signals,score:Math.round(checks.filter(Boolean).length/checks.length*100),checks:{validation:Boolean(checks[0]),ci:Boolean(checks[1]),ownership:Boolean(checks[2]),instructions:Boolean(checks[3]),adrs:Boolean(checks[4])}};
}
