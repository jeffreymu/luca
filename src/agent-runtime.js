import { access, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { runGit } from "./git.js";

const TOOL_DEFS = [
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 file from the task worktree", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a UTF-8 file in the task worktree", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "list_files", description: "List files recursively under a directory", parameters: { type: "object", properties: { path: { type: "string" } } } } },
  { type: "function", function: { name: "search_files", description: "Search text in project files", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
  { type: "function", function: { name: "run_command", description: "Run an allowed command without a shell", parameters: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } } }, required: ["command"] } } },
  { type: "function", function: { name: "git_status", description: "Inspect git status", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "git_diff", description: "Inspect current git diff", parameters: { type: "object", properties: {} } } },
];

function lexicallySafePath(root, relative = ".") {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Path escapes worktree");
  return target;
}

async function safeExistingPath(root, relative = ".") {
  const target = lexicallySafePath(root, relative);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) throw new Error("Symlink escapes worktree");
  return realTarget;
}

async function safeWritePath(root, relative) {
  const target = lexicallySafePath(root, relative);
  const realRoot = await realpath(root);
  let ancestor = path.dirname(target);
  while (ancestor !== root) {
    try { await access(ancestor); break; } catch { ancestor = path.dirname(ancestor); }
  }
  const realAncestor = await realpath(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) throw new Error("Symlink escapes worktree");
  return target;
}

function exec(command, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} failed (${err.code ?? 1}): ${String(stderr || err.message).slice(-4000)}`));
      else resolve({ stdout: String(stdout).slice(-20_000), stderr: String(stderr).slice(-20_000), exitCode: 0 });
    });
  });
}

async function walk(root, dir, acc, limit = 500) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (acc.length >= limit || [".git", "node_modules", "target", ".next"].includes(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, absolute, acc, limit);
    else acc.push(path.relative(root, absolute));
  }
}

export class ToolExecutor {
  constructor({ root, policy = {} }) {
    this.root = path.resolve(root);
    this.policy = {
      allowedCommands: ["node", "npm", "npx", "git", "cargo", "python", "python3", "pytest", "go", "make"],
      timeoutMs: 120_000,
      ...policy,
    };
  }

  async execute(name, args = {}) {
    if (name === "read_file") return { content: (await readFile(await safeExistingPath(this.root, args.path), "utf8")).slice(0, 100_000) };
    if (name === "write_file") {
      const target = await safeWritePath(this.root, args.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, args.content, "utf8"); return { written: args.path, bytes: Buffer.byteLength(args.content) };
    }
    if (name === "list_files") { const files=[]; await walk(this.root, await safeExistingPath(this.root,args.path||"."),files); return { files }; }
    if (name === "search_files") {
      const files=[]; await walk(this.root,this.root,files,300); const matches=[];
      for (const file of files) { try { const text=await readFile(path.join(this.root,file),"utf8"); text.split("\n").forEach((line,i)=>{ if(matches.length<100 && line.includes(args.query)) matches.push({file,line:i+1,text:line.slice(0,300)}); }); } catch {} }
      return { matches };
    }
    if (name === "run_command") {
      if (!this.policy.allowedCommands.includes(args.command)) throw new Error(`Command not allowed: ${args.command}`);
      const commandArgs=(args.args ?? []).map(String);
      if(this.policy.allowOutsidePaths!==true && commandArgs.some((arg)=>path.isAbsolute(arg)||arg.includes("../")||arg.includes("=/"))) throw new Error("Command argument may escape worktree");
      if(this.policy.containerId) return exec("docker",["exec","--workdir","/workspace",this.policy.containerId,args.command,...commandArgs],this.root,this.policy.timeoutMs);
      return exec(args.command, commandArgs, this.root, this.policy.timeoutMs);
    }
    if (name === "git_status") return { status: (await runGit(["status", "--short", "--branch"], this.root)).stdout };
    if (name === "git_diff") return { diff: (await runGit(["diff", "--no-ext-diff"], this.root)).stdout.slice(0,100_000) };
    throw new Error(`Unknown tool: ${name}`);
  }
}

export class CodingAgentRuntime {
  constructor(provider) { this.provider = provider; }

  async run({ worktreePath, card, story, brief, policy, maxTurns = 30, onEvent = () => {}, shouldCancel = () => false }) {
    if (!this.provider?.chat) throw new Error("Active provider does not support tool-calling runtime");
    const executor = new ToolExecutor({ root: worktreePath, policy });
    const messages = [
      { role: "system", content: "You are LucaPi Coding Agent. Implement the requested card in the provided worktree. Inspect existing code before editing. Use tools for every file and command operation. Stay in scope. Run available tests. Do not claim success without real tool evidence. Finish with a concise summary." },
      { role: "user", content: `CARD: ${card.title}\nOBJECTIVE: ${card.objective}\nSTORY: ${JSON.stringify(story)}\nBRIEF: ${JSON.stringify(brief)}` },
    ];
    const toolCalls = [];
    for (let turn=0; turn<maxTurns; turn++) {
      if (shouldCancel()) throw new Error("Session cancelled by operator");
      const message = await this.provider.chat({ messages, tools: TOOL_DEFS });
      messages.push(message);
      if (!message.tool_calls?.length) return { summary: message.content || "Agent finished", toolCalls, turns: turn+1 };
      for (const call of message.tool_calls) {
        let args={}; try { args=JSON.parse(call.function.arguments||"{}"); } catch {}
        const record={tool:call.function.name,args,ok:false}; onEvent({type:"tool_start",...record});
        try { record.result=await executor.execute(call.function.name,args); record.ok=true; }
        catch(err) { record.error=err.message; }
        toolCalls.push(record); onEvent({type:"tool_end",...record});
        messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(record.ok?record.result:{error:record.error})});
      }
    }
    throw new Error(`Coding agent exceeded ${maxTurns} turns`);
  }
}
