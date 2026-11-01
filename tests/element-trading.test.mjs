import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Wallet, TypedDataEncoder, Signature } from 'ethers';
import { createElementTrading, ELEMENT_EX, ELEMENT_INTERFACE, NFT_INTERFACE, WBNB, NATIVE_TOKEN, ZERO_ADDRESS, elementTypedData, packElementExpiry, unpackElementExpiry, decodeElementOfferTransaction } from '../lib/element-trading.mjs';

// Public deterministic test keys, used only for synthetic offline fixtures.
const maker = new Wallet('0x' + '1'.padStart(64,'0'));
const seller = new Wallet('0x' + '2'.padStart(64,'0'));
const nft = '0x4444444444444444444444444444444444444444';
const feeRecipient = '0x5555555555555555555555555555555555555555';
const now = 1_800_000_000_000, seconds = now / 1000;
const rule = { walletAddress:seller.address.toLowerCase(),addr:nft,standard:'ERC721',tokenId:'123',quantity:'1',mode:'fixed-listing',listingUnitPriceBnb:'1',maxFeesBnb:'0.1',minNetBnb:'0.5',expirySec:86400 };
const token = new Interface(['function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)']);
const response = data => new Response(JSON.stringify({code:0,data}),{headers:{'content-type':'application/json'}});
const position = (r = rule) => ({walletAddress:r.walletAddress,addr:r.addr,standard:r.standard,tokenId:r.tokenId,quantity:r.quantity,verifiedOwnership:true,verifiedAt:now,approved:true});

function environment({approved=true,owned=true,chainId='0x38',feePoints=200,postTransform=x=>x,offers=[],trade=null,fetchOverride=null,rpcOverride=null}={}) {
  const requests=[],rpcCalls=[];
  const fetchImpl=async(url,opts)=>{
    requests.push({url,opts}); assert.equal(new URL(url).origin,'https://api.element.market'); assert.equal(opts.headers['X-Api-Key'],'test-key'); assert.equal(opts.redirect,'error');
    const path=new URL(url).pathname;
    if(fetchOverride) {const result=await fetchOverride(url,opts);if(result)return result;}
    if(path.endsWith('/collection/fee')) return response({feeList:[{contractAddress:nft,protocolFeePoints:feePoints,protocolFeeAddress:feeRecipient,royaltyFeePoints:0,royaltyFeeAddress:ZERO_ADDRESS}]});
    if(path.endsWith('/orders/nonce')) return response({nonce:'7'});
    if(path.endsWith('/orders/confData')) return response({oracleSignature:1});
    if(path.endsWith('/orders/list')) return response({orders:offers});
    if(path.endsWith('/orders/encodeTradeDataByOrderId')) return response({...trade,flags:[true]});
    if(path.endsWith('/orders/post')) {const p=JSON.parse(opts.body);return response(postTransform({...p,orderId:'order-1',assetContract:p.metadata.asset.address,assetTokenId:p.metadata.asset.id,schema:p.metadata.schema}));}
    assert.fail('Unexpected API endpoint '+path);
  };
  const rpc=async(method,params)=>{
    rpcCalls.push({method,params}); assert.ok(['eth_chainId','eth_call','eth_estimateGas','eth_gasPrice','eth_blockNumber','eth_getLogs'].includes(method),'No write RPC permitted');
    if(rpcOverride) {const result=await rpcOverride(method,params);if(result!==undefined)return result;}
    if(method==='eth_chainId')return chainId;
    if(method==='eth_estimateGas')return '0x186a0';
    if(method==='eth_gasPrice')return '0x3b9aca00';
    const tx=params[0],to=tx.to.toLowerCase();
    if(to===nft) {
      const decoded=NFT_INTERFACE.parseTransaction({data:tx.data}); const name=decoded.name;
      if(name==='ownerOf')return NFT_INTERFACE.encodeFunctionResult(name,[owned?seller.address:maker.address]);
      if(name==='getApproved')return NFT_INTERFACE.encodeFunctionResult(name,[approved?ELEMENT_EX:ZERO_ADDRESS]);
      if(name==='isApprovedForAll')return NFT_INTERFACE.encodeFunctionResult(name,[approved]);
      if(name==='balanceOf')return NFT_INTERFACE.encodeFunctionResult(name,[owned?100n:0n]);
      assert.fail('Unexpected NFT call '+name);
    }
    if(to===ELEMENT_EX) {
      const decoded=ELEMENT_INTERFACE.parseTransaction({data:tx.data}),name=decoded.name;
      if(name==='getHashNonce')return ELEMENT_INTERFACE.encodeFunctionResult(name,[0n]);
      if(name.endsWith('OrderHash')) {
        const o=decoded.args[0].toObject(),standard=name.includes('721')?'ERC721':'ERC1155',side=name.includes('Buy')?'buy':'sell';
        o.fees=[...o.fees].map(f=>f.toObject()); if(o.nftProperties)o.nftProperties=[...o.nftProperties].map(p=>p.toObject()); if(o.erc1155TokenProperties)o.erc1155TokenProperties=[...o.erc1155TokenProperties].map(p=>p.toObject()); o.hashNonce='0';
        const t=elementTypedData(o,standard,side);return ELEMENT_INTERFACE.encodeFunctionResult(name,[TypedDataEncoder.hash(t.domain,t.types,t.message)]);
      }
      if(name==='getERC721BuyOrderStatus'||name==='getERC721SellOrderStatus')return ELEMENT_INTERFACE.encodeFunctionResult(name,[1]);
      if(name==='getERC1155BuyOrderInfo'||name==='getERC1155SellOrderInfo')return ELEMENT_INTERFACE.encodeFunctionResult(name,[{orderHash:'0x'+'1'.repeat(64),status:1,orderAmount:2,remainingAmount:2}]);
      if(name==='sellERC721'||name==='sellERC1155'){assert.equal(tx.from,rule.walletAddress);assert.equal(tx.value,'0');return '0x';}
      assert.fail('Unexpected Element call '+name);
    }
    if(to===WBNB){const decoded=token.parseTransaction({data:tx.data});return token.encodeFunctionResult(decoded.name,[10n**22n]);}
    assert.fail('Unexpected RPC target '+to);
  };
  return {adapter:createElementTrading({getApiKey:()=> 'test-key',fetchImpl,rpc,now:()=>now}),requests,rpcCalls,fetchImpl,rpc};
}

