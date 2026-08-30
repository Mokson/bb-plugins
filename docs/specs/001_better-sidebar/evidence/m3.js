(()=>{
const rows=[...document.querySelectorAll("[data-better-sidebar-row]")];
let list=rows[0]; for(let i=0;i<6;i++) list=list.parentElement;
const root=rows[0].closest("div[class*=overflow]")||list;
// find headers: elements containing uppercase section words
const words=["NEEDS YOU","PINNED","TODAY","YESTERDAY","LAST 7 DAYS","LAST 30 DAYS","OLDER"];
const hdrs=[...root.querySelectorAll("*")].filter(e=>e.children.length<=3 && words.some(w=>e.textContent.trim().toUpperCase().startsWith(w)) && e.textContent.trim().length<40);
const uniq=[];const seen=new Set();
for(const h of hdrs){const t=h.textContent.trim();if(!seen.has(t)){seen.add(t);uniq.push({t,tag:h.tagName,cls:(h.className||"").slice(0,60),rect:h.getBoundingClientRect()})}}
return JSON.stringify({scrollH:root.scrollHeight,clientH:root.clientHeight,rootcls:(root.className||"").slice(0,80),hdrs:uniq},null,1);
})()
