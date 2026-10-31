import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'
const require = createRequire(import.meta.url)
const load = file => require(path.join(process.env.MRS_TEST_DIST || path.resolve('dist'), file))
const { default: ReactFunc } = load('browser/ReactFunc.js')
const { mergeRenderedEarn } = load('browser/parsers/RenderedEarn.js')
const { verifyOffer } = load('functions/activities/api/OfferVerification.js')
const { UrlReward } = load('functions/activities/api/UrlReward.js')
const { default: BrowserFunc } = load('browser/BrowserFunc.js')
const { pointValue, pointDelta, creditedPoints } = load('util/PointAccounting.js')
const logger = Object.fromEntries(['info','debug','warn','error'].map(k=>[k,()=>{}]))
const flight = object => `<script>self.__next_f.push([1,${JSON.stringify('1:'+JSON.stringify(object))}])</script>`
test('upstream point arithmetic rejects missing, negative and decreasing observations',()=>{
 for(const value of [null,undefined,'',false,{},-1,NaN]) assert.equal(pointValue(value),null)
 assert.equal(pointDelta(100,95),null)
 assert.equal(creditedPoints(5,100,110),5)
 assert.equal(creditedPoints(0,100,110),null)
 assert.equal(creditedPoints(5,100,103),null)
})
test('streak expiry and numeric values are parsed without fabricating a daily counter',()=>{
 const parser=new ReactFunc({logger})
 const streak={partner:'bing',dailyPoints:[1,2],completedDays:'2',totalDays:'7',activitiesCompleted:'1',activitiesTotal:'1',isCurrentDayCompleted:true}
 let snapshot=parser.snapshotPage(flight({expiresAt:'$D2000-01-01T00:00:00Z',streak}))
 assert.equal(snapshot.streaks.length,0)
 snapshot=parser.snapshotPage(flight({expiresAt:'$D2099-01-01T00:00:00Z',streak}))
 assert.equal(snapshot.streaks[0].completedDays,2)
 assert.equal(snapshot.streaks[0].resetAt,'2099-01-01T00:00:00.000Z')
 assert.equal(snapshot.dailyStreak,null)
 assert.equal(parser.snapshotPage(flight({streakCounter:0})).dailyStreak,0)
})
test('rendered cards require unique identity and never fabricate signed hashes',()=>{
 const offer={offerId:'a',title:'Task',destination:'https://bing.com/search?q=test',points:5,reportable:true,isCompleted:false,isLocked:false}
 const snapshot={offers:[offer],reportable:[offer]}
 const card={index:0,parentControlIndex:null,visible:true,title:'Task',offerIds:['a'],points:5,complete:true,disabled:false}
 assert.equal(mergeRenderedEarn(snapshot,[card],'https://rewards.bing.com/earn'),0)
 assert.equal(offer.isCompleted,true);assert.equal(offer.reportable,false);assert.equal(offer.hash,undefined)
 assert.equal(mergeRenderedEarn(snapshot,[{...card,offerIds:[],title:'Unmatched',complete:false}],'https://rewards.bing.com/earn'),1)
 assert.equal(snapshot.offers.length,1)
})
for(const scenario of ['delayed','unrelated-credit','missing','decreasing']) test(`offer verification: ${scenario}`,async()=>{
 let reads=0
 const before={offerId:'a',points:5,pointProgress:0}
 const bot={logger,utils:{wait:async()=>{}},browser:{func:{refreshEarnSnapshot:async()=>{
  reads++
  if(scenario==='missing')return null
  return {account:{availablePoints:scenario==='decreasing'?90:105},offers:[{...before,isCompleted:scenario!=='delayed'||reads>1,pointProgress:scenario==='unrelated-credit'?0:scenario==='delayed'&&reads===1?0:5}]}
 }}}}
 const result=await verifyOffer(bot,before,100,null)
 assert.equal(result.complete,scenario!=='missing')
 assert.equal(result.gained,scenario==='delayed'?5:null)
 assert.ok(reads<=3)
})
test('unacknowledged URL actions do not count unrelated balance changes as earned points',async()=>{
 let checks=0
 const bot={logger,nextActions:{reportActivity:'synthetic'},config:{skipNonPointTasks:true},userData:{currentPoints:100,gainedPoints:0},nextRouterStateTree:'synthetic',refreshCurrentRewardsContext:async()=>false,browser:{func:{ensureOffer:async()=>({offerId:'a',reportable:true,hash:'synthetic',points:5}),reportServerAction:async()=>({acknowledged:false,status:200,availablePoints:500}),refreshEarnSnapshot:async()=>{checks++;return null}}}}
 await new UrlReward(bot).doUrlReward({offerId:'a'})
 assert.equal(bot.userData.gainedPoints,0);assert.equal(checks,0)
})
test('stale bootstrap balance is never returned as a fresh balance',async()=>{
 const func=Object.create(BrowserFunc.prototype)
 Object.assign(func,{bot:{logger,reactSnapshot:{account:{availablePoints:999}}},getDashboardData:async()=>{throw Error('offline')},refreshEarnSnapshot:async()=>null,getActivePage:()=>null,cachedBalance:()=>null})
 assert.equal(await func.getCurrentPoints(),null)
})
test('v5 rendered Earn and Quest parsers read actual DOM, skip hidden/locked cards and retain task progress',async()=>{
 const {chromium}=require('patchright')
 const {readEarnPage}=load('browser/parsers/EarnPageParser.js')
 const {readPunchCardParents,readPunchCardPage}=load('browser/parsers/PunchCardPageParser.js')
 const browser=await chromium.launch({headless:true})
 try{
  const page=await browser.newPage()
  await page.route('https://rewards.bing.com/**',route=>route.fulfill({contentType:'text/html',body:`<main>
  <section id="moreactivities"><a href="https://bing.com/search?offerid=earn-a" data-offerid="earn-a"><h3>Earn task</h3><div class="rounded-cornerCircular"><p class="text-metadata">+5</p></div></a></section>
  <section id="quests"><a href="/earn/quest/test-quest"><h3>Test quest</h3><span>2/5 tasks</span><div class="rounded-cornerCircular"><p>+50</p></div></a><a style="display:none" href="/earn/quest/hidden"><h3>Hidden</h3></a></section>
  <div><div><h3>Locked step</h3><p>Search for 5 days</p><button disabled>Start searching</button></div></div>
  </main>`}))
  await page.goto('https://rewards.bing.com/earn')
  const earn=await readEarnPage(page);assert.equal(earn.cards.length,1);assert.equal(earn.cards[0].offerId,'earn-a')
  const parents=await readPunchCardParents(page);assert.equal(parents.length,1);assert.equal(parents[0].completedTasks,2);assert.equal(parents[0].totalTasks,5)
  const quest=await readPunchCardPage(page);assert.equal(quest.steps.find(s=>s.title==='Locked step').disabled,true)
 }finally{await browser.close()}
})