async function offerFixture({standard='ERC721',properties=[],callback='0x',unwrap=false,quantity='1',expiry=packElementExpiry(seconds-60,seconds+3600)}={}) {
  const r={...rule,standard,quantity,mode:'take-profit-offer'};
  const order={maker:maker.address,taker:ZERO_ADDRESS,expiry,nonce:'3',erc20Token:WBNB,erc20TokenAmount:'1000000000000000000',fees:[{recipient:feeRecipient,amount:'20000000000000000',feeData:'0x'}],...(standard==='ERC721'?{nft,nftId:r.tokenId,nftProperties:properties}:{erc1155Token:nft,erc1155TokenId:r.tokenId,erc1155TokenProperties:properties,erc1155TokenAmount:quantity}),hashNonce:'0'};
  const typedData=elementTypedData(order,standard,'buy'),signature=Signature.from(await maker.signTypedData(typedData.domain,typedData.types,typedData.message));
  const args=standard==='ERC721'?[order,{signatureType:0,v:signature.v,r:signature.r,s:signature.s},r.tokenId,unwrap,callback]:[order,{signatureType:0,v:signature.v,r:signature.r,s:signature.s},r.tokenId,quantity,unwrap,callback];
  const trade={to:ELEMENT_EX,data:ELEMENT_INTERFACE.encodeFunctionData(standard==='ERC721'?'sellERC721':'sellERC1155',args),value:'0'};
  const row={orderId:'bid-1',side:0,saleKind:0,exchange:ELEMENT_EX,assetContract:nft,assetTokenId:r.tokenId,schema:standard,paymentToken:WBNB,maker:maker.address,nonce:'3',hashNonce:'0',basePrice:'1020000000000000000',quantity,listingTime:seconds-60,expirationTime:seconds+3600,hash:TypedDataEncoder.hash(typedData.domain,typedData.types,typedData.message)};
  return {r,order,typedData,trade,row};
}

test('packed expiry preserves oracle/time and rejects unknown bit fields',()=>{
  const packed=packElementExpiry(seconds-60,seconds+86400);
  assert.deepEqual(unpackElementExpiry(packed),{listingTime:seconds-60,expirationTime:seconds+86400,oracleSignature:1});
  assert.throws(()=>unpackElementExpiry((BigInt(packed)|(1n<<100n)).toString()),{code:'UNSUPPORTED_ORDER'});
  assert.throws(()=>packElementExpiry(1,2,2),{code:'INVALID_EXPIRY'});
});

