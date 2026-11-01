import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWalletConfig } from '../lib/wallet-model.mjs';
import * as readiness from '../lib/wallet-readiness.mjs';

const A = '0x'+'1'.repeat(40), B = '0x'+'2'.repeat(40);
const profiles = [{id:'wallet-a',name:'A',address:A,mode:'auto'},{id:'wallet-b',name:'B',address:B,mode:'auto'}];

test('public availability rejects stale readiness and never exposes persisted arbitrary reason text',()=>{
  const now=1_900_000_000_000,ready={ready:true,code:'READY',reason:'sessionId=not-public',checkedAt:now-1,expiresAt:now+60000};
  assert.deepEqual(Object.keys(readiness.publicWalletAvailability(ready,{now})),['ready','code','reason','checkedAt']);
  assert.equal(JSON.stringify(readiness.publicWalletAvailability(ready,{now})).includes('not-public'),false);
  assert.equal(readiness.publicWalletAvailability({...ready,expiresAt:now},{now}).code,'DEV_MODE_EXPIRED');
  assert.equal(readiness.publicWalletAvailability({...ready,checkedAt:now-60001},{now}).ready,false);
  assert.equal(readiness.publicWalletAvailability({...ready,code:'arbitrary',reason:'not-public'},{now}).ready,false);
});

test('ambiguous BSC address lists never become runnable even when the first entry matches',()=>{
  const wallet={...profiles[0]},now=Date.now(),session={status:'CONNECTED',address:A,settings:{devMode:{enabled:true,expiresAt:now+3600000}}};
  for(const addresses of[[],{},[{binanceChainId:'56',address:B}],[{binanceChainId:'56',address:A},{binanceChainId:56,address:B}]])assert.equal(readiness.assessWalletReadiness(wallet,{...session,addresses},{now}).ready,false);
  assert.equal(readiness.assessWalletReadiness(wallet,{...session,addresses:[{binanceChainId:'56',address:A}]},{now}).ready,true);
});

async function localStart({monitorOnly=false,web=false,wallets=profiles,offline=new Set(),settingsFailure=new Set()}={}){
  const source=readFileSync(new URL('../local-service.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('import.meta.url',JSON.stringify('file:///isolated/local-service.mjs'));
  const config={monitorOnly,wallets},files=new Map([['/isolated/config.json',JSON.stringify(config)]]),commands=[],cli=[],messages=[]; let pid=null;
  const sandbox={...readiness,normalizeWalletConfig,dirname,join,fileURLToPath,
    assertWalletMaintenanceIdle(){},
    runWallet:async(args,options)=>{
      cli.push({args,options});assert.equal(args[0],'wallet');
      if(args[1]==='status')return{success:true,data:{status:offline.has(options.walletId)?'UNCONNECTED':'CONNECTED'}};
      if(args[1]==='address')return{success:true,data:{addresses:[{binanceChainId:'56',address:wallets.find(w=>w.id===options.walletId).address}]}};
      if(args[1]==='settings')return settingsFailure.has(options.walletId)?{success:false,error:{message:'sensitive-not-public'}}:{success:true,data:{devMode:{enabled:true,expiresAt:Date.now()+3600000}}};
      assert.fail('Unexpected wallet command');
    },
    process:{execPath:'/mock/node',argv:['/mock/node','/isolated/local-service.mjs','start',...(web?['web']:[])],env:{},on(){},kill(value){assert.equal(value,pid);}},
    spawnSync:(cmd,args)=>{commands.push({cmd,args});return cmd==='/bin/ps'?{status:0,stdout:'/mock/node /isolated/local-service.mjs run'+(web?' web':'')}:{status:0};},
    spawn:(cmd,args)=>{commands.push({cmd,args,spawn:true});pid=12345;return{pid,once(event,callback){if(event==='spawn')queueMicrotask(callback);return this;},unref(){}};},
    existsSync:path=>files.has(path),mkdirSync(){},readFileSync:path=>{if(!files.has(path))throw Error('No in-memory file');return files.get(path);},writeFileSync:(path,value)=>files.set(path,String(value)),rmSync:path=>files.delete(path),
    openSync:()=>1,closeSync(){},statSync:()=>({mtimeMs:Date.now()}),setTimeout:callback=>{queueMicrotask(callback);return 1;},
    console:{log:value=>messages.push(String(value)),error:value=>messages.push(String(value))},
  };
  const result=vm.runInNewContext('(async()=>{'+source+'})()',sandbox,{timeout:1000});
  try{await result;return{commands,cli,messages,config};}catch(error){return{commands,cli,messages,config,error};}
}

test('local scanner start admits an online wallet and reports its offline peer without editing configuration',async()=>{
  const original=JSON.stringify(profiles),result=await localStart({offline:new Set(['wallet-b'])});
  assert.equal(result.error,undefined);assert.equal(result.commands.filter(c=>c.spawn).length,1);assert.ok(result.messages.some(line=>line.includes('[B]')&&line.includes('未连接')));assert.equal(JSON.stringify(profiles),original);
  assert.equal(result.cli.some(c=>c.args[0]!=='wallet'),false);
});

test('all offline or permission-unverifiable local scanner starts stop before spawning',async()=>{
  for(const options of[{offline:new Set(['wallet-a','wallet-b'])},{settingsFailure:new Set(['wallet-a','wallet-b'])}]){
    const result=await localStart(options);assert.equal(result.error.code,'NO_READY_WALLETS');assert.equal(result.commands.filter(c=>c.spawn).length,0);assert.equal(String(result.error).includes('sensitive-not-public'),false);
  }
});

test('monitor and Web startup do not require any wallet login, including an empty automatic wallet configuration',async()=>{
  for(const options of[{monitorOnly:true,wallets:[]},{web:true,wallets:[]}]){
    const result=await localStart(options);assert.equal(result.error,undefined);assert.equal(result.cli.length,0);assert.equal(result.commands.filter(c=>c.spawn).length,1);
  }
});
