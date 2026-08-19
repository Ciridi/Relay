/* GarageLog v2 — Supabase integration.
   Replace the two placeholders below. NEVER use a service_role/secret key here. */
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Configuration and application state
  // ---------------------------------------------------------------------------

  const CATEGORIES = [
    "ENGINE",
    "SUSPENSION",
    "BRAKES",
    "INTERIOR",
    "WHEELS",
    "PAINT",
    "BODYKIT",
    "EXHAUST",
    "ELECTRICAL",
    "OTHER",
  ];

  const FALLBACK_IMAGE =
    "https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=900&q=80";

  const config = window.GARAGELOG_SUPABASE || {
    url: "https://coiqtywzdcpremwtfrwe.supabase.co",
    anonKey: "sb_publishable_5whWyCwroyRSUc03OdLpvQ_kkx4r-UQ",
  };

  const state = {
    supabase: null,
    user: null,
    profile: null,
    projects: [],
    currentProjectId: null,
    currentProject: null,
    category: "ENGINE",
    editMode: true,
    sort: "updated",
    authMode: "login",
    connectCategory: "ENGINE",
    currentConnectBuildId: null,
    currentConnectBuild: null,
    timelineProjectId: null,
    timelineMode: "view",
    homepageClockTimer: null,
    axleMessages: [],
    axleBusy: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const main = $("#main");
  const toast = $("#toast");

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  const configured = () =>
    Boolean(
      config.url &&
        !config.url.startsWith("YOUR_") &&
        config.anonKey &&
        !config.anonKey.startsWith("YOUR_"),
    );

  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#039;",
        })[character],
    );

  const uid = () =>
    crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

  const money = (value) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
    }).format(Number(value) || 0);

  const dateText = (value) => {
    if (!value) return "—";
    const raw = String(value).trim();
    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const date = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(raw);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  };

  function localDateKey(value) {
    if (!value) return "";

    const raw = String(value).trim();
    const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) return raw;

    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "";

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function dateFromKey(key) {
    const match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function numericDateText(value) {
    const key = localDateKey(value);
    if (!key) return "--/--/----";
    const [year, month, day] = key.split("-");
    return `${month}/${day}/${year}`;
  }

  function todayKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const total = (project) =>
    (project?.parts || []).reduce(
      (sum, part) => sum + Number(part.cost || 0),
      0,
    );

  const logged = () => Boolean(state.user);

  function safePublicUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function projectImageUrl(value) {
    return safePublicUrl(value) || FALLBACK_IMAGE;
  }

  function vehicleDetails(project) {
    const vehicle = project?.vehicle || {};
    return {
      year: String(project?.vehicle_year ?? project?.vehicleYear ?? project?.year ?? vehicle.year ?? "").trim(),
      make: String(project?.vehicle_make ?? project?.vehicleMake ?? project?.make ?? vehicle.make ?? "").trim(),
      model: String(project?.vehicle_model ?? project?.vehicleModel ?? project?.model ?? vehicle.model ?? "").trim(),
    };
  }

  function vehicleLabel(project) {
    const { year, make, model } = vehicleDetails(project);
    return [year, make, model].filter(Boolean).join(" ");
  }

  function setCompatibilitySelectValue(selector, value) {
    const select = $(selector);
    if (!select) return;
    const normalized = String(value ?? "").trim();
    const option = document.createElement("option");
    option.value = normalized;
    option.textContent = normalized;
    select.replaceChildren(option);
    select.value = normalized;
  }

  function hydrateProjectVehicleForm(project) {
    const { year, make, model } = vehicleDetails(project);

    if ($("#wizardVehicleYear")) $("#wizardVehicleYear").value = year;
    if ($("#wizardVehicleMake")) $("#wizardVehicleMake").value = make;
    if ($("#wizardVehicleModel")) $("#wizardVehicleModel").value = model;

    // project-wizard.js still uses these hidden controls as a compatibility adapter.
    // Populate them from the selected project before opening the dialog so its
    // anti-stale-state hydration logic has the correct project-specific source.
    setCompatibilitySelectValue("#vehicleYear", year);
    setCompatibilitySelectValue("#vehicleMake", make);
    setCompatibilitySelectValue("#vehicleModel", model);
  }

  function notify(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(notify.t);
    notify.t = setTimeout(() => toast.classList.remove("show"), 2800);
  }

  async function safe(fn, fallbackMessage) {
    try {
      return await fn();
    } catch (error) {
      console.error(error);
      notify(error?.message || fallbackMessage);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Supabase initialization and data loading
  // ---------------------------------------------------------------------------
async function init(){
 if(configured()&&window.supabase){
  state.supabase=window.supabase.createClient(config.url,config.anonKey);
  const {data,error}=await state.supabase.auth.getSession();if(error)console.error(error);state.user=data.session?.user||null;
  state.supabase.auth.onAuthStateChange((_event,session)=>{state.user=session?.user||null;if(state.user)loadAccount().then(render);else{state.profile=null;state.projects=[];state.currentProject=null;render()}});
  if(state.user)await loadAccount();
 }else state.projects=guestProjects();
 render();
}
function guestProjects(){return[{id:"guest-demo",name:"E36 Track Refresh",description:"Temporary demo project — sign in to persist your builds.",image_url:FALLBACK_IMAGE,start_date:"2026-01-18",created_at:"2026-01-18T12:00:00Z",updated_at:"2026-08-04T16:20:00Z",parts:[{id:"gp1",category:"ENGINE",name:"Cold air intake",cost:340,install_date:"2026-02-10",source:"Example Motors",link:"",notes:"Prototype item."},{id:"gp2",category:"SUSPENSION",name:"Coilover kit",cost:1299,install_date:"2026-08-04",source:"Example Motors",link:"",notes:"Corner-weight after alignment."}],logs:[]}]}
async function loadAccount() {
    if (!state.user) return;

    await safe(async () => {
      const profileResult = await state.supabase
        .from("profiles")
        .select("*")
        .eq("id", state.user.id)
        .maybeSingle();

      if (profileResult.error) throw profileResult.error;

      state.profile = profileResult.data;
      await loadProjects();
    }, "Could not load your account.");
  }

  async function loadProjects() {
    const [summaryResult, visibilityResult] = await Promise.all([
      state.supabase
        .from("project_summaries")
        .select("*")
        .order("updated_at", { ascending: false }),
      state.supabase
        .from("projects")
        .select("id,is_public"),
    ]);

    if (summaryResult.error) throw summaryResult.error;
    if (visibilityResult.error) throw visibilityResult.error;

    const visibilityById = new Map(
      (visibilityResult.data || []).map((project) => [project.id, Boolean(project.is_public)]),
    );

    state.projects = (summaryResult.data || []).map((project) => ({
      ...project,
      is_public: visibilityById.get(project.id) ?? false,
    }));
  }
async function loadProject(id){
 if(!logged()){state.currentProject=state.projects.find(p=>p.id===id)||null;return state.currentProject}
 return safe(async()=>{const p=await state.supabase.from("projects").select("*").eq("id",id).single();if(p.error)throw p.error;const [parts,logs]=await Promise.all([state.supabase.from("parts").select("*").eq("project_id",id).order("created_at"),state.supabase.from("build_logs").select("*").eq("project_id",id).order("created_at",{ascending:false})]);if(parts.error)throw parts.error;if(logs.error)throw logs.error;state.currentProject={...p.data,parts:parts.data||[],logs:logs.data||[]};return state.currentProject},"Could not load this project.")}
function syncHomepageNav(){
 const homeNav=document.querySelector(".home-nav");
 if(homeNav)homeNav.hidden=!logged();
}

function render(){
 syncHomepageNav();
 const h=location.hash.replace(/^#\/?/,"");
 if(h!=="home")stopHomepageClock();
 if(h.startsWith("connect/")){
  state.currentConnectBuildId=decodeURIComponent(h.split("/")[1]||"");
  renderConnectBuild();
 }else if(h==="connect"){
  renderConnect();
 }else if(h==="timeline"){
  renderTimeline();
 }else if(h==="axle"){
  renderAxle();
 }else if(h==="home"){
  if(logged())renderHomepage();
  else renderHome();
 }else if(h==="settings"){
  if(!logged()){
   location.hash="#/projects";
   return;
  }
  renderSettings();
 }else if(h.startsWith("project/")){
  state.currentProjectId=decodeURIComponent(h.split("/")[1]||"");
  renderBuilder();
 }else if(h==="projects"){
  renderProjects();
 }else{
  renderHome();
 }
 main.focus({preventScroll:true});
}

// ---------------------------------------------------------------------------
// AXLE chatbot framework
// ---------------------------------------------------------------------------

const AXLE_ICON = "animation.gif";

function normalizeAxleMessage(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function axleLocalReply(message) {
  const text = normalizeAxleMessage(message);

  const hasAny = (...phrases) => phrases.some((phrase) => {
    if (text === phrase) return true;
    if (phrase.includes(" ")) return text.includes(phrase);
    return text.split(/\s+/).includes(phrase);
  });

  if (hasAny("hello", "hi", "hey", "hiya", "howdy", "yo", "good morning", "good afternoon", "good evening")) {
    return "Bark! I’m AXLE!";
  }

  if (hasAny("what can you do", "what do you do", "how can you help", "help me", "your abilities", "your features", "what are your capabilities")) {
    return "Bark! I’m your personal assistant. I can help you with project management. Currently I’m limited, but in the future I will be able to help you with all aspects of the site.";
  }

  if (hasAny("who are you", "what are you", "tell me about yourself", "your name")) {
    return "Bark! I’m AXLE, RELAY’s AI shop dog. Right now I’m a simple assistant, but I’m being built to help keep your projects organized.";
  }

  if (hasAny("project", "build plan", "plan my build", "next objective", "next step", "what should i do next")) {
    return "Bark! I can help you think through project goals and next steps. For now I can only offer simple guidance, but future AXLE versions will be able to work directly with your RELAY projects.";
  }

  if (hasAny("part", "parts", "budget", "cost", "money", "spend")) {
    return "Bark! Parts and budgets are important to track. RELAY can already store your parts and costs, and future AXLE versions will be able to help organize and review that information with you.";
  }

  if (hasAny("timeline", "deadline", "objective", "objectives", "schedule", "planning mode")) {
    return "Bark! RELAY’s Timeline and Planning Mode are built for objectives and deadlines. In a future version, I’ll be able to help turn your ideas into planned tasks.";
  }

  if (hasAny("connect", "community", "public build", "share my build")) {
    return "Bark! Connect is where public RELAY builds can be shared and explored. I’m not connected to community data yet, but that can be added later.";
  }

  if (hasAny("thank you", "thanks", "thx", "appreciate it")) {
    return "Bark! You got it! I’m always happy to hang around the shop.";
  }

  if (hasAny("bye", "goodbye", "see you", "later")) {
    return "Bark! See you in the garage!";
  }

  return "Bark! I’m still learning that one. Try asking what I can do, or ask me about projects, parts, objectives, timelines, or RELAY.";
}

function axleContext() {
  return {
    signedIn: logged(),
    username: logged() ? homepageUsername() : "Guest",
    projectCount: state.projects.length,
    currentProjectId: state.currentProjectId || null,
  };
}

async function requestAxleReply(message) {
  // Future LLM integration point:
  // Assign an async function to window.RELAY_AXLE_PROVIDER. It will receive the
  // newest message, the current AXLE conversation, and lightweight RELAY context.
  // If no provider exists, AXLE remains fully local and uses the rules below.
  const provider = window.RELAY_AXLE_PROVIDER;
  if (typeof provider === "function") {
    try {
      const response = await provider({
        message,
        history: state.axleMessages.map(({ role, content }) => ({ role, content })),
        context: axleContext(),
      });
      const content = typeof response === "string" ? response : response?.content;
      if (content && String(content).trim()) {
        const clean = String(content).trim();
        return /^bark!/i.test(clean) ? clean : `Bark! ${clean}`;
      }
    } catch (error) {
      console.error("AXLE provider failed; falling back to local responses.", error);
    }
  }

  return axleLocalReply(message);
}

function axleSuggestions() {
  return [
    "Hello",
    "What can you do?",
    "Help me plan my build",
    "Tell me about objectives",
  ];
}

function axleMessageMarkup(message) {
  const assistant = message.role === "assistant";
  return `<div class="axle-message-row ${assistant ? "assistant" : "user"}">${assistant ? `<img class="axle-message-avatar" src="${AXLE_ICON}" alt="AXLE">` : ""}<div class="axle-message ${assistant ? "assistant" : "user"}">${esc(message.content)}</div></div>`;
}

function axleConversationMarkup() {
  if (!state.axleMessages.length) return "";
  return `<div class="axle-chat-log" id="axleChatLog" aria-live="polite">${state.axleMessages.map(axleMessageMarkup).join("")}${state.axleBusy ? `<div class="axle-message-row assistant axle-typing-row"><img class="axle-message-avatar" src="${AXLE_ICON}" alt=""><div class="axle-message assistant axle-typing" aria-label="AXLE is typing"><span></span><span></span><span></span></div></div>` : ""}</div>`;
}

function renderAxle() {
  const started = state.axleMessages.length > 0;
  const suggestions = axleSuggestions();

  main.innerHTML = `<section class="page axle-page ${started ? "started" : "intro"}">
    <div class="axle-shell">
      ${started ? `<header class="axle-chat-header"><img class="axle-header-avatar" src="${AXLE_ICON}" alt="AXLE"><div><p class="eyebrow">AI SHOP DOG</p><h1>AXLE</h1><p class="muted">Work in progress · simple local responses only</p></div></header>${axleConversationMarkup()}` : `<div class="axle-intro"><img class="axle-intro-avatar" src="${AXLE_ICON}" alt="AXLE, the RELAY shop dog"><p class="eyebrow">MEET AXLE</p><h1>AXLE</h1><p>This is AXLE your AI shop dog. He is a work in progress, please be patient.</p><div class="axle-prompt-card"><h2>How can AXLE help?</h2><p class="muted">Start with a simple question about RELAY, your projects, parts, objectives, or planning.</p><div class="axle-suggestions">${suggestions.map((text) => `<button type="button" class="axle-suggestion" data-axle-prompt="${esc(text)}">${esc(text)}</button>`).join("")}</div></div></div>`}
      <form id="axleForm" class="axle-composer" autocomplete="off">
        <textarea id="axleInput" rows="1" maxlength="1200" placeholder="Message AXLE…" aria-label="Message AXLE" ${state.axleBusy ? "disabled" : ""}></textarea>
        <button type="submit" class="button primary axle-send" ${state.axleBusy ? "disabled" : ""}>Send</button>
      </form>
      <p class="axle-disclaimer muted">AXLE is currently a demo framework and does not use an LLM yet.</p>
    </div>
  </section>`;

  $("#axleForm")?.addEventListener("submit", submitAxleMessage);
  $("#axleInput")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  });
  document.querySelectorAll("[data-axle-prompt]").forEach((button) => {
    button.addEventListener("click", () => sendAxleMessage(button.dataset.axlePrompt || ""));
  });

  if (started) {
    requestAnimationFrame(() => {
      const log = $("#axleChatLog");
      if (log) log.scrollTop = log.scrollHeight;
      $("#axleInput")?.focus({ preventScroll: true });
    });
  }
}

async function submitAxleMessage(event) {
  event.preventDefault();
  const input = $("#axleInput");
  const message = input?.value.trim() || "";
  if (!message || state.axleBusy) return;
  if (input) input.value = "";
  await sendAxleMessage(message);
}

async function sendAxleMessage(message) {
  const clean = String(message || "").trim();
  if (!clean || state.axleBusy) return;

  state.axleMessages.push({ role: "user", content: clean });
  state.axleBusy = true;
  renderAxle();

  // A short delay makes the local demo feel conversational while keeping this
  // function asynchronous so a future network/LLM provider can drop in cleanly.
  await new Promise((resolve) => setTimeout(resolve, 360));
  const reply = await requestAxleReply(clean);
  state.axleMessages.push({ role: "assistant", content: reply });
  state.axleBusy = false;

  if (location.hash.replace(/^#\/?/, "") === "axle") renderAxle();
}

function renderHome(){main.innerHTML=`<section class="hero"><div class="hero-inner"><p class="eyebrow">CAR PROJECT ORGANIZER</p><h1>Build the car.<br>Keep the story.</h1><p>One workspace for parts, costs, installation dates, build notes, and the decisions that turn a project car into your project car.</p><button class="button primary" data-route="projects">Take me to the editor</button><p class="muted" style="font-size:.82rem;margin-top:18px">${logged()?`Signed in as ${esc(state.profile?.username||state.user.email)}`:"Guest editor — changes disappear on refresh"}</p></div></section>`}

function homepageUsername(){
 const direct=state.profile?.username||state.user?.user_metadata?.username||state.user?.user_metadata?.display_name;
 if(direct)return String(direct).trim();
 const email=String(state.user?.email||"");
 return email.includes("@")?email.split("@")[0]:"Builder";
}

function homepageGreeting(username){
 const options=[
  `Hey ${username}`,
  `Welcome back ${username}`,
  `Let’s get building ${username}!`,
  `Ready to go ${username}?`,
 ];
 let last=-1;
 try{last=Number(sessionStorage.getItem("relayHomepageGreetingIndex"));}catch{}
 const next=Number.isInteger(last)&&last>=0?(last+1)%options.length:Math.floor(Math.random()*options.length);
 try{sessionStorage.setItem("relayHomepageGreetingIndex",String(next));}catch{}
 return options[next];
}

function renderHomepage(){
 if(!logged()){renderHome();return;}
 const username=homepageUsername();
 const greeting=homepageGreeting(username);
 const quickProjectOptions=state.projects.map(project=>{
  const vehicle=vehicleLabel(project);
  return`<button type="button" class="homepage-quick-project-option" data-homepage-quick-project="${esc(project.id)}" role="option" aria-selected="false"><img src="${esc(projectImageUrl(project.image_url||project.image))}" alt=""><span><strong>${esc(project.name||"Untitled project")}</strong>${vehicle?`<small>${esc(vehicle)}</small>`:""}</span></button>`;
 }).join("");
 main.innerHTML=`<section class="page homepage-page"><div class="page-header homepage-header"><div class="homepage-greeting"><p class="eyebrow">HOMEPAGE</p><h1>${esc(greeting)}</h1><p class="muted">Here’s what’s happening with your builds and the RELAY community.</p><button class="button primary homepage-editor-button" data-route="projects">Take me to the editor</button></div><div id="homepageWeather" class="homepage-weather-blurb" aria-live="polite"><div class="homepage-weather-line"><span id="homepageClock">${esc(homepageTimeText())}</span></div><div class="homepage-weather-status muted">Finding your local weather…</div></div></div><div class="homepage-grid"><div class="homepage-main"><section class="panel homepage-card homepage-quick-update"><div class="homepage-section-head"><div><p class="eyebrow">PROJECTS</p><h2>Quick Update</h2></div></div>${state.projects.length?`<form id="homepageQuickUpdateForm" class="homepage-quick-update-form"><div class="homepage-quick-project-field"><span class="homepage-quick-project-label">Car</span><div class="homepage-quick-project-picker" id="homepageQuickProjectPicker"><button type="button" class="homepage-quick-project-button" id="homepageQuickProjectButton" aria-haspopup="listbox" aria-expanded="false"><span class="homepage-quick-project-placeholder">Select a car</span><span class="homepage-quick-project-chevron" aria-hidden="true">⌄</span></button><input type="hidden" id="homepageQuickProject" value=""><div class="homepage-quick-project-menu" id="homepageQuickProjectMenu" role="listbox" aria-label="Select a car" hidden>${quickProjectOptions}</div></div></div><label>Update<textarea id="homepageQuickText" rows="4" maxlength="3000" required placeholder="What happened? Add a quick update to this project’s build log."></textarea></label><div class="homepage-quick-update-actions"><button type="submit" class="button primary" id="homepageQuickPost">Post Update</button></div></form>`:`<div class="homepage-empty muted">Create a project before posting a quick update.</div>`}</section><section class="panel homepage-card"><div class="homepage-section-head"><div><p class="eyebrow">CONNECT</p><h2>Recent community updates</h2></div><button type="button" class="button ghost" data-route="connect">View Connect</button></div><div id="homepageCommunity" class="homepage-loading">Loading recent activity…</div></section></div><aside class="panel homepage-card homepage-objectives-panel"><div class="homepage-section-head"><div><p class="eyebrow">PLANNING</p><h2>Current Objectives</h2></div></div><div id="homepageObjectives" class="homepage-loading">Loading objectives…</div><div class="homepage-objective-actions"><button type="button" class="button primary" data-route="timeline">Manage Objectives</button></div></aside></div></section>`;
 $("#homepageQuickUpdateForm")?.addEventListener("submit",addHomepageQuickUpdate);
 const quickPicker=$("#homepageQuickProjectPicker");
 quickPicker?.addEventListener("click",event=>{
  const option=event.target.closest?.("[data-homepage-quick-project]");
  if(option){selectHomepageQuickProject(option.dataset.homepageQuickProject);return;}
  const toggle=event.target.closest?.("#homepageQuickProjectButton");
  if(toggle)toggleHomepageQuickProjectMenu();
 });
 quickPicker?.addEventListener("keydown",event=>{
  if(event.key!=="Escape")return;
  closeHomepageQuickProjectMenu();
  $("#homepageQuickProjectButton")?.focus();
 });
 quickPicker?.addEventListener("focusout",()=>setTimeout(()=>{
  const picker=$("#homepageQuickProjectPicker");
  if(picker&&!picker.contains(document.activeElement))closeHomepageQuickProjectMenu();
 },0));
 $("#homepageObjectives")?.addEventListener("click",event=>{
  const button=event.target.closest?.("[data-homepage-complete-objective]");
  if(!button)return;
  completeHomepageObjective(button.dataset.homepageCompleteObjective,button.dataset.projectId,button);
 });
 startHomepageClock();
 loadHomepageObjectives();
 loadHomepageCommunity();
 loadHomepageWeather();
}

function closeHomepageQuickProjectMenu(){
 const menu=$("#homepageQuickProjectMenu");
 const button=$("#homepageQuickProjectButton");
 if(menu)menu.hidden=true;
 if(button)button.setAttribute("aria-expanded","false");
}

function toggleHomepageQuickProjectMenu(){
 const menu=$("#homepageQuickProjectMenu");
 const button=$("#homepageQuickProjectButton");
 if(!menu||!button)return;
 const open=menu.hidden;
 menu.hidden=!open;
 button.setAttribute("aria-expanded",open?"true":"false");
}

function selectHomepageQuickProject(projectId){
 const project=state.projects.find(item=>String(item.id)===String(projectId));
 const input=$("#homepageQuickProject");
 const button=$("#homepageQuickProjectButton");
 if(!project||!input||!button)return;
 input.value=String(project.id);
 button.innerHTML=`<span class="homepage-quick-project-selected"><img src="${esc(projectImageUrl(project.image_url||project.image))}" alt=""><span>${esc(project.name||"Untitled project")}</span></span><span class="homepage-quick-project-chevron" aria-hidden="true">⌄</span>`;
 document.querySelectorAll("[data-homepage-quick-project]").forEach(option=>{
  const selected=String(option.dataset.homepageQuickProject)===String(project.id);
  option.classList.toggle("selected",selected);
  option.setAttribute("aria-selected",selected?"true":"false");
 });
 closeHomepageQuickProjectMenu();
}

function homepageStillActive(){
 return logged()&&location.hash.replace(/^#\/?/,"")==="home";
}

async function loadHomepageObjectives(){
 const root=$("#homepageObjectives");
 if(!root||!logged()||!state.supabase)return;
 const projectIds=state.projects.map(project=>project.id).filter(Boolean);
 if(!projectIds.length){
  root.innerHTML=`<div class="homepage-empty muted">No active objectives yet. Create one in Planning Mode.</div>`;
  return;
 }
 try{
  const {data,error}=await state.supabase.from("objectives").select("*").in("project_id",projectIds).eq("objective_completed",false).order("deadline",{ascending:true,nullsFirst:false});
  if(error)throw error;
  if(!homepageStillActive())return;
  const target=$("#homepageObjectives");
  if(!target)return;
  const projectNames=new Map(state.projects.map(project=>[project.id,project.name||"Untitled project"]));
  const objectives=Array.isArray(data)?data:[];
  const today=todayKey();
  target.innerHTML=objectives.length?`<div class="homepage-objective-list">${objectives.map(item=>{
   const deadlineKey=localDateKey(item.deadline);
   const overdue=Boolean(deadlineKey&&deadlineKey<today);
   return`<article class="homepage-objective-item ${overdue?"overdue":""}"><div class="homepage-objective-main"><div class="homepage-objective-project">From ${esc(projectNames.get(item.project_id)||"Untitled project")}</div><h3>${esc(item.objective_name||"Untitled objective")}</h3><div class="homepage-objective-deadline">Deadline ${esc(numericDateText(item.deadline))}</div></div><button type="button" class="button primary homepage-objective-complete" data-homepage-complete-objective="${esc(item.id)}" data-project-id="${esc(item.project_id)}">Complete task</button></article>`;
  }).join("")}</div>`:`<div class="homepage-empty muted">No active objectives yet. Create one in Planning Mode.</div>`;
 }catch(error){
  console.error(error);
  if(!homepageStillActive())return;
  const target=$("#homepageObjectives");
  if(target)target.innerHTML=`<div class="homepage-empty muted">Current objectives could not be loaded.</div>`;
 }
}

async function completeHomepageObjective(objectiveId,projectId,button){
 if(!logged()||!state.supabase||!objectiveId||!projectId)return;
 if(button){button.disabled=true;button.textContent="Completing…";}
 const result=await safe(async()=>{
  const query=await state.supabase.rpc("complete_objective",{p_objective_id:objectiveId});
  if(query.error)throw query.error;
  return query.data;
 },"Could not mark this objective as completed.");
 if(result===null){
  if(button){button.disabled=false;button.textContent="Complete task";}
  return;
 }
 await touch(projectId);
 notify("Objective completed and added to your build log.");
 await loadHomepageObjectives();
 loadHomepageCommunity();
}

async function addHomepageQuickUpdate(event){
 event.preventDefault();
 if(!logged()||!state.supabase)return;
 const projectId=$("#homepageQuickProject")?.value||"";
 const text=$("#homepageQuickText")?.value.trim()||"";
 if(!projectId){notify("Select a car.");$("#homepageQuickProjectButton")?.focus();return;}
 if(!text)return;
 if(!state.projects.some(project=>String(project.id)===String(projectId))){
  notify("Select one of your projects.");
  return;
 }
 const button=$("#homepageQuickPost");
 if(button){button.disabled=true;button.textContent="Posting…";}
 const result=await safe(async()=>{
  const query=await state.supabase.from("build_logs").insert({project_id:projectId,text}).select().single();
  if(query.error)throw query.error;
  return query.data;
 },"Could not save this quick update.");
 if(result){
  await touch(projectId);
  const input=$("#homepageQuickText");
  if(input)input.value="";
  notify("Build log posted.");
  loadHomepageCommunity();
 }
 const currentButton=$("#homepageQuickPost");
 if(currentButton){currentButton.disabled=false;currentButton.textContent="Post Update";}
}

function homepageActivityTime(value){
 if(!value)return 0;
 const raw=String(value).trim();
 const dateOnly=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 const date=dateOnly?new Date(Number(dateOnly[1]),Number(dateOnly[2])-1,Number(dateOnly[3])):new Date(raw);
 return Number.isNaN(date.getTime())?0:date.getTime();
}

function latestPublicBuildActivity(payload){
 const candidates=[];
 for(const part of Array.isArray(payload?.parts)?payload.parts:[]){
  const activityDate=part.install_date||part.created_at;
  if(activityDate)candidates.push({type:"part",date:activityDate,time:homepageActivityTime(activityDate)});
 }
 for(const post of Array.isArray(payload?.build_logs)?payload.build_logs:[]){
  if(post.created_at)candidates.push({type:"post",date:post.created_at,time:homepageActivityTime(post.created_at)});
 }
 return candidates.sort((a,b)=>b.time-a.time)[0]||null;
}

async function fetchHomepageBuildActivity(build){
 // Use the same public-build RPC that powers Connect. This keeps the homepage
 // compatible with the current database functions and avoids requiring a
 // second homepage-only migration.
 const {data,error}=await state.supabase.rpc("connect_public_build",{build_id:build.id});
 if(error)throw error;
 const activity=latestPublicBuildActivity(data);
 if(!activity)return null;
 return{build:{...build,...(data?.project||{})},activity};
}

async function loadHomepageCommunity(){
 const root=$("#homepageCommunity");
 if(!root||!state.supabase)return;
 try{
  // Requirement: show the four PUBLIC projects with the newest part/log
  // activity. Do not exclude projects based on ownership. Sample community
  // builds may intentionally reuse an existing auth.users owner to satisfy
  // the projects.user_id foreign key, and filtering by owner can otherwise
  // make the entire feed disappear for that account.
  const publicBuilds=await fetchPublicBuilds();
  const seen=new Set();
  const builds=publicBuilds.filter(build=>{
   const id=String(build?.id||"");
   if(!id||seen.has(id))return false;
   seen.add(id);
   return true;
  });
  const settled=await Promise.allSettled(builds.map(fetchHomepageBuildActivity));
  if(!homepageStillActive())return;
  const target=$("#homepageCommunity");
  if(!target)return;
  const recent=settled
   .filter(result=>result.status==="fulfilled"&&result.value)
   .map(result=>result.value)
   .sort((a,b)=>b.activity.time-a.activity.time)
   .slice(0,4);
  target.innerHTML=recent.length?`<div class="homepage-update-list">${recent.map(({build,activity})=>`<article class="homepage-update-card" data-open-connect="${esc(build.id)}" tabindex="0" role="button"><img src="${esc(projectImageUrl(build.image_url))}" alt=""><div class="homepage-update-copy"><div class="homepage-update-kicker">${activity.type==="part"?"Part activity":"Build log post"}</div><h3>${esc(build.name||"Untitled build")}</h3><p>By ${esc(build.owner_name||"RELAY Builder")}</p><span>${esc(dateText(activity.date))}</span></div></article>`).join("")}</div>`:`<div class="homepage-empty muted">No recent community activity yet.</div>`;
 }catch(error){
  console.error(error);
  if(!homepageStillActive())return;
  const target=$("#homepageCommunity");
  if(target)target.innerHTML=`<div class="homepage-empty muted">Community updates could not be loaded.</div>`;
 }
}

function homepageTimeText(timeZone){
 try{
  return new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit",timeZone:timeZone||undefined}).format(new Date());
 }catch{
  return new Intl.DateTimeFormat(undefined,{hour:"numeric",minute:"2-digit"}).format(new Date());
 }
}

function stopHomepageClock(){
 if(state.homepageClockTimer){
  clearInterval(state.homepageClockTimer);
  state.homepageClockTimer=null;
 }
}

function startHomepageClock(timeZone){
 stopHomepageClock();
 const update=()=>{
  const clock=$("#homepageClock");
  if(clock)clock.textContent=homepageTimeText(timeZone);
  else stopHomepageClock();
 };
 update();
 state.homepageClockTimer=setInterval(update,30000);
}

function currentPosition(){
 return new Promise((resolve,reject)=>{
  if(!navigator.geolocation){reject(new Error("Geolocation is not supported by this browser."));return;}
  navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:false,timeout:10000,maximumAge:10*60*1000});
 });
}

function weatherCondition(code){
 const value=Number(code);
 if(value===0)return{label:"Clear",icon:"☀"};
 if(value===1)return{label:"Mainly clear",icon:"☀"};
 if(value===2)return{label:"Partly cloudy",icon:"⛅"};
 if(value===3)return{label:"Overcast",icon:"☁"};
 if([45,48].includes(value))return{label:"Foggy",icon:"☁"};
 if([51,53,55,56,57].includes(value))return{label:"Drizzle",icon:"🌧"};
 if([61,63,65,66,67,80,81,82].includes(value))return{label:"Rain",icon:"🌧"};
 if([71,73,75,77,85,86].includes(value))return{label:"Snow",icon:"❄"};
 if([95,96,99].includes(value))return{label:"Thunderstorms",icon:"⛈"};
 return{label:"Current weather",icon:"◌"};
}

function weatherFlavor(current){
 const code=Number(current?.weather_code);
 const snowing=Number(current?.snowfall||0)>0||[71,73,75,77,85,86].includes(code);
 const raining=Number(current?.rain||0)>0||Number(current?.showers||0)>0||Number(current?.precipitation||0)>0||[51,53,55,56,57,61,63,65,66,67,80,81,82,95,96,99].includes(code);
 const sunny=[0,1].includes(code);
 if(snowing)return"Bring out those snow tires, because it’s mountain season!";
 if(raining)return"Seems a little wet, some drifting perhaps?";
 if(sunny)return"Perfect day for a drive!";
 return"Good weather to get some wrenching done.";
}

async function loadHomepageWeather(){
 const root=$("#homepageWeather");
 if(!root)return;
 try{
  if(!window.isSecureContext&&location.hostname!=="localhost"&&location.hostname!=="127.0.0.1")throw new Error("Location access requires HTTPS.");
  const position=await currentPosition();
  const latitude=position.coords.latitude;
  const longitude=position.coords.longitude;
  const params=new URLSearchParams({
   latitude:String(latitude),
   longitude:String(longitude),
   current:"temperature_2m,apparent_temperature,precipitation,rain,showers,snowfall,weather_code,wind_speed_10m",
   temperature_unit:"fahrenheit",
   wind_speed_unit:"mph",
   precipitation_unit:"inch",
   timezone:"auto",
  });
  const response=await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`,{headers:{Accept:"application/json"}});
  if(!response.ok)throw new Error(`Weather service returned ${response.status}.`);
  const payload=await response.json();
  if(!payload?.current)throw new Error("Current weather was unavailable.");
  if(!homepageStillActive())return;
  const target=$("#homepageWeather");
  if(!target)return;
  const current=payload.current;
  const condition=weatherCondition(current.weather_code);
  const temperature=Math.round(Number(current.temperature_2m));
  const apparent=Math.round(Number(current.apparent_temperature));
  const wind=Math.round(Number(current.wind_speed_10m));
  target.innerHTML=`<div class="homepage-weather-line"><span id="homepageClock">${esc(homepageTimeText(payload.timezone))}</span><span aria-hidden="true">·</span><strong>${Number.isFinite(temperature)?esc(temperature):"—"}°F</strong><span>${esc(condition.icon)} ${esc(condition.label)}</span></div><p class="homepage-weather-flavor">${esc(weatherFlavor(current))}</p><div class="homepage-weather-meta"><span>Feels like ${Number.isFinite(apparent)?esc(apparent):"—"}°F</span><span>Wind ${Number.isFinite(wind)?esc(wind):"—"} mph</span></div>`;
  startHomepageClock(payload.timezone);
 }catch(error){
  console.warn("[RELAY] Local weather unavailable.",error);
  if(!homepageStillActive())return;
  const target=$("#homepageWeather");
  if(!target)return;
  const message=error?.message==="Location access requires HTTPS."?"Location access requires HTTPS for local weather.":"Allow location access to show local weather.";
  target.innerHTML=`<div class="homepage-weather-line"><span id="homepageClock">${esc(homepageTimeText())}</span></div><div class="homepage-weather-status muted">${esc(message)}</div>`;
  startHomepageClock();
 }
}

function renderSettings(){
 const email=state.user?.email||"";
 const username=state.profile?.username||state.user?.user_metadata?.username||"";
 main.innerHTML=`<section class="page settings-page"><div class="page-header settings-header"><div><p class="eyebrow">ACCOUNT</p><h1>Settings</h1><p class="muted">Update your RELAY account information.</p></div></div><form id="settingsForm" class="panel settings-panel"><section class="settings-section"><div class="settings-section-copy"><h2>Account information</h2><p class="muted">Change the email address or username associated with your account.</p></div><div class="form-grid settings-grid"><label class="full">Change email<input id="settingsEmail" type="email" autocomplete="email" value="${esc(email)}" required></label><label class="full">Change username<input id="settingsUsername" maxlength="40" autocomplete="username" value="${esc(username)}"></label></div></section><section class="settings-section"><div class="settings-section-copy"><h2>Change password</h2><p class="muted">Enter your current password before choosing a new password.</p></div><div class="form-grid settings-grid"><label class="full">Enter old password<input id="settingsOldPassword" type="password" autocomplete="current-password" minlength="6"></label><label class="full">Enter new password<input id="settingsNewPassword" type="password" autocomplete="new-password" minlength="6"></label></div></section><p id="settingsError" class="error-text settings-error" hidden></p><div class="settings-actions"><button type="submit" class="button primary" id="settingsApply">Apply</button></div></form></section>`;
 $("#settingsForm")?.addEventListener("submit",saveAccountSettings);
}

async function saveAccountSettings(event){
 event.preventDefault();
 if(!logged()||!state.supabase)return;

 const email=$("#settingsEmail").value.trim();
 const username=$("#settingsUsername").value.trim();
 const oldPassword=$("#settingsOldPassword").value;
 const newPassword=$("#settingsNewPassword").value;
 const errorText=$("#settingsError");
 const applyButton=$("#settingsApply");
 const currentEmail=state.user.email||"";
 const currentUsername=state.profile?.username||state.user?.user_metadata?.username||"";
 const emailChanged=email!==currentEmail;
 const usernameChanged=username!==currentUsername;
 const passwordChanged=Boolean(oldPassword||newPassword);

 errorText.hidden=true;
 errorText.textContent="";

 if(passwordChanged&&(!oldPassword||!newPassword)){
  errorText.textContent="Enter both your old password and your new password.";
  errorText.hidden=false;
  return;
 }
 if(newPassword&&newPassword.length<6){
  errorText.textContent="New password must be at least 6 characters.";
  errorText.hidden=false;
  return;
 }
 if(!emailChanged&&!usernameChanged&&!passwordChanged){
  notify("No account changes to apply.");
  return;
 }

 applyButton.disabled=true;
 applyButton.textContent="Applying…";

 try{
  if(passwordChanged){
   const verifier=window.supabase.createClient(config.url,config.anonKey,{
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
   });
   const verify=await verifier.auth.signInWithPassword({email:currentEmail,password:oldPassword});
   if(verify.error)throw new Error("Your old password is incorrect.");
   await verifier.auth.signOut();
  }

  const authUpdates={};
  if(emailChanged)authUpdates.email=email;
  if(newPassword)authUpdates.password=newPassword;
  if(usernameChanged)authUpdates.data={
   ...(state.user.user_metadata||{}),
   username:username||null,
   display_name:username||null,
  };

  if(Object.keys(authUpdates).length){
   const authResult=await state.supabase.auth.updateUser(authUpdates);
   if(authResult.error)throw authResult.error;
   if(authResult.data?.user)state.user=authResult.data.user;
  }

  if(usernameChanged){
   const profileResult=await state.supabase
    .from("profiles")
    .update({username:username||null})
    .eq("id",state.user.id)
    .select("*")
    .maybeSingle();
   if(profileResult.error)throw profileResult.error;
   state.profile=profileResult.data||{...(state.profile||{}),username:username||null};
  }

  $("#settingsOldPassword").value="";
  $("#settingsNewPassword").value="";

  if(emailChanged&&state.user.email!==email){
   notify("Changes applied. Check your email to confirm the new address.");
  }else{
   notify("Account settings updated.");
  }
  renderSettings();
 }catch(error){
  console.error(error);
  if(!document.body.contains(errorText))renderSettings();
  const currentError=$("#settingsError");
  if(currentError){
   currentError.textContent=error.message||"Could not update your account settings.";
   currentError.hidden=false;
  }
 }finally{
  const button=$("#settingsApply");
  if(button){button.disabled=false;button.textContent="Apply";}
 }
}
function renderProjects(){
 const ps=[...state.projects].sort((a,b)=>state.sort==="cost"?(b.total_cost??total(b))-(a.total_cost??total(a)):state.sort==="mods"?(b.part_count??b.parts?.length??0)-(a.part_count??a.parts?.length??0):new Date(b.updated_at||b.updatedAt)-new Date(a.updated_at||a.updatedAt));
 main.innerHTML=`<section class="page"><div class="page-header"><div><p class="eyebrow">WORKSPACE</p><h1>Your projects</h1><p class="muted">${logged()?"Persistent projects linked to your account.":"Guest mode is temporary. Sign in to persist projects."}</p></div><button class="button primary" data-action="new-project">New project</button></div>${!configured()?`<div class="warning">Supabase is not configured. Add your project URL and publishable/anon key to <code>app.js</code> after running the SQL schema.</div>`:""}<div class="toolbar"><label class="muted">Sort by <select class="select" id="sortSelect"><option value="updated">Recency</option><option value="cost">Total cost</option><option value="mods">Modification amount</option></select></label><button class="button ghost" data-action="import-prompt">Import</button><button class="button ghost" data-action="export">Export</button></div><div class="project-list">${ps.length?ps.map(projectCard).join(""):`<div class="empty"><h2>No projects yet</h2><p class="muted">Start your first build.</p></div>`}</div></section>`;
 $("#sortSelect").value=state.sort;$("#sortSelect").onchange=e=>{state.sort=e.target.value;renderProjects()}
}
function projectCard(p){const vehicle=vehicleLabel(p);return`<article class="project-card" data-open-project="${esc(p.id)}" tabindex="0" role="button"><img class="thumb" src="${esc(p.image_url||p.image||FALLBACK_IMAGE)}" alt=""><div><h3>${esc(p.name)}</h3><div class="project-card-vehicle ${vehicle?"":"missing"}">${esc(vehicle||"Vehicle details not set")}</div><div class="meta">Last modified ${esc(dateText(p.updated_at||p.updatedAt))}${p.is_public?' · Public':''}</div><div class="project-hover">${esc(p.description||"No description yet.")}<br>${esc(dateText(p.start_date||p.startDate))} · ${p.part_count??p.parts?.length??0} modifications</div></div><div class="project-total">${money(p.total_cost??total(p))}</div></article>`}


function timelineModeToggle({disabled=false}={}) {
 const planning=state.timelineMode==="planning";
 return`<label class="timeline-mode-toggle ${disabled?"disabled":""}" title="${disabled?"Planning Mode is available when signed in.":planning?"Switch to View mode":"Switch to Planning Mode"}"><span class="timeline-mode-copy"><strong>${planning?"Planning Mode":"View mode"}</strong></span><input type="checkbox" role="switch" data-action="timeline-mode" ${planning?"checked":""} ${disabled?"disabled":""} aria-label="${planning?"Switch to View mode":"Switch to Planning Mode"}"></label>`;
}

function timelineProjectPicker(selectedProject) {
 const selectedImage=selectedProject?projectImageUrl(selectedProject.image_url||selectedProject.image):"";
 return`<div class="timeline-picker"><button type="button" class="timeline-picker-button" data-action="timeline-toggle" aria-haspopup="listbox" aria-expanded="false">${selectedProject?`<span class="timeline-picker-project"><img src="${esc(selectedImage)}" alt=""><span>${esc(selectedProject.name||"Untitled project")}</span></span>`:`<span class="timeline-picker-placeholder">Select a project</span>`}<span class="timeline-picker-chevron" aria-hidden="true">⌄</span></button><div class="timeline-project-menu" id="timelineProjectMenu" role="listbox" aria-label="Select a project" hidden>${state.projects.length?state.projects.map(project=>`<button type="button" class="timeline-project-option ${selectedProject?.id===project.id?"selected":""}" data-timeline-project="${esc(project.id)}" role="option" aria-selected="${selectedProject?.id===project.id?"true":"false"}"><img src="${esc(projectImageUrl(project.image_url||project.image))}" alt=""><span>${esc(project.name||"Untitled project")}</span></button>`).join(""):`<div class="timeline-project-empty muted">No projects available.</div>`}</div></div>`;
}

function timelineBaseLine(startDate=null, events=[], {planningMode=false,objectives=[]}={}) {
 if(planningMode){
  const active=[...(objectives||[])].filter(item=>!item.objective_completed).sort((a,b)=>String(a.deadline||"").localeCompare(String(b.deadline||""))||String(a.created_at||"").localeCompare(String(b.created_at||"")));
  const dots=active.map((objective,index)=>{
   const position=((index+1)/(active.length+1))*100;
   const edgeClass=position<16?"near-start":position>84?"near-end":"";
   return`<div class="timeline-event-dot timeline-objective-dot ${edgeClass}" style="--timeline-position:${position}%" role="button" tabindex="0" aria-label="Objective ${esc(objective.objective_name||"Untitled objective")}, deadline ${esc(numericDateText(objective.deadline))}"><div class="timeline-event-popover"><article class="timeline-event-tile timeline-objective-tile"><div class="timeline-event-date">Deadline ${esc(numericDateText(objective.deadline))}</div><strong>${esc(objective.objective_name||"Untitled objective")}</strong><p>${esc(objective.additional_notes||"No additional notes.")}</p></article></div></div>`;
  }).join("");
  const today=todayKey();
  return`<div class="timeline-stage-scroll"><div class="timeline-stage timeline-stage-planning"><div class="timeline-track"><span class="timeline-line" aria-hidden="true"></span><span class="timeline-endpoint timeline-endpoint-start" aria-hidden="true"></span>${dots}<div class="timeline-end-label timeline-end-label-start"><strong>Today</strong><span>${esc(numericDateText(today))}</span></div></div></div></div>`;
 }

 const startKey=localDateKey(startDate);
 const endKey=todayKey();
 const start=dateFromKey(startKey);
 const end=dateFromKey(endKey);
 const startTime=start?.getTime();
 const endTime=end?.getTime();
 const span=start&&end?Math.max(1,endTime-startTime):1;
 const dots=events.map(group=>{
  const eventDate=dateFromKey(group.date);
  let position=50;
  if(start&&end&&eventDate){
   position=((eventDate.getTime()-startTime)/span)*100;
   position=Math.min(100,Math.max(0,position));
  }
  const edgeClass=position<16?"near-start":position>84?"near-end":"";
  return`<div class="timeline-event-dot ${edgeClass}" style="--timeline-position:${position}%" role="button" tabindex="0" aria-label="${esc(group.items.length)} timeline ${group.items.length===1?"event":"events"} on ${esc(numericDateText(group.date))}"><div class="timeline-event-popover">${group.items.map(item=>timelineEventTile(item)).join("")}</div></div>`;
 }).join("");
 return`<div class="timeline-stage-scroll"><div class="timeline-stage"><div class="timeline-track"><span class="timeline-line" aria-hidden="true"></span><span class="timeline-endpoint timeline-endpoint-start" aria-hidden="true"></span><span class="timeline-endpoint timeline-endpoint-today" aria-hidden="true"></span>${dots}<div class="timeline-end-label timeline-end-label-start"><strong>Project Start Date</strong><span>${esc(numericDateText(startDate))}</span></div><div class="timeline-end-label timeline-end-label-today"><strong>Today</strong><span>${esc(numericDateText(endKey))}</span></div></div></div></div>`;
}

function timelineEventTile(item) {
 if(item.type==="part"){
  return`<article class="timeline-event-tile"><div class="timeline-event-date">${esc(numericDateText(item.date))}</div><strong>${esc(item.name||"Unnamed part")}</strong><p>${esc(item.description||"No description added.")}</p></article>`;
 }
 return`<article class="timeline-event-tile"><div class="timeline-event-date">${esc(numericDateText(item.date))}</div><p>${esc(item.text||"No post text.")}</p></article>`;
}

function timelineEventGroups(project) {
 const byDate=new Map();
 const add=(date,item)=>{
  const key=localDateKey(date);
  if(!key)return;
  if(!byDate.has(key))byDate.set(key,[]);
  byDate.get(key).push({...item,date:key});
 };
 (project.parts||[]).forEach(part=>{
  if(part.install_date)add(part.install_date,{type:"part",name:part.name,description:part.description||part.notes||""});
 });
 (project.logs||[]).forEach(log=>{
  if(log.created_at)add(log.created_at,{type:"post",text:log.text||""});
 });
 return[...byDate.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,items])=>({date,items}));
}

function timelineObjectiveCard(objective,{completed=false}={}){
 const completion=completed?`<span>Completed ${esc(numericDateText(objective.objective_completed_date))}</span>`:`<span>Deadline ${esc(numericDateText(objective.deadline))}</span>`;
 return`<article class="timeline-objective-card ${completed?"completed":""}"><div class="timeline-objective-main"><div class="timeline-objective-meta">${completion}</div><h3>${esc(objective.objective_name||"Untitled objective")}</h3>${objective.additional_notes?`<p>${esc(objective.additional_notes)}</p>`:""}</div>${completed?"":`<button type="button" class="button primary timeline-objective-complete" data-action="complete-objective" data-objective-id="${esc(objective.id)}">Mark as completed</button>`}</article>`;
}

function timelineObjectivesSection(project){
 if(!project)return`<section class="timeline-objectives"><div class="timeline-objective-section"><div class="timeline-objective-heading"><h2>Current objectives</h2></div><div class="timeline-objective-empty muted">Select a project to view its objectives.</div></div><div class="timeline-objective-section completed-section"><div class="timeline-objective-heading"><h2>Completed objectives</h2></div><div class="timeline-objective-empty muted">Select a project to view completed objectives.</div></div></section>`;
 const objectives=[...(project.objectives||[])];
 const current=objectives.filter(item=>!item.objective_completed).sort((a,b)=>String(a.deadline||"").localeCompare(String(b.deadline||""))||String(a.created_at||"").localeCompare(String(b.created_at||"")));
 const completed=objectives.filter(item=>item.objective_completed).sort((a,b)=>String(b.objective_completed_date||"").localeCompare(String(a.objective_completed_date||""))||String(b.updated_at||"").localeCompare(String(a.updated_at||"")));
 return`<section class="timeline-objectives"><div class="timeline-objective-section"><div class="timeline-objective-heading"><h2>Current objectives</h2><span class="muted">${current.length}</span></div><div class="timeline-objective-list">${current.length?current.map(item=>timelineObjectiveCard(item)).join(""):`<div class="timeline-objective-empty muted">No current objectives for this project.</div>`}</div></div><div class="timeline-objective-section completed-section"><div class="timeline-objective-heading"><h2>Completed objectives</h2><span class="muted">${completed.length}</span></div><div class="timeline-objective-list">${completed.length?completed.map(item=>timelineObjectiveCard(item,{completed:true})).join(""):`<div class="timeline-objective-empty muted">No completed objectives yet.</div>`}</div></div></section>`;
}

function timelinePlanButton(hasProject){
 if(state.timelineMode!=="planning")return"";
 return`<div class="timeline-plan-actions"><button type="button" class="button primary timeline-plan-button" data-action="plan-objective" ${hasProject?"":"disabled"}>Let’s Plan</button></div>`;
}

async function loadTimelineProject(id){
 if(!logged()||!id)return null;
 return safe(async()=>{
  const projectResult=await state.supabase.from("projects").select("*").eq("id",id).single();
  if(projectResult.error)throw projectResult.error;
  const [partsResult,logsResult,objectivesResult]=await Promise.all([
   state.supabase.from("parts").select("*").eq("project_id",id).order("install_date",{ascending:true}),
   state.supabase.from("build_logs").select("*").eq("project_id",id).order("created_at",{ascending:true}),
   state.supabase.from("objectives").select("*").eq("project_id",id).order("deadline",{ascending:true}),
  ]);
  if(partsResult.error)throw partsResult.error;
  if(logsResult.error)throw logsResult.error;
  if(objectivesResult.error)throw objectivesResult.error;
  return{...projectResult.data,parts:partsResult.data||[],logs:logsResult.data||[],objectives:objectivesResult.data||[]};
 },"Could not load this project timeline.");
}

function openObjectiveDialog(){
 if(!logged()||!state.timelineProjectId)return;
 const dialog=$("#objectiveDialog");
 $("#objectiveProjectId").value=state.timelineProjectId;
 $("#objectiveName").value="";
 $("#objectiveDeadline").value="";
 $("#objectiveNotes").value="";
 dialog?.showModal();
}

async function saveObjective(event){
 event.preventDefault();
 if(!logged()||!state.supabase)return;
 const form=$("#objectiveForm");
 if(Number(form?.dataset.currentStep||1)<3){$("#objectiveNextButton")?.click();return;}
 const projectId=$("#objectiveProjectId")?.value||state.timelineProjectId;
 const objectiveName=$("#objectiveName")?.value.trim();
 const deadline=$("#objectiveDeadline")?.value||null;
 const notes=$("#objectiveNotes")?.value.trim()||null;
 if(!projectId||!objectiveName||!deadline)return;
 const result=await safe(async()=>{
  const query=await state.supabase.from("objectives").insert({project_id:projectId,objective_name:objectiveName,deadline,additional_notes:notes}).select().single();
  if(query.error)throw query.error;
  return query.data;
 },"Could not save this objective.");
 if(!result)return;
 $("#objectiveDialog")?.close();
 await touch(projectId);
 notify("Objective added to your future timeline.");
 renderTimeline();
}

async function completeObjective(objectiveId){
 if(!logged()||!state.supabase||!objectiveId||!state.timelineProjectId)return;
 const result=await safe(async()=>{
  const query=await state.supabase.rpc("complete_objective",{p_objective_id:objectiveId});
  if(query.error)throw query.error;
  return query.data;
 },"Could not mark this objective as completed.");
 if(result===null)return;
 await touch(state.timelineProjectId);
 notify("Objective completed and added to your build log.");
 renderTimeline();
}

async function renderTimeline(){
 const routeAtStart=location.hash.replace(/^#\/?/,"");
 if(!logged()){
  state.timelineProjectId=null;
  state.timelineMode="view";
  main.innerHTML=`<section class="page timeline-page timeline-disabled"><div class="page-header timeline-page-header"><div><p class="eyebrow">TIMELINE</p><h1>Timeline Disabled</h1><p class="muted">Timeline is available with a RELAY account. Please log in to continue</p><button class="button primary timeline-signin" data-action="timeline-signin">Sign in</button></div>${timelineModeToggle({disabled:true})}</div>${timelineBaseLine()}${timelineObjectivesSection(null)}</section>`;
  return;
 }

 let selectedSummary=state.projects.find(project=>project.id===state.timelineProjectId)||null;
 if(state.timelineProjectId&&!selectedSummary)state.timelineProjectId=null;
 selectedSummary=state.projects.find(project=>project.id===state.timelineProjectId)||null;
 const planning=state.timelineMode==="planning";
 const pageTop=`<div class="page-header timeline-page-header"><div><p class="eyebrow">TIMELINE</p><h1>${planning?"Your Future Timeline":"Your Project Timeline"}</h1><p class="muted">${planning?"Let’s plan out your build! Select a car to begin.":"Select a project to view its timeline"}</p></div>${timelineModeToggle()}</div>${timelineProjectPicker(selectedSummary)}`;

 if(!selectedSummary){
  main.innerHTML=`<section class="page timeline-page ${planning?"timeline-planning-mode":""}">${pageTop}${timelineBaseLine(null,[],{planningMode:planning})}${timelinePlanButton(false)}${timelineObjectivesSection(null)}</section>`;
  return;
 }

 main.innerHTML=`<section class="page timeline-page ${planning?"timeline-planning-mode":""}">${pageTop}<div class="timeline-loading">Loading timeline…</div></section>`;
 const project=await loadTimelineProject(selectedSummary.id);
 if(location.hash.replace(/^#\/?/,"")!==routeAtStart||state.timelineProjectId!==selectedSummary.id)return;
 if(!project){
  main.innerHTML=`<section class="page timeline-page ${planning?"timeline-planning-mode":""}">${pageTop}<div class="warning">This project timeline could not be loaded.</div>${timelineBaseLine(selectedSummary.start_date,[],{planningMode:planning})}${timelinePlanButton(true)}${timelineObjectivesSection(null)}</section>`;
  return;
 }
 const groups=timelineEventGroups(project);
 main.innerHTML=`<section class="page timeline-page ${planning?"timeline-planning-mode":""}">${pageTop}${timelineBaseLine(project.start_date,groups,{planningMode:planning,objectives:project.objectives})}${timelinePlanButton(true)}${timelineObjectivesSection(project)}</section>`;
}

function closeTimelineMenu(){
 const menu=$("#timelineProjectMenu");
 const button=document.querySelector("[data-action='timeline-toggle']");
 if(menu)menu.hidden=true;
 if(button)button.setAttribute("aria-expanded","false");
}

async function fetchPublicBuilds(){
 if(!state.supabase)throw new Error("Supabase is not configured.");
 const {data,error}=await state.supabase.rpc("connect_public_builds");
 if(error)throw error;
 return Array.isArray(data)?data:[];
}

async function fetchPublicBuild(id){
 if(!state.supabase)throw new Error("Supabase is not configured.");
 const [{data,error},{data:vehicleData,error:vehicleError}]=await Promise.all([
  state.supabase.rpc("connect_public_build",{build_id:id}),
  state.supabase.rpc("connect_public_build_vehicle",{build_id:id}),
 ]);
 if(error)throw error;
 if(vehicleError){
  // Keep Connect backward-compatible if the frontend lands before the migration.
  console.warn("[RELAY] Vehicle metadata RPC unavailable. Run the vehicle metadata migration.",vehicleError);
 }else if(data?.project&&vehicleData){
  data.project={...data.project,...vehicleData};
 }
 return data||null;
}

async function renderConnect(){
 main.innerHTML=`<section class="page"><div class="page-header"><div><p class="eyebrow">CONNECT</p><h1>Community builds</h1><p class="muted">Browse public builds shared by RELAY users.</p></div></div><div class="connect-loading">Loading public builds…</div></section>`;
 try{
  const builds=await fetchPublicBuilds();
  main.innerHTML=`<section class="page"><div class="page-header"><div><p class="eyebrow">CONNECT</p><h1>Community builds</h1><p class="muted">Browse public builds shared by RELAY users.</p></div></div>${builds.length?`<div class="connect-grid">${builds.map(connectCard).join("")}</div>`:`<div class="empty"><h2>No public builds yet</h2><p class="muted">Public projects will appear here as builders share them.</p></div>`}</section>`;
 }catch(error){
  console.error(error);
  main.innerHTML=`<section class="page"><div class="page-header"><div><p class="eyebrow">CONNECT</p><h1>Community builds</h1></div></div><div class="warning">Connect could not load public builds. Make sure the RELAY Connect database migration has been run.</div></section>`;
 }
}

function connectCard(build){
 const image=projectImageUrl(build.image_url);
 return`<article class="connect-card" data-open-connect="${esc(build.id)}" tabindex="0" role="button" aria-label="Open ${esc(build.name)} by ${esc(build.owner_name||"RELAY Builder")}"><img class="connect-card-image" src="${esc(image)}" alt=""><div class="connect-card-copy"><h2>${esc(build.name||"Untitled build")}</h2><p>By ${esc(build.owner_name||"RELAY Builder")}</p></div></article>`;
}

function connectPartRow(part){
 const link=safePublicUrl(part.link);
 return`<article class="connect-part-row"><div><div class="part-name">${esc(part.name||"Unnamed part")}</div><div class="part-sub">${esc(part.source||"Source not specified")}</div>${part.notes?`<p class="connect-part-notes">${esc(part.notes)}</p>`:""}${link?`<a class="connect-part-link" href="${esc(link)}" target="_blank" rel="noopener noreferrer">View part link</a>`:""}</div><div class="cost">${money(part.cost)}</div><div class="date muted">${esc(dateText(part.install_date))}</div></article>`;
}

async function renderConnectBuild(){
 const requestedId=state.currentConnectBuildId;
 main.innerHTML=`<section class="page"><div class="connect-loading">Loading build…</div></section>`;
 try{
  const payload=await fetchPublicBuild(requestedId);
  if(requestedId!==state.currentConnectBuildId)return;
  if(!payload?.project){
   main.innerHTML=`<section class="page"><div class="empty"><h2>Build unavailable</h2><p class="muted">This build does not exist or is no longer public.</p><button class="button ghost" data-route="connect">Back to Connect</button></div></section>`;
   return;
  }

  const p={...payload.project,parts:Array.isArray(payload.parts)?payload.parts:[],logs:Array.isArray(payload.build_logs)?payload.build_logs:[]};
  state.currentConnectBuild=p;
  const category=state.connectCategory;
  const parts=p.parts.filter(x=>x.category===category);
  const logs=p.logs;
  const image=projectImageUrl(p.image_url);

  main.innerHTML=`<section class="page connect-build"><button class="button ghost connect-back" data-route="connect">← Connect</button><div class="builder-head"><img class="builder-image" src="${esc(image)}" alt=""><div><div class="page-header" style="margin-bottom:10px"><div><p class="eyebrow">PUBLIC BUILD</p><h1>${esc(p.name||"Untitled build")}</h1></div></div><p class="project-vehicle ${vehicleLabel(p)?"":"missing"}">${esc(vehicleLabel(p)||"Vehicle details not set")}</p><p class="muted">${esc(p.description||"No description yet.")}</p><div class="builder-meta"><span>Builder: ${esc(p.owner_name||"RELAY Builder")}</span><span>Start: ${esc(dateText(p.start_date))}</span><span>Modified: ${esc(dateText(p.updated_at))}</span><span class="public-badge">Public</span></div></div></div>
<section class="panel"><div class="panel-head"><h2>Build Log</h2><span class="muted">${logs.length} entries</span></div><div class="log-list">${logs.length?logs.map(x=>`<article class="log-item"><div class="muted">${esc(dateText(x.created_at))}</div><p>${esc(x.text)}</p></article>`).join(""):`<div class="stock">No build log entries yet.</div>`}</div></section>
<div class="tabs">${CATEGORIES.map(c=>`<button class="tab ${category===c?"active":""}" data-connect-category="${c}">${c}</button>`).join("")}</div>
<section class="panel parts-panel"><div class="panel-head"><h2>${esc(category)}</h2><span class="muted">${parts.length} ${parts.length===1?"part":"parts"}</span></div>${parts.length?`<div class="parts-list connect-parts-list">${parts.map(connectPartRow).join("")}</div>`:`<div class="stock">Stock</div>`}<div class="total"><span>Total project cost</span><strong>${money(total(p))}</strong></div></section></section>`;
 }catch(error){
  console.error(error);
  main.innerHTML=`<section class="page"><div class="empty"><h2>Build unavailable</h2><p class="muted">This public build could not be loaded.</p><button class="button ghost" data-route="connect">Back to Connect</button></div></section>`;
 }
}
async function renderBuilder(){
 const p=await loadProject(state.currentProjectId);if(!p){location.hash="#/projects";return}
 const parts=(p.parts||[]).filter(x=>x.category===state.category),logs=p.logs||[],visible=p.showAllLogs?logs:logs.slice(0,3);
 main.innerHTML=`<section class="page"><div class="builder-head"><img class="builder-image" src="${esc(p.image_url||FALLBACK_IMAGE)}" alt=""><div><div class="page-header" style="margin-bottom:10px"><div><p class="eyebrow">PROJECT</p><h1>${esc(p.name)}</h1></div><div class="mode-toggle"><button class="${state.editMode?"active":""}" data-action="mode" data-mode="edit">Modify</button><button class="${!state.editMode?"active":""}" data-action="mode" data-mode="view">View</button></div></div><p class="project-vehicle ${vehicleLabel(p)?"":"missing"}">${esc(vehicleLabel(p)||"Vehicle details not set")}</p><p class="muted">${esc(p.description||"No description yet.")}</p><div class="builder-meta"><span>Builder: ${esc(state.profile?.username||"Guest")}</span><span>Start: ${esc(dateText(p.start_date))}</span><span>Modified: ${esc(dateText(p.updated_at))}</span><button class="button ghost" data-action="edit-project">Edit project</button></div></div></div>
<section class="panel"><div class="panel-head"><h2>Build Log</h2><span class="muted">${logs.length} entries</span></div>${state.editMode?`<form class="log-form" id="logForm"><textarea id="logText" placeholder="What happened? Add an install note, inspection, milestone, or setback." required maxlength="3000"></textarea><button class="button primary">Post</button></form>`:""}<div class="log-list">${visible.length?visible.map(x=>`<article class="log-item"><div class="muted">${esc(dateText(x.created_at))}</div><p>${esc(x.text)}</p></article>`).join(""):`<div class="stock">No build log entries yet.</div>`}${logs.length>3?`<button class="button ghost" data-action="logs">${p.showAllLogs?"Show less":"Show more"}</button>`:""}</div></section>
<div class="tabs">${CATEGORIES.map(c=>`<button class="tab ${state.category===c?"active":""}" data-category="${c}">${c}</button>`).join("")}</div>
<section class="panel parts-panel"><div class="panel-head"><h2>${state.category}</h2>${state.editMode?`<button class="button primary" data-action="add-part">${parts.length?"Add new parts":"Let’s change that"}</button>`:""}</div>${parts.length?`<div class="parts-list">${parts.map(partRow).join("")}</div>`:`<div class="stock">Stock</div>`}<div class="total"><span>Total project cost</span><strong>${money(total(p))}</strong></div></section></section>`;
 $("#logForm")?.addEventListener("submit",addLog)
}
function partRow(x){return`<article class="part-row" data-part="${esc(x.id)}" tabindex="0"><div><div class="part-name">${esc(x.name)}</div><div class="part-sub">${esc(x.source||"Source not specified")}</div></div><div class="cost">${money(x.cost)}</div><div class="date muted">${esc(dateText(x.install_date))}</div></article>`}
async function addLog(e){e.preventDefault();const text=$("#logText").value.trim(),p=state.currentProject;if(!text)return;if(!logged()){p.logs.unshift({id:uid(),text,created_at:new Date().toISOString()});p.updated_at=new Date().toISOString();notify("Build log posted for this guest session.");renderBuilder();return}const r=await safe(()=>state.supabase.from("build_logs").insert({project_id:p.id,text}).select().single(),"Could not save build log.");if(!r)return;await touch(p.id);notify("Build log posted.");renderBuilder()}
function openProjectDialog(p=null){
 $("#projectDialogTitle").textContent=p?"Edit project":"New project";
 $("#projectId").value=p?.id||"";
 $("#projectName").value=p?.name||"";
 $("#projectDescription").value=p?.description||"";
 $("#projectStartDate").value=p?.start_date||new Date().toISOString().slice(0,10);
 $("#projectImage").value=p?.image_url||"";
 hydrateProjectVehicleForm(p);
 $("#deleteProjectButton").hidden=!p;

 const publicToggle=$("#projectPublic");
 const visibilityControl=$("#projectVisibilityControl");
 const visibilityMode=$("#projectVisibilityMode");
 const visibilityStatus=$("#projectVisibilityStatus");
 const signedIn=logged();

 publicToggle.checked=signedIn&&Boolean(p?.is_public);
 publicToggle.disabled=!signedIn;
 visibilityControl?.classList.toggle("disabled",!signedIn);
 if(visibilityControl){
  visibilityControl.title=signedIn
   ?"Can other people see your build?"
   :"Build Visibility available only when Signed in";
 }
 if(visibilityMode)visibilityMode.textContent=publicToggle.checked?"Public":"Private";
 if(visibilityStatus){
  visibilityStatus.textContent=!signedIn
   ?"Sign in to make a build public."
   :publicToggle.checked
    ?"Anyone using Connect can view this build."
    :"Only you can access this build.";
 }

 $("#projectDialog").showModal();
}
async function saveProject(e){e.preventDefault();const projectForm=$("#projectForm"),wizardStep=Number(projectForm?.dataset.currentStep||1);if(wizardStep<5){$("#projectNextButton")?.click();return}const id=$("#projectId").value,name=$("#projectName").value.trim();if(!name)return;const vehicleYear=$("#wizardVehicleYear")?.value.trim()||"",vehicleMake=$("#wizardVehicleMake")?.value.trim()||"",vehicleModel=$("#wizardVehicleModel")?.value.trim()||"";const payload={name,description:$("#projectDescription").value.trim(),start_date:$("#projectStartDate").value||null,image_url:$("#projectImage").value.trim()||null,is_public:logged()?Boolean($("#projectPublic")?.checked):false,vehicle_year:vehicleYear?Number(vehicleYear):null,vehicle_make:vehicleMake||null,vehicle_model:vehicleModel||null};if(payload.image_url)try{new URL(payload.image_url)}catch{notify("Please enter a valid image URL.");return}
 if(!logged()){if(id){const p=state.projects.find(x=>x.id===id);Object.assign(p,payload,{updated_at:new Date().toISOString()})}else state.projects.unshift({id:uid(),...payload,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),parts:[],logs:[]});$("#projectDialog").close();notify("Guest project updated.");renderProjects();return}
 const r=await safe(async()=>{if(id){const q=await state.supabase.from("projects").update(payload).eq("id",id).select().single();if(q.error)throw q.error;return q.data}const q=await state.supabase.from("projects").insert({...payload,user_id:state.user.id}).select().single();if(q.error)throw q.error;return q.data},"Could not save project.");if(!r)return;$("#projectDialog").close();await loadProjects();notify(id?"Project updated.":"Project created.");location.hash=`#/project/${id||r.id}`}
async function deleteProject(){const id=$("#projectId").value;if(!id||!confirm("Delete this project and all of its parts/logs?"))return;if(!logged()){state.projects=state.projects.filter(x=>x.id!==id);$("#projectDialog").close();location.hash="#/projects";notify("Project deleted.");return}const r=await safe(()=>state.supabase.from("projects").delete().eq("id",id),"Could not delete project.");if(r===null)return;$("#projectDialog").close();await loadProjects();location.hash="#/projects";notify("Project deleted.")}
function openPart(x=null){$("#partDialogCategory").textContent=state.category||"PART";$("#partDialogTitle").textContent=x?"Part details":"Add part";$("#partId").value=x?.id||"";$("#partCategory").value=x?.category||state.category;$("#partName").value=x?.name||"";$("#partCost").value=x?.cost??"";$("#partDate").value=x?.install_date||"";$("#partSource").value=x?.source||"";$("#partLink").value=x?.link||"";$("#partNotes").value=x?.notes||"";$("#deletePartButton").hidden=!x;const disabled=!state.editMode&&!!x;$("#partForm").querySelectorAll("input:not([type=hidden]),textarea").forEach(e=>e.disabled=disabled);$("#partForm button[type=submit]").hidden=disabled;$("#partDialog").showModal()}
async function savePart(e){e.preventDefault();const partSaveButton=$("#partSaveButton");if(partSaveButton?.hidden){$("#partNextButton")?.click();return}const p=state.currentProject,id=$("#partId").value,name=$("#partName").value.trim();if(!name)return;const payload={project_id:p.id,category:$("#partCategory").value,name,cost:Math.max(0,Number($("#partCost").value)||0),install_date:$("#partDate").value||null,source:$("#partSource").value.trim()||null,link:$("#partLink").value.trim()||null,notes:$("#partNotes").value.trim()||null};if(payload.link)try{new URL(payload.link)}catch{notify("Please enter a valid URL.");return}
 if(!logged()){if(id){const i=p.parts.findIndex(x=>x.id===id);if(i>=0)p.parts[i]={...p.parts[i],...payload}}else p.parts.push({id:uid(),...payload});p.updated_at=new Date().toISOString();$("#partDialog").close();notify(id?"Part updated.":"Part added.");renderBuilder();return}
 const r=await safe(async()=>{if(id){const q=await state.supabase.from("parts").update(payload).eq("id",id).select().single();if(q.error)throw q.error;return q.data}const q=await state.supabase.from("parts").insert(payload).select().single();if(q.error)throw q.error;return q.data},"Could not save part.");if(!r)return;await touch(p.id);$("#partDialog").close();notify(id?"Part updated.":"Part added.");renderBuilder()}
async function deletePart(){const id=$("#partId").value,p=state.currentProject;if(!id||!confirm("Delete this part?"))return;if(!logged()){p.parts=p.parts.filter(x=>x.id!==id);$("#partDialog").close();notify("Part deleted.");renderBuilder();return}const r=await safe(()=>state.supabase.from("parts").delete().eq("id",id),"Could not delete part.");if(r===null)return;await touch(p.id);$("#partDialog").close();notify("Part deleted.");renderBuilder()}
async function touch(id){const {error}=await state.supabase.from("projects").update({updated_at:new Date().toISOString()}).eq("id",id);if(error)console.error(error)}
async function authSubmit(event) {
    event.preventDefault();

    const authError = $("#authError");
    authError.hidden = true;

    if (!state.supabase) {
      notify("Supabase is not configured.");
      $("#authDialog").close();
      return;
    }

    try {
      const email = $("#authEmail").value.trim();
      const password = $("#authPassword").value;
      const username = $("#authUsername").value.trim();

      let result;

      if (state.authMode === "login") {
        result = await state.supabase.auth.signInWithPassword({ email, password });
      } else {
        // Profile creation is handled by the database trigger on auth.users.
        // We only pass the profile values as Auth user metadata here.
        result = await state.supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              username: username || null,
              display_name: username || null,
            },
          },
        });
      }

      if (result.error) throw result.error;

      // With email confirmation enabled, signUp() creates the user/profile but
      // intentionally returns no active session until confirmation is complete.
      if (!result.data.session) {
        notify("Account created. Check your email if confirmation is enabled.");
        $("#authDialog").close();
        return;
      }

      state.user = result.data.user;
      await loadAccount();
      $("#authDialog").close();
      notify("Signed in.");
      if(location.hash==="#/home")render();
      else location.hash="#/home";
    } catch (error) {
      console.error(error);
      authError.hidden = false;
      authError.textContent = error.message || "Authentication failed.";
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async function signOut(){const r=await safe(()=>state.supabase.auth.signOut(),"Could not sign out.");if(r===null)return;state.user=null;state.profile=null;state.projects=guestProjects();location.hash="#/";notify("Signed out. Guest mode is active.")}

  // ---------------------------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------------------------

  function exportData(){const blob=new Blob([JSON.stringify({format:"GarageLog Export",version:2,exportedAt:new Date().toISOString(),projects:state.projects},null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="garagelog-export.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);notify("Export created.")}
function importData(file){const r=new FileReader();r.onerror=()=>notify("Could not read file.");r.onload=async()=>{try{const d=JSON.parse(r.result);if(!Array.isArray(d.projects))throw new Error("Invalid GarageLog export.");if(!logged()){state.projects=d.projects.map(p=>({...p,is_public:false}));notify("Import complete. Imported guest projects are private.");renderProjects();return}for(const p of d.projects){const q=await state.supabase.from("projects").insert({user_id:state.user.id,name:p.name||"Imported Project",description:p.description||"",image_url:p.image_url||p.image||null,start_date:p.start_date||p.startDate||null,is_public:false,vehicle_year:Number(vehicleDetails(p).year)||null,vehicle_make:vehicleDetails(p).make||null,vehicle_model:vehicleDetails(p).model||null}).select().single();if(q.error)throw q.error;for(const x of p.parts||[])await state.supabase.from("parts").insert({project_id:q.data.id,category:x.category||"OTHER",name:x.name||"Imported Part",cost:Number(x.cost)||0,install_date:x.install_date||x.installDate||null,source:x.source||null,link:x.link||null,notes:x.notes||null});for(const l of p.logs||[])await state.supabase.from("build_logs").insert({project_id:q.data.id,text:l.text||""})}await loadProjects();notify("Import complete.");renderProjects()}catch(e){console.error(e);notify(e.message||"Import failed.")}};r.readAsText(file)}

  // ---------------------------------------------------------------------------
  // Global event wiring
  // ---------------------------------------------------------------------------

  document.addEventListener("click",e=>{
 const insideTimelinePicker=e.target.closest?.(".timeline-picker");
 if(!insideTimelinePicker)closeTimelineMenu();
 const route=e.target.closest("[data-route]");
 if(route){location.hash="#/"+route.dataset.route;return}
 const timelineProject=e.target.closest("[data-timeline-project]");
 if(timelineProject){state.timelineProjectId=timelineProject.dataset.timelineProject;closeTimelineMenu();renderTimeline();return}
 const connect=e.target.closest("[data-open-connect]");
 if(connect){location.hash="#/connect/"+encodeURIComponent(connect.dataset.openConnect);return}
 const op=e.target.closest("[data-open-project]");
 if(op){location.hash="#/project/"+encodeURIComponent(op.dataset.openProject);return}
 const connectCat=e.target.closest("[data-connect-category]");
 if(connectCat){state.connectCategory=connectCat.dataset.connectCategory;renderConnectBuild();return}
 const cat=e.target.closest("[data-category]");
 if(cat){state.category=cat.dataset.category;renderBuilder();return}
 const part=e.target.closest("[data-part]");
 if(part){const x=state.currentProject?.parts?.find(p=>p.id===part.dataset.part);if(x)openPart(x);return}
 const a=e.target.closest("[data-action]");
 if(!a)return;
 switch(a.dataset.action){
  case"new-project":openProjectDialog();break;
  case"edit-project":openProjectDialog(state.currentProject);break;
  case"timeline-toggle":{const menu=$("#timelineProjectMenu");if(menu){const next=menu.hidden;menu.hidden=!next;a.setAttribute("aria-expanded",next?"true":"false")}break}
  case"timeline-mode":if(logged()){state.timelineMode=a.checked?"planning":"view";closeTimelineMenu();renderTimeline()}break;
  case"plan-objective":openObjectiveDialog();break;
  case"complete-objective":completeObjective(a.dataset.objectiveId);break;
  case"timeline-signin":state.authMode="login";$("#authTitle").textContent="Sign in";$("#authSubmit").textContent="Sign in";$("#toggleAuth").textContent="Create account";$("#usernameWrap").hidden=true;$("#authEmail").value="";$("#authPassword").value="";$("#authUsername").value="";$("#authError").textContent="";$("#authError").hidden=true;$("#authDialog").showModal();break;
  case"export":exportData();break;
  case"import-prompt":$("#importInput").click();break;
  case"auth":if(state.user)document.querySelector(".account-menu")?.remove()||showAccountMenu();else $("#authDialog").showModal();break;
  case"settings":document.querySelector(".account-menu")?.remove();location.hash="#/settings";break;
  case"mode":state.editMode=a.dataset.mode==="edit";renderBuilder();break;
  case"add-part":openPart();break;
  case"logs":state.currentProject.showAllLogs=!state.currentProject.showAllLogs;renderBuilder();break;
  case"signout":signOut();break;
 }
});
function showAccountMenu(){const m=document.createElement("div");m.className="account-menu";m.innerHTML=`<div class="muted" style="padding:7px 10px">${esc(state.profile?.username||state.user.email)}</div><button data-action="settings">Settings</button><button data-action="signout">Sign out</button>`;document.body.appendChild(m)}
$("#projectForm").addEventListener("submit",saveProject);$("#deleteProjectButton").addEventListener("click",deleteProject);$("#partForm").addEventListener("submit",savePart);$("#deletePartButton").addEventListener("click",deletePart);$("#objectiveForm")?.addEventListener("submit",saveObjective);$("#authForm").addEventListener("submit",authSubmit);
$("#toggleAuth").addEventListener("click",()=>{state.authMode=state.authMode==="login"?"signup":"login";const s=state.authMode==="signup";$("#authTitle").textContent=s?"Create account":"Sign in";$("#authSubmit").textContent=s?"Create account":"Sign in";$("#toggleAuth").textContent=s?"Back to sign in":"Create account";$("#usernameWrap").hidden=!s});

$("#projectPublic")?.addEventListener("change",e=>{
 const mode=$("#projectVisibilityMode");
 const status=$("#projectVisibilityStatus");
 if(mode)mode.textContent=e.target.checked?"Public":"Private";
 if(status)status.textContent=e.target.checked
  ?"Anyone using Connect can view this build."
  :"Only you can access this build.";
});

document.addEventListener("keydown",e=>{
 if(!["Enter"," "].includes(e.key))return;
 const connect=e.target.closest?.("[data-open-connect]");
 if(!connect)return;
 e.preventDefault();
 location.hash="#/connect/"+encodeURIComponent(connect.dataset.openConnect);
});

$("#importInput").addEventListener("change",e=>{if(e.target.files[0])importData(e.target.files[0]);e.target.value=""});window.addEventListener("hashchange",render);init();
})();