test('ERC721 position uses single-token approve, 1155 explicitly marks collection approval',async()=>{
  const {adapter}=environment({approved:false});const p=await adapter.position(rule);
  assert.equal(p.verifiedOwnership,true);assert.equal(p.approved,false);assert.equal(p.approval.scope,'token');assert.equal(NFT_INTERFACE.parseTransaction({data:p.approval.data}).name,'approve');
  const multi=await adapter.position({...rule,standard:'ERC1155',quantity:'2'});assert.equal(multi.approval.scope,'collection');assert.equal(multi.approval.requiresManualConfirmation,true);
  const wrong=environment({owned:false});assert.equal((await wrong.adapter.position(rule)).verifiedOwnership,false);
  await assert.rejects(environment({chainId:'0x1'}).adapter.position(rule),{code:'CHAIN_MISMATCH'});
});

test('missing key blocks API work and never appears in a quote or error',async()=>{
  let fetches=0;const adapter=createElementTrading({getApiKey:()=>'',fetchImpl:()=>{fetches++;throw Error('should not run');},now:()=>now});
  await assert.rejects(adapter.quote(rule,position()),{code:'ELEMENT_API_KEY_REQUIRED'});assert.equal(fetches,0);
  const bad=environment({fetchOverride:()=>{throw Error('secret test-key');}});await assert.rejects(bad.adapter.quote(rule,position()),error=>!error.message.includes('test-key'));
});

test('key validity probe performs only authenticated confData GET and returns booleans',async()=>{
  const{adapter,requests,rpcCalls}=environment({fetchOverride:(url)=>url.endsWith('/orders/confData?chain=bsc')?response({oracleSignature:1,extra:'test-key'}):null});
  const result=await adapter.checkApiKey();
  assert.deepEqual(result,{valid:true,capabilities:{readConfiguration:true,oracleVerification:true}});
  assert.equal(requests.length,1);assert.equal(requests[0].url,'https://api.element.market/openapi/v1/orders/confData?chain=bsc');assert.equal(requests[0].opts.method,'GET');assert.equal(requests[0].opts.body,undefined);assert.equal(rpcCalls.length,0);assert.ok(!JSON.stringify(result).includes('test-key'));
});

test('key probe rejects missing key, rejected HTTP and changed configuration without exposing responses',async()=>{
  let fetches=0;
  const empty=createElementTrading({getApiKey:()=>'',fetchImpl:()=>{fetches++;throw Error();}});
  await assert.rejects(empty.checkApiKey(),{code:'ELEMENT_API_KEY_REQUIRED'});assert.equal(fetches,0);
  for(const data of[{},[],{oracleSignature:0},{oracleSignature:'1'}])await assert.rejects(environment({fetchOverride:()=>response(data)}).adapter.checkApiKey(),{code:'ELEMENT_INVALID_CONFIGURATION'});
  const rejected=environment({fetchOverride:()=>new Response('secret test-key',{status:401})});
  await assert.rejects(rejected.adapter.checkApiKey(),error=>error.code==='ELEMENT_HTTP_ERROR'&&!error.message.includes('test-key')&&!error.message.includes('secret'));
});

test('fee plan builds exact EIP712/post metadata and verified publication with offline fixture',async()=>{
  const {adapter,requests,rpcCalls}=environment();const quote=await adapter.quote(rule,position());
  assert.equal(quote.grossWei,'1000000000000000000');assert.equal(quote.feesWei,'20000000000000000');assert.equal(quote.netWei,'980000000000000000');
  const plan=await adapter.buildListing(rule,quote);assert.equal(plan.typedData.primaryType,'NFTSellOrder');assert.equal(plan.order.erc20Token,NATIVE_TOKEN);assert.equal(plan.request.paymentToken,ZERO_ADDRESS);assert.equal(plan.request.basePrice,quote.grossWei);assert.equal(plan.apiDocumentationConflict,true);
  assert.deepEqual(plan.request.metadata,{asset:{id:'123',address:nft},schema:'ERC721'});assert.equal(plan.request.oracleSignature,1);assert.equal(plan.request.signatureType,0);
  const signature=await seller.signTypedData(plan.typedData.domain,plan.typedData.types,plan.typedData.message);const published=await adapter.publishListing(plan,signature);assert.equal(published.verified,true);assert.equal(published.status,'listed');
  assert.equal(requests.filter(x=>x.url.includes('/orders/post')).length,1);assert.ok(rpcCalls.every(x=>!x.method.includes('send')));
  const cancel=adapter.cancelTransaction({plan},rule);const tx=ELEMENT_INTERFACE.parseTransaction({data:cancel.data});assert.equal(tx.name,'cancelERC721Order');assert.equal(tx.args[0],7n);
  assert.equal((await adapter.orderStatus({plan},rule)).status,'listed');
});

