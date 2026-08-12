(() => {
  "use strict";

  const CURRENT_BRAND = "RELAY";
  const LEGACY_BRAND = ["Garage", "Log"].join("");
  const LEGACY_PATTERN = new RegExp(LEGACY_BRAND, "gi");

  let switchingToModify = false;

  function swapBrand(value) {
    return typeof value === "string"
      ? value.replace(LEGACY_PATTERN, CURRENT_BRAND)
      : value;
  }

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

    requestAnimationFrame(() => {
      clearAuthCredentials();
    });

    window.setTimeout(clearAuthCredentials, 75);
  }

  function closeDialogFromButton(button) {
    const dialog = button.closest("dialog");

    if (dialog?.open) {
      dialog.close("cancel");
    }
  }

  function replaceBranding(root = document) {
    if (document.title.includes(LEGACY_BRAND)) {
      document.title = swapBrand(document.title);
    }

    const elementRoot =
      root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE
        ? root
        : root.parentElement;

    if (!elementRoot?.querySelectorAll) {
      return;
    }

    const elements = [
      ...(elementRoot.nodeType === Node.ELEMENT_NODE ? [elementRoot] : []),
      ...elementRoot.querySelectorAll("*"),
    ];

    for (const element of elements) {
      if (["SCRIPT", "STYLE", "TEXTAREA", "INPUT"].includes(element.tagName)) {
        continue;
      }

      for (const attributeName of ["title", "aria-label", "placeholder"]) {
        if (element.hasAttribute?.(attributeName)) {
          const currentValue = element.getAttribute(attributeName);
          const nextValue = swapBrand(currentValue);

          if (nextValue !== currentValue) {
            element.setAttribute(attributeName, nextValue);
          }
        }
      }

      for (const node of element.childNodes) {
        if (node.nodeType !== Node.TEXT_NODE) {
          continue;
        }

        const nextValue = swapBrand(node.nodeValue);

        if (nextValue !== node.nodeValue) {
          node.nodeValue = nextValue;
        }
      }
    }
  }

  function removeLegacyModeToggle(root = document) {
    const elementRoot =
      root.nodeType === Node.ELEMENT_NODE || root.nodeType === Node.DOCUMENT_NODE
        ? root
        : root.parentElement;

    if (!elementRoot?.querySelectorAll) {
      return;
    }

    const toggles = [
      ...(elementRoot.matches?.(".mode-toggle") ? [elementRoot] : []),
      ...elementRoot.querySelectorAll(".mode-toggle"),
    ];

    for (const toggle of toggles) {
      const buttons = [...toggle.querySelectorAll("button")];
      const modifyButton = buttons.find((button) =>
        /^modify$/i.test(button.textContent.trim())
      );
      const activeButton = toggle.querySelector("button.active");

      if (
        modifyButton &&
        activeButton !== modifyButton &&
        !switchingToModify
      ) {
        switchingToModify = true;
        modifyButton.click();

        queueMicrotask(() => {
          switchingToModify = false;
          removeLegacyModeToggle(document);
        });

        continue;
      }

      toggle.remove();
    }
  }

  function processDynamicUi(root = document) {
    replaceBranding(root);
    removeLegacyModeToggle(root);
  }

  // Make downloaded filenames use the current product name even if the existing
  // main script still creates a legacy filename internally.
  const nativeAnchorClick = HTMLAnchorElement.prototype.click;

  HTMLAnchorElement.prototype.click = function patchedAnchorClick(...args) {
    if (this.download) {
      this.download = swapBrand(this.download);
    }

    return nativeAnchorClick.apply(this, args);
  };

  // Capture these actions before app.js handlers so cancellation truly cancels.
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      const dialogClose = target.closest(
        "[data-dialog-close], dialog.modal button[value='cancel']"
      );

      if (dialogClose) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeDialogFromButton(dialogClose);
        return;
      }

      const exportButton = target.closest("[data-action='export']");

      if (exportButton) {
        const approved = window.confirm(
          "Export your RELAY project data to a file?"
        );

        if (!approved) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }

        return;
      }

      const importLabel = target.closest(".import-label");

      // A label click subsequently activates its hidden input. Confirm on the
      // label activation only so the user sees exactly one prompt.
      if (importLabel && target.id !== "importInput") {
        const approved = window.confirm(
          "Importing data can add or merge projects in RELAY. Continue?"
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
    true
  );

  // Dismiss the account dropdown when the user clicks anywhere outside it.
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;

      if (!(target instanceof Element)) {
        return;
      }

      if (!target.closest(".account-menu") && !target.closest("#authButton")) {
        closeAccountMenu();
      }
    },
    true
  );

  // Remove the dropdown after sign-out while allowing the existing sign-out
  // handler to finish first.
  document.addEventListener("click", (event) => {
    const target = event.target;

    if (!(target instanceof Element)) {
      return;
    }

    const accountMenuButton = target.closest(".account-menu button");

    if (
      accountMenuButton &&
      /sign\s*out/i.test(accountMenuButton.textContent)
    ) {
      queueMicrotask(closeAccountMenu);
    }
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processDynamicUi(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          replaceBranding(node.parentElement ?? document);
        }
      }
    }
  });

  processDynamicUi(document);

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
