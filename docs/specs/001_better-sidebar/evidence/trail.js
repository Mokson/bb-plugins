(()=>{
const rows=[...document.querySelectorAll("[data-better-sidebar-row]")];
const res=rows.map(r=>{
 const row1=r.querySelector("[data-better-sidebar-row1]");
 const trail=row1.children[3];
 const parts=[...trail.children].map(c=>({t:c.textContent.trim()||c.getAttribute("data-better-sidebar-signals")!==null?"signals":c.tagName,
   w:+c.getBoundingClientRect().width.toFixed(1),cls:(c.className||"").slice(0,40),txt:c.textContent.trim().slice(0,12)}));
 return {id:r.getAttribute("data-better-sidebar-row"),pl:r.firstElementChild.style.paddingLeft,
   h:+r.getBoundingClientRect().height.toFixed(1), trailW:+trail.getBoundingClientRect().width.toFixed(1), parts};
});
const roots=res.filter(x=>x.pl==="8px");
return JSON.stringify({roots,childSample:res.filter(x=>x.pl!=="8px").slice(0,3)});
})()