test('post response mismatch/timeout remains unverified, never a false listing success',async()=>{
  for(const config of [{postTransform:r=>({...r,basePrice:'1'})},{postTransform:r=>({...r,hash:'0x'+'f'.repeat(64)})},{fetchOverride:(url)=>{if(url.endsWith('/orders/post'))throw Error('offline test-key');}}]){
    const {adapter}=environment(config);const q=await adapter.quote(rule,position()),plan=await adapter.buildListing(rule,q),sig=await seller.signTypedData(plan.typedData.domain,plan.typedData.types,plan.typedData.message);const result=await adapter.publishListing(plan,sig);
    assert.equal(result.verified,false);assert.equal(result.submissionUnknown,true);assert.equal(result.status,'unverified');assert.ok(!result.reason.includes('test-key'));
  }
});

test('invalid fees, stale ownership, changed binding, approval and expiry fail closed',async()=>{
  await assert.rejects(environment({feePoints:-1}).adapter.quote(rule,position()),{code:'FEES_UNVERIFIED'});
  await assert.rejects(environment().adapter.quote(rule,{...position(),verifiedAt:now-60001}),{code:'OWNERSHIP_UNVERIFIED'});
  await assert.rejects(environment().adapter.quote(rule,{...position(),tokenId:'1'}),{code:'BINDING_MISMATCH'});
  await assert.rejects(environment().adapter.quote({...rule,maxFeesBnb:'0.001'},position()),{code:'FEES_EXCEEDED'});
  const {adapter}=environment({approved:false}),q=await adapter.quote(rule,position());await assert.rejects(adapter.buildListing(rule,q),{code:'APPROVAL_REQUIRED'});
  const ok=environment().adapter,quote=await ok.quote(rule,position());await assert.rejects(ok.buildListing({...rule,listingUnitPriceBnb:'2'},quote),{code:'BINDING_MISMATCH'});
  await assert.rejects(ok.buildListing({...rule,expirySec:9000000},quote),{code:'INVALID_EXPIRY'});
});

test('ordinary verified WBNB bid produces net/gas bound transaction without sending',async()=>{
  const f=await offerFixture(),{adapter,requests}=environment({offers:[f.row],trade:f.trade});const q=await adapter.quote(f.r,position(f.r));
  assert.equal(q.source,'executable-offer');assert.equal(q.currency,'WBNB');assert.equal(q.grossWei,'1020000000000000000');assert.equal(q.marketFeesWei,'20000000000000000');assert.equal(q.gasWei,'120000000000000');assert.equal(q.netWei,'999880000000000000');assert.deepEqual(q.context.transaction,f.trade);
  const encode=requests.find(x=>x.url.includes('encodeTradeData'));assert.deepEqual(JSON.parse(encode.opts.body),{chain:'bsc',taker:rule.walletAddress,orderIdList:[{orderId:'bid-1',takeCount:1,tokenId:'123'}]});
});

test('ERC1155 full-quantity bid and explicit WBNB unwrap use the same restricted validator',async()=>{
  const f=await offerFixture({standard:'ERC1155',quantity:'2',unwrap:true}),{adapter}=environment({offers:[f.row],trade:f.trade});const q=await adapter.quote(f.r,position(f.r));assert.equal(q.currency,'BNB');assert.equal(q.quantity,'2');assert.equal(q.context.unwrap,true);
});

