'use strict';
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let cfg={}, dashboard={calls:[],appointments:[],customers:[],handoffs:[],metrics:[],upcoming:[]}, health={}, currentPage='overview', socket=null, callId=null, operatorId=null;
let ctx=null, micStream=null, micSource=null, worklet=null, muted=false, audioNodes=new Set(), playbackAt=0, audioGeneration=0, decodeChain=Promise.resolve(), toastTimer;
let closingCall=false;
async function api(path,options={}){
  const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});
  if(!response.ok){let detail;try{detail=(await response.json()).detail}catch{detail=response.statusText}throw Error(typeof detail==='string'?detail:JSON.stringify(detail))}
  return response.json();
}
function toast(text,error=false){const t=$('#toast');t.textContent=text;t.className='show'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.className='',6500)}
function page(name){currentPage=name;$$('.page').forEach(el=>el.classList.toggle('active',el.id==='page-'+name));$$('.nav').forEach(el=>el.classList.toggle('active',el.dataset.page===name));$('#breadcrumb').textContent=({overview:'Overview',reception:'Reception desk',appointments:'Appointments',customers:'Customers',calls:'Call history',handoffs:'Human handoffs',settings:'Settings & providers'})[name];if(name==='settings')loadSettings();if(name==='handoffs')renderHandoffs();window.scrollTo(0,0)}
document.addEventListener('click',event=>{const target=event.target.closest('[data-page]');if(target)page(target.dataset.page)});
$('#go-reception').onclick=()=>page('reception');$('#hero-call').onclick=()=>{page('reception');startCall()};
function date(value,options={}){return new Intl.DateTimeFormat('en-GB',{timeZone:cfg.timezone||'Asia/Karachi',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',...options}).format(new Date(value))}
function localDay(value=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:cfg.timezone||'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(value)}
function status(value){return `<span class="status ${esc(value)}">${esc(value.replace('_',' '))}</span>`}
function initials(value){return String(value).trim().split(/\s+/).slice(0,2).map(s=>s[0]).join('').toUpperCase()}
async function refresh(){
  try{dashboard=await api('/api/dashboard');render();if(operatorId)await refreshOperator()}catch(e){$('#connection').textContent='Disconnected'}
}
async function refreshHealth(){try{health=await api('/api/health');$('#connection').textContent='Local server online';renderSystem();renderDiagnostics()}catch{$('#connection').textContent='Server offline'}}
function render(){
  $('#stat-calls').textContent=dashboard.total_calls??dashboard.calls.length;$('#stat-bookings').textContent=dashboard.upcoming.length;$('#stat-customers').textContent=dashboard.customers.length;
  const waiting=dashboard.handoffs.filter(h=>h.status!=='resolved').length;$('#stat-handoffs').textContent=waiting;$('#queue-badge').textContent=waiting;
  $('#upcoming-list').innerHTML=dashboard.upcoming.slice().sort((a,b)=>a.start_at.localeCompare(b.start_at)).slice(0,3).map(a=>`<div class="mini-booking"><div class="mini-date">${esc(date(a.start_at,{month:'short',day:undefined,hour:undefined,minute:undefined}).toUpperCase())}<strong>${esc(date(a.start_at,{month:undefined,day:'2-digit',hour:undefined,minute:undefined}))}</strong></div><div><h4>${esc(a.name)}</h4><p>${esc(a.service)}</p></div><span>${esc(date(a.start_at,{day:undefined,month:undefined}))}</span></div>`).join('')||'<div class="empty"><span class="empty-illustration">▦</span>A clear calendar. A fresh start.<small>Your next appointment will appear here.</small></div>';
  renderAppointments();renderCustomers();renderCalls();if(currentPage==='handoffs')renderHandoffs();
}
function renderSystem(){
  const ollamaReady=health.ollama_models?.includes(cfg.ollama_model);
  const rows=[['Speech recognition',cfg.llm_provider==='openai_realtime'?'OpenAI Realtime':cfg.stt_provider==='deepgram'?'Deepgram streaming':health.speech_ready?'Whisper · ready':'Whisper · setup needed',cfg.stt_provider==='whisper'&&!health.speech_ready&&cfg.llm_provider!=='openai_realtime'],['Conversation',cfg.llm_provider==='guided'?'Guided · ready':cfg.llm_provider==='ollama'?(ollamaReady?'Ollama · ready':'Ollama · unavailable'):'OpenAI Realtime',cfg.llm_provider==='ollama'&&!ollamaReady],['Voice output',cfg.tts_provider==='kokoro'?'Kokoro · neural voice':cfg.tts_provider==='windows'?'Windows · on device':'Piper · on device',false],['Calendar & data',health.database==='postgresql'?'PostgreSQL':'SQLite · on device',false]];
  $('#system-list').innerHTML=rows.map(([name,value,warn])=>`<div class="system-row"><span class="tiny-dot"></span><strong>${esc(name)}</strong><span class="${warn?'state-warn':''}">${esc(value)}</span></div>`).join('');
}
function renderAppointments(){
  const query=$('#appointment-search').value.toLowerCase(),filter=$('#appointment-filter').value;
  const list=dashboard.appointments.filter(a=>(filter==='all'||filter==='cancelled'&&a.status==='cancelled'||filter==='upcoming'&&a.status==='booked'&&new Date(a.start_at)>new Date())&&[a.name,a.phone,a.service,a.id].some(v=>v.toLowerCase().includes(query)));
  $('#appointment-rows').innerHTML=list.map(a=>`<tr><td><strong>${esc(a.name)}</strong><small>${esc(a.phone)}</small></td><td>${esc(a.service)}<small>#${esc(a.id)}</small></td><td>${esc(date(a.start_at))}<small>${esc(cfg.timezone)}</small></td><td>${status(a.status)}</td><td>${a.status==='booked'?`<button class="link" data-reschedule="${a.id}">Reschedule</button><button class="link" data-cancel="${a.id}">Cancel</button>`:''}</td></tr>`).join('');$('#appointment-empty').classList.toggle('hidden',list.length>0);
}
$('#appointment-search').oninput=renderAppointments;$('#appointment-filter').onchange=renderAppointments;
function renderCustomers(){const query=$('#customer-search').value.toLowerCase();const list=dashboard.customers.filter(c=>c.name.toLowerCase().includes(query)||c.phone.includes(query));$('#customer-rows').innerHTML=list.map(c=>`<tr><td><strong>${esc(c.name)}</strong><small>Added ${esc(date(c.created_at,{hour:undefined,minute:undefined}))}</small></td><td>${esc(c.phone)}</td><td>${esc(c.notes)||'—'}</td><td><button class="link" data-customer="${c.id}">Edit details</button></td></tr>`).join('');$('#customer-empty').classList.toggle('hidden',list.length>0)}
$('#customer-search').oninput=renderCustomers;
function renderCalls(){
  $('#call-rows').innerHTML=dashboard.calls.map(c=>`<tr><td><strong>#${esc(c.id)}</strong></td><td>${esc(date(c.started_at))}</td><td>${esc(c.channel)}</td><td>${esc(c.provider)}</td><td>${status(c.status)}</td><td><button class="link" data-transcript="${c.id}">Transcript ↗</button></td></tr>`).join('');$('#call-empty').classList.toggle('hidden',dashboard.calls.length>0);
  $('#metric-cards').innerHTML=dashboard.metrics.map(m=>`<div class="metric"><strong>${Math.round(m.mean_ms)} ms</strong>${esc(m.provider)} · ${m.turns} turns · mean workflow processing</div>`).join('');
}
function renderHandoffs(){
  $('#handoff-list').innerHTML=dashboard.handoffs.map(h=>`<article class="panel handoff-card"><div class="panel-heading">${status(h.status)}<span class="muted">${esc(date(h.created_at))}</span></div><h3>${esc(h.reason)}</h3><p>Callback: ${esc(h.phone||'Not supplied')}<br>Conversation #${esc(h.call_id)}</p><div class="actions">${h.status!=='resolved'?`<button class="button primary" data-take="${h.id}">Take over</button><button class="button secondary" data-resolve="${h.id}">Mark resolved</button>`:''}<button class="link" data-transcript="${h.call_id}">View transcript</button></div></article>`).join('')||'<article class="panel empty">All quiet on the front desk.<small>Requests for human help will appear here.</small></article>';
}
function openModal(title,body){$('#modal-title').textContent=title;$('#modal-body').innerHTML=body;$('#modal').showModal()}
$('#modal-close').onclick=()=>$('#modal').close();$('#modal').addEventListener('click',e=>{if(e.target===$('#modal')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close()}});
function bookingForm(old=null){
  openModal(old?'Reschedule appointment':'New appointment',`<form id="booking-form" class="modal-form"><label>Customer name<input name="name" value="${esc(old?.name||'')}" required minlength="2" maxlength="100"></label><label>Phone number<input name="phone" value="${esc(old?.phone||'')}" required minlength="7" maxlength="30"></label><label>Service<select name="service">${cfg.services.map(s=>`<option${old?.service===s?' selected':''}>${esc(s)}</option>`).join('')}</select></label><label>Date (${esc(cfg.timezone)})<input name="day" type="date" value="${localDay()}" min="${localDay()}" required></label><label>Available time<select name="start_at" required><option value="">Loading…</option></select></label><label>Notes<textarea name="notes" rows="2" maxlength="2000">${esc(old?.notes||'')}</textarea></label><div class="info">${old?'Confirming replaces the previous appointment only if the new slot is still available.':'Confirming saves this appointment to your local calendar.'}</div><button class="button primary" type="submit">${old?'Confirm reschedule':'Confirm booking'}</button></form>`);
  const form=$('#booking-form');async function loadSlots(){try{const slots=await api('/api/slots?day='+encodeURIComponent(form.day.value));form.start_at.innerHTML=slots.map(v=>`<option value="${esc(v)}">${esc(date(v,{month:undefined,day:undefined}))}</option>`).join('')||'<option value="">No available times — choose another date</option>'}catch(e){toast(e.message,true)}}form.day.onchange=loadSlots;loadSlots();
  form.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(form));delete data.day;if(old)data.replace_id=old.id;try{await api('/api/appointments',{method:'POST',body:JSON.stringify(data)});$('#modal').close();toast('Appointment '+(old?'rescheduled':'booked'));refresh()}catch(e){toast(e.message,true);loadSlots()}};
}
$('#new-booking').onclick=()=>bookingForm();
function customerForm(old=null){openModal(old?'Customer details':'Add customer',`<form id="customer-form" class="modal-form"><label>Full name<input name="name" value="${esc(old?.name||'')}" required minlength="2" maxlength="100"></label><label>Phone<input name="phone" value="${esc(old?.phone||'')}" required minlength="7" maxlength="30"></label><label>Notes<textarea name="notes" rows="4" maxlength="2000">${esc(old?.notes||'')}</textarea></label><button class="button primary">Save customer</button></form>`);$('#customer-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/customers'+(old?'/'+old.id:''),{method:old?'PUT':'POST',body:JSON.stringify(Object.fromEntries(new FormData(e.target)))});$('#modal').close();toast('Customer saved');refresh()}catch(e){toast(e.message,true)}}}
$('#new-customer').onclick=()=>customerForm();
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  try{
    if(b.dataset.reschedule)bookingForm(dashboard.appointments.find(a=>a.id===b.dataset.reschedule));
    if(b.dataset.cancel){const a=dashboard.appointments.find(a=>a.id===b.dataset.cancel);openModal('Cancel appointment',`<div class="confirmation">Cancel ${esc(a.service)} for ${esc(a.name)} on ${esc(date(a.start_at))}?</div><button class="button danger" id="confirm-cancel">Confirm cancellation</button>`);$('#confirm-cancel').onclick=async()=>{try{await api('/api/appointments/'+a.id+'/cancel',{method:'POST'});$('#modal').close();toast('Appointment cancelled');refresh()}catch(e){toast(e.message,true)}}}
    if(b.dataset.customer)customerForm(dashboard.customers.find(c=>c.id===b.dataset.customer));
    if(b.dataset.transcript){const call=await api('/api/calls/'+b.dataset.transcript);openModal('Conversation #'+call.id,`<div class="modal-transcript">${call.messages.map(messageHTML).join('')}</div><a class="button secondary" href="/api/calls/${call.id}/export">Download transcript</a>`)}
    if(b.dataset.take){await api('/api/handoffs/'+b.dataset.take+'/take',{method:'POST'});operatorId=dashboard.handoffs.find(h=>h.id===b.dataset.take).call_id;$('#operator-label').textContent='You are speaking with conversation #'+operatorId;await refreshOperator();refresh();toast('You have joined the conversation')}
    if(b.dataset.resolve){await api('/api/handoffs/'+b.dataset.resolve+'/resolve',{method:'POST'});operatorId=null;$('#operator-label').textContent='Request resolved. Choose another active request.';$('#operator-messages').innerHTML='';refresh();toast('Request resolved')}
    if(b.dataset.prompt)sendText(b.dataset.prompt);
  }catch(e){toast(e.message,true)}
});
function messageHTML(m){return `<div class="message ${esc(m.role)}"><div class="message-label">${esc(m.role==='assistant'?cfg.receptionist_name:m.role==='user'?'Caller':m.role)}</div><div class="message-content">${esc(m.content)}</div></div>`}
function appendMessage(role,content){if($('#messages .conversation-empty'))$('#messages').innerHTML='';$('#messages').insertAdjacentHTML('beforeend',messageHTML({role,content}));$('#messages').scrollTop=$('#messages').scrollHeight}
function renderSuggestions(items){
  if(!Array.isArray(items))return;
  $('.quick-prompts').innerHTML=items.map(item=>`<button data-prompt="${esc(item.text)}">${esc(item.label)}</button>`).join('');
}
async function refreshOperator(){const call=await api('/api/calls/'+operatorId);const box=$('#operator-messages');const html=call.messages.map(messageHTML).join('');if(box.innerHTML!==html){box.innerHTML=html;box.scrollTop=box.scrollHeight}}
$('#operator-form').onsubmit=async e=>{e.preventDefault();if(!operatorId)return toast('Take over an active request first',true);const input=$('#operator-input');if(!input.value.trim())return;try{await api('/api/calls/'+operatorId+'/operator',{method:'POST',body:JSON.stringify({text:input.value})});input.value='';await refreshOperator()}catch(e){toast(e.message,true)}};
async function loadSettings(){cfg=await api('/api/settings');const form=$('#settings-form');for(const [key,value] of Object.entries(cfg)){const el=form.elements.namedItem(key);if(el)el.value=key==='services'?value.join('\n'):value}$('#days').innerHTML=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d,i)=>`<label><input type="checkbox" value="${i}" ${cfg.open_days.includes(i)?'checked':''}>${d}</label>`).join('');renderDiagnostics()}
function applyBrand(){const name=cfg.business_name||'Your Business';$('#workspace-name').textContent=name;$('.workspace-icon').textContent=name[0].toUpperCase();$('#assistant-name').textContent=cfg.receptionist_name;$('#call-provider').textContent=cfg.llm_provider==='openai_realtime'?'OPENAI REALTIME':'LOCAL '+cfg.llm_provider.toUpperCase()}
$('#save-settings').onclick=async()=>{const form=$('#settings-form');if(!form.reportValidity())return;let value=Object.fromEntries(new FormData(form));for(const k of ['opening_hour','closing_hour','slot_minutes','silence_ms'])value[k]=Number(value[k]);value.vad_threshold=Number(value.vad_threshold);value.tts_speed=Number(value.tts_speed);value.open_days=$$('#days input:checked').map(e=>Number(e.value));value.services=value.services.split('\n').map(s=>s.trim()).filter(Boolean);try{cfg=await api('/api/settings',{method:'PUT',body:JSON.stringify(value)});applyBrand();renderSystem();toast('Settings saved. Start a new conversation to use the new providers.');refreshHealth()}catch(e){toast(e.message,true)}};
function renderDiagnostics(){if(!$('#diagnostics'))return;$('#diagnostics').innerHTML=[`Database: ${health.database||'checking'}`,`Speech model: ${health.speech_ready?'ready':health.speech_error||'loading'}`,`Ollama: ${health.ollama_models?.length||0} models`,`Neural voice: ${health.neural_voice_error||(health.neural_voice_installed?"installed":"optional setup")}`,`Server: localhost only`].map(v=>`<span class="diagnostic">${esc(v)}</span>`).join('');$('#ollama-models').innerHTML=(health.ollama_models||[]).filter(v=>!v.includes(':cloud')).map(v=>`<option value="${esc(v)}"></option>`).join('');$('#credential-status').innerHTML=Object.entries(health.configured||{}).map(([key,value])=>`<div class="credential">${esc(key)}<span>${value?'Configured':'Not configured'}</span></div>`).join('')}
async function audioContext(){if(!ctx)ctx=new AudioContext();if(ctx.state==='suspended')await ctx.resume();return ctx}
function stopPlayback(){audioGeneration++;for(const node of audioNodes){try{node.stop()}catch{}}audioNodes.clear();playbackAt=ctx?.currentTime||0;decodeChain=Promise.resolve()}
function play(event){if(!$('#voice-enabled').checked)return;const generation=audioGeneration;decodeChain=decodeChain.then(async()=>{const context=await audioContext();if(generation!==audioGeneration)return;const raw=Uint8Array.from(atob(event.audio),c=>c.charCodeAt(0));let buffer;if(event.type==='pcm'){const view=new DataView(raw.buffer);buffer=context.createBuffer(1,raw.length/2,event.sample_rate);const channel=buffer.getChannelData(0);for(let i=0;i<channel.length;i++)channel[i]=view.getInt16(i*2,true)/32768}else buffer=await context.decodeAudioData(raw.buffer);if(generation!==audioGeneration)return;const node=context.createBufferSource();node.buffer=buffer;node.connect(context.destination);audioNodes.add(node);node.onended=()=>audioNodes.delete(node);playbackAt=Math.max(context.currentTime+0.025,playbackAt);node.start(playbackAt);playbackAt+=buffer.duration}).catch(e=>toast('Audio playback: '+e.message,true))}
async function startMic(){
  if(!$('#mic-enabled').checked||closingCall)return;
  const owner=socket;
  try{
    const context=await audioContext();
    const stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},video:false});
    if(socket!==owner||owner?.readyState!==1||closingCall||!$('#mic-enabled').checked){stream.getTracks().forEach(t=>t.stop());return}
    micStream=stream;await context.audioWorklet.addModule('/static/pcm-worklet.js');
    if(socket!==owner||owner?.readyState!==1||closingCall||!$('#mic-enabled').checked){stream.getTracks().forEach(t=>t.stop());return}
    micSource=context.createMediaStreamSource(stream);worklet=new AudioWorkletNode(context,'pcm-capture');
    worklet.port.onmessage=({data})=>{if(!muted&&!closingCall&&socket===owner&&owner.readyState===1){if(owner.bufferedAmount<128000)owner.send(data.pcm);$('#meter-fill').style.width=Math.min(100,data.level*900)+'%'}};
    const silent=context.createGain();silent.gain.value=0;micSource.connect(worklet);worklet.connect(silent).connect(context.destination);
    $('#mic-note').textContent='Microphone is on. Speak naturally, and pause when finished.';
  }catch(e){toast('Microphone unavailable. You can still type: '+e.message,true);$('#mic-note').textContent='Microphone unavailable. Type in the conversation instead.'}
}
function stopMic(){micStream?.getTracks().forEach(t=>t.stop());micSource?.disconnect();worklet?.disconnect();micStream=null;micSource=null;worklet=null;$('#meter-fill').style.width='0'}
function beginCallEnd(){closingCall=true;stopMic();$('#chat-input').disabled=true;$('#voice-status').textContent='Ending conversation…'}
async function finishCall(){
  beginCallEnd();const endingSocket=socket;
  await decodeChain;
  const remaining=ctx?Math.max(0,playbackAt-ctx.currentTime)*1000:0;
  setTimeout(()=>{if(socket===endingSocket&&endingSocket?.readyState===1){endingSocket.send(JSON.stringify({type:'end'}));endingSocket.close()}},Math.min(15000,remaining+100));
}
async function startCall(){
  if(socket?.readyState===1)return;$('#start-call').disabled=true;
  try{await audioContext();closingCall=false;$('#chat-input').disabled=false;$('#messages').innerHTML='';stopPlayback();socket=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws/call');socket.binaryType='arraybuffer';
    socket.onopen=async()=>{$('#start-call').classList.add('hidden');['end-call','mute-call','interrupt-call'].forEach(id=>$('#'+id).classList.remove('hidden'));$('.voice-panel').classList.add('live');$('#voice-status').textContent='Connected';$('#call-state').textContent='CONVERSATION ACTIVE';await startMic()};
    socket.onmessage=({data})=>{const e=JSON.parse(data);if(e.suggestions)renderSuggestions(e.suggestions);if(e.type==='ready'){callId=e.call_id;$('#call-reference').textContent='#'+callId;$('#call-provider').textContent=e.provider.toUpperCase();refresh()}else if(e.type==='reply'){appendMessage(e.role||'assistant',e.text);$('#interim').textContent='';if(e.speak===false)$('#voice-status').textContent='Speaking…';if(e.end_call)beginCallEnd()}else if(e.type==='call_ended'){finishCall()}else if(e.type==='transcript'){appendMessage('user',e.text);$('#interim').textContent=''}else if(e.type==='interim')$('#interim').textContent=e.text;else if(e.type==='interrupt')stopPlayback();else if(e.type==='audio'||e.type==='pcm'){play(e);$('#voice-status').textContent='Speaking…'}else if(e.type==='status')$('#voice-status').textContent=e.text;else if(e.type==='timing')$('#timing').textContent=`STT ${e.stt_ms} ms · workflow ${e.response_ms} ms · synthesis ${e.synthesis_ms} ms`;else if(e.type==='waiting')$('#voice-status').textContent='Waiting for operator';else if(e.type==='error'){toast(e.text,true);$('#voice-status').textContent='Ready for typed messages'}};
    socket.onerror=()=>toast('Connection failed. Make sure Start.ps1 is running.',true);socket.onclose=()=>{socket=null;callId=null;stopMic();stopPlayback();$('#start-call').disabled=false;$('#start-call').classList.remove('hidden');['end-call','mute-call','interrupt-call'].forEach(id=>$('#'+id).classList.add('hidden'));$('.voice-panel').classList.remove('live');$('#voice-status').textContent='Conversation ended';$('#call-state').textContent='READY TO CONNECT';refresh()};
  }catch(e){toast(e.message,true);$('#start-call').disabled=false}
}
$('#start-call').onclick=startCall;$('#end-call').onclick=()=>{if(socket?.readyState===1)socket.send(JSON.stringify({type:'end'}));socket?.close()};$('#mute-call').onclick=()=>{muted=!muted;$('#mute-call').textContent=muted?'Unmute mic':'Mute mic';micStream?.getAudioTracks().forEach(t=>t.enabled=!muted)};$('#interrupt-call').onclick=()=>{stopPlayback();if(socket?.readyState===1)socket.send(JSON.stringify({type:'interrupt'}))};$('#voice-enabled').onchange=()=>{if(!$('#voice-enabled').checked)stopPlayback()};$('#mic-enabled').onchange=()=>{if(socket?.readyState===1){if($('#mic-enabled').checked)startMic();else stopMic()}};
function sendText(text){if(closingCall)return;if(socket?.readyState!==1)return toast('Start a conversation first');text=text.trim();if(!text)return;stopPlayback();appendMessage('user',text);socket.send(JSON.stringify({type:'text',text}));$('#chat-input').value=''}
$('#chat-form').onsubmit=e=>{e.preventDefault();sendText($('#chat-input').value)};
window.addEventListener('beforeunload',()=>{socket?.close();stopMic()});
async function boot(){try{cfg=await api('/api/settings');applyBrand();await Promise.all([refresh(),refreshHealth()]);setInterval(refresh,5000);setInterval(refreshHealth,15000);setInterval(()=>{$('#clock').textContent=new Intl.DateTimeFormat('en-GB',{timeZone:cfg.timezone,hour:'2-digit',minute:'2-digit',weekday:'short',day:'numeric',month:'short'}).format(new Date())},1000)}catch(e){toast('Could not connect to local server: '+e.message,true)}}boot();

$('#preview-voice').onclick=async()=>{const button=$('#preview-voice');button.disabled=true;try{const r=await fetch('/api/voice/preview',{method:'POST'});if(!r.ok)throw Error('Could not generate voice preview. Check the saved provider and installation.');const context=await audioContext();const buffer=await context.decodeAudioData(await r.arrayBuffer());const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);source.start()}catch(e){toast(e.message,true)}finally{button.disabled=false}};
