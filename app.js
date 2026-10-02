const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const params = {
  grainSize:120, density:18, position:20, spray:12, pitch:0, jitter:.5, spread:70,
  reverseChance:15, stretch:1, wet:100,
  stutterChance:0, gate:45, repeatCount:3, pitchRamp:0,
  filter:15000, drive:5, delay:12, feedback:30, reverb:30, flange:8
};

let ctx, buffer, reversedBuffer, master, filterNode, shaper, dryGain, wetGain;
let delayNode, delayFeedback, delayWet, convolver, reverbWet, flangeDelay, flangeWet, flangeOsc, flangeOscGain;
let scheduler = null, playing = false, frozen = false, chaos = false, holdStutter = false, glitchAuto = false;
let playheadStart = 0, playheadOffset = 0, currentPosition = 0, activeSources = new Set();
let division = 8;
let mediaDest, recorder, recordedChunks = [];

function initAudio() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain(); master.gain.value = .9;
  filterNode = ctx.createBiquadFilter(); filterNode.type='lowpass'; filterNode.frequency.value=params.filter;
  shaper = ctx.createWaveShaper(); shaper.curve = makeDriveCurve(params.drive); shaper.oversample='4x';
  dryGain = ctx.createGain(); wetGain = ctx.createGain();
  dryGain.gain.value = 0; wetGain.gain.value = 1;

  delayNode = ctx.createDelay(2); delayNode.delayTime.value=.24;
  delayFeedback = ctx.createGain(); delayFeedback.gain.value=.3;
  delayWet = ctx.createGain(); delayWet.gain.value=.12;
  delayNode.connect(delayFeedback).connect(delayNode); delayNode.connect(delayWet);

  convolver = ctx.createConvolver(); convolver.buffer = impulseResponse(2.6,2.4);
  reverbWet = ctx.createGain(); reverbWet.gain.value=.3;
  convolver.connect(reverbWet);

  flangeDelay = ctx.createDelay(.05); flangeDelay.delayTime.value=.006;
  flangeWet = ctx.createGain(); flangeWet.gain.value=.08;
  flangeDelay.connect(flangeWet);
  flangeOsc = ctx.createOscillator(); flangeOsc.frequency.value=.18;
  flangeOscGain = ctx.createGain(); flangeOscGain.gain.value=.0035;
  flangeOsc.connect(flangeOscGain).connect(flangeDelay.delayTime); flangeOsc.start();

  wetGain.connect(filterNode).connect(shaper).connect(master);
  wetGain.connect(delayNode); delayWet.connect(master);
  wetGain.connect(convolver); reverbWet.connect(master);
  wetGain.connect(flangeDelay); flangeWet.connect(master);
  dryGain.connect(master);
  master.connect(ctx.destination);
  mediaDest = ctx.createMediaStreamDestination(); master.connect(mediaDest);
}

function impulseResponse(duration, decay) {
  const rate = ctx.sampleRate, len = rate*duration, impulse = ctx.createBuffer(2,len,rate);
  for (let c=0;c<2;c++) {
    const data=impulse.getChannelData(c);
    for(let i=0;i<len;i++) data[i]=(Math.random()*2-1)*Math.pow(1-i/len,decay);
  }
  return impulse;
}
function makeDriveCurve(amount){
  const n=2048, curve=new Float32Array(n), k=amount*4;
  for(let i=0;i<n;i++){ const x=i*2/n-1; curve[i]=((1+k)*x)/(1+k*Math.abs(x)); }
  return curve;
}

function buildKnobs(){
  $$('.knob-control').forEach(el=>{
    const key=el.dataset.param, min=+el.dataset.min, max=+el.dataset.max, step=+el.dataset.step;
    params[key] = params[key] ?? +el.dataset.value;
    const knob=document.createElement('div'); knob.className='knob';
    const label=document.createElement('div'); label.className='knob-label'; label.textContent=el.dataset.label;
    const value=document.createElement('div'); value.className='knob-value';
    el.append(knob,label,value);
    const update=()=>{
      const v=params[key], norm=(v-min)/(max-min), rot=-135+270*norm;
      knob.style.setProperty('--rot', `${rot}deg`);
      value.textContent=`${format(v)} ${el.dataset.unit}`;
      applyParam(key,v);
    };
    const set=(v)=>{ params[key]=clamp(Math.round(v/step)*step,min,max); update(); };
    let dragging=false,lastY=0;
    knob.addEventListener('pointerdown',e=>{dragging=true;lastY=e.clientY;knob.setPointerCapture(e.pointerId)});
    knob.addEventListener('pointermove',e=>{if(!dragging)return; const d=lastY-e.clientY; lastY=e.clientY; set(params[key]+d*step*((max-min)>1000?8:1));});
    knob.addEventListener('pointerup',()=>dragging=false);
    knob.addEventListener('wheel',e=>{e.preventDefault(); set(params[key]+(e.deltaY<0?step:-step));},{passive:false});
    el._set=set; update();
  });
}
function format(v){ return Math.abs(v)>=100 ? Math.round(v) : Number(v.toFixed(2)); }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function setParam(key,v){ const el=$(`.knob-control[data-param="${key}"]`); if(el&&el._set) el._set(v); else {params[key]=v;applyParam(key,v);} }

