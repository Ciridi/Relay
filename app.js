/* RELAY — Supabase-backed car project organizer.
   Never place a service_role/secret key in this browser file. */
(() => {
  "use strict";

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

  // Optional override for deployments that configure Supabase outside this file.
  const config = window.RELAY_SUPABASE || {
    url: "https://coiqtywzdcpremwtfrwe.supabase.co",
    anonKey: "sb_publishable_5whWyCwroyRSUc03OdLpvQ_kkx4r-UQ",
  };

  /*
   * Vehicle data is intentionally accessed through a provider boundary.
   * Today RELAY uses manual make/model/engine entry plus a local year list, so
   * project creation never depends on CarAPI or the Supabase vehicle catalog.
   *
   * A future CarAPI-backed integration can define window.RELAY_VEHICLE_PROVIDER
   * before app.js loads. The provider may normalize user-entered details and
   * return a catalogId without changing the project form or persistence flow.
   */
  const manualVehicleProvider = {
    getYearOptions() {
      const newestModelYear = new Date().getFullYear() + 1;
      const oldestModelYear = 1900;
      return Array.from(
        { length: newestModelYear - oldestModelYear + 1 },
        (_value, index) => newestModelYear - index,
      );
    },

    async resolveVehicle(vehicle) {
      return { vehicle, catalogId: null, source: "manual" };
    },
  };

  const vehicleProvider = window.RELAY_VEHICLE_PROVIDER || manualVehicleProvider;

  const state = {
    supabase: null,
    user: null,
    profile: null,
    projects: [],
    currentProjectId: null,
    currentProject: null,
    category: "ENGINE",
    sort: "updated",
    authMode: "login",
  };

  const $ = (selector) => document.querySelector(selector);
  const main = $("#main");
  const toast = $("#toast");

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

  function guestProjects() {
    return [
      {
        id: "guest-demo",
        name: "E36 Track Refresh",
        description: "Temporary demo project — sign in to persist your builds.",
        image_url: FALLBACK_IMAGE,
        start_date: "2026-01-18",
        created_at: "2026-01-18T12:00:00Z",
        updated_at: "2026-08-04T16:20:00Z",
        vehicle_id: null,
        vehicle_year: 1997,
        vehicle_make: "BMW",
        vehicle_model: "328i",
        vehicle_engine: "M52B28 2.8L I6",
        vehicle: {
          id: null,
          year: 1997,
          make: "BMW",
          model: "328i",
          engine: "M52B28 2.8L I6",
        },
        is_swapped: false,
        swapped_vehicle_id: null,
        parts: [
          {
            id: "gp1",
            category: "ENGINE",
            name: "Cold air intake",
            cost: 340,
            install_date: "2026-02-10",
            source: "Example Motors",
            link: "",
            notes: "Prototype item.",
          },
          {
            id: "gp2",
            category: "SUSPENSION",
            name: "Coilover kit",
            cost: 1299,
            install_date: "2026-08-04",
            source: "Example Motors",
            link: "",
            notes: "Corner-weight after alignment.",
          },
        ],
        logs: [],
      },
    ];
  }

  async function init() {
    if (configured() && window.supabase) {
      state.supabase = window.supabase.createClient(config.url, config.anonKey);
      const { data, error } = await state.supabase.auth.getSession();

      if (error) console.error(error);
      state.user = data.session?.user || null;

      state.supabase.auth.onAuthStateChange((_event, session) => {
        state.user = session?.user || null;

        if (state.user) {
          loadAccount().then(render);
        } else {
          state.profile = null;
          state.projects = guestProjects();
          state.currentProject = null;
          render();
        }
      });

      if (state.user) {
        await loadAccount();
      } else {
        state.projects = guestProjects();
      }
    } else {
      state.projects = guestProjects();
    }

    render();
  }

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
    const { data, error } = await state.supabase
      .from("project_summaries")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) throw error;
    state.projects = (data || []).map(attachVehicleObjects);
  }

  function vehicleFromRecord(project, swapped = false) {
    if (!project) return null;

    const prefix = swapped ? "swapped_vehicle" : "vehicle";
    const nested = swapped ? project.swapped_vehicle : project.vehicle;
    const year = nested?.year ?? project[`${prefix}_year`];
    const make = nested?.make ?? project[`${prefix}_make`];
    const model = nested?.model ?? project[`${prefix}_model`];
    const engine = nested?.engine ?? project[`${prefix}_engine`];

    if (!year && !make && !model && !engine) return null;

    return {
      id: nested?.id || (swapped ? project.swapped_vehicle_id : project.vehicle_id) || null,
      year: year ? Number(year) : null,
      make: make || "",
      model: model || "",
      engine: engine || "",
    };
  }

  function attachVehicleObjects(project) {
    if (!project) return project;
    project.vehicle = vehicleFromRecord(project, false);
    project.swapped_vehicle = vehicleFromRecord(project, true);
    return project;
  }

  async function hydrateProjectVehicles(project) {
    if (!project) return project;

    // Manual fields are always usable, even if vehicle_catalog is empty/unavailable.
    attachVehicleObjects(project);

    if (!state.supabase) return project;
    const ids = [project.vehicle_id, project.swapped_vehicle_id].filter(Boolean);
    if (!ids.length) return project;

    // Legacy/future catalog links are optional enrichment, never a hard dependency.
    try {
      const { data, error } = await state.supabase
        .from("vehicle_catalog")
        .select("id,year,make,model,engine")
        .in("id", ids);

      if (error) throw error;

      const baseCatalogVehicle = data?.find(
        (vehicle) => vehicle.id === project.vehicle_id,
      );
      const swapCatalogVehicle = data?.find(
        (vehicle) => vehicle.id === project.swapped_vehicle_id,
      );

      if (baseCatalogVehicle) project.vehicle = baseCatalogVehicle;
      if (swapCatalogVehicle) project.swapped_vehicle = swapCatalogVehicle;
    } catch (error) {
      console.warn(
        "RELAY vehicle catalog enrichment unavailable; using saved manual vehicle fields.",
        error,
      );
    }

    return project;
  }

  async function loadProject(id) {
    if (!logged()) {
      state.currentProject =
        state.projects.find((project) => project.id === id) || null;
      attachVehicleObjects(state.currentProject);
      return state.currentProject;
    }

    return safe(async () => {
      const projectResult = await state.supabase
        .from("projects")
        .select("*")
        .eq("id", id)
        .single();

      if (projectResult.error) throw projectResult.error;

      const [partsResult, logsResult] = await Promise.all([
        state.supabase
          .from("parts")
          .select("*")
          .eq("project_id", id)
          .order("created_at"),
        state.supabase
          .from("build_logs")
          .select("*")
          .eq("project_id", id)
          .order("created_at", { ascending: false }),
      ]);

      if (partsResult.error) throw partsResult.error;
      if (logsResult.error) throw logsResult.error;

      state.currentProject = {
        ...projectResult.data,
        parts: partsResult.data || [],
        logs: logsResult.data || [],
      };

      await hydrateProjectVehicles(state.currentProject);
      return state.currentProject;
    }, "Could not load this project.");
  }

  function render() {
    const route = location.hash.replace(/^#\/?/, "");

    if (route.startsWith("project/")) {
      state.currentProjectId = decodeURIComponent(route.split("/")[1] || "");
      renderBuilder();
    } else if (route === "projects") {
      renderProjects();
    } else {
      renderHome();
    }

    main.focus({ preventScroll: true });
  }

  function renderHome() {
    main.innerHTML = `
      <section class="hero">
        <div class="hero-inner">
          <p class="eyebrow">CAR PROJECT ORGANIZER</p>
          <h1>Build the car.<br>Keep the story.</h1>
          <p>One workspace for parts, costs, installation dates, build notes, and the decisions that turn a project car into your project car.</p>
          <button class="button primary" data-route="projects">Take me to the editor</button>
          <p class="muted" style="font-size:.82rem;margin-top:18px">
            ${
              logged()
                ? `Signed in as ${esc(state.profile?.username || state.user.email)}`
                : "Guest editor — changes disappear on refresh"
            }
          </p>
        </div>
      </section>`;
  }

  function projectVehicleText(project) {
    if (project?.vehicle) {
      return `${project.vehicle.year} ${project.vehicle.make} ${project.vehicle.model}`;
    }

    if (project?.vehicle_year && project?.vehicle_make && project?.vehicle_model) {
      return `${project.vehicle_year} ${project.vehicle_make} ${project.vehicle_model}`;
    }

    return "Vehicle not set";
  }

  function projectCard(project) {
    return `
      <article class="project-card" data-open-project="${esc(project.id)}" tabindex="0" role="button">
        <img class="thumb" src="${esc(project.image_url || project.image || FALLBACK_IMAGE)}" alt="">
        <div>
          <h3>${esc(project.name)}</h3>
          <div class="meta">${esc(projectVehicleText(project))} · Last modified ${esc(
            dateText(project.updated_at || project.updatedAt),
          )}</div>
          <div class="project-hover">
            ${esc(project.description || "No description yet.")}<br>
            ${esc(dateText(project.start_date || project.startDate))} · ${
              project.part_count ?? project.parts?.length ?? 0
            } modifications
          </div>
        </div>
        <div class="project-total">${money(project.total_cost ?? total(project))}</div>
      </article>`;
  }

  function renderProjects() {
    const projects = [...state.projects].sort((a, b) => {
      if (state.sort === "cost") {
        return (b.total_cost ?? total(b)) - (a.total_cost ?? total(a));
      }

      if (state.sort === "mods") {
        return (b.part_count ?? b.parts?.length ?? 0) - (a.part_count ?? a.parts?.length ?? 0);
      }

      return new Date(b.updated_at || b.updatedAt) - new Date(a.updated_at || a.updatedAt);
    });

    main.innerHTML = `
      <section class="page">
        <div class="page-header">
          <div>
            <p class="eyebrow">WORKSPACE</p>
            <h1>Your projects</h1>
            <p class="muted">${
              logged()
                ? "Persistent projects linked to your account."
                : "Guest mode is temporary. Sign in to persist projects."
            }</p>
          </div>
          <button class="button primary" data-action="new-project">New project</button>
        </div>

        ${
          !configured()
            ? `<div class="warning">Supabase is not configured. Add your project URL and publishable/anon key to <code>app.js</code> after running the SQL schema.</div>`
            : ""
        }

        <div class="toolbar">
          <label class="muted">
            Sort by
            <select class="select" id="sortSelect">
              <option value="updated">Recency</option>
              <option value="cost">Total cost</option>
              <option value="mods">Modification amount</option>
            </select>
          </label>
          <button class="button ghost" data-action="import-prompt">Import</button>
          <button class="button ghost" data-action="export">Export</button>
        </div>

        <div class="project-list">
          ${
            projects.length
              ? projects.map(projectCard).join("")
              : `<div class="empty"><h2>No projects yet</h2><p class="muted">Start your first build.</p></div>`
          }
        </div>
      </section>`;

    $("#sortSelect").value = state.sort;
    $("#sortSelect").onchange = (event) => {
      state.sort = event.target.value;
      renderProjects();
    };
  }

  function vehicleDetailMarkup(project) {
    const vehicle = project.vehicle;
    const swappedVehicle = project.swapped_vehicle;

    if (!vehicle) {
      return `<span>Vehicle: not set</span>`;
    }

    const base = `<span>Vehicle: ${esc(`${vehicle.year} ${vehicle.make} ${vehicle.model}`)}</span><span>Engine: ${esc(vehicle.engine)}</span>`;

    if (!project.is_swapped || !swappedVehicle) return base;

    return `${base}<span class="swap-meta">Swapped from: ${esc(
      `${swappedVehicle.year} ${swappedVehicle.make} ${swappedVehicle.model} · ${swappedVehicle.engine}`,
    )}</span>`;
  }

  async function renderBuilder() {
    const project = await loadProject(state.currentProjectId);
    if (!project) {
      location.hash = "#/projects";
      return;
    }

    const parts = (project.parts || []).filter((part) => part.category === state.category);
    const logs = project.logs || [];
    const visibleLogs = project.showAllLogs ? logs : logs.slice(0, 3);

    main.innerHTML = `
      <section class="page">
        <div class="builder-head">
          <img class="builder-image" src="${esc(project.image_url || FALLBACK_IMAGE)}" alt="">
          <div>
            <div class="page-header" style="margin-bottom:10px">
              <div>
                <p class="eyebrow">PROJECT</p>
                <h1>${esc(project.name)}</h1>
              </div>
            </div>
            <p class="muted">${esc(project.description || "No description yet.")}</p>
            <div class="builder-meta">
              ${vehicleDetailMarkup(project)}
              <span>Builder: ${esc(state.profile?.username || "Guest")}</span>
              <span>Start: ${esc(dateText(project.start_date))}</span>
              <span>Modified: ${esc(dateText(project.updated_at))}</span>
              <button class="button ghost" data-action="edit-project">Edit project</button>
            </div>
          </div>
        </div>

        <section class="panel">
          <div class="panel-head">
            <h2>Build Log</h2>
            <span class="muted">${logs.length} entries</span>
          </div>
          <form class="log-form" id="logForm">
            <textarea id="logText" placeholder="What happened? Add an install note, inspection, milestone, or setback." required maxlength="3000"></textarea>
            <button class="button primary">Post</button>
          </form>
          <div class="log-list">
            ${
              visibleLogs.length
                ? visibleLogs
                    .map(
                      (entry) => `
                        <article class="log-item">
                          <div class="muted">${esc(dateText(entry.created_at))}</div>
                          <p>${esc(entry.text)}</p>
                        </article>`,
                    )
                    .join("")
                : `<div class="stock">No build log entries yet.</div>`
            }
            ${
              logs.length > 3
                ? `<button class="button ghost" data-action="logs">${
                    project.showAllLogs ? "Show less" : "Show more"
                  }</button>`
                : ""
            }
          </div>
        </section>

        <div class="tabs">
          ${CATEGORIES.map(
            (category) => `
              <button class="tab ${state.category === category ? "active" : ""}" data-category="${category}">
                ${category}
              </button>`,
          ).join("")}
        </div>

        <section class="panel parts-panel">
          <div class="panel-head">
            <h2>${state.category}</h2>
            <button class="button primary" data-action="add-part">
              ${parts.length ? "Add new parts" : "Let’s change that"}
            </button>
          </div>
          ${
            parts.length
              ? `<div class="parts-list">${parts.map(partRow).join("")}</div>`
              : `<div class="stock">Stock</div>`
          }
          <div class="total">
            <span>Total project cost</span>
            <strong>${money(total(project))}</strong>
          </div>
        </section>
      </section>`;

    $("#logForm")?.addEventListener("submit", addLog);
  }

  function partRow(part) {
    return `
      <article class="part-row" data-part="${esc(part.id)}" tabindex="0">
        <div>
          <div class="part-name">${esc(part.name)}</div>
          <div class="part-sub">${esc(part.source || "Source not specified")}</div>
        </div>
        <div class="cost">${money(part.cost)}</div>
        <div class="date muted">${esc(dateText(part.install_date))}</div>
      </article>`;
  }

  async function addLog(event) {
    event.preventDefault();
    const text = $("#logText").value.trim();
    const project = state.currentProject;
    if (!text) return;

    if (!logged()) {
      project.logs.unshift({ id: uid(), text, created_at: new Date().toISOString() });
      project.updated_at = new Date().toISOString();
      notify("Build log posted for this guest session.");
      renderBuilder();
      return;
    }

    const result = await safe(
      () =>
        state.supabase
          .from("build_logs")
          .insert({ project_id: project.id, text })
          .select()
          .single(),
      "Could not save build log.",
    );

    if (!result || result.error) {
      if (result?.error) notify(result.error.message);
      return;
    }

    await touch(project.id);
    notify("Build log posted.");
    renderBuilder();
  }

  const vehicleFieldIds = (prefix) => ({
    year: `#${prefix}Year`,
    make: `#${prefix}Make`,
    model: `#${prefix}Model`,
    engine: `#${prefix}Engine`,
  });

  function populateVehicleYears(prefix, selectedYear = "") {
    const yearSelect = $(vehicleFieldIds(prefix).year);
    const years = vehicleProvider.getYearOptions?.() || manualVehicleProvider.getYearOptions();

    yearSelect.innerHTML = `<option value="">Select year</option>${years
      .map((year) => `<option value="${esc(year)}">${esc(year)}</option>`)
      .join("")}`;

    if (selectedYear) yearSelect.value = String(selectedYear);
  }

  function initializeVehicleFields(prefix, vehicle = null) {
    const ids = vehicleFieldIds(prefix);
    populateVehicleYears(prefix, vehicle?.year || "");
    $(ids.make).value = vehicle?.make || "";
    $(ids.model).value = vehicle?.model || "";
    $(ids.engine).value = vehicle?.engine || "";
  }

  function readVehicle(prefix) {
    const ids = vehicleFieldIds(prefix);
    const year = Number($(ids.year).value);
    const make = $(ids.make).value.trim();
    const model = $(ids.model).value.trim();
    const engine = $(ids.engine).value.trim();

    if (!year || !make || !model || !engine) return null;
    return { year, make, model, engine };
  }

  function vehicleColumnPayload(vehicle, swapped = false) {
    const prefix = swapped ? "swapped_vehicle" : "vehicle";
    return {
      [`${prefix}_year`]: vehicle?.year || null,
      [`${prefix}_make`]: vehicle?.make || null,
      [`${prefix}_model`]: vehicle?.model || null,
      [`${prefix}_engine`]: vehicle?.engine || null,
    };
  }

  async function resolveVehicleForPersistence(vehicle) {
    if (!vehicle) return { vehicle: null, catalogId: null, source: "manual" };

    try {
      const resolved = await vehicleProvider.resolveVehicle?.(vehicle, {
        supabase: state.supabase,
        user: state.user,
      });

      return {
        vehicle: resolved?.vehicle || vehicle,
        catalogId: resolved?.catalogId || null,
        source: resolved?.source || "manual",
      };
    } catch (error) {
      console.warn(
        "RELAY vehicle provider could not resolve a catalog record; saving manual fields instead.",
        error,
      );
      return { vehicle, catalogId: null, source: "manual" };
    }
  }

  function clearVehicleFields(prefix) {
    const ids = vehicleFieldIds(prefix);
    $(ids.year).value = "";
    $(ids.make).value = "";
    $(ids.model).value = "";
    $(ids.engine).value = "";
  }

  function setSwappedFields(enabled, { clear = false } = {}) {
    const fields = $("#swapVehicleFields");
    const ids = vehicleFieldIds("swapVehicle");
    fields.hidden = !enabled;

    for (const selector of Object.values(ids)) {
      $(selector).required = enabled;
    }

    if (!enabled && clear) clearVehicleFields("swapVehicle");
  }

  async function openProjectDialog(project = null) {
    $("#projectDialogTitle").textContent = project ? "Edit project" : "New project";
    $("#projectId").value = project?.id || "";
    $("#projectName").value = project?.name || "";
    $("#projectDescription").value = project?.description || "";
    $("#projectStartDate").value =
      project?.start_date || new Date().toISOString().slice(0, 10);
    $("#projectImage").value = project?.image_url || "";
    $("#deleteProjectButton").hidden = !project;

    const isSwapped = Boolean(project?.is_swapped);
    $("#projectSwapped").checked = isSwapped;
    setSwappedFields(isSwapped);

    initializeVehicleFields("vehicle", project?.vehicle || vehicleFromRecord(project));
    initializeVehicleFields(
      "swapVehicle",
      isSwapped ? project?.swapped_vehicle || vehicleFromRecord(project, true) : null,
    );

    $("#projectDialog").showModal();
  }

  async function saveProject(event) {
    event.preventDefault();

    const id = $("#projectId").value;
    const name = $("#projectName").value.trim();
    if (!name) return;

    const enteredVehicle = readVehicle("vehicle");
    const isSwapped = $("#projectSwapped").checked;
    const enteredSwappedVehicle = isSwapped ? readVehicle("swapVehicle") : null;

    if (!enteredVehicle) {
      notify("Enter the vehicle year, make, model, and engine.");
      return;
    }

    if (isSwapped && !enteredSwappedVehicle) {
      notify("Enter the donor vehicle year, make, model, and engine.");
      return;
    }

    const [vehicleResolution, swappedVehicleResolution] = await Promise.all([
      resolveVehicleForPersistence(enteredVehicle),
      isSwapped
        ? resolveVehicleForPersistence(enteredSwappedVehicle)
        : Promise.resolve({ vehicle: null, catalogId: null, source: "manual" }),
    ]);

    const vehicle = vehicleResolution.vehicle;
    const swappedVehicle = swappedVehicleResolution.vehicle;

    const payload = {
      name,
      description: $("#projectDescription").value.trim(),
      start_date: $("#projectStartDate").value || null,
      image_url: $("#projectImage").value.trim() || null,
      ...vehicleColumnPayload(vehicle),
      vehicle_id: vehicleResolution.catalogId,
      is_swapped: isSwapped,
      ...vehicleColumnPayload(swappedVehicle, true),
      swapped_vehicle_id: swappedVehicleResolution.catalogId,
    };

    if (payload.image_url) {
      try {
        new URL(payload.image_url);
      } catch {
        notify("Please enter a valid image URL.");
        return;
      }
    }

    if (!logged()) {
      if (id) {
        const project = state.projects.find((item) => item.id === id);
        if (!project) return;
        Object.assign(project, payload, {
          vehicle,
          swapped_vehicle: swappedVehicle,
          updated_at: new Date().toISOString(),
        });
      } else {
        state.projects.unshift({
          id: uid(),
          ...payload,
          vehicle,
          swapped_vehicle: swappedVehicle,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          parts: [],
          logs: [],
        });
      }

      $("#projectDialog").close();
      notify(id ? "Guest project updated." : "Guest project created.");
      renderProjects();
      return;
    }

    const result = await safe(async () => {
      if (id) {
        const query = await state.supabase
          .from("projects")
          .update(payload)
          .eq("id", id)
          .select()
          .single();
        if (query.error) throw query.error;
        return query.data;
      }

      const query = await state.supabase
        .from("projects")
        .insert({ ...payload, user_id: state.user.id })
        .select()
        .single();
      if (query.error) throw query.error;
      return query.data;
    }, "Could not save project.");

    if (!result) return;

    $("#projectDialog").close();
    await loadProjects();
    notify(id ? "Project updated." : "Project created.");
    location.hash = `#/project/${id || result.id}`;
  }

  async function deleteProject() {
    const id = $("#projectId").value;
    if (!id || !confirm("Delete this project and all of its parts/logs?")) return;

    if (!logged()) {
      state.projects = state.projects.filter((project) => project.id !== id);
      $("#projectDialog").close();
      location.hash = "#/projects";
      notify("Project deleted.");
      return;
    }

    const result = await safe(
      () => state.supabase.from("projects").delete().eq("id", id),
      "Could not delete project.",
    );
    if (result === null) return;

    $("#projectDialog").close();
    await loadProjects();
    location.hash = "#/projects";
    notify("Project deleted.");
  }

  function openPart(part = null) {
    $("#partDialogEyebrow").textContent = state.category;
    $("#partDialogTitle").textContent = part ? "Part details" : "Add part";
    $("#partId").value = part?.id || "";
    $("#partCategory").value = part?.category || state.category;
    $("#partName").value = part?.name || "";
    $("#partCost").value = part?.cost ?? "";
    $("#partDate").value = part?.install_date || "";
    $("#partSource").value = part?.source || "";
    $("#partLink").value = part?.link || "";
    $("#partNotes").value = part?.notes || "";
    $("#deletePartButton").hidden = !part;
    $("#partDialog").showModal();
  }

  async function savePart(event) {
    event.preventDefault();

    const project = state.currentProject;
    const id = $("#partId").value;
    const name = $("#partName").value.trim();
    if (!name) return;

    const payload = {
      project_id: project.id,
      category: $("#partCategory").value,
      name,
      cost: Math.max(0, Number($("#partCost").value) || 0),
      install_date: $("#partDate").value || null,
      source: $("#partSource").value.trim() || null,
      link: $("#partLink").value.trim() || null,
      notes: $("#partNotes").value.trim() || null,
    };

    if (payload.link) {
      try {
        new URL(payload.link);
      } catch {
        notify("Please enter a valid URL.");
        return;
      }
    }

    if (!logged()) {
      if (id) {
        const index = project.parts.findIndex((part) => part.id === id);
        if (index >= 0) project.parts[index] = { ...project.parts[index], ...payload };
      } else {
        project.parts.push({ id: uid(), ...payload });
      }

      project.updated_at = new Date().toISOString();
      $("#partDialog").close();
      notify(id ? "Part updated." : "Part added.");
      renderBuilder();
      return;
    }

    const result = await safe(async () => {
      if (id) {
        const query = await state.supabase
          .from("parts")
          .update(payload)
          .eq("id", id)
          .select()
          .single();
        if (query.error) throw query.error;
        return query.data;
      }

      const query = await state.supabase.from("parts").insert(payload).select().single();
      if (query.error) throw query.error;
      return query.data;
    }, "Could not save part.");

    if (!result) return;

    await touch(project.id);
    $("#partDialog").close();
    notify(id ? "Part updated." : "Part added.");
    renderBuilder();
  }

  async function deletePart() {
    const id = $("#partId").value;
    const project = state.currentProject;
    if (!id || !confirm("Delete this part?")) return;

    if (!logged()) {
      project.parts = project.parts.filter((part) => part.id !== id);
      $("#partDialog").close();
      notify("Part deleted.");
      renderBuilder();
      return;
    }

    const result = await safe(
      () => state.supabase.from("parts").delete().eq("id", id),
      "Could not delete part.",
    );
    if (result === null) return;

    await touch(project.id);
    $("#partDialog").close();
    notify("Part deleted.");
    renderBuilder();
  }

  async function touch(id) {
    const { error } = await state.supabase
      .from("projects")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) console.error(error);
  }

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

  async function signOut() {
    const result = await safe(
      () => state.supabase.auth.signOut(),
      "Could not sign out.",
    );
    if (result === null) return;

    state.user = null;
    state.profile = null;
    state.projects = guestProjects();
    location.hash = "#/projects";
    notify("Signed out. Guest mode is active.");
  }

  function exportData() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            format: "RELAY Export",
            version: 4,
            exportedAt: new Date().toISOString(),
            projects: state.projects,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "relay-export.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
    notify("Export created.");
  }

  function importedVehicle(project, swapped = false) {
    return vehicleFromRecord(project, swapped);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onerror = () => notify("Could not read file.");

    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.projects)) {
          throw new Error("Invalid RELAY export.");
        }

        if (!logged()) {
          state.projects = data.projects.map(attachVehicleObjects);
          notify("Import complete.");
          renderProjects();
          return;
        }

        for (const project of data.projects) {
          const baseVehicle = importedVehicle(project, false);
          const swapVehicle = project.is_swapped
            ? importedVehicle(project, true)
            : null;
          const [baseResolution, swapResolution] = await Promise.all([
            resolveVehicleForPersistence(baseVehicle),
            project.is_swapped
              ? resolveVehicleForPersistence(swapVehicle)
              : Promise.resolve({ vehicle: null, catalogId: null }),
          ]);

          const projectResult = await state.supabase
            .from("projects")
            .insert({
              user_id: state.user.id,
              name: project.name || "Imported Project",
              description: project.description || "",
              image_url: project.image_url || project.image || null,
              start_date: project.start_date || project.startDate || null,
              ...vehicleColumnPayload(baseResolution.vehicle),
              vehicle_id: baseResolution.catalogId,
              is_swapped: Boolean(project.is_swapped && swapResolution.vehicle),
              ...vehicleColumnPayload(swapResolution.vehicle, true),
              swapped_vehicle_id: swapResolution.catalogId,
            })
            .select()
            .single();

          if (projectResult.error) throw projectResult.error;

          for (const part of project.parts || []) {
            const partResult = await state.supabase.from("parts").insert({
              project_id: projectResult.data.id,
              category: part.category || "OTHER",
              name: part.name || "Imported Part",
              cost: Number(part.cost) || 0,
              install_date: part.install_date || part.installDate || null,
              source: part.source || null,
              link: part.link || null,
              notes: part.notes || null,
            });
            if (partResult.error) throw partResult.error;
          }

          for (const log of project.logs || []) {
            const logResult = await state.supabase.from("build_logs").insert({
              project_id: projectResult.data.id,
              text: log.text || "",
            });
            if (logResult.error) throw logResult.error;
          }
        }

        await loadProjects();
        notify("Import complete.");
        renderProjects();
      } catch (error) {
        console.error(error);
        notify(error.message || "Import failed.");
      }
    };

    reader.readAsText(file);
  }

  function showAccountMenu() {
    document.querySelector(".account-menu")?.remove();
    const menu = document.createElement("div");
    menu.className = "account-menu";
    menu.innerHTML = `
      <div class="muted" style="padding:7px 10px">${esc(
        state.profile?.username || state.user.email,
      )}</div>
      <button data-action="signout">Sign out</button>`;
    document.body.appendChild(menu);
  }

  document.addEventListener("click", (event) => {
    const route = event.target.closest("[data-route]");
    if (route) {
      location.hash = `#/${route.dataset.route}`;
      return;
    }

    const project = event.target.closest("[data-open-project]");
    if (project) {
      location.hash = `#/project/${encodeURIComponent(project.dataset.openProject)}`;
      return;
    }

    const category = event.target.closest("[data-category]");
    if (category) {
      state.category = category.dataset.category;
      renderBuilder();
      return;
    }

    const part = event.target.closest("[data-part]");
    if (part) {
      const record = state.currentProject?.parts?.find(
        (item) => item.id === part.dataset.part,
      );
      if (record) openPart(record);
      return;
    }

    const action = event.target.closest("[data-action]");
    if (!action) return;

    switch (action.dataset.action) {
      case "new-project":
        openProjectDialog();
        break;
      case "edit-project":
        openProjectDialog(state.currentProject);
        break;
      case "export":
        exportData();
        break;
      case "import-prompt":
        $("#importInput").click();
        break;
      case "auth":
        if (state.user) showAccountMenu();
        else $("#authDialog").showModal();
        break;
      case "add-part":
        openPart();
        break;
      case "logs":
        state.currentProject.showAllLogs = !state.currentProject.showAllLogs;
        renderBuilder();
        break;
      case "signout":
        signOut();
        break;
      default:
        break;
    }
  });

  $("#projectSwapped").addEventListener("change", (event) => {
    setSwappedFields(event.target.checked, { clear: true });
  });

  $("#projectForm").addEventListener("submit", saveProject);
  $("#deleteProjectButton").addEventListener("click", deleteProject);
  $("#partForm").addEventListener("submit", savePart);
  $("#deletePartButton").addEventListener("click", deletePart);
  $("#authForm").addEventListener("submit", authSubmit);

  $("#toggleAuth").addEventListener("click", () => {
    state.authMode = state.authMode === "login" ? "signup" : "login";
    const signup = state.authMode === "signup";
    $("#authTitle").textContent = signup ? "Create account" : "Sign in";
    $("#authSubmit").textContent = signup ? "Create account" : "Sign in";
    $("#toggleAuth").textContent = signup ? "Back to sign in" : "Create account";
    $("#usernameWrap").hidden = !signup;
  });

  $("#importInput").addEventListener("change", (event) => {
    if (event.target.files[0]) importData(event.target.files[0]);
    event.target.value = "";
  });

  window.addEventListener("hashchange", render);
  init();
})();
