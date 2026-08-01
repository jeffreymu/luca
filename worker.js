import { existsSync } from "node:fs";
import { openDb, Store } from "./src/db.js";
import { Engine } from "./src/engine.js";
import { RealExecutionService } from "./src/real-execution.js";
import { DurableWorker } from "./src/job-worker.js";
import { providerFromRow, resolveProvider, SimulatedProvider } from "./src/providers.js";

const dbPath=process.env.LUCAPI_DB??process.env.LUCA_DB??(existsSync("luca.db")?"luca.db":"lucapi.db"),store=new Store(openDb(dbPath));
const providers=(providerId=null)=>{const row=providerId?store.getProvider(providerId):store.getActiveProvider();return row?{primary:providerFromRow(row),fallback:new SimulatedProvider(),mode:"llm",source:"db"}:resolveProvider();};
const broadcast=(event)=>{if(["FAILED","CANCELLED"].includes(event.status))console.error(JSON.stringify(event));};
const engine=new Engine(store,providers,broadcast,new RealExecutionService(store));
const worker=new DurableWorker({store,engine,broadcast,maxConcurrency:Number(process.env.LUCAPI_WORKER_CONCURRENCY??2)});
worker.start();console.log(`◆ LucaPi worker ${worker.workerId} started (${dbPath}, concurrency ${worker.maxConcurrency})`);
const shutdown=async()=>{const result=await worker.stop({drainMs:Number(process.env.LUCAPI_DRAIN_MS??30_000)});console.log(`◆ LucaPi worker stopped; drained=${result.drained}`);process.exit(result.drained?0:1);};
process.once("SIGTERM",shutdown);process.once("SIGINT",shutdown);
