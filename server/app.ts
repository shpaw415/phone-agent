// Phone Agent — dashboard page app (bundled by the control plane from index.html).
// Moved verbatim from the former template strings in server.ts: same ids, same
// classes emitted at runtime, same i18n dictionary, same relative fetch paths.
const L = {
  en: {
    callsSub: "Live calls and history. The agent answers with the settings below.",
    missionsSub: "Give the agent a mission: it calls, talks, and reports back here.",
    settingsSub: "What is configured, and what is still missing.",
    ready: "Ready — calls can be placed.",
    setup: "Setup needed — see the Settings tab.",
    net: "Could not reach the plugin server.",
    live: "Live", history: "History", missions: "Missions", newMission: "New mission",
    when: "When", dirLabel: "Dir", number: "Number", dur: "Duration", status: "Status", report: "Report",
    out: "Out", in: "In",
    noCalls: "No calls yet.", noMissions: "No missions yet.",
    to: "To (E.164, e.g. +18195550123)", missionText: "Mission for the agent (self-contained, in the callee's language)",
    place: "Place the call", placing: "Placing…",
    transcript: "Transcript", whisperPh: "Whisper an instruction to the agent…", whisperSend: "Send",
    hangup: "Hang up", incoming: "Incoming call", from: "from", answeredByAgent: "answered by the agent",
    you: "Operator", agent: "Agent", caller: "Caller",
    settingsChecks: "Checklist", set: "set", missing: "missing",
    kxai: "xAI API key (Grok Voice)", ksid: "Twilio Account SID", ktok: "Twilio Auth Token",
    kphone: "Twilio phone number", kbase: "Public endpoint URL (Config → Endpoints)",
    kswSpace: "SignalWire Space name", kswProject: "SignalWire Project ID", kswToken: "SignalWire API token",
    kswPhone: "SignalWire phone number",
    phoneProvider: "Phone provider", twilioName: "Twilio", signalwireName: "SignalWire",
    webhooks: "{p} number wiring",
    webhookHelp: "In the {p} console, on your phone number, set “A call comes in” to the Voice URL below (HTTP POST). The status callback is optional.",
    voiceUrl: "Voice URL", statusUrl: "Status callback (optional)",
    current: "Current values", model: "Model", voice: "Voice", autoAnswer: "Auto-answer incoming calls",
    verify: "Verify Twilio signatures", place2: "Place a mission from any thread with:",
    costsNote: "Calls use your Twilio account and your xAI key — normal billing applies.",
    fromThread: "From a thread",
    navCalls: "Calls",navMissions: "Missions",navSettings: "Settings",
  },
  fr: {
    callsSub: "Appels en direct et historique. L'agent répond avec les réglages ci-dessous.",
    missionsSub: "Donne une mission à l'agent : il appelle, parle, et rend compte ici.",
    settingsSub: "Ce qui est configuré, et ce qui manque encore.",
    ready: "Prêt — les appels peuvent partir.",
    setup: "Configuration requise — vois l'onglet Réglages.",
    net: "Serveur du plugin injoignable.",
    live: "En direct", history: "Historique", missions: "Missions", newMission: "Nouvelle mission",
    when: "Quand", dirLabel: "Sens", number: "Numéro", dur: "Durée", status: "Statut", report: "Compte rendu",
    out: "Sortant", in: "Entrant",
    noCalls: "Aucun appel pour le moment.", noMissions: "Aucune mission pour le moment.",
    to: "Vers (E.164, ex. +18195550123)", missionText: "Mission pour l'agent (autonome, dans la langue de l'appelé)",
    place: "Passer l'appel", placing: "Appel en cours…",
    transcript: "Transcription", whisperPh: "Souffle une instruction à l'agent…", whisperSend: "Envoyer",
    hangup: "Raccrocher", incoming: "Appel entrant", from: "de", answeredByAgent: "répondu par l'agent",
    you: "Toi", agent: "Agent", caller: "Correspondant",
    settingsChecks: "Liste de vérification", set: "configuré", missing: "manquant",
    kxai: "Clé API xAI (Grok Voice)", ksid: "Twilio Account SID", ktok: "Twilio Auth Token",
    kphone: "Numéro de téléphone Twilio", kbase: "URL d'endpoint public (Config → Endpoints)",
    kswSpace: "Nom d'espace SignalWire", kswProject: "ID de projet SignalWire", kswToken: "Jeton API SignalWire",
    kswPhone: "Numéro de téléphone SignalWire",
    phoneProvider: "Fournisseur téléphonique", twilioName: "Twilio", signalwireName: "SignalWire",
    webhooks: "Raccordement du numéro {p}",
    webhookHelp: "Dans la console {p}, sur ton numéro, mets « A call comes in » sur l'URL Voice ci-dessous (HTTP POST). Le callback de statut est optionnel.",
    voiceUrl: "URL Voice", statusUrl: "Callback de statut (optionnel)",
    current: "Valeurs actuelles", model: "Modèle", voice: "Voix", autoAnswer: "Réponse auto aux appels entrants",
    verify: "Vérifier les signatures Twilio", place2: "Lance une mission depuis n'importe quel fil avec :",
    costsNote: "Les appels utilisent ton compte Twilio et ta clé xAI — facturation normale.",
    fromThread: "Depuis un fil",
    navCalls: "Appels",navMissions: "Missions",navSettings: "Réglages",
  },
  es: {
    callsSub: "Llamadas en vivo e historial. El agente responde con los ajustes de abajo.",
    missionsSub: "Dale una misión al agente: llama, habla y da cuenta aquí.",
    settingsSub: "Lo que está configurado y lo que falta.",
    ready: "Listo — se pueden hacer llamadas.",
    setup: "Configuración necesaria — mira la pestaña Ajustes.",
    net: "No se pudo contactar el servidor del plugin.",
    live: "En vivo", history: "Historial", missions: "Misiones", newMission: "Nueva misión",
    when: "Cuándo", dirLabel: "Sentido", number: "Número", dur: "Duración", status: "Estado", report: "Informe",
    out: "Saliente", in: "Entrante",
    noCalls: "Aún no hay llamadas.", noMissions: "Aún no hay misiones.",
    to: "Para (E.164, ej. +18195550123)", missionText: "Misión para el agente (autónoma, en el idioma del destinatario)",
    place: "Llamar", placing: "Llamando…",
    transcript: "Transcripción", whisperPh: "Susúrrale una instrucción al agente…", whisperSend: "Enviar",
    hangup: "Colgar", incoming: "Llamada entrante", from: "de", answeredByAgent: "respondida por el agente",
    you: "Tú", agent: "Agente", caller: "Interlocutor",
    settingsChecks: "Lista de verificación", set: "configurado", missing: "falta",
    kxai: "Clave API de xAI (Grok Voice)", ksid: "Twilio Account SID", ktok: "Twilio Auth Token",
    kphone: "Número de teléfono de Twilio", kbase: "URL pública (Config → Endpoints)",
    kswSpace: "Nombre de espacio SignalWire", kswProject: "ID de proyecto SignalWire", kswToken: "Token de API SignalWire",
    kswPhone: "Número de teléfono SignalWire",
    phoneProvider: "Proveedor telefónico", twilioName: "Twilio", signalwireName: "SignalWire",
    webhooks: "Cableado del número {p}",
    webhookHelp: "En la consola de {p}, en tu número, pon “A call comes in” en la URL de voz de abajo (HTTP POST). El callback de estado es opcional.",
    voiceUrl: "URL de voz", statusUrl: "Callback de estado (opcional)",
    current: "Valores actuales", model: "Modelo", voice: "Voz", autoAnswer: "Respuesta automática a entrantes",
    verify: "Verificar firmas Twilio", place2: "Lanza una misión desde cualquier hilo con:",
    costsNote: "Las llamadas usan tu cuenta de Twilio y tu clave de xAI — facturación normal.",
    fromThread: "Desde un hilo",
    navCalls: "Llamadas",navMissions: "Misiones",navSettings: "Ajustes",
  },
  de: {
    callsSub: "Live-Anrufe und Verlauf. Der Agent antwortet gemäß den Einstellungen unten.",
    missionsSub: "Gib dem Agenten eine Mission: Er ruft an, spricht und berichtet hier.",
    settingsSub: "Was konfiguriert ist und was noch fehlt.",
    ready: "Bereit — Anrufe können gehen.",
    setup: "Einrichtung nötig — siehe Tab Einstellungen.",
    net: "Plugin-Server nicht erreichbar.",
    live: "Live", history: "Verlauf", missions: "Missionen", newMission: "Neue Mission",
    when: "Wann", dirLabel: "Richtung", number: "Nummer", dur: "Dauer", status: "Status", report: "Bericht",
    out: "Ausgehend", in: "Eingehend",
    noCalls: "Noch keine Anrufe.", noMissions: "Noch keine Missionen.",
    to: "An (E.164, z. B. +18195550123)", missionText: "Mission für den Agenten (in sich geschlossen, in der Sprache des Angerufenen)",
    place: "Anrufen", placing: "Rufe…",
    transcript: "Transkript", whisperPh: "Flüstere dem Agenten eine Anweisung zu…", whisperSend: "Senden",
    hangup: "Auflegen", incoming: "Eingehender Anruf", from: "von", answeredByAgent: "vom Agenten beantwortet",
    you: "Du", agent: "Agent", caller: "Anrufer",
    settingsChecks: "Checkliste", set: "gesetzt", missing: "fehlt",
    kxai: "xAI-API-Schlüssel (Grok Voice)", ksid: "Twilio Account SID", ktok: "Twilio Auth Token",
    kphone: "Twilio-Telefonnummer", kbase: "Öffentliche Endpoint-URL (Config → Endpoints)",
    kswSpace: "SignalWire-Space-Name", kswProject: "SignalWire-Projekt-ID", kswToken: "SignalWire-API-Token",
    kswPhone: "SignalWire-Telefonnummer",
    phoneProvider: "Telefonanbieter", twilioName: "Twilio", signalwireName: "SignalWire",
    webhooks: "Verkabelung der {p}-Nummer",
    webhookHelp: "Stelle in der {p}-Konsole bei deiner Nummer „A call comes in“ auf die untenstehende Voice-URL (HTTP POST). Der Status-Callback ist optional.",
    voiceUrl: "Voice-URL", statusUrl: "Status-Callback (optional)",
    current: "Aktuelle Werte", model: "Modell", voice: "Stimme", autoAnswer: "Eingehende Anrufe automatisch annehmen",
    verify: "Twilio-Signaturen prüfen", place2: "Starte eine Mission aus jedem Thread mit:",
    costsNote: "Anrufe nutzen deinen Twilio-Account und deinen xAI-Schlüssel — normale Abrechnung.",
    fromThread: "Aus einem Thread",
    navCalls: "Anrufe",navMissions: "Missionen",navSettings: "Einstellungen",
  },
};

