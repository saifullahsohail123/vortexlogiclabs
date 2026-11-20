'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const defaultSettings = {
  business_name: 'Vortex Logic Labs',
  receptionist_name: 'Aria',
  address: 'Islamabad / Remote',
  business_phone: '+92 311 5801109',
  timezone: 'Asia/Karachi',
  opening_hour: 9,
  closing_hour: 18,
  slot_minutes: 30,
  open_days: [0, 1, 2, 3, 4],
  services: [
    'AI Architecture Consultation (45 min)',
    'Enterprise Cloud Scoping (30 min)',
    'Autonomous Systems Demo (60 min)'
  ],
  llm_provider: 'guided',
  stt_provider: 'whisper',
  tts_provider: 'kokoro',
  tts_speed: 1.0,
  vad_threshold: 0.02,
  silence_ms: 1200
};

const defaultDashboard = {
  calls: [
    { id: '1042', started_at: new Date(Date.now() - 3600000).toISOString(), channel: 'web', provider: 'Aria Neural', status: 'completed' },
    { id: '1041', started_at: new Date(Date.now() - 18000000).toISOString(), channel: 'web', provider: 'Aria Neural', status: 'completed' }
  ],
  appointments: [
    { id: 'apt-01', name: 'Alexander Wright', phone: '+1 555 0192', service: 'AI Architecture Consultation (45 min)', start_at: new Date(Date.now() + 86400000).toISOString(), status: 'booked' },
    { id: 'apt-02', name: 'Sophia Chen', phone: '+1 555 0834', service: 'Enterprise Cloud Scoping (30 min)', start_at: new Date(Date.now() + 172800000).toISOString(), status: 'booked' }
  ],
  customers: [
    { id: 'c-1', name: 'Alexander Wright', phone: '+1 555 0192', notes: 'Interested in LangGraph & Voice agents.', created_at: new Date().toISOString() },
    { id: 'c-2', name: 'Sophia Chen', phone: '+1 555 0834', notes: 'CTO exploring CTI & defense telemetry.', created_at: new Date().toISOString() }
  ],
  handoffs: [],
  metrics: [
    { provider: 'Aria Dialogue', turns: 42, mean_ms: 180 }
  ],
  upcoming: [
    { id: 'apt-01', name: 'Alexander Wright', phone: '+1 555 0192', service: 'AI Architecture Consultation (45 min)', start_at: new Date(Date.now() + 86400000).toISOString(), status: 'booked' }
  ]
};

let cfg = { ...defaultSettings };
let dashboard = { ...defaultDashboard };
let health = { database: 'browser-storage', speech_ready: true, neural_voice_installed: true };
let currentPage='overview', socket=null, callId=null, operatorId=null;
let ctx=null, micStream=null, micSource=null, worklet=null, muted=false, audioNodes=new Set(), playbackAt=0, audioGeneration=0, decodeChain=Promise.resolve(), toastTimer;
let closingCall=false, isLocalDemo=false;
let synth = window.speechSynthesis || null;
let speechRecognizer = null;

async function api(path,options={}){
  try {
    const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
    if(!response.ok){let detail;try{detail=(await response.json()).detail}catch{detail=response.statusText}throw Error(typeof detail==='string'?detail:JSON.stringify(detail))}
    return response.json();
  } catch(err) {
    throw err;
  }
}

function toast(text,error=false){const t=$('#toast');t.textContent=text;t.className='show'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.className='',6500)}

function page(name){
  currentPage=name;
  $$('.page').forEach(el=>el.classList.toggle('active',el.id==='page-'+name));
  $$('.nav').forEach(el=>el.classList.toggle('active',el.dataset.page===name));
  $('#breadcrumb').textContent=({overview:'Overview',reception:'Reception desk',appointments:'Appointments',customers:'Customers',calls:'Call history',handoffs:'Human handoffs',settings:'Settings & providers'})[name];
  if(name==='settings')loadSettings();
  if(name==='handoffs')renderHandoffs();
  window.scrollTo(0,0);
}

document.addEventListener('click',event=>{const target=event.target.closest('[data-page]');if(target)page(target.dataset.page)});
$('#go-reception').onclick=()=>page('reception');
$('#hero-call').onclick=()=>{page('reception');startCall()};

