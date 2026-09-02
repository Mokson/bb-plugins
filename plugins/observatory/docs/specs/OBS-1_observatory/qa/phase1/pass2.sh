#!/usr/bin/env bash
# Consolidated browser pass: range control, exports, cache drilldown,
# thread cost tab, footer strip. One load, many assertions.
cd "$(dirname "$0")" || exit 1
source ./journey.sh

load "cost?range=7d" >/dev/null || { echo "LOADFAIL"; exit 1; }

# The observatory panel is the subtree containing the "spend usd" hero.
PANEL="(()=>{const h=[...document.querySelectorAll('*')].find(e=>e.children.length===0&&e.textContent.trim()==='spend usd');let n=h;for(let i=0;i<12&&n;i++){if(n.textContent.includes('Lineage')&&n.textContent.includes('range'))return n;n=n.parentElement;}return null})()"

echo "=== R1 range control markup (panel-scoped) ==="
js "(()=>{const p=$PANEL;if(!p)return 'NO PANEL';const c=[...p.querySelectorAll('button,a')].filter(e=>['1d','7d','30d','90d'].includes(e.textContent.trim()));return JSON.stringify(c.map(e=>({tag:e.tagName,t:e.textContent.trim(),ap:e.getAttribute('aria-pressed'),ds:e.getAttribute('data-state'),cls:e.className.slice(0,50)})))})()"

echo "=== R2 click 1d inside panel, read hero ==="
js "(()=>{const p=$PANEL;const b=[...p.querySelectorAll('button,a')].find(e=>e.textContent.trim()==='1d');b.click();return 'clicked'})()"
sleep 2
js "JSON.stringify({search:location.search,hero:document.body.innerText.match(/spend usd\n([\d,.]+)/)?.[1],rows:document.querySelectorAll('tbody tr').length})"

echo "=== R3 back to 7d ==="
js "(()=>{const p=$PANEL;const b=[...p.querySelectorAll('button,a')].find(e=>e.textContent.trim()==='7d');b.click();return 'clicked'})()"
sleep 2
js "JSON.stringify({search:location.search,hero:document.body.innerText.match(/spend usd\n([\d,.]+)/)?.[1],rows:document.querySelectorAll('tbody tr').length})"

echo "=== R4 export controls ==="
js "(()=>{const p=$PANEL;const c=[...p.querySelectorAll('button,a')].filter(e=>['MD','JSON'].includes(e.textContent.trim()));return JSON.stringify(c.map(e=>({tag:e.tagName,t:e.textContent.trim(),href:(e.getAttribute('href')||'').slice(0,60),dl:e.getAttribute('download')})))})()"

echo "=== R5 density audit ==="
js "(()=>{const p=$PANEL;if(!p)return 'NO PANEL';const all=[...p.querySelectorAll('*')];const fonts=new Set(),sizes={},radii=new Set();let rightNum=0,totNum=0,rowH=new Set();
for(const e of all){const s=getComputedStyle(e);if(e.children.length===0&&e.textContent.trim()){fonts.add(s.fontFamily.split(',')[0].trim());sizes[s.fontSize]=(sizes[s.fontSize]||0)+1;}
 const r=parseFloat(s.borderTopLeftRadius)||0;if(r>0)radii.add(r);}
for(const td of p.querySelectorAll('tbody td')){const t=td.textContent.trim();if(/^[\d,.]+[eᵉ]?$/.test(t)&&t){totNum++;if(getComputedStyle(td).textAlign==='right')rightNum++;}}
for(const tr of p.querySelectorAll('tbody tr')){rowH.add(Math.round(tr.getBoundingClientRect().height));}
const emoji=(p.innerText.match(/\p{Extended_Pictographic}/gu)||[]);
return JSON.stringify({fonts:[...fonts],sizes,radii:[...radii].sort((a,b)=>a-b),numericRightAligned:rightNum+'/'+totNum,rowHeights:[...rowH].sort((a,b)=>a-b).slice(0,6),emoji:emoji.slice(0,5),emojiCount:emoji.length},null,0)})()"

shot j9-density.png
