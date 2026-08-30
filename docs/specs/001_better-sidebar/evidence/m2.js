(()=>{
const rows=[...document.querySelectorAll("[data-better-sidebar-row]")];
const html=rows[0].outerHTML;
const html2=rows[1].outerHTML;
const list=rows[0].closest("[data-better-sidebar-list]")||rows[0].parentElement.parentElement;
const heads=[...document.querySelectorAll("h2,h3,[data-better-sidebar-section]")].map(h=>h.textContent.trim()).slice(0,20);
return JSON.stringify({html:html.slice(0,2200),html2:html2.slice(0,1400),heads},null,1);
})()
