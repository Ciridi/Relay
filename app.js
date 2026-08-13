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

  const dateText = (value) =>
    value
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
          new Date(value),
        )
      : "—";

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
function render(){
 const h=location.hash.replace(/^#\/?/,"");
 if(h.startsWith("connect/")){
  state.currentConnectBuildId=decodeURIComponent(h.split("/")[1]||"");
  renderConnectBuild();
 }else if(h==="connect"){
  renderConnect();
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
function renderHome(){main.innerHTML=`<section class="hero"><div class="hero-inner"><p class="eyebrow">CAR PROJECT ORGANIZER</p><h1>Build the car.<br>Keep the story.</h1><p>One workspace for parts, costs, installation dates, build notes, and the decisions that turn a project car into your project car.</p><button class="button primary" data-route="projects">Take me to the editor</button><p class="muted" style="font-size:.82rem;margin-top:18px">${logged()?`Signed in as ${esc(state.profile?.username||state.user.email)}`:"Guest editor — changes disappear on refresh"}</p></div></section>`}
function renderProjects(){
 const ps=[...state.projects].sort((a,b)=>state.sort==="cost"?(b.total_cost??total(b))-(a.total_cost??total(a)):state.sort==="mods"?(b.part_count??b.parts?.length??0)-(a.part_count??a.parts?.length??0):new Date(b.updated_at||b.updatedAt)-new Date(a.updated_at||a.updatedAt));
 main.innerHTML=`<section class="page"><div class="page-header"><div><p class="eyebrow">WORKSPACE</p><h1>Your projects</h1><p class="muted">${logged()?"Persistent projects linked to your account.":"Guest mode is temporary. Sign in to persist projects."}</p></div><button class="button primary" data-action="new-project">New project</button></div>${!configured()?`<div class="warning">Supabase is not configured. Add your project URL and publishable/anon key to <code>app.js</code> after running the SQL schema.</div>`:""}<div class="toolbar"><label class="muted">Sort by <select class="select" id="sortSelect"><option value="updated">Recency</option><option value="cost">Total cost</option><option value="mods">Modification amount</option></select></label><button class="button ghost" data-action="import-prompt">Import</button><button class="button ghost" data-action="export">Export</button></div><div class="project-list">${ps.length?ps.map(projectCard).join(""):`<div class="empty"><h2>No projects yet</h2><p class="muted">Start your first build.</p></div>`}</div></section>`;
 $("#sortSelect").value=state.sort;$("#sortSelect").onchange=e=>{state.sort=e.target.value;renderProjects()}
}
function projectCard(p){const vehicle=vehicleLabel(p);return`<article class="project-card" data-open-project="${esc(p.id)}" tabindex="0" role="button"><img class="thumb" src="${esc(p.image_url||p.image||FALLBACK_IMAGE)}" alt=""><div><h3>${esc(p.name)}</h3><div class="project-card-vehicle ${vehicle?"":"missing"}">${esc(vehicle||"Vehicle details not set")}</div><div class="meta">Last modified ${esc(dateText(p.updated_at||p.updatedAt))}${p.is_public?' · Public':''}</div><div class="project-hover">${esc(p.description||"No description yet.")}<br>${esc(dateText(p.start_date||p.startDate))} · ${p.part_count??p.parts?.length??0} modifications</div></div><div class="project-total">${money(p.total_cost??total(p))}</div></article>`}

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
async function saveProject(e){e.preventDefault();const id=$("#projectId").value,name=$("#projectName").value.trim();if(!name)return;const vehicleYear=$("#wizardVehicleYear")?.value.trim()||"",vehicleMake=$("#wizardVehicleMake")?.value.trim()||"",vehicleModel=$("#wizardVehicleModel")?.value.trim()||"";const payload={name,description:$("#projectDescription").value.trim(),start_date:$("#projectStartDate").value||null,image_url:$("#projectImage").value.trim()||null,is_public:logged()?Boolean($("#projectPublic")?.checked):false,vehicle_year:vehicleYear?Number(vehicleYear):null,vehicle_make:vehicleMake||null,vehicle_model:vehicleModel||null};if(payload.image_url)try{new URL(payload.image_url)}catch{notify("Please enter a valid image URL.");return}
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
      render();
    } catch (error) {
      console.error(error);
      authError.hidden = false;
      authError.textContent = error.message || "Authentication failed.";
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  async function signOut(){const r=await safe(()=>state.supabase.auth.signOut(),"Could not sign out.");if(r===null)return;state.user=null;state.profile=null;state.projects=guestProjects();location.hash="#/projects";notify("Signed out. Guest mode is active.")}

  // ---------------------------------------------------------------------------
  // Import / export
  // ---------------------------------------------------------------------------

  function exportData(){const blob=new Blob([JSON.stringify({format:"GarageLog Export",version:2,exportedAt:new Date().toISOString(),projects:state.projects},null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="garagelog-export.json";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);notify("Export created.")}
function importData(file){const r=new FileReader();r.onerror=()=>notify("Could not read file.");r.onload=async()=>{try{const d=JSON.parse(r.result);if(!Array.isArray(d.projects))throw new Error("Invalid GarageLog export.");if(!logged()){state.projects=d.projects.map(p=>({...p,is_public:false}));notify("Import complete. Imported guest projects are private.");renderProjects();return}for(const p of d.projects){const q=await state.supabase.from("projects").insert({user_id:state.user.id,name:p.name||"Imported Project",description:p.description||"",image_url:p.image_url||p.image||null,start_date:p.start_date||p.startDate||null,is_public:false,vehicle_year:Number(vehicleDetails(p).year)||null,vehicle_make:vehicleDetails(p).make||null,vehicle_model:vehicleDetails(p).model||null}).select().single();if(q.error)throw q.error;for(const x of p.parts||[])await state.supabase.from("parts").insert({project_id:q.data.id,category:x.category||"OTHER",name:x.name||"Imported Part",cost:Number(x.cost)||0,install_date:x.install_date||x.installDate||null,source:x.source||null,link:x.link||null,notes:x.notes||null});for(const l of p.logs||[])await state.supabase.from("build_logs").insert({project_id:q.data.id,text:l.text||""})}await loadProjects();notify("Import complete.");renderProjects()}catch(e){console.error(e);notify(e.message||"Import failed.")}};r.readAsText(file)}

  // ---------------------------------------------------------------------------
  // Global event wiring
  // ---------------------------------------------------------------------------

  document.addEventListener("click",e=>{
 const route=e.target.closest("[data-route]");
 if(route){location.hash="#/"+route.dataset.route;return}
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
  case"export":exportData();break;
  case"import-prompt":$("#importInput").click();break;
  case"auth":if(state.user)document.querySelector(".account-menu")?.remove()||showAccountMenu();else $("#authDialog").showModal();break;
  case"mode":state.editMode=a.dataset.mode==="edit";renderBuilder();break;
  case"add-part":openPart();break;
  case"logs":state.currentProject.showAllLogs=!state.currentProject.showAllLogs;renderBuilder();break;
  case"signout":signOut();break;
 }
});
function showAccountMenu(){const m=document.createElement("div");m.className="account-menu";m.innerHTML=`<div class="muted" style="padding:7px 10px">${esc(state.profile?.username||state.user.email)}</div><button data-action="signout">Sign out</button>`;document.body.appendChild(m)}
$("#projectForm").addEventListener("submit",saveProject);$("#deleteProjectButton").addEventListener("click",deleteProject);$("#partForm").addEventListener("submit",savePart);$("#deletePartButton").addEventListener("click",deletePart);$("#authForm").addEventListener("submit",authSubmit);
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