(function(){
var lang=(navigator.language||'en').slice(0,2).toLowerCase();
var T=L[lang]||L.en;
function $(id){return document.getElementById(id)}
$('t-sub').textContent=T.callsSub;
$('nav-calls').textContent=T.navCalls;$('nav-missions').textContent=T.navMissions;$('nav-settings').textContent=T.navSettings;
$('t-live').textContent=T.live;$('t-hist').textContent=T.history;
$('h-when').textContent=T.when;$('h-dir').textContent=T.dirLabel;$('h-num').textContent=T.number;$('h-dur').textContent=T.dur;$('h-st').textContent=T.status;
$('c-nocalls').textContent=T.noCalls;$('foot').textContent=T.costsNote;
$('t-new').textContent=T.newMission;$('t-list').textContent=T.missions;
$('l-to').textContent=T.to;$('l-m').textContent=T.missionText;$('m-place').textContent=T.place;$('m-nom').textContent=T.noMissions;
$('t-check').textContent=T.settingsChecks;$('l-vurl').textContent=T.voiceUrl;$('l-surl').textContent=T.statusUrl;
$('t-cur').textContent=T.current;$('t-cli').textContent=T.fromThread;
$('s-cli').textContent=T.place2+'\nob-plugin-phone-agent-call --to "+18195550123" --mission "…"';
function banner(id,k,t){var b=$(id);b.className='banner '+k;b.textContent=t;}
function fmt(s){s=Math.max(0,Math.round(s||0));var m=Math.floor(s/60);return m+':'+(s%60<10?'0':'')+(s%60);}
function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML;}
var current='calls';
function show(sec){current=sec;
  ['calls','missions','settings'].forEach(function(x){
    $('sec-'+x).style.display=(x===sec)?'block':'none';
    $('nav-'+x).className='navbtn'+((x===sec)?' on':'');});
  try{location.hash=sec;}catch(e){}
  if(sec==='missions')loadMissions();
  if(sec==='settings')loadSettings();}
$('nav-calls').onclick=function(){show('calls');};
$('nav-missions').onclick=function(){show('missions');};
$('nav-settings').onclick=function(){show('settings');};
var h=(location.hash||'').replace('#','');show(['calls','missions','settings'].indexOf(h)>=0?h:'calls');
window.addEventListener('hashchange',function(){var h2=(location.hash||'').replace('#','');if(['calls','missions','settings'].indexOf(h2)>=0&&h2!==current)show(h2);});
var activeSid='',beeped={};
function beep(){try{var c=new (window.AudioContext||window.webkitAudioContext)();var o=c.createOscillator(),g=c.createGain();
o.connect(g);g.connect(c.destination);o.frequency.value=880;g.gain.value=0.12;o.start();
setTimeout(function(){o.stop();c.close();},350);}catch(e){}}
function pill(t,c){var p=$('c-livepill');p.textContent=t;p.className='pill'+(c?' '+c:'');}
function loadCalls(){fetch('api/status').then(function(r){return r.json()}).then(function(s){
  if(s.ready){banner('c-banner','ok',T.ready);}else{banner('c-banner','setup',T.setup);}}).catch(function(){banner('c-banner','err',T.net);});
  fetch('api/calls').then(function(r){return r.json()}).then(renderCalls).catch(function(){});}
function renderCalls(j){
  var calls=j.calls||[];
  var act=calls.filter(function(c){return !c.endedAt&&c.status!=='completed'&&c.status!=='failed'&&c.status!=='no-answer'&&c.status!=='busy'&&c.status!=='canceled';});
  var inc=act.filter(function(c){return c.direction==='in';});
  if(inc.length){var c0=inc[0];
    $('c-ring').style.display='block';$('c-ring').textContent=T.incoming+' '+T.from+' '+(c0.from||'')+' — '+T.answeredByAgent;
    if(!beeped[c0.callSid]){beeped[c0.callSid]=1;beep();setTimeout(beep,1200);}}
  else{$('c-ring').style.display='none';}
  if(act.length){pill(act.length+' '+T.live,'live');var a=act[0];
    if(a.callSid!==activeSid){activeSid=a.callSid;renderLive(a,false);}
    fetch('api/calls?full='+encodeURIComponent(activeSid)).then(function(r){return r.json()}).then(function(d){if(d.call)renderLive(d.call,true);}).catch(function(){});}
  else{activeSid='';$('c-livebox').innerHTML='';pill('—','');}
  var tb=$('c-calls');tb.innerHTML='';var done=calls.filter(function(c){return c.endedAt;});
  $('c-nocalls').style.display=done.length?'none':'block';
  done.slice(0,15).forEach(function(c){var tr=document.createElement('tr');
    var cells=[new Date(c.startedAt).toLocaleString(),c.direction==='in'?T.in:T.out,(c.direction==='in'?c.from:c.to)||'',
    c.durationSec?fmt(c.durationSec):'—',c.status];
    cells.forEach(function(v){var td=document.createElement('td');td.textContent=v;tr.appendChild(td);});tb.appendChild(tr);});
}
function renderLive(c,keep){
  var box=$('c-livebox');var html='';
  html+='<div class=row style=margin-bottom:8px><span class="dir '+(c.direction||'out')+'">'+(c.direction==='in'?T.in:T.out)+'</span>' +
    '<span class=pill '+(c.status==='in-progress'?'live':'ring')+'>'+(c.status||'')+'</span>' +
    '<span>'+((c.direction==='in'?c.from:c.to)||'')+'</span><span style=flex:1></span><button class=danger id=c-hang>'+T.hangup+'</button></div>';
  html+='<label>'+T.transcript+'</label><div id=c-log></div>';
  html+='<div class=row style=margin-top:8px><input type=text id=c-whisper placeholder="'+T.whisperPh+'"><button id=c-wh class=primary>'+T.whisperSend+'</button></div>';
  if(!keep){box.innerHTML=html;$('c-hang').onclick=function(){fetch('api/hangup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callSid:c.callSid})}).then(loadCalls);};
    $('c-wh').onclick=sendWhisper;$('c-whisper').onkeydown=function(e){if(e.key==='Enter')sendWhisper();};}
  var log=$('c-log');if(!log)return;log.innerHTML='';var tr=c.transcript||[];
  if(!tr.length){log.innerHTML='<div class=empty>…</div>';return;}
  tr.forEach(function(t){var d=document.createElement('div');d.className='msg '+t.role;
    var w=document.createElement('span');w.className='who';w.textContent=t.role==='agent'?T.agent:(t.role==='caller'?T.caller:T.you);
    d.appendChild(w);var p=document.createElement('span');p.textContent=t.text;d.appendChild(p);log.appendChild(d);});
  log.scrollTop=log.scrollHeight;}
function sendWhisper(){var i=$('c-whisper');var v=i.value.trim();if(!v||!activeSid)return;
  fetch('api/whisper',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({callSid:activeSid,text:v})}).then(function(){i.value='';});}
$('m-place').onclick=function(){
  var to=$('m-to').value.trim(),m=$('m-text').value.trim();if(!to||!m)return;
  $('m-place').disabled=true;$('m-place').textContent=T.placing;$('m-msg').textContent='';
  fetch('api/missions/place',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:to,mission:m})})
  .then(function(r){return r.json()}).then(function(j){
    $('m-place').disabled=false;$('m-place').textContent=T.place;
    if(j.ok){$('m-to').value='';$('m-text').value='';$('m-msg').textContent=j.callSid||'';loadMissions();}
    else{$('m-msg').textContent=(j.error||'error')+' — '+(j.hint||'');}})
  .catch(function(){$('m-place').disabled=false;$('m-place').textContent=T.place;$('m-msg').textContent=T.net;});};