function applyParam(key,v){
  if(!ctx) return;
  const t=ctx.currentTime;
  if(key==='filter') filterNode.frequency.setTargetAtTime(v,t,.02);
  if(key==='drive') shaper.curve=makeDriveCurve(v);
  if(key==='wet'){ wetGain.gain.setTargetAtTime(v/100,t,.02); dryGain.gain.setTargetAtTime(1-v/100,t,.02); }
  if(key==='delay') delayWet.gain.setTargetAtTime(v/100,t,.02);
  if(key==='feedback') delayFeedback.gain.setTargetAtTime(v/100,t,.02);
  if(key==='reverb') reverbWet.gain.setTargetAtTime(v/100,t,.02);
  if(key==='flange') flangeWet.gain.setTargetAtTime(v/100,t,.02);
  if(key==='position') $('#region').style.left=`${v}%`;
}

async function loadFile(file){
  initAudio(); await ctx.resume();
  const arr=await file.arrayBuffer();
  buffer=await ctx.decodeAudioData(arr.slice(0));
  reversedBuffer=reverseAudioBuffer(buffer);
  $('#fileName').textContent=file.name.toUpperCase();
  $('#timeReadout').textContent=`00:00.000 / ${fmtTime(buffer.duration)}`;
  $('#playBtn').disabled=$('#stopBtn').disabled=$('#recordBtn').disabled=false;
  drawWaveform(buffer); currentPosition=0; setParam('position',0); $('#engineStatus').textContent='READY';
}
function reverseAudioBuffer(src){
  const out=ctx.createBuffer(src.numberOfChannels,src.length,src.sampleRate);
  for(let c=0;c<src.numberOfChannels;c++){ const s=src.getChannelData(c), d=out.getChannelData(c); for(let i=0,j=s.length-1;i<s.length;i++,j--) d[i]=s[j]; }
  return out;
}

function start(){
  if(!buffer) return; initAudio(); ctx.resume();
  stopSources(); playing=true; $('#playBtn').textContent='❚❚ PAUSE'; $('#engineStatus').textContent='RUN';
  playheadStart=performance.now(); playheadOffset=currentPosition;
  scheduler=setInterval(scheduleTick, 18);
  requestAnimationFrame(updateUI);
}
function pause(){
  playing=false; clearInterval(scheduler); scheduler=null; stopSources(); $('#playBtn').textContent='▶ PLAY'; $('#engineStatus').textContent='PAUSE';
}
function stop(){
  pause(); currentPosition=0; playheadOffset=0; $('#playhead').style.left='0%'; $('#timeReadout').textContent=`00:00.000 / ${buffer?fmtTime(buffer.duration):'00:00.000'}`; $('#engineStatus').textContent=buffer?'READY':'IDLE';
}
function stopSources(){ activeSources.forEach(s=>{try{s.stop()}catch{}}); activeSources.clear(); }

