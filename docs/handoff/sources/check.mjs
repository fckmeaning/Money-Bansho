// Polite live check: bounded concurrency, per-host serialization, timeouts, no personal data.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const repo='C:/Users/777/Desktop/Money-Bansho';
const { rssFetchHeadersForHost } = await import(pathToFileURL(repo+'/api/_rss-fetch-headers.js'));
const [,, inFile, outFile] = process.argv;
let list;
if (inFile==='--added') {
  const cur=JSON.parse(readFileSync(repo+'/shared/news-catalog.json','utf8'));
  const base=JSON.parse(execSync(`git -C ${repo} show 09e31ce:shared/news-catalog.json`,{maxBuffer:1e8}));
  const urls=f=>[...(typeof f.url==='string'?[f.url]:Object.values(f.url)), ...(f.browser?.url?(typeof f.browser.url==='string'?[f.browser.url]:Object.values(f.browser.url)):[])];
  const old=new Set(base.feeds.flatMap(urls));
  list=cur.feeds.flatMap(f=>urls(f).filter(u=>!old.has(u)).map(url=>({name:f.name,url,cats:[...new Set(f.placements.map(p=>p.category))]})));
} else list=JSON.parse(readFileSync(inFile,'utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const MONTHS={};
function analyse(body){
  const head=body.slice(0,3000);
  const isFeed=/<(rss|feed|rdf:RDF|urlset)[\s>:]/i.test(head);
  const items=(body.match(/<(item|entry|url)[\s>]/g)||[]).length;
  const dates=[...body.matchAll(/<(?:pubDate|updated|published|dc:date|news:publication_date|lastBuildDate)[^>]*>\s*(?:<!\[CDATA\[)?([^<\]]+)/g)].map(m=>Date.parse(m[1].trim())).filter(t=>t && t<Date.now()+2*864e5);
  const newest=dates.length?new Date(Math.max(...dates)).toISOString().slice(0,10):null;
  return {isFeed,items,newest};
}
async function once(url){
  const ac=new AbortController(); const t=setTimeout(()=>ac.abort(),20000);
  try{
    const r=await fetch(url,{headers:rssFetchHeadersForHost(new URL(url).hostname),signal:ac.signal,redirect:'follow'});
    const buf=await r.arrayBuffer();
    const body=new TextDecoder('utf-8').decode(buf);
    return {http:r.status,final:r.url,...(r.ok?analyse(body):{})};
  }catch(e){return {http:0,err:String(e.cause?.code||e.name||e.message)}}finally{clearTimeout(t)}
}
const classify=r=>r.http!==200?'FAIL':!r.isFeed?'NOTFEED':r.items===0?'EMPTY':r.newest&&Date.now()-Date.parse(r.newest)>45*864e5?'STALE':'OK';
const queues=new Map();
for(const f of list){const h=new URL(f.url).hostname;(queues.get(h)??queues.set(h,[]).get(h)).push(f)}
const hosts=[...queues.keys()].sort((a,b)=>queues.get(b).length-queues.get(a).length);
const results=[];let done=0;
async function worker(){
  while(hosts.length){
    const h=hosts.shift();const gap=h==='news.google.com'?2500:700;
    for(const f of queues.get(h)){
      let r=await once(f.url);
      if(r.http===429||r.http===503){await sleep(15000);r=await once(f.url)} else if(r.http===0){await sleep(2000);r=await once(f.url)}
      results.push({...f,...r,status:classify(r)});
      if(++done%50===0){console.log(done,'/',list.length);writeFileSync(outFile,JSON.stringify(results,null,1))}
      await sleep(gap);
    }
  }
}
await Promise.all(Array.from({length:8},worker));
writeFileSync(outFile,JSON.stringify(results,null,1));
const c={};for(const r of results)c[r.status]=(c[r.status]||0)+1;console.log('total',results.length,c);