function loadMissions(){fetch('api/status').then(function(r){return r.json()}).then(function(st){
  if(st.ready){banner('m-banner','ok',T.ready);}else{banner('m-banner','setup',T.setup);}}).catch(function(){});
  fetch('api/missions').then(function(r){return r.json()}).then(function(j){
  var ms=(j.missions||[]).slice().reverse();
  $('m-nom').style.display=ms.length?'none':'block';
  var box=$('m-list');box.innerHTML='';
  ms.forEach(function(m){var d=document.createElement('div');d.style.cssText='border-top:1px solid var(--line);padding:10px 0;';
    var live=!m.endedAt;
    d.innerHTML='<div class=row><span class=pill '+(live?'ring':'')+'>'+esc(m.status)+'</span><strong>'+esc(m.to)+'</strong>' +
      '<span class=sub>'+new Date(m.createdAt).toLocaleString()+'</span></div>' +
      '<div class=sub style=margin:4px 0>'+esc(m.mission).slice(0,300)+'</div>' +
      (m.report?'<details><summary>'+T.report+'</summary><div class=sub style=white-space:pre-wrap>'+esc(m.report)+'</div></details>':'');
    box.appendChild(d);});
}).catch(function(){});}
function row(label,ok,val){var d=document.createElement('div');d.className='row';d.style.cssText='padding:6px 0;border-bottom:1px solid var(--line);justify-content:space-between';
  var l=document.createElement('span');l.textContent=label;
  var r=document.createElement('span');r.innerHTML='<span class='+(ok?'ok':'err')+'>'+(ok?T.set:T.missing)+'</span>'+(val?' <span class=sub>'+val+'</span>':'');
  d.appendChild(l);d.appendChild(r);return d;}