let nextGrainTime=0;
function scheduleTick(){
  if(!playing||!buffer) return;
  const now=ctx.currentTime, interval=1/Math.max(1,params.density);
  if(nextGrainTime<now) nextGrainTime=now;
  while(nextGrainTime<now+.08){ spawnGrain(nextGrainTime); nextGrainTime+=interval; }
}
function spawnGrain(when){
  const dur=Math.max(.015,params.grainSize/1000);
  const base=(params.position/100)*Math.max(0,buffer.duration-dur);
  const spraySecs=(params.spray/100)*Math.min(3,buffer.duration*.3);
  const stutter = holdStutter || Math.random()*100<params.stutterChance || (glitchAuto && Math.random()<.08);
  let pos = frozen ? base : base + (Math.random()*2-1)*spraySecs;
  if(stutter){
    const beat=60/(+$('#bpm').value||138), step=beat*(4/division);
    const block=Math.floor((ctx.currentTime/step)%Math.max(1,params.repeatCount));
    pos=base + block*0.0001;
  }
  pos=clamp(pos,0,Math.max(0,buffer.duration-dur));
  const reverse=Math.random()*100<params.reverseChance;
  const src=ctx.createBufferSource(); src.buffer=reverse?reversedBuffer:buffer;
  const semis=params.pitch + (Math.random()*2-1)*params.jitter + (stutter?params.pitchRamp*Math.random():0);
  src.playbackRate.value=Math.pow(2,semis/12)/Math.max(.2,params.stretch);
  const gain=ctx.createGain(); const pan=ctx.createStereoPanner();
  pan.pan.value=(Math.random()*2-1)*(params.spread/100);
  const attack=dur*.22, release=dur*.35;
  gain.gain.setValueAtTime(.0001,when); gain.gain.exponentialRampToValueAtTime(.72,when+attack);
  const gateFactor=stutter?Math.max(.05,params.gate/100):1;
  gain.gain.setValueAtTime(.72,when+Math.max(attack,dur*gateFactor-release));
  gain.gain.exponentialRampToValueAtTime(.0001,when+dur*gateFactor);
  src.connect(gain).connect(pan).connect(wetGain);
  activeSources.add(src); src.onended=()=>activeSources.delete(src);
  const offset=reverse?Math.max(0,buffer.duration-pos-dur):pos;
  try{src.start(when,offset,dur);}catch{}
}

function updateUI(){
  if(!playing||!buffer) return;
  if(!frozen){
    const elapsed=(performance.now()-playheadStart)/1000;
    currentPosition=(playheadOffset + elapsed/buffer.duration*100)%100;
    setParam('position',currentPosition);
  }
  $('#playhead').style.left=`${currentPosition}%`;
  $('#timeReadout').textContent=`${fmtTime(buffer.duration*currentPosition/100)} / ${fmtTime(buffer.duration)}`;
  requestAnimationFrame(updateUI);
}

