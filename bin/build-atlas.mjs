#!/usr/bin/env node
/**
 * One-shot build step, run once when the template was created.
 *
 * Takes the atlas engine and swaps its hardcoded department data for a loader that
 * fetches org.config.json and state/inventory.json at runtime, then splices in the
 * template's prose sections. Kept in the repo so the transformation is auditable.
 *
 *   node bin/build-atlas.mjs
 */
import { readFile, writeFile, unlink, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const HTML = join(ROOT, "atlas", "index.html");
const PROSE = join(ROOT, "atlas", "_prose.html");

async function exists(p) { try { await access(p); return true; } catch { return false; } }
let html = await readFile(HTML, "utf8");

// Already built. This is a one-shot transform, kept for auditability rather than reuse.
if (html.includes('<script type="module">') && html.includes("const FALLBACK=")) {
  console.log("atlas is already built, nothing to do");
  console.log("run: node bin/check-atlas.mjs   to verify it");
  process.exit(0);
}

/* ------------------------------------------------ 1. prose sections ------ */
if (await exists(PROSE)) {
  const prose = (await readFile(PROSE, "utf8")).trim();
  const a = html.indexOf('<div class="wrap">\n\n<section id="verdict">');
  const b = html.indexOf("</footer>");
  if (a < 0 || b < 0) throw new Error("prose anchors not found");
  html = html.slice(0, a) + prose + "\n" + html.slice(b + "</footer>".length);
  await unlink(PROSE);
  console.log("prose replaced");
}

/* ------------------------------------------------ 2. data -> loader ------ */
const LOADER = `/* =======================================================================
   CONFIG
   The atlas reads your live org.config.json and state/inventory.json when it is
   served over http (npm run atlas). Opened straight off the filesystem the browser
   blocks those fetches, so it falls back to the demo below. Either way it renders.
   ======================================================================= */
const FALLBACK={
  org:{name:"Acme",tagline:"four departments, one operator"},
  departments:[
    {id:"growth",name:"Growth",sub:"audience \\u00B7 content",color:"#9B8CC4",
     mission:"Turn what you learn into things people find.",home:"vaults/notes/Content",
     note:"This is the bundled demo. Serve the atlas with npm run atlas to see your own config.",
     clusters:[
      {name:"Research",items:[
        {label:"trend-scan",type:"core",desc:"Whatever you use to find what people are talking about.",where:"~/.claude/skills/..."},
        {label:"web-search",type:"tool",desc:"A connector for search and page extraction.",where:"MCP connector"}]},
      {name:"Creation",items:[
        {label:"draft",type:"core",desc:"The skill that writes the thing.",where:"~/.claude/skills/..."},
        {label:"post-retro",type:"gap",desc:"Nothing records how a piece performed after it shipped, so the loop never closes.",where:"does not exist yet"}]},
      {name:"Ledger",items:[
        {label:"queue",type:"core",desc:"Ideas to queued to shipped, append-style.",where:"vaults/notes/Content/Pipeline"}]}]},
    {id:"product",name:"Product",sub:"what you ship",color:"#4FB88A",
     mission:"Ship and keep alive the things that charge money directly.",home:"vaults/code",
     note:"Name the repos that make money, and the one event chain that tells you whether they do.",
     clusters:[
      {name:"Build",items:[
        {label:"your-app",type:"core",desc:"The main repo.",where:"vaults/code/your-app"}]},
      {name:"Ship",items:[
        {label:"github",type:"tool",desc:"Repos, pull requests, issues, code search.",where:"MCP connector"},
        {label:"incident-log",type:"gap",desc:"Nothing records what broke or what fixed it, so every outage is diagnosed from scratch.",where:"does not exist yet"}]}]},
    {id:"revenue",name:"Revenue",sub:"offers \\u00B7 funnel",color:"#E3B341",
     mission:"Convert attention into money, and know which step converts.",home:"vaults/notes/Money",
     note:"Describe the funnel as it actually runs, including the step you cannot measure.",
     clusters:[
      {name:"Offer",items:[
        {label:"money-map",type:"core",desc:"One file describing the funnel and the offers.",where:"vaults/notes/Money/Money-Map.md"},
        {label:"pricing-test",type:"gap",desc:"No structured pricing experiment has been run.",where:"does not exist yet"}]}]},
    {id:"memory",name:"Memory",sub:"the vault itself",color:"#E8873C",
     mission:"Hold what the other departments need to remember.",home:"vaults/notes",
     note:"This ledger records changes to how the vault is organised, not the content going into it.",
     clusters:[
      {name:"Rules",items:[
        {label:"search-scoping",type:"core",desc:"The order a session searches in. This is why exact search keeps working as the vault grows.",where:"vaults/notes/CLAUDE.md"}]},
      {name:"Recall",items:[
        {label:"obsidian",type:"tool",desc:"Reads and writes the vault directly.",where:"MCP connector"},
        {label:"weekly-digest",type:"gap",desc:"Nothing summarises what the vault learned this week.",where:"run /review"}]}]}]
};

async function grab(url){
  try{
    const r=await fetch(url,{cache:"no-store"});
    if(!r.ok)return null;
    return await r.json();
  }catch{return null;}
}

const liveCfg=await grab("../org.config.json");
const inventory=await grab("../state/inventory.json");
const cfg=(liveCfg&&Array.isArray(liveCfg.departments)&&liveCfg.departments.length)?liveCfg:FALLBACK;
const IS_LIVE=cfg!==FALLBACK;

// config shape -> engine shape
const DEPTS=cfg.departments.map(d=>{
  let clusters=(d.clusters||[]).map(c=>({
    n:c.name,
    j:(c.items||[]).map(i=>({l:i.label,t:["core","tool","gap"].includes(i.type)?i.type:"core",
                             d:i.desc||"",w:i.where||""}))
  })).filter(c=>c.j.length);
  // a department with no declared units still needs something on the map
  if(!clusters.length){
    clusters=[{n:"Paths",j:(d.paths||[d.home||"unmapped"]).map(p=>({
      l:String(p).split("/").pop(),t:"core",d:"Declared path. Add clusters in org.config.json to describe what lives here.",w:p}))}];
  }
  return {id:d.id,name:d.name,sub:d.sub||"",color:d.color||"#8A8272",
          mission:d.mission||"",home:d.home||(d.paths&&d.paths[0])||"",
          ledger:d.ledger||("state/"+d.id+".md"),note:d.note||"",
          paths:d.paths||[],clusters};
});

const ORGNAME=cfg.org?.name||"Org";
const ORGTAG=cfg.org?.tagline||(DEPTS.length+" departments");
document.title=cfg.org?.atlasTitle||(ORGNAME+" Org Atlas");
{
  const b=document.querySelector(".brand");
  if(b)b.innerHTML="<b>"+ORGNAME+"</b>";
  const t=document.getElementById("crumbT");
  if(t)t.textContent=ORGNAME;
  const s=document.getElementById("crumbS");
  if(s)s.textContent=ORGTAG;
}
`;

const startIdx = html.indexOf("const DEPTS=[");
const buildIdx = html.indexOf("/* =======================================================================\n   WORLD BUILD");
if (startIdx < 0 || buildIdx < 0) throw new Error("data anchors not found");
html = html.slice(0, startIdx) + LOADER + "\n" + html.slice(buildIdx);
console.log("data block replaced with loader");

/* ------------------------------------------------ 3. module + await ------ */
html = html.replace("<script>\n\"use strict\";", '<script type="module">\n"use strict";');
if (!html.includes('<script type="module">')) throw new Error("script tag not converted");

/* ------------------------------------------------ 4. drop workforce js --- */
const wfStart = html.indexOf('document.getElementById("wfBody")');
if (wfStart >= 0) {
  const wfEnd = html.indexOf("}).join(\"\");", wfStart);
  html = html.slice(0, wfStart) + "/* the command table is static in the prose above */" + html.slice(wfEnd + '}).join("");'.length);
  console.log("workforce renderer removed");
}

/* ------------------------------------------------ 5. default inspector --- */
const OLD_INSPECTOR_START = 'const unrouted=';
const oi = html.indexOf(OLD_INSPECTOR_START);
if (oi >= 0) {
  const oiEnd = html.indexOf("return;", oi);
  const replacement = `const gaps=DEPTS.reduce((n,d)=>n+d.clusters.flatMap(c=>c.j).filter(j=>j.t==="gap").length,0);
    const missing=inventory?Object.entries(inventory.departments||{})
      .flatMap(([id,dep])=>(dep.paths||[]).filter(p=>p.missing).map(p=>id+": "+p.path)):[];
    inspector.innerHTML=
      '<div class="ins-cell"><h4>The map</h4><p>'+totalUnits+' units across '+DEPTS.length+
        ' departments'+(IS_LIVE?', read from your org.config.json':', bundled demo data')+
        '. Click any department to fly in, then any orb for its profile.</p></div>'+
      '<div class="ins-cell"><h4>Not built yet ('+gaps+')</h4><p>'+
        (gaps?'Gaps are drawn in gold. They are what <code>/review</code> ranks and what a brief lists first.':'Nothing outstanding.')+
        '</p></div>'+
      '<div class="ins-cell"><h4>'+(missing.length?'Paths that moved ('+missing.length+')':'Inventory')+'</h4>'+
        (missing.length
          ? '<ul class="chips">'+missing.slice(0,8).map(m=>'<li class="is-gap">'+m+'</li>').join('')+'</ul>'
          : '<p>'+(inventory?'Every declared path exists. Last scan '+String(inventory.generated).slice(0,10)+'.':'Run <code>npm run sync</code> to scan the real filesystem.')+'</p>')+
      '</div>';
    return;`;
  html = html.slice(0, oi) + replacement + html.slice(oiEnd + "return;".length);
  console.log("default inspector rewritten");
}

await writeFile(HTML, html, "utf8");
console.log("atlas built:", html.length, "bytes");
