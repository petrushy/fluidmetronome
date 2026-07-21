// Registers the service worker and, when a new version has installed in the
// background, shows an unobtrusive "reload" prompt. Registration lives here
// rather than in the WASM so the update UX is plain DOM and needs no round trip
// through Yew.
(function () {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  // Guard against a reload loop: a new worker calling clients.claim() fires
  // controllerchange, but we only ever reload in response to a user click.
  let reloading = false;

  function showUpdatePrompt(worker) {
    if (document.getElementById("fm-update-banner")) {
      return;
    }

    const banner = document.createElement("div");
    banner.id = "fm-update-banner";
    banner.setAttribute("role", "status");

    const text = document.createElement("span");
    text.textContent = "A new version is available.";

    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Reload";
    reload.addEventListener("click", () => {
      reloading = true;
      // Ask the waiting worker to take over now; we reload on controllerchange.
      if (worker && worker.state === "installed") {
        worker.postMessage({ type: "skip-waiting" });
      }
      window.location.reload();
    });

    banner.append(text, reload);
    document.body.appendChild(banner);
  }

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) {
      return;
    }
    reloading = true;
    window.location.reload();
  });

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/static/sw.js");

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) {
          return;
        }

        installing.addEventListener("statechange", () => {
          // A worker that reaches "installed" while one already controls the
          // page is an update, not a first install -- prompt for it.
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            showUpdatePrompt(installing);
          }
        });
      });
    } catch (error) {
      console.error("Service worker registration failed", error);
    }
  });
})();