test('pure decoder rejects wrong NFT/ID/quantity/payment/target/value/callback/properties and trailers',async()=>{
  const good=await offerFixture();assert.equal(decodeElementOfferTransaction(good.trade,position(),{now}).netWei,'1000000000000000000');
  for(const tx of [{...good.trade,to:nft},{...good.trade,value:'1'},{...good.trade,data:good.trade.data+'00'.repeat(32)}])assert.throws(()=>decodeElementOfferTransaction(tx,position(),{now}));
  assert.throws(()=>decodeElementOfferTransaction(good.trade,{...position(),tokenId:'124'},{now}),{code:'BINDING_MISMATCH'});
  for(const settings of [{callback:'0x1234'},{properties:[{propertyValidator:ZERO_ADDRESS,propertyData:'0x'}]},{expiry:packElementExpiry(seconds-1000,seconds-1)}]){
    const f=await offerFixture(settings);assert.throws(()=>decodeElementOfferTransaction(f.trade,position(),{now}));
  }
});

test('wrong order hash, stale status, low buyer funds and unknown encoding cannot become bids',async()=>{
  const f=await offerFixture();
  for(const opts of [{offers:[{...f.row,hash:'0x'+'f'.repeat(64)}],trade:f.trade},{offers:[f.row],trade:{...f.trade,data:f.trade.data+'00'.repeat(32)}},{offers:[f.row],trade:f.trade,rpcOverride:(method,params)=>{if(method==='eth_call'&&params[0].to===WBNB){const d=token.parseTransaction({data:params[0].data});return token.encodeFunctionResult(d.name,[0]);}}}]){
    await assert.rejects(environment(opts).adapter.quote(f.r,position(f.r)),{code:'NO_EXECUTABLE_OFFER'});
  }
  assert.equal((await environment().adapter.orderStatus({},rule)).status,'unknown');
});

const txHash='0x'+'a'.repeat(64);
function filledLog(order,hash,{standard='ERC721',side='Buy',overrides={}}={}){
  const name=(standard==='ERC721'?'ERC721':'ERC1155')+side+'OrderFilled';
  const quantity=standard==='ERC721'?'1':order.erc1155TokenAmount;
  const total=BigInt(order.erc20TokenAmount)+order.fees.reduce((n,f)=>n+BigInt(f.amount),0n);
  const values={orderHash:hash,maker:order.maker,taker:side==='Buy'?rule.walletAddress:maker.address,nonce:order.nonce,erc20Token:order.erc20Token,fees:order.fees.map(f=>({recipient:f.recipient,amount:f.amount})),...(standard==='ERC721'?{erc20TokenAmount:total,erc721Token:nft,erc721TokenId:rule.tokenId}:{erc20FillAmount:total,erc1155Token:nft,erc1155TokenId:rule.tokenId,erc1155FillAmount:quantity}),...overrides};
  const event=ELEMENT_INTERFACE.getEvent(name),encoded=ELEMENT_INTERFACE.encodeEventLog(event,event.inputs.map(input=>values[input.name]));
  return{address:ELEMENT_EX,...encoded,transactionHash:txHash};
}
const fillReceipt=(logs,from=rule.walletAddress)=>({status:'0x1',transactionHash:txHash,from,gasUsed:'0x186a0',effectiveGasPrice:'0x3b9aca00',logs});

test('native BNB listing receipt is confirmed only by exact protocol payment event; buyer pays gas',async()=>{
  const{adapter}=environment(),q=await adapter.quote(rule,position()),plan=await adapter.buildListing(rule,q);
  const log=filledLog(plan.order,plan.hash,{side:'Sell'}),st={plan,txHash};
  const result=adapter.verifyFill(rule,st,fillReceipt([log],maker.address));
  assert.equal(result.confirmed,true);assert.equal(result.currency,'BNB');assert.equal(result.netWei,'980000000000000000');assert.equal(result.gasWei,'0');
  for(const [r,receipt]of[
    [rule,fillReceipt([])],
    [rule,fillReceipt([filledLog(plan.order,plan.hash,{side:'Sell',overrides:{nonce:'9'}})])],
    [rule,fillReceipt([filledLog(plan.order,'0x'+'b'.repeat(64),{side:'Sell'})])],
    [rule,fillReceipt([log,log])],
    [rule,{...fillReceipt([log]),effectiveGasPrice:undefined}],
    [rule,{...fillReceipt([log]),transactionHash:'0x'+'b'.repeat(64)}],
    [{...rule,minNetBnb:'0.99'},fillReceipt([log],maker.address)],
    [{...rule,maxFeesBnb:'0.001'},fillReceipt([log],maker.address)],
  ])assert.equal(adapter.verifyFill(r,st,receipt).confirmed,false);
});

