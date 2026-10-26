import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
const active = new Set();
function groupExists(pid) { try { process.kill(-pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
function signalGroup(pid, signal) { if (!Number.isSafeInteger(pid) || pid <= 1 || !active.has(pid)) throw new Error("Unowned process group"); try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; } }
async function waitGone(pid, duration) { const until = Date.now() + duration; do { if (!groupExists(pid)) return true; await pause(20); } while (Date.now() < until); return !groupExists(pid); }
async function stop(pid, immediate = false) {
  signalGroup(pid, immediate ? "SIGKILL" : "SIGTERM"); if (!immediate && await waitGone(pid, 1000)) return true;
  signalGroup(pid, "SIGKILL"); return waitGone(pid, 2000);
}
export function installOwnedShutdown() {
  let interrupted = false;
  const onSignal = () => { interrupted = true; for (const pid of active) signalGroup(pid, "SIGKILL"); };
  process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
  return { get interrupted() { return interrupted; }, dispose() { process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal); } };
}
export function executeOwned(command, args, { cwd, env, timeoutMs, maximumOutputBytes = 4_000_000 }) {
  if (process.platform !== "linux") throw new Error("Owned conformance process groups require Linux");
  return new Promise(done => {
    const child = spawn(command, args, { cwd, env, detached: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid; if (pid) active.add(pid);
    let stdout = "", stderr = "", reason, stopping;
    const terminate = why => { if (reason) return; reason = why; if (pid) stopping = stop(pid).catch(() => false); };
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    const collect = channel => part => { if (reason) return; if (stdout.length + stderr.length + part.length > maximumOutputBytes) terminate("output-overflow"); else if (channel === "stdout") stdout += part; else stderr += part; };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr"));
    child.once("error", () => { clearTimeout(timer); if (pid) active.delete(pid); done({ exitCode: null, stdout: "", stderr: "child-start-failed", groupReaped: !pid, terminationReason: "start-failed" }); });
    child.once("close", async code => {
      clearTimeout(timer); let reaped = !pid;
      try {
        if (!pid) reaped = true;
        else if (stopping) reaped = await stopping;
        else if (await waitGone(pid, 2000)) reaped = true; // tsx/esbuild may finish its ordinary shutdown just after parent close.
        else { reason ??= "descendants-survived"; reaped = await stop(pid); }
      } catch { reaped = false; }
      if (pid) active.delete(pid);
      done({ exitCode: reason || !reaped ? null : code, stdout, stderr, groupReaped: reaped, ...(reason ? { terminationReason: reason } : {}) });
    });
  });
}
