import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {choose,onlineEntry} from './core.mjs';
const API='https://cnmeme.wiki/api/v1/public/memes';
const META='wiki-sync',DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const normalized=value=>String(value??'').normalize('NFKC').trim().toLowerCase();
const entryId=slug=>'wiki-'+createHash('sha256').update(slug).digest('hex');
export function syncCycle(now,settings){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timeZone??'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=name=>parts.find(part=>part.type===name).value;
  const date=Date.UTC(Number(get('year')),Number(get('month'))-1,Number(get('day')));
  const target=DAYS.indexOf(settings.syncWeekday??'Sunday');
  if(target<0||!/^([01]\d|2[0-3]):[0-5]\d$/.test(settings.syncTime??'04:00'))throw Error('自动同步时间设置无效。');
  let days=(new Date(date).getUTCDay()-target+7)%7;
  if(days===0&&get('hour')+':'+get('minute')<(settings.syncTime??'04:00'))days=7;
  return new Date(date-days*86400000).toISOString().slice(0,10);
}
function empty(){return {version:1,cycle:null,done:false,offset:0,scanned:0,pending:[],index:[],added:0,lastSuccessAt:null,retryAt:0,lastError:''};}
async function read(ctx){
  const value=await ctx.documents.get(META);if(value===null||value===undefined)return empty();
  if(value.version!==1||!Array.isArray(value.pending)||!Array.isArray(value.index)||value.index.length>5000||!Number.isSafeInteger(value.offset)||value.offset<0||value.offset>100000||value.pending.some(item=>!validItem(item))||value.index.some(item=>!validItem(item)))throw Error('梗词库同步记录无效，已保留原数据。');
  return structuredClone(value);
}
function validItem(item){return typeof item?.title==='string'&&item.title.trim().length>0&&item.title.length<=100&&typeof item.slug==='string'&&item.slug.length>0&&item.slug.length<=200;}
function statusOf(meta){return {cycle:meta.cycle,completed:meta.done,scanned:meta.scanned,pending:meta.pending.length,added:meta.added,totalAdded:meta.index.length,lastSuccessAt:meta.lastSuccessAt,lastError:meta.lastError,retryAt:meta.retryAt};}
export function createWikiSync(baseEntries,{requestBudget=6,pause=(ms,signal)=>delay(ms,undefined,{signal}),entryData=onlineEntry}={}){
  const base=new Set(baseEntries.flatMap(item=>[normalized(item.title),normalized(item.slug)]));
  const locks=new Map();
  async function run(ctx){
    const settings=ctx.config();
    if(settings.autoSync!==true||settings.online===false)return {status:'disabled'};
    let meta=await read(ctx);const cycle=syncCycle(ctx.now,settings);
    if(meta.cycle===cycle&&meta.done)return {status:'up_to_date',...statusOf(meta)};
    if(meta.cycle!==cycle)meta={...empty(),cycle,index:meta.index,lastSuccessAt:meta.lastSuccessAt};
    if(meta.retryAt>ctx.now)return {status:'deferred',retryLater:true,...statusOf(meta)};
    let remaining=requestBudget,requested=false;
    const get=async url=>{
      ctx.signal?.throwIfAborted();
      if(requested)await pause(350,ctx.signal);requested=true;remaining--;
      const response=await ctx.fetch(url,{maxChars:32000,timeoutMs:2400});
      if(!response.ok||response.headers.get('X-WeChatAgent-Truncated')==='true')throw Error('MEMEWIKI_SYNC_NETWORK');
      return response.json();
    };
    try{
      while(remaining>0){
        if(meta.pending.length){
          const item=meta.pending[0],data=await get(API+'/'+encodeURIComponent(item.slug));
          if(!validItem(data.item)||normalized(data.item.title)!==normalized(item.title)||data.item.slug!==item.slug)throw Error('MEMEWIKI_SYNC_DETAIL');
          const parsed=entryData(data.item),entry={version:1,title:item.title,slug:item.slug,updatedAt:ctx.now};
          for(const [field,max]of [['usage',700],['origin',500],['other',400],['summary',400]])entry[field]=String(parsed[field]??'').trim().slice(0,max);
          const nextIndex=meta.index.some(row=>row.slug===item.slug)?meta.index:[...meta.index,item];
          if(nextIndex.length>5000||Buffer.byteLength(JSON.stringify(nextIndex))>800000)throw Error('MEMEWIKI_SYNC_CAPACITY');
          await ctx.documents.put(entryId(item.slug),entry);
          meta.index=nextIndex;meta.pending.shift();meta.added++;
        }else if(meta.hasMore===false){break;}
        else{
          const page=await get(API+'?limit=20&offset='+meta.offset);
          if(!Array.isArray(page.items)||page.items.length>20||typeof page.has_more!=='boolean'||page.items.some(item=>!validItem(item))||page.items.length===0&&page.has_more)throw Error('MEMEWIKI_SYNC_PAGE');
          const known=new Set([...base,...meta.index.flatMap(item=>[normalized(item.title),normalized(item.slug)])]);
          for(const item of page.items){
            if(!known.has(normalized(item.title))&&!known.has(normalized(item.slug))){meta.pending.push({title:item.title,slug:item.slug});known.add(normalized(item.title));known.add(normalized(item.slug));}
          }
          meta.offset+=page.items.length;meta.scanned=meta.offset;meta.hasMore=page.has_more;
        }
        meta.retryAt=0;meta.lastError='';
        if(meta.hasMore===false&&meta.pending.length===0){meta.done=true;meta.lastSuccessAt=ctx.now;}
        await ctx.documents.put(META,meta);
        if(meta.done)break;
      }
      return {status:meta.done?'complete':'in_progress',...(!meta.done?{retryLater:true}:{}),...statusOf(meta)};
    }catch(error){
      meta.lastError=/^MEMEWIKI_SYNC_[A-Z]+$/.test(error?.message)?error.message:'MEMEWIKI_SYNC_DEFERRED';
      meta.retryAt=ctx.now+15*60000;
      await ctx.documents.put(META,meta);
      return {status:'deferred',retryLater:true,...statusOf(meta)};
    }
  }
  return {
    async step(ctx){
      const scope=(ctx.account?.id??'')+'|'+ctx.chat.key;
      if(locks.has(scope))return {status:'busy',retryLater:true};
      const job=run(ctx);locks.set(scope,job);try{return await job;}finally{locks.delete(scope);}
    },
    status:async ctx=>statusOf(await read(ctx)),
    async lookup(ctx,query){
      const meta=await read(ctx),match=choose(meta.index,query);if(!match)return null;
      const entry=await ctx.documents.get(entryId(match.slug));
      if(!entry||entry.version!==1||entry.title!==match.title||entry.slug!==match.slug)throw Error('新增梗词条文件无效，已保留原数据。');
      return entry;
    },
  };
}