test('WBNB/unwrap offer receipt binds bid hash and taker, with actual seller gas',async()=>{
  for(const unwrap of[false,true]){
    const f=await offerFixture({unwrap}),{adapter}=environment({offers:[f.row],trade:f.trade}),q=await adapter.quote(f.r,position(f.r));
    const st={operation:{kind:'accept',quote:q},txHash},log=filledLog(f.order,f.row.hash),receipt=fillReceipt([log]);
    const result=adapter.verifyFill(f.r,st,receipt);assert.equal(result.confirmed,true);assert.equal(result.currency,unwrap?'BNB':'WBNB');assert.equal(result.netWei,'999900000000000000');
    assert.equal(adapter.verifyFill(f.r,st,fillReceipt([log],maker.address)).confirmed,false);
    assert.equal(adapter.verifyFill(f.r,st,fillReceipt([filledLog(f.order,f.row.hash,{overrides:{taker:maker.address}})])).confirmed,false);
  }
});

test('1155 receipt must fill exact signed quantity and fee schedule',async()=>{
  const f=await offerFixture({standard:'ERC1155',quantity:'2'}),{adapter}=environment({offers:[f.row],trade:f.trade}),q=await adapter.quote(f.r,position(f.r));
  const st={operation:{kind:'accept',quote:q},txHash},log=filledLog(f.order,f.row.hash,{standard:'ERC1155'});
  assert.equal(adapter.verifyFill(f.r,st,fillReceipt([log])).filledQuantity,'2');
  assert.equal(adapter.verifyFill(f.r,st,fillReceipt([filledLog(f.order,f.row.hash,{standard:'ERC1155',overrides:{erc1155FillAmount:'1'}})])).confirmed,false);
  assert.equal(adapter.verifyFill(f.r,st,fillReceipt([filledLog(f.order,f.row.hash,{standard:'ERC1155',overrides:{fees:[{recipient:feeRecipient,amount:'1'}]}})])).confirmed,false);
});

test('persisted plan mutations cannot turn publication or cancel into an arbitrary action',async()=>{
  const {adapter,requests}=environment(),q=await adapter.quote(rule,position()),plan=await adapter.buildListing(rule,q),sig=await seller.signTypedData(plan.typedData.domain,plan.typedData.types,plan.typedData.message);
  for(const mutate of[p=>p.request.metadata.asset.id='999',p=>p.request.basePrice='1',p=>p.typedData.domain.verifyingContract=nft,p=>p.order.nonce='999',p=>p.quantity='2']){
    const tampered=structuredClone(plan);mutate(tampered);await assert.rejects(adapter.publishListing(tampered,sig),{code:'INVALID_PLAN'});assert.throws(()=>adapter.cancelTransaction({plan:tampered},rule));
  }
  assert.equal(requests.filter(r=>r.url.endsWith('/orders/post')).length,0);
});

test('unfillable listing needs exact fill/cancel event; no inferred sale from status alone',async()=>{
  const base=environment(),q=await base.adapter.quote(rule,position()),plan=await base.adapter.buildListing(rule,q);
  const cancel=ELEMENT_INTERFACE.encodeEventLog(ELEMENT_INTERFACE.getEvent('ERC721OrderCancelled'),[rule.walletAddress,plan.nonce]);
  for(const [logs,expected]of[[[],'unavailable'],[[filledLog(plan.order,plan.hash,{side:'Sell'})],'filled'],[[{address:ELEMENT_EX,...cancel,transactionHash:txHash}],'cancelled']]){
    const env=environment({rpcOverride:(method,params)=>{
      if(method==='eth_blockNumber')return '0x100';if(method==='eth_getLogs')return logs;
      if(method==='eth_call'&&params[0].to===ELEMENT_EX){const d=ELEMENT_INTERFACE.parseTransaction({data:params[0].data});if(d.name==='getERC721SellOrderStatus')return ELEMENT_INTERFACE.encodeFunctionResult(d.name,[2]);}
    }});
    const status=await env.adapter.orderStatus({plan,submittedBlock:200},rule);assert.equal(status.status,expected);
    if(expected==='filled'){assert.equal(status.txHash,txHash);assert.equal(status.confirmed,false);}else assert.equal(status.confirmed,expected==='cancelled');
    if(expected==='unavailable')assert.equal(status.proofCancelNonce,plan.nonce);
  }
});
