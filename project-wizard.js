(() => {
  "use strict";

  const dialog = document.getElementById("projectDialog");
  const form = document.getElementById("projectForm");
  if (!dialog || !form) return;

  const steps = [...form.querySelectorAll("[data-project-step]")];
  const progress = [...form.querySelectorAll("[data-progress-step]")];
  const stepNumber = document.getElementById("projectStepNumber");
  const previousButton = document.getElementById("projectPreviousButton");
  const nextButton = document.getElementById("projectNextButton");
  const saveButton = document.getElementById("projectSaveButton");
  const projectId = document.getElementById("projectId");

  const visibleYear = document.getElementById("wizardVehicleYear");
  const visibleMake = document.getElementById("wizardVehicleMake");
  const visibleModel = document.getElementById("wizardVehicleModel");
  const engineSwap = document.getElementById("engineSwap");
  const engineSwapField = document.getElementById("engineSwapField");
  const engineSwapValue = document.getElementById("engineSwapValue");

  const legacyYear = document.getElementById("vehicleYear");
  const legacyMake = document.getElementById("vehicleMake");
  const legacyModel = document.getElementById("vehicleModel");
  const legacyEngine = document.getElementById("vehicleEngine");
  const legacySwapped = document.getElementById("projectSwapped");
  const legacySwapYear = document.getElementById("swapVehicleYear");
  const legacySwapMake = document.getElementById("swapVehicleMake");
  const legacySwapModel = document.getElementById("swapVehicleModel");
  const legacySwapEngine = document.getElementById("swapVehicleEngine");

  const projectImage = document.getElementById("projectImage");
  const manualImage = document.getElementById("manualProjectImage");
  const imageChoices = document.getElementById("projectImageChoices");
  const imageStatus = document.getElementById("imageSearchStatus");
  const refreshImagesButton = document.getElementById("refreshProjectImages");

  let currentStep = 1;
  let selectedImageUrl = "";
  let lastSearchKey = "";
  let searchController = null;

  function text(value) {
    return String(value ?? "").trim();
  }

  function setLegacySelectValue(select, value) {
    if (!select) return;
    const normalized = text(value);
    const option = document.createElement("option");
    option.value = normalized;
    option.textContent = normalized;
    select.replaceChildren(option);
    select.value = normalized;
  }

  function clearLegacySwapVehicle() {
    setLegacySelectValue(legacySwapYear, "");
    setLegacySelectValue(legacySwapMake, "");
    setLegacySelectValue(legacySwapModel, "");
    setLegacySelectValue(legacySwapEngine, "");
  }

  function clearLegacyVehicleCompatibilityFields() {
    /*
      These hidden controls are only an adapter for the existing app.js. Do not let
      values from one modal session become the source for the next project edit.
    */
    setLegacySelectValue(legacyYear, "");
    setLegacySelectValue(legacyMake, "");
    setLegacySelectValue(legacyModel, "");
    setLegacySelectValue(legacyEngine, "");
    if (legacySwapped) legacySwapped.checked = false;
    clearLegacySwapVehicle();
  }

  function syncCompatibilityFields() {
    setLegacySelectValue(legacyYear, visibleYear?.value);
    setLegacySelectValue(legacyMake, visibleMake?.value);
    setLegacySelectValue(legacyModel, visibleModel?.value);

    const engine = engineSwap?.checked ? text(engineSwapValue?.value) : "";
    setLegacySelectValue(legacyEngine, engine);

    /*
      Critical compatibility fix:
      The previous build routes checked "Swapped" projects through a second donor
      vehicle validation/save branch. The new model stores only the optional engine
      string, so we deliberately keep the legacy swapped flag false.
    */
    if (legacySwapped) legacySwapped.checked = false;
    clearLegacySwapVehicle();

    const manual = text(manualImage?.value);
    if (manual) selectedImageUrl = manual;
    if (projectImage) projectImage.value = selectedImageUrl;
  }

  function validateStep(step) {
    const panel = steps.find((item) => Number(item.dataset.projectStep) === step);
    if (!panel) return true;

    const controls = [...panel.querySelectorAll("input, textarea, select")].filter(
      (control) => !control.disabled && control.type !== "hidden"
    );

    for (const control of controls) {
      if (!control.checkValidity()) {
        control.reportValidity();
        return false;
      }
    }

    if (step === 3 && engineSwap?.checked && !text(engineSwapValue?.value)) {
      engineSwapValue.setCustomValidity("Enter the swapped engine.");
      engineSwapValue.reportValidity();
      engineSwapValue.setCustomValidity("");
      return false;
    }

    return true;
  }

  function setStep(step, options = {}) {
    const target = Math.max(1, Math.min(4, Number(step) || 1));
    currentStep = target;

    steps.forEach((panel) => {
      panel.hidden = Number(panel.dataset.projectStep) !== target;
    });

    progress.forEach((bar) => {
      bar.classList.toggle("active", Number(bar.dataset.progressStep) <= target);
    });

    if (stepNumber) stepNumber.textContent = String(target);
    if (previousButton) previousButton.disabled = target === 1;
    if (nextButton) nextButton.hidden = target === 4;
    if (saveButton) saveButton.hidden = target !== 4;

    const active = steps.find((panel) => Number(panel.dataset.projectStep) === target);
    active?.querySelector("input:not([type=hidden]), textarea, select")?.focus({ preventScroll: true });

    if (target === 4 && options.searchImages !== false) {
      searchProjectImages();
    }
  }

  function setEngineSwapUi() {
    const checked = Boolean(engineSwap?.checked);
    if (engineSwapField) engineSwapField.hidden = !checked;
    if (engineSwapValue) engineSwapValue.required = checked;
  }

  function clearWizardSessionFields({ clearLegacy = false } = {}) {
    if (visibleYear) visibleYear.value = "";
    if (visibleMake) visibleMake.value = "";
    if (visibleModel) visibleModel.value = "";
    if (engineSwap) engineSwap.checked = false;
    if (engineSwapValue) engineSwapValue.value = "";

    selectedImageUrl = "";
    lastSearchKey = "";
    if (projectImage) projectImage.value = "";
    if (manualImage) manualImage.value = "";
    imageChoices?.replaceChildren();
    if (imageStatus) imageStatus.textContent = "";

    if (clearLegacy) clearLegacyVehicleCompatibilityFields();
    setEngineSwapUi();
  }

  function hydrateFromLegacy({ overwrite = false, resetStep = true } = {}) {
    const isNewProject = !text(projectId?.value);

    // A brand-new project always starts with a completely clean adapter state.
    // Previous/Next never calls this reset, so values still persist while navigating
    // inside one open wizard session.
    if (isNewProject) {
      clearWizardSessionFields({ clearLegacy: true });
      setStep(1, { searchImages: false });
      return;
    }

    const sourceWasSwapped = Boolean(legacySwapped?.checked);
    const donorEngine = text(legacySwapEngine?.value);
    const year = text(legacyYear?.value);
    const make = text(legacyMake?.value);
    const model = text(legacyModel?.value);

    /*
      Edit hydration must be allowed to overwrite an earlier pass. app.js may finish
      populating the selected project shortly after showModal(), so the first pass can
      legitimately see blank adapter fields. The old `only-if-empty` behavior caused
      stale values from the previously edited/created project to become permanent.
    */
    if (visibleYear && (overwrite || !text(visibleYear.value))) visibleYear.value = year;
    if (visibleMake && (overwrite || !text(visibleMake.value))) visibleMake.value = make;
    if (visibleModel && (overwrite || !text(visibleModel.value))) visibleModel.value = model;

    /*
      Only a project that was explicitly marked swapped in the old model is migrated
      into the new Engine Swap UI. A normal factory engine from the previous build is
      intentionally not carried forward.
    */
    if (sourceWasSwapped) {
      engineSwap.checked = true;
      engineSwapValue.value = donorEngine || text(legacyEngine?.value);
    } else {
      engineSwap.checked = false;
      engineSwapValue.value = "";
    }

    selectedImageUrl = text(projectImage?.value);
    if (manualImage) manualImage.value = selectedImageUrl;
    setEngineSwapUi();
    if (resetStep) setStep(1, { searchImages: false });
  }

  function imageSearchEndpoint() {
    const config = window.RELAY_IMAGE_SEARCH || {};
    return text(config.endpoint);
  }

  function vehicleSearchKey() {
    return [text(visibleYear?.value), text(visibleMake?.value), text(visibleModel?.value)]
      .join("|")
      .toLowerCase();
  }

  function selectImageChoice(button, url) {
    selectedImageUrl = url;
    if (projectImage) projectImage.value = url;
    if (manualImage) manualImage.value = "";

    [...imageChoices.querySelectorAll(".image-choice")].forEach((choice) => {
      const selected = choice === button;
      choice.classList.toggle("selected", selected);
      choice.setAttribute("aria-checked", selected ? "true" : "false");
    });
  }

  function renderImageChoices(items) {
    imageChoices.replaceChildren();

    if (!items.length) {
      const placeholder = document.createElement("div");
      placeholder.className = "image-placeholder";
      placeholder.textContent = "No image suggestions were returned. You can refresh or paste an image URL below.";
      imageChoices.appendChild(placeholder);
      return;
    }

    items.slice(0, 3).forEach((item, index) => {
      const url = text(item.url);
      const thumbnailUrl = text(item.thumbnailUrl) || url;
      if (!url) return;

      const wrap = document.createElement("div");
      wrap.className = "image-choice-wrap";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "image-choice";
      button.dataset.imageUrl = url;
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", url === selectedImageUrl ? "true" : "false");
      button.setAttribute("aria-label", `Use image ${index + 1}`);

      const image = document.createElement("img");
      image.src = thumbnailUrl;
      image.alt = text(item.title) || `${visibleYear.value} ${visibleMake.value} ${visibleModel.value}`;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";

      const copy = document.createElement("span");
      copy.className = "image-choice-copy";

      const title = document.createElement("strong");
      title.textContent = text(item.title) || `Image ${index + 1}`;

      const source = document.createElement("span");
      source.textContent = text(item.provider) || "Image result";

      copy.append(title, source);
      button.append(image, copy);

      if (url === selectedImageUrl) {
        button.classList.add("selected");
      }

      button.addEventListener("click", () => selectImageChoice(button, url));

      image.addEventListener("error", () => {
        button.classList.add("image-load-error");
      });

      wrap.appendChild(button);

      const contextUrl = text(item.contextUrl);
      const photographer = text(item.photographer);
      if (contextUrl || photographer) {
        const credit = document.createElement(contextUrl ? "a" : "span");
        credit.className = "image-credit";
        credit.textContent = photographer
          ? `Photo by ${photographer} on Pexels`
          : "View photo on Pexels";

        if (contextUrl) {
          credit.href = contextUrl;
          credit.target = "_blank";
          credit.rel = "noopener noreferrer";
        }

        wrap.appendChild(credit);
      }

      imageChoices.appendChild(wrap);
    });
  }

  function showExistingImage() {
    const url = text(projectImage?.value) || text(manualImage?.value);
    if (!url) return false;

    selectedImageUrl = url;
    renderImageChoices([{
      url,
      thumbnailUrl: url,
      contextUrl: "",
      title: "Current project image",
      provider: "Current image"
    }]);
    return true;
  }

  async function searchProjectImages(force = false) {
    if (!validateStep(3)) {
      setStep(3, { searchImages: false });
      return;
    }

    syncCompatibilityFields();

    const endpoint = imageSearchEndpoint();
    const key = vehicleSearchKey();

    if (!force && key === lastSearchKey && imageChoices.children.length) return;
    lastSearchKey = key;

    if (!endpoint || endpoint.includes("YOUR_")) {
      const hasExisting = showExistingImage();
      imageStatus.className = "image-search-status error";
      imageStatus.textContent = hasExisting
        ? "Automatic image search is not configured. Your current image is shown below."
        : "Automatic image search is not configured yet. Paste an image URL below, or configure relay-image-config.js.";
      return;
    }

    if (searchController) searchController.abort();
    searchController = new AbortController();

    imageStatus.className = "image-search-status";
    imageStatus.textContent = "Searching for images…";
    imageChoices.innerHTML = '<div class="image-placeholder">Loading image suggestions…</div>';
    refreshImagesButton.disabled = true;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: text(visibleYear.value),
          make: text(visibleMake.value),
          model: text(visibleModel.value)
        }),
        signal: searchController.signal
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || `Image search failed (${response.status}).`);
      }

      const items = Array.isArray(payload.images) ? payload.images : [];
      renderImageChoices(items);
      imageStatus.className = "image-search-status";
      imageStatus.textContent = items.length
        ? "Choose one of the three suggestions below."
        : "No matching images were returned.";
    } catch (error) {
      if (error?.name === "AbortError") return;

      console.error("[RELAY image search] Request failed", {
        endpoint,
        pageOrigin: window.location.origin,
        error
      });

      const hasExisting = showExistingImage();
      if (!hasExisting) renderImageChoices([]);

      const isNetworkFailure =
        error instanceof TypeError ||
        /network|fetch|cors/i.test(String(error?.message || ""));

      const detail = isNetworkFailure
        ? "Could not reach the Supabase Edge Function. Check the function URL, JWT verification setting, ALLOWED_ORIGIN, and Edge Function logs."
        : String(error?.message || "Image search failed.");

      imageStatus.className = "image-search-status error";
      imageStatus.textContent = hasExisting
        ? `Image search is unavailable. Your current image is still selected. ${detail}`
        : `Image search is unavailable. You can paste an image URL below. ${detail}`;
    } finally {
      refreshImagesButton.disabled = false;
    }
  }

  previousButton?.addEventListener("click", () => setStep(currentStep - 1, { searchImages: false }));

  nextButton?.addEventListener("click", () => {
    if (!validateStep(currentStep)) return;
    syncCompatibilityFields();
    setStep(currentStep + 1);
  });

  engineSwap?.addEventListener("change", setEngineSwapUi);

  manualImage?.addEventListener("input", () => {
    const url = text(manualImage.value);
    if (!url) return;
    selectedImageUrl = url;
    if (projectImage) projectImage.value = url;
    [...imageChoices.querySelectorAll(".image-choice")].forEach((choice) => {
      choice.classList.remove("selected");
      choice.setAttribute("aria-checked", "false");
    });
  });

  refreshImagesButton?.addEventListener("click", () => searchProjectImages(true));

  /*
    Capture-phase sync runs before the existing app.js submit listener, regardless of
    which script registered its listener first. We do not prevent submission; the
    current, already-working persistence code remains responsible for the database write.
  */
  form.addEventListener("submit", (event) => {
    for (const step of [1, 2, 3]) {
      if (!validateStep(step)) {
        event.preventDefault();
        setStep(step, { searchImages: false });
        return;
      }
    }

    syncCompatibilityFields();

    if (!text(projectImage?.value)) {
      event.preventDefault();
      setStep(4, { searchImages: false });
      imageStatus.className = "image-search-status error";
      imageStatus.textContent = "Choose an image suggestion or enter an image URL before saving.";
      manualImage?.focus();
    }
  }, true);

  const openObserver = new MutationObserver(() => {
    if (!dialog.open) return;

    const openedProjectId = text(projectId?.value);
    const isEdit = Boolean(openedProjectId);

    if (isEdit) {
      // Never display data left in the visible wizard controls from another project
      // while the selected project's compatibility fields are being populated.
      if (visibleYear) visibleYear.value = "";
      if (visibleMake) visibleMake.value = "";
      if (visibleModel) visibleModel.value = "";
      if (engineSwap) engineSwap.checked = false;
      if (engineSwapValue) engineSwapValue.value = "";
      setEngineSwapUi();
    }

    // app.js can populate the compatibility controls synchronously or shortly after
    // showModal(). Re-read during the opening window and intentionally overwrite each
    // earlier edit-hydration pass so the selected project, not the last project, wins.
    hydrateFromLegacy({ overwrite: isEdit });
    [40, 120, 260].forEach((delay) => {
      setTimeout(() => {
        if (!dialog.open) return;
        if (text(projectId?.value) !== openedProjectId) return;
        hydrateFromLegacy({ overwrite: isEdit, resetStep: false });
      }, delay);
    });
  });

  openObserver.observe(dialog, { attributes: true, attributeFilter: ["open"] });

  dialog.addEventListener("close", () => {
    if (searchController) searchController.abort();
    searchController = null;

    // End the current wizard session. Clear BOTH the visible wizard fields and the
    // hidden compatibility controls so no vehicle can leak into the next project.
    // app.js will repopulate the adapter controls when an existing project is opened.
    clearWizardSessionFields({ clearLegacy: true });
    setStep(1, { searchImages: false });
  });

  setEngineSwapUi();
  setStep(1, { searchImages: false });
})();