function drawWaveform(buf){
  const canvas=$('#waveform'), g=canvas.getContext('2d'), w=canvas.width,h=canvas.height;
  g.clearRect(0,0,w,h); g.fillStyle='#050707'; g.fillRect(0,0,w,h);
  const data=buf.getChannelData(0), step=Math.ceil(data.length/w), amp=h/2;
  g.strokeStyle='#b9ff66'; g.globalAlpha=.85; g.beginPath();
  for(let x=0;x<w;x++){ let min=1,max=-1; const start=x*step; for(let j=0;j<step&&start+j<data.length;j++){const v=data[start+j]; if(v<min)min=v;if(v>max)max=v;} g.moveTo(x,(1+min)*amp); g.lineTo(x,(1+max)*amp); }
  g.stroke(); g.globalAlpha=1;
}
function fmtTime(sec){ const m=Math.floor(sec/60), s=Math.floor(sec%60), ms=Math.floor((sec%1)*1000); return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms).padStart(3,'0')}`; }

const presets={
  digitalAngel:{grainSize:145,density:28,spray:28,pitch:12,jitter:2.2,spread:95,reverseChance:18,stretch:1.35,filter:17500,drive:6,delay:22,feedback:35,reverb:58,flange:18,stutterChance:8},
  y2kVocal:{grainSize:85,density:34,spray:8,pitch:7,jitter:.8,spread:72,reverseChance:7,stretch:1,filter:13200,drive:12,delay:16,feedback:25,reverb:34,flange:8,stutterChance:18,gate:42},
  brokenCd:{grainSize:34,density:50,spray:42,pitch:0,jitter:5,spread:100,reverseChance:44,stretch:.72,filter:7600,drive:54,delay:8,feedback:52,reverb:12,flange:35,stutterChance:48,gate:18,repeatCount:5,pitchRamp:-5},
  silverPad:{grainSize:390,density:14,spray:18,pitch:0,jitter:.4,spread:100,reverseChance:30,stretch:2.1,filter:11600,drive:2,delay:34,feedback:46,reverb:82,flange:21,stutterChance:0},
  vocalShred:{grainSize:42,density:55,spray:16,pitch:5,jitter:3.4,spread:82,reverseChance:24,stretch:.88,filter:14500,drive:28,delay:13,feedback:34,reverb:25,flange:11,stutterChance:62,gate:21,repeatCount:4,pitchRamp:4},
  glassChoir:{grainSize:210,density:22,spray:20,pitch:12,jitter:1.1,spread:100,reverseChance:22,stretch:1.65,filter:18000,drive:4,delay:30,feedback:40,reverb:74,flange:16,stutterChance:4},
  microStutter:{grainSize:24,density:60,spray:3,pitch:0,jitter:.25,spread:52,reverseChance:10,stretch:1,filter:16000,drive:16,delay:5,feedback:22,reverb:18,flange:5,stutterChance:82,gate:10,repeatCount:6,pitchRamp:2},
  heavenGate:{grainSize:310,density:18,spray:35,pitch:7,jitter:1.5,spread:100,reverseChance:38,stretch:1.8,filter:15800,drive:3,delay:39,feedback:48,reverb:90,flange:14,stutterChance:5}
};
function loadPreset(name){ Object.entries(presets[name]).forEach(([k,v])=>setParam(k,v)); $('#presetName').textContent=`PRESET: ${name.replace(/([A-Z])/g,' $1').toUpperCase()}`; $$('#presetGrid button').forEach(b=>b.classList.toggle('selected',b.dataset.preset===name)); }

function randomize(){
  ['grainSize','density','spray','pitch','jitter','spread','reverseChance','stretch','filter','drive','delay','feedback','reverb','flange','stutterChance','gate'].forEach(k=>{
    const el=$(`.knob-control[data-param="${k}"]`); if(!el)return; const min=+el.dataset.min,max=+el.dataset.max; setParam(k,min+Math.random()*(max-min));
  });
}
function applyChaos(){ if(!chaos)return; setParam('spray',clamp(params.spray+Math.random()*18-9,0,100)); setParam('jitter',clamp(params.jitter+Math.random()*1.5-.75,0,12)); setParam('reverseChance',clamp(params.reverseChance+Math.random()*12-6,0,100)); }
setInterval(applyChaos,700);

async function toggleRecord(){
  initAudio(); await ctx.resume();
  if(recorder&&recorder.state==='recording'){ recorder.stop(); $('#recordBtn').textContent='● RECORD OUTPUT'; return; }
  recordedChunks=[]; recorder=new MediaRecorder(mediaDest.stream,{mimeType:'audio/webm'});
  recorder.ondataavailable=e=>{if(e.data.size)recordedChunks.push(e.data)};
  recorder.onstop=()=>{ const blob=new Blob(recordedChunks,{type:'audio/webm'}); const url=URL.createObjectURL(blob); $('#downloadLink').href=url; $('#downloadLink').classList.remove('hidden'); $('#downloadLink').textContent='DOWNLOAD RECORDING'; };
  recorder.start(); $('#recordBtn').textContent='■ STOP RECORDING'; if(!playing) start();
}

$('#loadBtn').onclick=()=>$('#fileInput').click();
$('#fileInput').onchange=e=>e.target.files[0]&&loadFile(e.target.files[0]);
$('#dropZone').ondragover=e=>{e.preventDefault();e.currentTarget.classList.add('drag')};
$('#dropZone').ondragleave=e=>e.currentTarget.classList.remove('drag');
$('#dropZone').ondrop=e=>{e.preventDefault();e.currentTarget.classList.remove('drag');const f=e.dataTransfer.files[0]; if(f)loadFile(f)};
$('#playBtn').onclick=()=>playing?pause():start(); $('#stopBtn').onclick=stop;
$('#freezeBtn').onclick=e=>{frozen=!frozen;e.currentTarget.classList.toggle('active',frozen)};
$('#chaosBtn').onclick=e=>{chaos=!chaos;e.currentTarget.classList.toggle('active',chaos)};
$('#randomizeBtn').onclick=randomize;
$('#stutterHoldBtn').onclick=e=>{holdStutter=!holdStutter;e.currentTarget.classList.toggle('active',holdStutter)};
$('#glitchBtn').onclick=e=>{glitchAuto=!glitchAuto;e.currentTarget.classList.toggle('active',glitchAuto)};
$$('.division').forEach(b=>b.onclick=()=>{division=+b.dataset.div; $$('.division').forEach(x=>x.classList.remove('active')); b.classList.add('active')});
$$('#presetGrid button').forEach(b=>b.onclick=()=>loadPreset(b.dataset.preset));
$('#recordBtn').onclick=toggleRecord;
$('#waveform').onclick=e=>{if(!buffer)return; const r=e.currentTarget.getBoundingClientRect(); const p=(e.clientX-r.left)/r.width*100; setParam('position',p); currentPosition=p; playheadOffset=p; playheadStart=performance.now();};

buildKnobs();