function loadSettings(){fetch('api/settings').then(function(r){return r.json()}).then(function(s){
  var pn=s.phoneProvider==='signalwire'?T.signalwireName:T.twilioName;
  $('t-hooks').textContent=T.webhooks.replace('{p}',pn);
  $('t-hookhelp').textContent=T.webhookHelp.replace('{p}',pn);
  var c=$('s-checks');c.innerHTML='';
  c.appendChild(row(T.kxai,s.hasKey));
  if(s.phoneProvider==='signalwire'){
    c.appendChild(row(T.kswSpace,s.signalwire.space));
    c.appendChild(row(T.kswProject,s.signalwire.project));
    c.appendChild(row(T.kswToken,s.signalwire.token));
    c.appendChild(row(T.kswPhone,s.signalwire.phone,s.signalwire.phone?('…'+String(s.signalwire.phone).slice(-4)):''));
  }else{
    c.appendChild(row(T.ksid,s.twilio.sid));
    c.appendChild(row(T.ktok,s.twilio.token));
    c.appendChild(row(T.kphone,s.twilio.phone,s.twilio.phone?('…'+String(s.twilio.phone).slice(-4)):''));
  }
  c.appendChild(row(T.kbase,s.publicBase));
  if(s.ready){banner('s-banner','ok',T.ready);}else{banner('s-banner','setup',T.setup);}
  var hook=s.phoneProvider==='signalwire'?'/signalwire/':'/twilio/';
  if(s.publicBase){$('s-vurl').textContent=s.publicBase+hook+'voice';$('s-surl').textContent=s.publicBase+hook+'status';}
  else{$('s-vurl').textContent='—';$('s-surl').textContent='—';}
  var cu=$('s-cur');cu.innerHTML='';
  [[T.phoneProvider,pn],[T.model,s.model],[T.voice,s.voice],[T.autoAnswer,s.autoAnswer?'on':'off']].forEach(function(p){
    var d=document.createElement('div');d.className='row';d.style.cssText='padding:6px 0;border-bottom:1px solid var(--line);justify-content:space-between';
    d.innerHTML='<span>'+p[0]+'</span><span class=sub>'+p[1]+'</span>';cu.appendChild(d);});
}).catch(function(){banner('s-banner','err',T.net);});}
loadCalls();
setInterval(function(){if(current==='calls')loadCalls();},2500);
setInterval(function(){if(current==='missions')loadMissions();},3000);
})();
