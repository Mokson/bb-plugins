(()=>{
const rows=[...document.querySelectorAll("[data-better-sidebar-row]")];
const st=[...document.querySelectorAll("[data-sidebar-thread-shortcut-target]")];
const anchors=st.map(e=>e.tagName+":"+(e instanceof HTMLAnchorElement));
const r1=[...document.querySelectorAll("[data-better-sidebar-row1]")];
const sample=rows.slice(0,6).map(r=>{
  const b=r.getBoundingClientRect();
  const row1=r.querySelector("[data-better-sidebar-row1]");
  const rb=row1?row1.getBoundingClientRect():null;
  const cs=row1?getComputedStyle(row1):null;
  return {id:r.getAttribute("data-sidebar-thread-id")||r.dataset.threadId,depth:r.getAttribute("data-depth"),
   h:+b.height.toFixed(1), row1h:rb?+rb.height.toFixed(1):null,
   gap:cs?cs.gap:null, fs:cs?cs.fontSize:null, pad:cs?cs.padding:null, radius:cs?cs.borderRadius:null,
   hasRow2: !!r.querySelector("[data-better-sidebar-row2]"),
   kids: r.querySelectorAll("*").length,
   order:[...(row1?row1.children:[])].map(c=>c.getAttribute("data-better-sidebar-provider")!==null?"provider":(c.className&&typeof c.className==="string"?c.className.slice(0,28):c.tagName))
  };
});
return JSON.stringify({rowCount:rows.length,r1Count:r1.length,allAnchors:anchors.every(a=>a.endsWith("true")),tagset:[...new Set(anchors)],sample},null,1);
})()
