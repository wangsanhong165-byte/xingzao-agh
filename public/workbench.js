async function checkCaseMaterials(){
 try{const r=await fetch('/api/submission/status');if(!r.ok||(await r.json()).casesAvailable!==true)throw Error();}
 catch{for(const a of document.querySelectorAll('.case')){a.href='/submission-guide';a.querySelector('[data-case-state]').textContent='案例资料见参赛包';a.querySelector('strong').textContent='查看案例安装说明 →';}}
}
void checkCaseMaterials();
