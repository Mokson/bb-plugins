(()=>{
const rows=[...document.querySelectorAll("[data-better-sidebar-row]")];
const out={};
const info=rows.map(r=>{
 const trig=r.firstElementChild, row1=r.querySelector("[data-better-sidebar-row1]");
 const inner=trig.querySelector(".relative.flex.min-w-0.flex-col");
 const row2=inner&&inner.children.length>1?inner.children[1]:null;
 const kids=[...row1.children];
 const chev=kids[0], prov=kids[1], title=kids[2], trail=kids[3];
 const tb=title.getBoundingClientRect(), trb=trail.getBoundingClientRect();
 const timeEl=[...trail.querySelectorAll("span")].pop();
 const cnt=r.querySelector("[aria-label*='child threads']");
 return {id:r.getAttribute("data-better-sidebar-row"),
  pl:trig.style.paddingLeft, h:+r.getBoundingClientRect().height.toFixed(1),
  r1h:+row1.getBoundingClientRect().height.toFixed(1),
  hasRow2:!!row2, row2txt:row2?row2.textContent.trim().slice(0,50):null,
  chevW:+chev.getBoundingClientRect().width.toFixed(1), chevX:+chev.getBoundingClientRect().left.toFixed(1),
  provOk:!!prov.querySelector("[data-better-sidebar-provider]"), provLabel:prov.getAttribute("aria-label"),
  titleX:+tb.left.toFixed(1), titleR:+tb.right.toFixed(1),
  trailX:+trb.left.toFixed(1), trailR:+trb.right.toFixed(1), trailW:+trb.width.toFixed(1),
  trailTxt:trail.textContent.trim(), gapTitleTrail:+(trb.left-tb.right).toFixed(1),
  truncated: title.scrollWidth>title.clientWidth+1,
  hasChevron:!!chev.firstElementChild, childCount:cnt?cnt.getAttribute("aria-label"):null,
  overflowY: r.scrollHeight>r.clientHeight+1
 };
});
const hdr=[...document.querySelectorAll("h2")].filter(h=>/TODAY|YESTERDAY|LAST|OLDER|NEEDS|PINNED/.test(h.textContent));
out.headers=hdr.map(h=>{const btn=h.querySelector("button")||h;const sp=[...btn.querySelectorAll("span")];
 const lbl=sp[0],num=sp[sp.length-1];
 return {txt:h.textContent.trim(),labelR:lbl?+lbl.getBoundingClientRect().right.toFixed(1):null,
  numL:num?+num.getBoundingClientRect().left.toFixed(1):null,numR:num?+num.getBoundingClientRect().right.toFixed(1):null,
  btnR:+btn.getBoundingClientRect().right.toFixed(1)};});
out.rows=info; out.n=rows.length;
out.titleXset=[...new Set(info.map(r=>r.pl+"/"+r.titleX))];
out.docScrollX=document.documentElement.scrollWidth>document.documentElement.clientWidth;
return JSON.stringify(out);
})()
