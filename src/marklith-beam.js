// Hero light beam with floating dust (three.js). Mounts on any canvas[data-beam]; the canvas parent is the host.
import * as THREE from '../vendor/three/three.module.js';

const RM = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
const BASE = -2.3, SWING = 0.7, OX = 1.04, OY = 1.18, COUNT = 3400;
// Brand: navy #17243A ground, blue #356AE6 family for the light
const BEAM = new THREE.Color('#8FB0FF'), CORE = new THREE.Color('#E6EEFF'), DIM = new THREE.Color('#356AE6'), WHITE = new THREE.Color('#FFFFFF');

const ss = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
// Same beam function as the fragment shader, evaluated per mote
function beamAt(x, y, asp, ang) {
  const dx = Math.cos(ang), dy = Math.sin(ang), vx = x - asp * OX, vy = y - OY;
  const al = vx * dx + vy * dy, pe = Math.abs(vx * dy - vy * dx), hw = 0.07 + Math.max(al, 0) * 0.3;
  return (1 - ss(hw * 0.25, hw, pe)) * ss(0, 0.3, al) * (1 - ss(0.3, 2.2, al));
}

const beamVert = 'void main(){gl_Position=vec4(position.xy,0.,1.);}';
const beamFrag = `
precision highp float;
uniform vec2 uRes;uniform float uAng,uTime;uniform vec3 uBeam,uCore;
void main(){
  float asp=uRes.x/uRes.y;vec2 p=gl_FragCoord.xy/uRes.y;
  vec2 d=vec2(cos(uAng),sin(uAng));vec2 v=p-vec2(asp*${OX.toFixed(2)},${OY.toFixed(2)});
  float al=dot(v,d);float pe=abs(v.x*d.y-v.y*d.x);float hw=0.07+max(al,0.)*0.3;
  float w=1.-smoothstep(hw*0.25,hw,pe);
  float st=smoothstep(0.,0.3,al);
  float fd=1.-smoothstep(0.3,2.2,al);
  float core=1.-smoothstep(0.,hw*0.35,pe);
  float rip=0.92+0.08*sin(al*22.-uTime*0.8+pe*14.);
  float b=w*st*fd;
  float a=(b*0.16+core*b*0.1)*rip;
  gl_FragColor=vec4(mix(uBeam,uCore,core*0.8),a);
}`;
const dustVert = `
attribute float aAlpha;attribute float aSize;attribute vec3 aColor;
uniform float uPR;varying float vA;varying vec3 vC;
void main(){vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;
  gl_PointSize=aSize*uPR*(6.0/-mv.z);vA=aAlpha;vC=aColor;}`;
const dustFrag = `
precision highp float;varying float vA;varying vec3 vC;
void main(){float d=length(gl_PointCoord-.5);float s=smoothstep(.5,0.,d);s*=s;if(s<.003)discard;gl_FragColor=vec4(vC,vA*s);}`;

