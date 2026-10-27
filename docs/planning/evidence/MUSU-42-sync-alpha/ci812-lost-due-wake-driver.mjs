import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { writeFile,readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createFairWorkCoordinator } from '/home/flamendrin/workspace/musubi/packages/sync-runtime/src/fair-work.ts';
let mono=1000,armed=false,reads=0,completed=false;
const clockReads=[],scheduled=[];
const coordinator=createFairWorkCoordinator({capacity:1,
 nowMs(){if(armed){reads++;if(reads>=4)mono=1001;clockReads.push({read:reads,value:mono});}return mono;},
 schedule(run,delayMs){const entry={run,delayMs,cancelled:false};scheduled.push(entry);return()=>{entry.cancelled=true;};},
 host:{async candidates(){return {candidates:[]};},async execute(_candidate,permit){armed=true;await coordinator.park(permit,1001);completed=true;return{kind:'settled',changedCalendarIDs:[]};}}
});
try{
 const execution=coordinator.submit({key:'cold-account-preview',family:'pull',accountFairnessKey:'account-e',laneKey:'account',dueAtMs:1000,orderKey:'1',collisionKeys:[],hostRef:{}});
 for(let i=0;i<5;i++)await nextTurn();
 const stranded=coordinator.snapshot(); console.log(JSON.stringify({clockReads,stranded,scheduled:scheduled.map(x=>x.delayMs),completed}));
 assert.equal(mono,1001);assert.equal(completed,false);assert.equal(stranded.parked,1);assert.equal(stranded.pending,1);assert.equal(scheduled.length,0);
 coordinator.kick();assert.equal((await execution).kind,'settled');assert.equal(completed,true);for(let i=0;i<2;i++)await nextTurn();
 const source='/home/flamendrin/workspace/musubi/packages/sync-runtime/src/fair-work.ts';
 const report={schemaVersion:1,kind:'actual-production-fair-work-lost-due-wake-reproduction',status:'REPRODUCED',source,sourceSha256:createHash('sha256').update(await readFile(source)).digest('hex'),clockReads,strandedSnapshot:stranded,scheduledWakeupsAtStranding:0,completionBeforeExternalKick:false,completionAfterExternalKick:true,after:coordinator.snapshot(),ports:'Actual production createFairWorkCoordinator with explicit clock/schedule/host dependency ports; no scheduler logic copied.',realDatabase:false,liveProvider:false,productionDeployment:false};
 await writeFile('/tmp/musu42-ci812-lost-due-wake-proof.json',JSON.stringify(report,null,2)+'\n');process.stdout.write(JSON.stringify(report)+'\n');
}finally{coordinator.close();}
