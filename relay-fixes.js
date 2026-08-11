(() => {
  "use strict";

  function closeAccountMenu() {
    document.querySelectorAll(".account-menu").forEach((menu) => menu.remove());
  }

  function clearAuthCredentials() {
    const email = document.getElementById("authEmail");
    const password = document.getElementById("authPassword");
    const username = document.getElementById("authUsername");
    const error = document.getElementById("authError");

    if (email) email.value = "";
    if (password) password.value = "";
    if (username) username.value = "";

    if (error) {
      error.textContent = "";
      error.hidden = true;
    }
  }

  function clearAuthCredentialsAfterOpen() {
    clearAuthCredentials();
    requestAnimationFrame(clearAuthCredentials);
    window.setTimeout(clearAuthCredentials, 75);
  }

  function closeDialogFromButton(button) {
    const dialog = button.closest("dialog");
    if (dialog?.open) dialog.close("cancel");
  }

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const dialogClose = target.closest(
        "[data-dialog-close], dialog.modal button[value='cancel']",
      );

      if (dialogClose) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeDialogFromButton(dialogClose);
        return;
      }

      const exportButton = target.closest("[data-action='export']");
      if (exportButton) {
        const approved = window.confirm("Export your RELAY project data to a file?");
        if (!approved) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }

      const importTrigger = target.closest(".import-label, [data-action='import-prompt']");
      if (importTrigger && target.id !== "importInput") {
        const approved = window.confirm(
          "Importing data can add or merge projects in RELAY. Continue?",
        );
        if (!approved) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }

      const authButton = target.closest("#authButton");
      if (authButton) {
        closeAccountMenu();
        clearAuthCredentialsAfterOpen();
      }
    },
    true,
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (!target.closest(".account-menu") && !target.closest("#authButton")) {
        closeAccountMenu();
      }
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const accountMenuButton = target.closest(".account-menu button");
    if (accountMenuButton && /sign\s*out/i.test(accountMenuButton.textContent)) {
      queueMicrotask(closeAccountMenu);
    }
  });
})();