function date(value,options={}){return new Intl.DateTimeFormat('en-GB',{timeZone:cfg.timezone||'Asia/Karachi',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',...options}).format(new Date(value))}
function localDay(value=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:cfg.timezone||'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(value)}
function status(value){return `<span class="status ${esc(value)}">${esc(value.replace('_',' '))}</span>`}

async function refresh(){
  try{
    dashboard=await api('/api/dashboard');
    render();
    if(operatorId)await refreshOperator();
  }catch(e){
    // Keep local dashboard rendered
    $('#connection').textContent='● Live Demo Online';
    render();
  }
}

async function refreshHealth(){
  try{
    health=await api('/api/health');
    $('#connection').textContent='● Server Online';
    renderSystem();
    renderDiagnostics();
  }catch{
    $('#connection').textContent='● Cloud Demo Online';
    renderSystem();
    renderDiagnostics();
  }
}

function render(){
  $('#stat-calls').textContent=dashboard.total_calls??dashboard.calls.length;
  $('#stat-bookings').textContent=dashboard.upcoming.length;
  $('#stat-customers').textContent=dashboard.customers.length;
  const waiting=dashboard.handoffs.filter(h=>h.status!=='resolved').length;
  $('#stat-handoffs').textContent=waiting;
  $('#queue-badge').textContent=waiting;
  $('#upcoming-list').innerHTML=dashboard.upcoming.slice().sort((a,b)=>a.start_at.localeCompare(b.start_at)).slice(0,3).map(a=>`<div class="mini-booking"><div class="mini-date">${esc(date(a.start_at,{month:'short',day:undefined,hour:undefined,minute:undefined}).toUpperCase())}<strong>${esc(date(a.start_at,{month:undefined,day:'2-digit',hour:undefined,minute:undefined}))}</strong></div><div><h4>${esc(a.name)}</h4><p>${esc(a.service)}</p></div><span>${esc(date(a.start_at,{day:undefined,month:undefined}))}</span></div>`).join('')||'<div class="empty"><span class="empty-illustration">▦</span>A clear calendar. A fresh start.<small>Your next appointment will appear here.</small></div>';
  renderAppointments();
  renderCustomers();
  renderCalls();
  if(currentPage==='handoffs')renderHandoffs();
}

function renderSystem(){
  const rows=[
    ['Speech recognition', 'Web Speech / Whisper · ready', false],
    ['Conversation engine', 'Aria Neural Agent · active', false],
    ['Voice output', 'Web Neural Voice · active', false],
    ['Calendar & data', 'Cloud Demo Storage · synced', false]
  ];
  $('#system-list').innerHTML=rows.map(([name,value,warn])=>`<div class="system-row"><span class="tiny-dot"></span><strong>${esc(name)}</strong><span class="${warn?'state-warn':''}">${esc(value)}</span></div>`).join('');
}

function renderAppointments(){
  const query=$('#appointment-search').value.toLowerCase(),filter=$('#appointment-filter').value;
  const list=dashboard.appointments.filter(a=>(filter==='all'||filter==='cancelled'&&a.status==='cancelled'||filter==='upcoming'&&a.status==='booked'&&new Date(a.start_at)>new Date())&&[a.name,a.phone,a.service,a.id].some(v=>v.toLowerCase().includes(query)));
  $('#appointment-rows').innerHTML=list.map(a=>`<tr><td><strong>${esc(a.name)}</strong><small>${esc(a.phone)}</small></td><td>${esc(a.service)}<small>#${esc(a.id)}</small></td><td>${esc(date(a.start_at))}<small>${esc(cfg.timezone)}</small></td><td>${status(a.status)}</td><td>${a.status==='booked'?`<button class="link" data-reschedule="${a.id}">Reschedule</button><button class="link" data-cancel="${a.id}">Cancel</button>`:''}</td></tr>`).join('');
  $('#appointment-empty').classList.toggle('hidden',list.length>0);
}
$('#appointment-search').oninput=renderAppointments;
$('#appointment-filter').onchange=renderAppointments;

function renderCustomers(){
  const query=$('#customer-search').value.toLowerCase();
  const list=dashboard.customers.filter(c=>c.name.toLowerCase().includes(query)||c.phone.includes(query));
  $('#customer-rows').innerHTML=list.map(c=>`<tr><td><strong>${esc(c.name)}</strong><small>Added ${esc(date(c.created_at,{hour:undefined,minute:undefined}))}</small></td><td>${esc(c.phone)}</td><td>${esc(c.notes)||'—'}</td><td><button class="link" data-customer="${c.id}">Edit details</button></td></tr>`).join('');
  $('#customer-empty').classList.toggle('hidden',list.length>0);
}
$('#customer-search').oninput=renderCustomers;

function renderCalls(){
  $('#call-rows').innerHTML=dashboard.calls.map(c=>`<tr><td><strong>#${esc(c.id)}</strong></td><td>${esc(date(c.started_at))}</td><td>${esc(c.channel)}</td><td>${esc(c.provider)}</td><td>${status(c.status)}</td><td><button class="link" data-transcript="${c.id}">Transcript ↗</button></td></tr>`).join('');
  $('#call-empty').classList.toggle('hidden',dashboard.calls.length>0);
  $('#metric-cards').innerHTML=dashboard.metrics.map(m=>`<div class="metric"><strong>${Math.round(m.mean_ms)} ms</strong>${esc(m.provider)} · ${m.turns} turns · mean response latency</div>`).join('');
}

function renderHandoffs(){
  $('#handoff-list').innerHTML=dashboard.handoffs.map(h=>`<article class="panel handoff-card"><div class="panel-heading">${status(h.status)}<span class="muted">${esc(date(h.created_at))}</span></div><h3>${esc(h.reason)}</h3><p>Callback: ${esc(h.phone||'Not supplied')}<br>Conversation #${esc(h.call_id)}</p><div class="actions">${h.status!=='resolved'?`<button class="button primary" data-take="${h.id}">Take over</button><button class="button secondary" data-resolve="${h.id}">Mark resolved</button>`:''}<button class="link" data-transcript="${h.call_id}">View transcript</button></div></article>`).join('')||'<article class="panel empty">All quiet on the front desk.<small>Requests for human help will appear here.</small></article>';
}

function openModal(title,body){$('#modal-title').textContent=title;$('#modal-body').innerHTML=body;$('#modal').showModal()}
$('#modal-close').onclick=()=>$('#modal').close();
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close()}});

function bookingForm(old=null){
  openModal(old?'Reschedule appointment':'New appointment',`<form id="booking-form" class="modal-form"><label>Customer name<input name="name" value="${esc(old?.name||'')}" required minlength="2" maxlength="100"></label><label>Phone number<input name="phone" value="${esc(old?.phone||'')}" required minlength="7" maxlength="30"></label><label>Service<select name="service">${cfg.services.map(s=>`<option${old?.service===s?' selected':''}>${esc(s)}</option>`).join('')}</select></label><label>Date (${esc(cfg.timezone)})<input name="day" type="date" value="${localDay()}" min="${localDay()}" required></label><label>Available time<select name="start_at" required><option value="10:00:00">10:00 AM</option><option value="11:30:00">11:30 AM</option><option value="14:00:00">02:00 PM</option><option value="15:30:00">03:30 PM</option><option value="16:30:00">04:30 PM</option></select></label><label>Notes<textarea name="notes" rows="2" maxlength="2000">${esc(old?.notes||'')}</textarea></label><div class="info">${old?'Confirming replaces the previous appointment only if the new slot is still available.':'Confirming saves this appointment to your calendar.'}</div><button class="button primary" type="submit">${old?'Confirm reschedule':'Confirm booking'}</button></form>`);
  const form=$('#booking-form');
  form.onsubmit=async e=>{
    e.preventDefault();
    const data=Object.fromEntries(new FormData(form));
    const fullDate = `${data.day}T${data.start_at}Z`;
    const newApt = {
      id: old ? old.id : 'apt-' + Math.floor(Math.random()*9000 + 1000),
      name: data.name,
      phone: data.phone,
      service: data.service,
      start_at: fullDate,
      status: 'booked'
    };
    if (old) {
      dashboard.appointments = dashboard.appointments.map(a => a.id === old.id ? newApt : a);
    } else {
      dashboard.appointments.unshift(newApt);
      dashboard.upcoming.unshift(newApt);
      dashboard.customers.unshift({ id: 'c-' + Date.now(), name: data.name, phone: data.phone, notes: data.service, created_at: new Date().toISOString() });
    }
    $('#modal').close();
    toast('Appointment '+(old?'rescheduled':'booked'));
    render();
  };
}
$('#new-booking').onclick=()=>bookingForm();

function customerForm(old=null){
  openModal(old?'Customer details':'Add customer',`<form id="customer-form" class="modal-form"><label>Full name<input name="name" value="${esc(old?.name||'')}" required minlength="2" maxlength="100"></label><label>Phone<input name="phone" value="${esc(old?.phone||'')}" required minlength="7" maxlength="30"></label><label>Notes<textarea name="notes" rows="4" maxlength="2000">${esc(old?.notes||'')}</textarea></label><button class="button primary">Save customer</button></form>`);
  $('#customer-form').onsubmit=async e=>{
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    if (old) {
      dashboard.customers = dashboard.customers.map(c => c.id === old.id ? { ...c, ...data } : c);
    } else {
      dashboard.customers.unshift({ id: 'c-' + Date.now(), ...data, created_at: new Date().toISOString() });
    }
    $('#modal').close();
    toast('Customer saved');
    render();
  };
}
$('#new-customer').onclick=()=>customerForm();

document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  try{
    if(b.dataset.reschedule)bookingForm(dashboard.appointments.find(a=>a.id===b.dataset.reschedule));
    if(b.dataset.cancel){
      const a=dashboard.appointments.find(a=>a.id===b.dataset.cancel);
      openModal('Cancel appointment',`<div class="confirmation">Cancel ${esc(a.service)} for ${esc(a.name)} on ${esc(date(a.start_at))}?</div><button class="button danger" id="confirm-cancel">Confirm cancellation</button>`);
      $('#confirm-cancel').onclick=async()=>{
        a.status = 'cancelled';
        dashboard.upcoming = dashboard.upcoming.filter(u => u.id !== a.id);
        $('#modal').close();
        toast('Appointment cancelled');
        render();
      };
    }
    if(b.dataset.customer)customerForm(dashboard.customers.find(c=>c.id===b.dataset.customer));
    if(b.dataset.prompt)sendText(b.dataset.prompt);
  }catch(e){toast(e.message,true)}
});

