import {test} from "node:test";
import assert from "node:assert/strict";
import {weeklyReview,reviewHTML,reviewText} from "../src/review.mjs";
import {alternativeHint} from "../src/alternative.mjs";
import {NOW,inHours,sandbox} from "./helpers.mjs";
import {writeStatusPage} from "../src/status-page.mjs";
import {snapshot} from "../src/providers.mjs";
import {recordReading} from "../src/store.mjs";
import {writeUsage} from "../src/usage.mjs";
import fs from "node:fs";

test("review distinguishes last-known remaining allowance, near-reset estimates, gaps and retained events",()=>{
 const end=NOW-1000;
 const pts=[[end-7*86400_000+12*3600_000,10],[end-2*3600_000,70]];
 const usage={windows:{},weeks:[{resetsAt:end/1000,pts}]};
 const rows=weeklyReview(usage,[{provider:"claude",kind:"pause",at:end-5000},{provider:"codex",kind:"pause",at:end-5000}],"claude",NOW);
 assert.equal(rows[0].remaining,30);assert.equal(rows[0].nearReset,false);assert.equal(rows[0].lateStart,true);assert.equal(rows[0].gaps,1);assert.equal(rows[0].interventions.pause,1);
 assert.match(reviewText(rows),/at last reading/);assert.doesNotMatch(reviewHTML(rows,"Claude"),/polyline/);
 usage.weeks[0].pts.push([end-60_000,72]);
 assert.equal(weeklyReview(usage,[],"claude",NOW)[0].nearReset,true);
 assert.match(reviewHTML(weeklyReview(usage,[],"claude",NOW),"<Agent>"),/&lt;Agent&gt;/);
});
const s=(provider,action="none",changes={})=>({provider,error:null,verdict:{action},ctx:{window:{five_hour:{usedPct:10,seenAt:NOW,resetsAt:inHours(3)},seven_day:{usedPct:40,seenAt:NOW,resetsAt:inHours(72)}}},...changes});
test("other-agent hints require a stopped agent and fresh, unpaused alternative with both windows",()=>{
 const stopped=s("claude","pause"),other=s("codex");
 assert.match(alternativeHint(stopped,[stopped,other],NOW),/Codex reports 90% 5-hour and 60% weekly/);
 assert.equal(alternativeHint(s("claude"),[other],NOW),null);
 for(const change of [{error:"offline"},{verdict:{action:"pause"}},{ctx:{window:{}}}])assert.equal(alternativeHint(stopped,[stopped,{...other,...change}],NOW),null);
 assert.equal(alternativeHint(stopped,[stopped,other],NOW+300001),null);
});
test("status artifact contains weekly chart and review detail from stored observations",async()=>{
 const {env}=sandbox();recordReading(env,{seven_day:{usedPct:30,seenAt:NOW,resetsAt:inHours(72)}});
 writeUsage(env,{v:1,windows:{seven_day:{resetsAt:inHours(72),pts:[[NOW-3600_000,20],[NOW,30]]}},weeks:[],blame:null});
 const file=writeStatusPage(env,[await snapshot(env,NOW)],NOW),html=fs.readFileSync(file,"utf8");
 assert.match(html,/id="weekly-review"/);assert.match(html,/<polyline/);assert.match(html,/70% remaining at last reading/);
});
