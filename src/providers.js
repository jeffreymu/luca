/** LucaPi LLM provider abstraction with OpenAI-compatible capability diagnostics. */

export class SimulatedProvider {
  constructor() { this.name = "simulated"; this.available = true; }
  async complete() { throw new Error("SimulatedProvider does not serve raw completions; specialists simulate directly."); }
}

function abortContext(timeoutMs, externalSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Provider timeout after ${timeoutMs}ms`)), timeoutMs);
  const abort = () => controller.abort(externalSignal?.reason ?? new Error("Provider request cancelled"));
  if (externalSignal) {
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener("abort", abort, { once: true });
  }
  return { signal: controller.signal, cleanup() { clearTimeout(timer); externalSignal?.removeEventListener("abort", abort); } };
}

function parseJsonContent(text) {
  if (!text) throw new Error("LLM returned empty content");
  try { return JSON.parse(text); } catch {}
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) { try { return JSON.parse(fenced); } catch {} }
  const start=String(text).indexOf("{"),end=String(text).lastIndexOf("}");
  if(start>=0&&end>start) return JSON.parse(String(text).slice(start,end+1));
  throw new Error("LLM response does not contain valid JSON");
}

export class OpenAIProvider {
  constructor({ baseUrl, apiKey, model, label }) {
    this.label = label;
    this.baseUrl = (baseUrl ?? "").replace(/\/$/, "");
    this.apiKey = apiKey ?? "";
    this.model = model ?? "";
    this.available = Boolean(this.baseUrl && this.model);
  }
  get name() { return this.label ? `${this.label} (${this.model})` : `openai:${this.model}`; }

  async request(body, { timeoutMs=120_000, signal }={}) {
    const abort=abortContext(timeoutMs,signal);
    try {
      const res=await fetch(`${this.baseUrl}/chat/completions`,{method:"POST",headers:{"content-type":"application/json",...(this.apiKey?{authorization:`Bearer ${this.apiKey}`}:{})},body:JSON.stringify(body),signal:abort.signal});
      const text=await res.text();
      if(!res.ok){const error=new Error(`LLM HTTP ${res.status}: ${text.slice(0,300)}`);error.status=res.status;throw error;}
      let parsed;try{parsed=JSON.parse(text);}catch{throw new Error("LLM returned invalid response JSON");}
      const message=parsed.choices?.[0]?.message;if(!message)throw new Error("LLM returned no message");return message;
    } finally { abort.cleanup(); }
  }

  async chat({ messages, tools, toolChoice = "auto", timeoutMs = 120_000, signal }) {
    return this.request({model:this.model,temperature:0.1,messages,tools,tool_choice:tools?.length?toolChoice:undefined},{timeoutMs,signal});
  }

  async complete({ system, user, timeoutMs = 60_000, signal }) {
    const base={model:this.model,temperature:0.2,messages:[{role:"system",content:system},{role:"user",content:user}]};
    let message;
    try { message=await this.request({...base,response_format:{type:"json_object"}},{timeoutMs,signal}); }
    catch(err) {
      if(![400,404,422].includes(err.status)) throw err;
      message=await this.request(base,{timeoutMs,signal});
    }
    return parseJsonContent(message.content);
  }
}

export function providerFromRow(row) { return new OpenAIProvider({baseUrl:row.base_url,apiKey:row.api_key,model:row.model,label:row.name}); }
export function maskApiKey(key) { if(!key)return "";if(key.length<=8)return key.slice(0,2)+"…";return `${key.slice(0,4)}…${key.slice(-4)}`; }

export async function testProvider(provider, timeoutMs = 10_000) {
  const started=Date.now(),abort=abortContext(timeoutMs);
  try {
    const res=await fetch(`${provider.baseUrl}/models`,{headers:provider.apiKey?{authorization:`Bearer ${provider.apiKey}`}:{},signal:abort.signal});
    const latencyMs=Date.now()-started;
    if(!res.ok)return{ok:false,latencyMs,detail:`HTTP ${res.status}: ${(await res.text()).slice(0,200)}`};
    const body=await res.json(),models=(body.data??[]).map((m)=>m.id).slice(0,5),modelFound=(body.data??[]).some((m)=>m.id===provider.model);
    return{ok:true,latencyMs,detail:modelFound?`连接成功，模型 ${provider.model} 可用。`:`连接成功，但模型列表中未找到 ${provider.model}。可用示例: ${models.join(", ")||"(空)"}`,modelFound,sampleModels:models};
  } catch(err){return{ok:false,latencyMs:Date.now()-started,detail:err.message};} finally {abort.cleanup();}
}

export async function diagnoseProvider(provider) {
  const models=await testProvider(provider);
  const checks={models};
  try {
    const message=await provider.chat({messages:[{role:"user",content:"Call the capability_probe tool exactly once."}],tools:[{type:"function",function:{name:"capability_probe",description:"Provider compatibility probe",parameters:{type:"object",properties:{ok:{type:"boolean"}},required:["ok"]}}}],timeoutMs:30_000});
    checks.toolCalling={ok:Boolean(message.tool_calls?.[0]?.function?.name==="capability_probe"),detail:message.tool_calls?.length?"Tool call returned":"No tool call returned"};
  } catch(err){checks.toolCalling={ok:false,detail:err.message};}
  try {const value=await provider.complete({system:"Return JSON only.",user:'Return {"ok":true}.',timeoutMs:30_000});checks.structuredJson={ok:typeof value==="object"&&value!==null,detail:"Structured JSON parsed"};}
  catch(err){checks.structuredJson={ok:false,detail:err.message};}
  return{ok:Object.values(checks).every((c)=>c.ok),provider:provider.name,checks};
}

export function resolveProvider(env = process.env) {
  const llm=new OpenAIProvider({baseUrl:env.LUCAPI_LLM_BASE_URL??env.LUCA_LLM_BASE_URL??"",apiKey:env.LUCAPI_LLM_API_KEY??env.LUCA_LLM_API_KEY??"",model:env.LUCAPI_LLM_MODEL??env.LUCA_LLM_MODEL??""});
  if(llm.available)return{primary:llm,fallback:new SimulatedProvider(),mode:"llm",source:"env"};
  return{primary:new SimulatedProvider(),fallback:null,mode:"simulated",source:"simulated"};
}