function messageHTML(m){return `<div class="message ${esc(m.role)}"><div class="message-label">${esc(m.role==='assistant'?cfg.receptionist_name:m.role==='user'?'Caller':m.role)}</div><div class="message-content">${esc(m.content)}</div></div>`}
function appendMessage(role,content){if($('#messages .conversation-empty'))$('#messages').innerHTML='';$('#messages').insertAdjacentHTML('beforeend',messageHTML({role,content}));$('#messages').scrollTop=$('#messages').scrollHeight}

function speakDemo(text){
  if(!synth || !$('#voice-enabled').checked) return;
  synth.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1.05;
  const voices = synth.getVoices();
  const femaleVoice = voices.find(v => (v.name.includes('Samantha') || v.name.includes('Google') || v.name.includes('Zira') || v.name.includes('Natural')) && v.lang.startsWith('en'));
  if(femaleVoice) utter.voice = femaleVoice;
  utter.onstart = () => { $('#voice-status').textContent='Speaking…'; $('.voice-orb').classList.add('speaking'); };
  utter.onend = () => { $('#voice-status').textContent='Listening…'; $('.voice-orb').classList.remove('speaking'); };
  synth.speak(utter);
}

function processAriaDemoTurn(text) {
  const lower = text.toLowerCase();
  let reply = "";
  let suggestions = [];

  if (lower.includes('book') || lower.includes('appointment') || lower.includes('schedule')) {
    reply = "I would be happy to schedule an appointment for you! We offer AI Architecture Consultations and Enterprise Cloud Scoping. What day and time works best for you?";
    suggestions = [{ label: "Tomorrow at 10 AM", text: "Tomorrow at 10 AM for AI Architecture" }, { label: "Our Services", text: "What services do you provide?" }];
  } else if (lower.includes('hour') || lower.includes('time') || lower.includes('open')) {
    reply = "Our engineering studio is active Monday through Friday from 9:00 AM to 6:00 PM. Would you like to schedule a call during those hours?";
    suggestions = [{ label: "Book a slot", text: "I want to book an appointment" }];
  } else if (lower.includes('service') || lower.includes('offer') || lower.includes('do')) {
    reply = "At Vortex Logic Labs, we design and deploy autonomous AI agents (LangGraph, MCP), real-time voice receptionists, cyber threat intelligence platforms, and high-performance cloud backends.";
    suggestions = [{ label: "Book a consultation", text: "I want to book an appointment" }, { label: "Contact Saif", text: "How can I contact Saif Ullah?" }];
  } else if (lower.includes('saif') || lower.includes('contact') || lower.includes('human') || lower.includes('speak to')) {
    reply = "Saif Ullah is the Lead Architect here at Vortex Logic Labs. You can connect with him directly at saifu0905@gmail.com or via LinkedIn at linkedin.com/in/saif-ullah-sohail.";
    suggestions = [{ label: "View Portfolio", text: "Tell me about his portfolio" }];
  } else if (lower.includes('tomorrow') || lower.includes('10 am') || lower.includes('confirm')) {
    const bookedApt = {
      id: 'apt-' + Math.floor(Math.random()*9000 + 1000),
      name: 'Demo Client',
      phone: '+1 555 0100',
      service: 'AI Architecture Consultation (45 min)',
      start_at: new Date(Date.now() + 86400000).toISOString(),
      status: 'booked'
    };
    dashboard.appointments.unshift(bookedApt);
    dashboard.upcoming.unshift(bookedApt);
    render();
    reply = "Wonderful! I have booked your AI Architecture Consultation for tomorrow at 10:00 AM. It has been confirmed and added to our calendar.";
    suggestions = [{ label: "Opening hours", text: "What are your opening hours?" }, { label: "Thank you", text: "Thank you Aria!" }];
  } else {
    reply = "Thank you for reaching out to Vortex Logic Labs front desk. I can help book a meeting, explain our AI engineering solutions, or route your inquiry to our engineering team.";
    suggestions = [{ label: "Book appointment", text: "I want to book an appointment" }, { label: "What are your hours?", text: "What are your opening hours?" }];
  }

  appendMessage('assistant', reply);
  speakDemo(reply);
  if(suggestions.length > 0) {
    $('.quick-prompts').innerHTML = suggestions.map(s => `<button data-prompt="${esc(s.text)}">${esc(s.label)}</button>`).join('');
  }
}