test('rendered fallback closes its temporary tab after redirects, read failures and successful reads', async () => {
    for (const outcome of ['redirect','failure','success']) {
        let closed=0
        const context={identity:'existing-account'}
        const tab={goto:async()=>{},url:()=>outcome==='redirect'?'https://login.live.com/':'https://rewards.bing.com/earn',locator:()=>({waitFor:async()=>{},first(){return this}}),close:async()=>{closed++}}
        const func=Object.create(BrowserFunc.prototype)
        Object.assign(func,{getActivePage:()=>({isClosed:()=>false,context:()=>context}),bot:{logger,newBrowserPage:async received=>{assert.equal(received,context);return tab}}})
        const value=await func.withRewardsPage('https://rewards.bing.com/earn',async()=>{if(outcome==='failure')throw Error('read failed');return 'verified'})
        assert.equal(value,outcome==='success'?'verified':null)
        assert.equal(closed,1)
    }
})

test('offer verification uses a fresh dashboard balance when Flight omits account balance', async () => {
    let balanceReads=0
    const before={offerId:'a',points:5,pointProgress:0}
    const bot={logger,utils:{wait:async()=>{}},browser:{func:{refreshEarnSnapshot:async()=>({account:{availablePoints:null},offers:[{...before,isCompleted:true,pointProgress:5}]}),getCurrentPoints:async()=>{balanceReads++;return 105}}}}
    const result=await verifyOffer(bot,before,100,null)
    assert.deepEqual(result,{complete:true,gained:5,balance:105})
    assert.equal(balanceReads,1)
})

test('rendered Earn discovery reaches cards loaded only after scrolling below the viewport', async () => {
    const {chromium}=require('patchright')
    const {readEarnPage}=load('browser/parsers/EarnPageParser.js')
    const browser=await chromium.launch({headless:true})
    try {
        const page=await browser.newPage({viewport:{width:1000,height:600}})
        await page.setContent(`<main><div style="height:2000px">Streaks</div><section id="moreactivities" style="min-height:200px">Loading</section></main><script>
        addEventListener('scroll',()=>{const section=document.querySelector('#moreactivities');if(section.getBoundingClientRect().top<innerHeight)section.innerHTML='<a href="https://bing.com/search?offerid=lazy"><h3>Lazy task</h3><div class="rounded-cornerCircular"><p class="text-metadata">+5</p></div></a>'});
        </script>`)
        assert.equal(await page.locator('#moreactivities a').count(),0)
        const result=await readEarnPage(page)
        assert.equal(result.cards.length,1)
        assert.equal(result.cards[0].offerId,'lazy')
    } finally { await browser.close() }
})