function mount(cv) {
  if (cv._ml) return; cv._ml = 1;
  const host = cv.parentElement;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas: cv, alpha: true, antialias: false, powerPreference: 'low-power' }); }
  catch (e) { return; }
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(50, 1, 0.1, 50); camera.position.z = 6;

  const beamMat = new THREE.ShaderMaterial({ vertexShader: beamVert, fragmentShader: beamFrag, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uAng: { value: BASE }, uTime: { value: 0 }, uBeam: { value: BEAM }, uCore: { value: CORE } } });
  const beamGeo = new THREE.PlaneGeometry(2, 2), beam = new THREE.Mesh(beamGeo, beamMat);
  beam.frustumCulled = false; beam.renderOrder = -1; scene.add(beam);

  const pos = new Float32Array(COUNT * 3), col = new Float32Array(COUNT * 3), alp = new Float32Array(COUNT), siz = new Float32Array(COUNT);
  const bx = new Float32Array(COUNT), by = new Float32Array(COUNT), bz = new Float32Array(COUNT), sp = new Float32Array(COUNT), ph = new Float32Array(COUNT), bs = new Float32Array(COUNT), tw = new Float32Array(COUNT);
  const geo = new THREE.BufferGeometry();
  const attr = (n, arr, k) => { const at = new THREE.BufferAttribute(arr, k); at.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(n, at); return at; };
  const aPos = attr('position', pos, 3), aCol = attr('aColor', col, 3), aAlp = attr('aAlpha', alp, 1), aSiz = attr('aSize', siz, 1);
  const dustMat = new THREE.ShaderMaterial({ vertexShader: dustVert, fragmentShader: dustFrag, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uPR: { value: 1 } } });
  const dust = new THREE.Points(geo, dustMat); dust.frustumCulled = false; dust.renderOrder = 1; scene.add(dust);

  let asp = 1;
  const halfH = (z) => Math.tan(THREE.MathUtils.degToRad(25)) * (camera.position.z - z);
  function seed(i, anyY) {
    const z = -3 + Math.random() * 4.5, hh = halfH(z), hw = hh * asp;
    bz[i] = z; bx[i] = (Math.random() * 2 - 1) * hw * 1.05;
    by[i] = anyY ? (Math.random() * 2 - 1) * hh * 1.05 : -hh * 1.08;
    sp[i] = 0.03 + Math.random() * 0.07; ph[i] = Math.random() * Math.PI * 2; bs[i] = 1.2 + Math.random() * 2.2; tw[i] = 1.5 + Math.random() * 3;
  }

  const v = new THREE.Vector3(), c = new THREE.Color();
  let ang = BASE, target = BASE, t = 0, last = 0, raf = 0, visible = true, pageOn = !document.hidden, dead = false;

  function resize() {
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight), pr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix(); asp = w / h;
    beamMat.uniforms.uRes.value.set(w * pr, h * pr); dustMat.uniforms.uPR.value = pr;
    for (let i = 0; i < COUNT; i++) seed(i, true);
    frame(0, true);
  }

  function frame(dt, still) {
    if (!still) { t += dt; ang += (target - ang) * Math.min(1, dt * 4); }
    beamMat.uniforms.uAng.value = ang; beamMat.uniforms.uTime.value = t;
    for (let i = 0; i < COUNT; i++) {
      if (!still) { by[i] += sp[i] * dt; if (by[i] > halfH(bz[i]) * 1.08) seed(i, false); }
      const x = bx[i] + Math.sin(t * 0.4 + ph[i]) * 0.06, y = by[i] + Math.cos(t * 0.3 + ph[i] * 1.3) * 0.03, z = bz[i];
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      v.set(x, y, z).project(camera);
      const b = beamAt((v.x * 0.5 + 0.5) * asp, v.y * 0.5 + 0.5, asp, ang);
      const twk = 0.65 + 0.35 * Math.sin(t * tw[i] + ph[i]);
      alp[i] = 0.07 + b * 0.75 * twk;
      siz[i] = bs[i] * (1 + b * 1.4);
      c.copy(DIM).lerp(WHITE, Math.min(1, b * 1.3));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    aPos.needsUpdate = aCol.needsUpdate = aAlp.needsUpdate = aSiz.needsUpdate = true;
    renderer.render(scene, camera);
  }

  function loop(now) {
    raf = 0; if (dead) return;
    if (!host.isConnected || !cv.isConnected) { dispose(); return; }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0; last = now;
    frame(dt, false);
    if (visible && pageOn && !RM()) raf = requestAnimationFrame(loop);
  }
  function wake() { if (!raf && visible && pageOn && !RM() && !dead) { last = 0; raf = requestAnimationFrame(loop); } }

  const onMove = (e) => {
    if (RM()) return;
    const r = host.getBoundingClientRect(); if (!r.width) return;
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) - 0.5;
    target = BASE + px * SWING;
  };
  const onVis = () => { pageOn = !document.hidden; wake(); };
  const mq = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const onMq = () => { if (RM()) { target = ang = BASE; frame(0, true); } else wake(); };

  const ro = new ResizeObserver(() => resize()); ro.observe(host);
  const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; wake(); }); io.observe(host);
  window.addEventListener('pointermove', onMove, { passive: true });
  document.addEventListener('visibilitychange', onVis);
  mq && mq.addEventListener && mq.addEventListener('change', onMq);

  function dispose() {
    if (dead) return; dead = true; cancelAnimationFrame(raf);
    ro.disconnect(); io.disconnect();
    window.removeEventListener('pointermove', onMove); document.removeEventListener('visibilitychange', onVis);
    mq && mq.removeEventListener && mq.removeEventListener('change', onMq);
    beamGeo.dispose(); beamMat.dispose(); geo.dispose(); dustMat.dispose(); renderer.dispose();
  }
  cv._dispose = dispose;
  resize(); wake();
}

function scan() {
  document.querySelectorAll('canvas[data-beam]').forEach(mount);
  document.querySelectorAll('canvas[data-beam]').forEach((cv) => {}); // mounted canvases dispose themselves when detached
}
new MutationObserver(() => { clearTimeout(scan._t); scan._t = setTimeout(scan, 50); }).observe(document.documentElement, { childList: true, subtree: true });
scan();
