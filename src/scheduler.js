function fieldMatcher(source,min,max){
  if(source==="*")return()=>true;
  if(source.startsWith("*/")){const step=Number(source.slice(2));if(!Number.isInteger(step)||step<1)throw new Error(`Invalid cron step: ${source}`);return(v)=>(v-min)%step===0;}
  const values=new Set(source.split(",").flatMap((part)=>{const [a,b]=part.split("-").map(Number);if(Number.isInteger(b))return Array.from({length:b-a+1},(_,i)=>a+i);return[a];}));
  if([...values].some((v)=>!Number.isInteger(v)||v<min||v>max))throw new Error(`Cron field outside ${min}-${max}: ${source}`);return(v)=>values.has(v);
}
export function nextCronDate(expression,timezone="UTC",from=new Date()){
  const fields=String(expression).trim().split(/\s+/);if(fields.length!==5)throw new Error("Cron expression must contain 5 fields");
  const match=[fieldMatcher(fields[0],0,59),fieldMatcher(fields[1],0,23),fieldMatcher(fields[2],1,31),fieldMatcher(fields[3],1,12),fieldMatcher(fields[4],0,6)];
  const fmt=new Intl.DateTimeFormat("en-US",{timeZone:timezone,minute:"numeric",hour:"numeric",hourCycle:"h23",day:"numeric",month:"numeric",weekday:"short"}),week={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  const candidate=new Date(from);candidate.setUTCSeconds(0,0);candidate.setUTCMinutes(candidate.getUTCMinutes()+1);
  for(let i=0;i<527040;i++,candidate.setUTCMinutes(candidate.getUTCMinutes()+1)){
    const p=Object.fromEntries(fmt.formatToParts(candidate).filter((x)=>x.type!=="literal").map((x)=>[x.type,x.value])),values=[Number(p.minute),Number(p.hour),Number(p.day),Number(p.month),week[p.weekday]];
    if(match.every((fn,index)=>fn(values[index])))return new Date(candidate);
  }
  throw new Error("Cron expression has no occurrence in the next year");
}
