import assert from "node:assert/strict";
import test from "node:test";
import { executeOwned } from "./process-group.mjs";
function assertGone(pid) { assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH"); }
test("owned descendant timeout exits the whole group before returning failed execution", async () => {
  const worker = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({parent:process.pid,child:child.pid})); process.on('SIGTERM',()=>{child.kill('SIGKILL');child.once('exit',()=>process.exit(0));}); setInterval(()=>{},1000);`;
  const result = await executeOwned(process.execPath, ["-e", worker], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 500 });
  assert.equal(result.exitCode, null); assert.equal(result.terminationReason, "timeout"); assert.equal(result.groupReaped, true);
  const pids = JSON.parse(result.stdout.trim()); assertGone(pids.parent); assertGone(pids.child);
});
test("owned output overflow terminates descendants and is never a successful exit", async () => {
  const worker = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.on('SIGTERM',()=>{child.kill('SIGKILL');child.once('exit',()=>process.exit(0));});setInterval(()=>console.log('x'.repeat(1024)),1);`;
  const result = await executeOwned(process.execPath, ["-e", worker], { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 2000, maximumOutputBytes: 2048 });
  assert.equal(result.exitCode, null); assert.equal(result.terminationReason, "output-overflow"); assert.equal(result.groupReaped, true);
});