function startWebSpeechRecognizer() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  if(!SpeechRec) return;
  speechRecognizer = new SpeechRec();
  speechRecognizer.continuous = false;
  speechRecognizer.interimResults = true;
  speechRecognizer.lang = 'en-US';

  speechRecognizer.onstart = () => {
    $('#voice-status').textContent = 'Listening to your voice…';
    $('#meter-fill').style.width = '60%';
  };
  speechRecognizer.onresult = (e) => {
    let final = '';
    for(let i=e.resultIndex; i<e.results.length; ++i){
      if(e.results[i].isFinal) final += e.results[i][0].transcript;
      else $('#interim').textContent = e.results[i][0].transcript;
    }
    if(final){
      $('#interim').textContent = '';
      sendText(final);
    }
  };
  speechRecognizer.onend = () => {
    $('#meter-fill').style.width = '0%';
    if(isLocalDemo && !closingCall) {
      try { speechRecognizer.start(); } catch(err){}
    }
  };
  try { speechRecognizer.start(); } catch(err){}
}

async function startCall(){
  closingCall = false;
  $('#start-call').classList.add('hidden');
  ['end-call','mute-call','interrupt-call'].forEach(id=>$('#'+id).classList.remove('hidden'));
  $('.voice-panel').classList.add('live');
  $('#voice-status').textContent='Connected';
  $('#call-state').textContent='CONVERSATION ACTIVE';
  $('#chat-input').disabled=false;
  $('#messages').innerHTML='';

  // Check if WebSocket is supported or if running as Cloud Demo
  let wsUrl = (location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws/call';
  try {
    socket = new WebSocket(wsUrl);
    socket.binaryType='arraybuffer';
    socket.onopen = () => {
      isLocalDemo = false;
      $('#call-provider').textContent='SERVER ONLINE';
    };
    socket.onerror = () => {
      activateCloudDemoMode();
    };
  } catch(e) {
    activateCloudDemoMode();
  }
}

function activateCloudDemoMode() {
  isLocalDemo = true;
  socket = null;
  $('#call-provider').textContent='ARIA CLOUD DEMO';
  $('#voice-status').textContent='Connected (Demo Mode)';
  const welcome = "Hello! Welcome to Vortex Logic Labs. I'm Aria, your virtual receptionist. How can I assist you today? You can ask to book a consultation, learn about our services, or speak to our team.";
  setTimeout(() => {
    appendMessage('assistant', welcome);
    speakDemo(welcome);
    startWebSpeechRecognizer();
  }, 400);
}

function sendText(text){
  if(closingCall)return;
  text=text.trim();
  if(!text)return;
  if(synth) synth.cancel();
  appendMessage('user', text);
  $('#chat-input').value='';

  if(socket && socket.readyState === 1) {
    socket.send(JSON.stringify({type:'text', text}));
  } else {
    setTimeout(() => processAriaDemoTurn(text), 600);
  }
}

$('#start-call').onclick=startCall;
$('#end-call').onclick=()=>{
  closingCall = true;
  if(synth) synth.cancel();
  if(speechRecognizer) speechRecognizer.stop();
  if(socket?.readyState===1) socket.send(JSON.stringify({type:'end'}));
  socket?.close();
  $('#start-call').classList.remove('hidden');
  ['end-call','mute-call','interrupt-call'].forEach(id=>$('#'+id).classList.add('hidden'));
  $('.voice-panel').classList.remove('live');
  $('#voice-status').textContent='Conversation ended';
  $('#call-state').textContent='READY TO CONNECT';
};

$('#mute-call').onclick=()=>{
  muted=!muted;
  $('#mute-call').textContent=muted?'Unmute mic':'Mute mic';
  if(speechRecognizer) {
    if(muted) speechRecognizer.stop();
    else speechRecognizer.start();
  }
};

$('#interrupt-call').onclick=()=>{
  if(synth) synth.cancel();
  $('#voice-status').textContent='Listening…';
};

$('#voice-enabled').onchange=()=>{
  if(!$('#voice-enabled').checked && synth) synth.cancel();
};

$('#chat-form').onsubmit=e=>{
  e.preventDefault();
  sendText($('#chat-input').value);
};

function loadSettings(){
  const form=$('#settings-form');
  for(const [key,value] of Object.entries(cfg)){
    const el=form.elements.namedItem(key);
    if(el)el.value=key==='services'?value.join('\n'):value;
  }
  $('#days').innerHTML=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d,i)=>`<label><input type="checkbox" value="${i}" ${cfg.open_days.includes(i)?'checked':''}>${d}</label>`).join('');
  renderDiagnostics();
}

function applyBrand(){
  const name=cfg.business_name||'Vortex Logic Labs';
  $('#workspace-name').textContent=name;
  $('.workspace-icon').textContent=name[0].toUpperCase();
  $('#assistant-name').textContent=cfg.receptionist_name||'Aria';
  $('#call-provider').textContent='LOCAL READY';
}

function renderDiagnostics(){
  if(!$('#diagnostics'))return;
  $('#diagnostics').innerHTML=[
    `Platform: Vortex Logic Labs`,
    `Speech Model: Web Speech STT/TTS Active`,
    `Engine: Aria Neural Dialogue`,
    `Calendar: Connected`
  ].map(v=>`<span class="diagnostic">${esc(v)}</span>`).join('');
}

async function boot(){
  try{
    cfg=await api('/api/settings');
  }catch(e){
    cfg={ ...defaultSettings };
  }
  applyBrand();
  render();
  renderSystem();
  renderDiagnostics();
  setInterval(()=>{$('#clock').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:cfg.timezone,hour:'2-digit',minute:'2-digit',weekday:'short',day:'numeric',month:'short'}).format(new Date())},1000);
}
boot();
