// marklith motion layer: heading and paragraph reveals, word rotators, paragraph line reveals.
// Style-only: never inserts or moves nodes inside React-owned elements.
(function(){
  if(window.__mlFx)return;window.__mlFx=1;
  const RM=()=>window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE='cubic-bezier(.32,.72,0,1)';
  const TOOL=['workspace','library','settings'];
  const route=()=>((location.hash.match(/^#\/([^/?]*)/)||[])[1])||'home';
  const HEAD='#main h1,#main h2';
  const PARA='#main h1 + p,#main h2 + p,#main [data-rv-intro],#main [data-rv-item]';
  const SKIP='#hero,[data-no-rv],[role="dialog"],form,footer,button,a,label,[data-skel]';
  const after=(fn)=>requestAnimationFrame(()=>requestAnimationFrame(fn));

  const STEP={head:420,text:260};
  const secOf=(el)=>el.closest('[data-rv-group],section,article,[data-screen-label],main')||document.body;
  // Text in a group waits until every heading above it in that group has started
  const headsAbove=(g,el)=>[...(g._heads||[])].filter(h=>{if(!h.isConnected||h.offsetParent===null){g._heads.delete(h);return false}return h.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING});
  // flush anything still waiting on a heading that has since left the page
  setInterval(()=>{document.querySelectorAll('[data-rv-group],section,article,[data-screen-label],main').forEach(g=>{if(g._wait&&g._wait.length){const w=g._wait;g._wait=[];w.forEach(x=>{if(!x.el.isConnected)return;if(headsAbove(g,x.el).length)g._wait.push(x);else x.fn()})}})},500);
  function whenHeads(el,fn,grp){const g=grp||secOf(el);const hs=headsAbove(g,el);if(!hs.length){fn();return}(g._wait=g._wait||[]).push({el,fn})}
  function headFired(h){const g=secOf(h);g._heads&&g._heads.delete(h);const w=g._wait||[];g._wait=[];
    w.forEach(x=>{if(headsAbove(g,x.el).length)g._wait.push(x);else x.fn()})}
  // stagger within a group; never more than 700ms behind "now" so fast scrolling can't build a long queue
  function slot(el,kind,extra){const s=secOf(el),now=performance.now(),start=Math.min(now+700,Math.max(now,s._seq||0));s._seq=start+(extra!=null?extra:STEP[kind]);return start-now}
  function whole(el,name,dur,delay){
    if(!el.isConnected)return 0;el.style.animation='none';void el.offsetWidth;
    el.style.opacity='';el.style.animation=name+' '+dur+'ms '+EASE+' '+(delay||0)+'ms both';
    el.querySelectorAll('[data-rot]').forEach(s=>{s._busy=performance.now()+dur+(delay||0)+200});
    clearTimeout(el._wT);el._wT=setTimeout(()=>{el.style.animation='';el.style.willChange=''},dur+(delay||0)+80);
    return dur;
  }
  function prep(el,mode){
    if(el.dataset.rv||el.closest(SKIP))return;
    if(TOOL.includes(route())&&(mode==='lines'||el.tagName==='H2')){el.dataset.rv='skip';return}
    const txt=(el.textContent||'').trim();if(!txt||el.offsetParent===null)return;
    if(/mono/i.test(getComputedStyle(el).fontFamily)){el.dataset.rv='skip';return}
    el.dataset.rv='1';if(RM())return;
    el.style.opacity='0';el.style.willChange='opacity,transform,filter';
    const head=mode==='words'&&/^H[12]$/.test(el.tagName);
    if(head){const g=secOf(el);(g._heads=g._heads||new Set()).add(el)}
    const io=new IntersectionObserver(es=>{if(!es[0].isIntersecting)return;io.disconnect();
      if(head){whole(el,'mlBlurIn',900,slot(el,'head'));headFired(el);return}
      whenHeads(el,()=>whole(el,'mlLineIn',700,slot(el,'text',el.hasAttribute('data-rv-item')?130:null)))},{threshold:mode==='words'?0.35:0.3});
    io.observe(el);
  }

  // Content blocks: everything after a heading in its section rises in, strictly after that heading
  const MANAGED='[data-rv],[data-lr],[data-line-split],[data-rv-item],[data-rv-intro],[data-rot],[data-blk],h1,h2';
  function blocksFor(h){
    const g=secOf(h),out=[];let n=h;
    // labels above the heading (kickers) join the heading
    const before=[];let p=h.previousElementSibling;while(p){before.push(p);p=p.previousElementSibling}
    while(n&&n!==g&&g.contains(n)){let s=n.nextElementSibling;while(s){out.push(s);s=s.nextElementSibling}n=n.parentElement}
    const ok=(b)=>b.offsetParent!==null&&!/^(SCRIPT|STYLE|TEMPLATE|INPUT|NAV)$/.test(b.tagName)&&!b.closest(SKIP)&&!b.matches(MANAGED)&&!b.querySelector(MANAGED)&&!b.style.animation&&!b.style.opacity&&b.getAttribute('aria-hidden')!=='true';
    return {g,before:before.filter(ok),after:out.filter(ok)};
  }
  function blockReveal(el,g,kind){
    el.dataset.blk='1';el.style.opacity='0';
    const io=new IntersectionObserver(es=>{if(!es[0].isIntersecting)return;io.disconnect();if(!el.isConnected){return}
      if(kind==='kicker'){whole(el,'mlLineIn',600,0);return}
      whenHeads(el,()=>whole(el,'mlLineIn',650,slot(el,'text',110)),g)},{threshold:0,rootMargin:'0px 0px -8% 0px'});
    io.observe(el);
  }
  function blocks(){
    if(RM()||TOOL.includes(route()))return;
    document.querySelectorAll(HEAD).forEach(h=>{if(h.dataset.rv!=='1'||h._blk)return;h._blk=1;
      const {g,before,after}=blocksFor(h);before.forEach(b=>blockReveal(b,g,'kicker'));after.forEach(b=>blockReveal(b,g,'after'))});
  }
  // Hero: replay on every slide change, only for the visible slide
  let heroSlide=null,heroIn=true;
  const curSlide=()=>document.querySelector('#hero [aria-roledescription="slide"]:not([aria-hidden="true"])');
  function heroPlay(){
    if(RM())return;const sl=curSlide();
    if(!sl||sl===heroSlide||!heroIn)return;heroSlide=sl;
    sl.querySelectorAll('[data-hero-h],[data-hero-p]').forEach(el=>{
      const h=el.hasAttribute('data-hero-h');whole(el,h?'mlBlurIn':'mlLineIn',h?900:700,h?0:420);
    });
    rotSync();
  }
  function heroWatch(){
    const hero=document.getElementById('hero');if(!hero||hero._rv)return;hero._rv=1;
    new MutationObserver(()=>{if(RM())return;const sl=curSlide();
      if(sl&&sl!==heroSlide&&heroIn)sl.querySelectorAll('[data-hero-h],[data-hero-p]').forEach(el=>{el.style.opacity='0'}); // style only, before paint
      after(heroPlay)}).observe(hero,{subtree:true,attributes:true,attributeFilter:['aria-hidden']});
    new IntersectionObserver(es=>{heroIn=es[0].isIntersecting;if(!heroIn)heroSlide=null;else heroPlay()},{threshold:0.3}).observe(hero);
    heroSlide=null;heroPlay();
  }

  // Hero art: pointer parallax on the 3D tilt (custom properties only)
  function artTilt(){
    const hero=document.getElementById('hero');if(!hero||hero._tilt||RM())return;hero._tilt=1;
    let raf=0,tx=0,ty=0;
    hero.addEventListener('pointermove',e=>{if(e.pointerType!=='mouse')return;const r=hero.getBoundingClientRect();
      tx=(e.clientX-r.left)/r.width-0.5;ty=(e.clientY-r.top)/r.height-0.5;
      if(!raf)raf=requestAnimationFrame(()=>{raf=0;hero.style.setProperty('--ml-ry',(-6+tx*6).toFixed(2)+'deg');hero.style.setProperty('--ml-rx',(4-ty*4).toFixed(2)+'deg')})},{passive:true});
    hero.addEventListener('pointerleave',()=>{hero.style.removeProperty('--ml-ry');hero.style.removeProperty('--ml-rx')});
  }
  // Word rotator: words roll up through a clipped slot while the slot width eases to the next word (style-only, GSAP)
  const HOLD=1.4,ROLL=0.8,START=500;
  const slots=new Set();
  const live=(s)=>s._vis&&s.isConnected&&!s.closest('[aria-hidden="true"]:not([data-rot])');
  // Hero slots are scrubbed from the slide progress bar (single clock): rolls finish before the slide fades, no loop-back, pause/hover stay in sync
  const HERO_SL='[aria-roledescription="slide"]',HFIRST=1.8,HLAST=5.6;let hRaf=0;
  function heroClock(){hRaf=0;let any=false;
    const fill=document.querySelector('#hero [style*="mlProgress"]'),an=fill&&fill.getAnimations?fill.getAnimations()[0]:null;
    const t=an&&an.currentTime!=null?an.currentTime/1000:0;
    slots.forEach(s=>{if(!s._hero||!s._tl)return;if(!s.isConnected){slots.delete(s);return}any=true;
      const sl=s.closest(HERO_SL),on=sl&&sl.getAttribute('aria-hidden')!=='true';
      if(on){if(Math.abs(s._tl.time()-t)>0.001)s._tl.time(Math.min(t,s._tl.duration()))}
      else if(s._tl.time()!==0&&getComputedStyle(sl).visibility==='hidden')s._tl.time(0)});
    if(any)hRaf=requestAnimationFrame(heroClock)}
  function rotSync(){slots.forEach(s=>{if(!s.isConnected){slots.delete(s);return}if(!s._tl||s._hero)return;
    if(!live(s)){clearTimeout(s._t);s._t=0;s._tl.pause(0);rotDraw(s,0)}
    else if(s._tl.paused()&&!s._t){const wait=Math.max(0,(s._busy||0)-performance.now())+START;s._t=setTimeout(()=>{s._t=0;if(!live(s))return;if((s._busy||0)>performance.now()){rotSync();return}s._tl.play()},wait)}})}
  function rot(slot){
    if(slot._rot)return;const g=window.gsap;if(!g)return;
    const words=[...slot.querySelectorAll('[data-rot-w]')];if(words.length<2||RM())return;slot._rot=1;
    g.set(slot,{width:words[0].offsetWidth});
    words.forEach(w=>{w.style.position='absolute';w.style.left='0';w.style.top='0'});
    const n=words.length;
    if(!slot.closest('#hero '+HERO_SL)){
      // Loop: one clock, every word's position computed from it, so at most two words are ever in the slot and they never share it
      slot._words=words;slot._ww=words.map(w=>w.offsetWidth);rotDraw(slot,0);words.forEach(w=>{w.style.visibility='visible'});
      slot._tl=g.to({},{duration:n*(HOLD+ROLL),ease:'none',repeat:-1,paused:true,onUpdate(){rotDraw(slot,this.time())}});slots.add(slot);
      new IntersectionObserver(es=>{slot._vis=es[0].isIntersecting;rotSync()},{threshold:0.5}).observe(slot);return}
    g.set(words.slice(1),{yPercent:115});words.forEach(w=>{w.style.visibility='visible'});
    {slot._hero=1;const tl=g.timeline({paused:true}),step=n>2?(HLAST-ROLL-HFIRST)/(n-2):0;
      for(let i=0;i<n-1;i++){const cur=words[i],next=words[i+1],t=HFIRST+i*step;
        tl.fromTo(cur,{yPercent:0},{yPercent:-115,duration:ROLL,ease:'power3.inOut',immediateRender:false},t)
          .fromTo(next,{yPercent:115},{yPercent:0,duration:ROLL,ease:'power3.inOut',immediateRender:false},t)
          .fromTo(slot,{width:()=>cur.offsetWidth},{width:()=>next.offsetWidth,duration:ROLL,ease:'expo.inOut',immediateRender:false},t)}
      tl.time(0);slot._tl=tl;slot._words=words;slots.add(slot);if(!hRaf)hRaf=requestAnimationFrame(heroClock);return}
  }
  let EM,EW;
  function rotDraw(s,t){
    const W=s._words,n=W.length,C=HOLD+ROLL;if(!W||!s._ww)return;
    if(!EM){EM=window.gsap.parseEase('power3.inOut');EW=window.gsap.parseEase('expo.inOut')}
    t=((t%(n*C))+n*C)%(n*C);const i=Math.floor(t/C)%n,j=(i+1)%n,p=t-Math.floor(t/C)*C;
    const k=p<=HOLD?0:Math.min(1,(p-HOLD)/ROLL),e=EM(k),ew=EW(k);
    W.forEach((w,x)=>{const y=x===i?-115*e:x===j&&k>0?115*(1-e):115;w.style.transform='translate3d(0,'+y.toFixed(2)+'%,0)'});
    const a=s._ww[i],b=s._ww[j];s.style.width=(a+(b-a)*ew).toFixed(2)+'px';
    if(s._ph&&s._ph.isConnected)s._ph.style.width=s.style.width;
  }
  function rotScan(){if(!window.gsap||RM())return;
    const go=()=>document.querySelectorAll('[data-rot]').forEach(rot);
    document.fonts&&document.fonts.ready?document.fonts.ready.then(go):go()}
  let rzW=window.innerWidth;
  window.addEventListener('resize',()=>{const g=window.gsap;if(!g)return;if(window.innerWidth===rzW)return;rzW=window.innerWidth;slots.forEach(s=>{if(!s._tl)return;
    if(!s._hero){s._ww=s._words.map(w=>w.offsetWidth);rotDraw(s,s._tl.time());return}
    s._tl.invalidate();
    const cur=s._words.find(w=>Math.abs(g.getProperty(w,'yPercent'))<1)||s._words[0];g.set(s,{width:cur.offsetWidth})})});

  // Paragraph line reveal: real word spans (React-owned) grouped by offsetTop into lines; style-only animation
  function lineReveal(el){
    if(el.dataset.lr||el.offsetParent===null)return;el.dataset.lr='1';if(RM())return;
    const li=el.closest('li')||el.parentElement;
    const words=[...el.querySelectorAll('[data-w]')],lead=[...li.querySelectorAll('[data-w-lead]')];
    const all=[...lead,...words];
    all.forEach(w=>{w.style.opacity='0';w.style.transform='translateY(16px)'});
    const io=new IntersectionObserver(es=>{if(!es[0].isIntersecting)return;io.disconnect();if(!el.isConnected)return;whenHeads(el,()=>{
      let top=null,line=-1;words.forEach(w=>{const t=w.offsetTop;if(top===null||Math.abs(t-top)>4){top=t;line++}w.style.setProperty('--i',line)});
      lead.forEach(w=>w.style.setProperty('--i',0));
      const n=line+1,d=Math.round(slot(el,'text',n*170+90));
      all.forEach(w=>{w.style.willChange='opacity,transform';w.style.opacity='';w.style.transform='';
        w.style.animation='mlLineIn 700ms '+EASE+' calc(var(--i) * 170ms + '+d+'ms) both'});
      setTimeout(()=>all.forEach(w=>{w.style.animation='';w.style.willChange=''}),d+n*170+760)})},{threshold:0.4});
    io.observe(el);
  }

  // Start only after the runtime has mounted the app (window load + #main present, no streaming placeholders)
  const ready=()=>document.readyState==='complete'&&document.getElementById('main')&&!document.querySelector('[hint-placeholder],[data-dc-placeholder]');
  let queued=false,started=false;
  function scan(){if(queued)return;queued=true;after(()=>{queued=false;
    if(!ready()){setTimeout(scan,120);return}
    document.querySelectorAll(HEAD+','+PARA+',[data-line-split]').forEach(el=>{
      if(el.hasAttribute('data-line-split'))lineReveal(el);else if(el.matches(HEAD))prep(el,'words');else prep(el,'lines')});
    blocks();
    rotScan();heroWatch();artTilt();
  })}
  function boot(){if(started)return;started=true;scan();
    new MutationObserver(scan).observe(document.body,{childList:true,subtree:true,characterData:true})}
  if(document.readyState==='complete')boot();else window.addEventListener('load',boot);
})();
