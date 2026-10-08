const h = React.createElement;
const params = new URLSearchParams(location.search);
const layout = params.get("layout") || "modern";
const clients = params.has("clients");
const root = ReactDOM.createRoot(document.getElementById("overview"));
let patientId = "123";
let loaded = !params.has("pendingTabs");
let mounted = !params.has("pendingRoot");
let revision = 0;
let nativeClicks = 0;
let bubbledClicks = 0;

globalThis.addEventListener("error", (event) => {
  document.querySelector('[data-testid="errors"]').textContent += `${event.message}\n`;
});

function nativeButton(legacy) {
  return h("button", {
    id: `react-aria-${patientId}-${revision}`,
    "data-testid": legacy || params.has("buttonTestId") ? "add-appointment-button" : undefined,
    onClick: () => {
      nativeClicks += 1;
      document.querySelector('[data-testid="native-clicks"]').textContent = nativeClicks;
    },
  }, h("svg", null, h("title", null, "Add Icon")), "Add appointment");
}

function tabs() {
  return h("div", { "data-testid": "tab-container" }, "Native appointments");
}

function modernSection() {
  return h("section", { "data-testid": "collapsible-section-body" },
    h("div", { "data-testid": "cop-appointments-contents" },
      loaded ? tabs() : h("p", null, "Appointments refreshed")),
    h("div", { className: "mt-3", "data-testid": "native-button-wrapper" },
      loaded ? nativeButton(false) : null),
    h("div", { className: "mt-3" }, h("button", null, "Add appointment reminder")));
}

function legacySection() {
  return h("section", { "data-testid": "cop-appointments-section" },
    h("div", { "data-testid": "legacy-area" },
      loaded ? tabs() : h("p", null, "Appointments refreshed"),
      loaded ? nativeButton(true) : null));
}

function Overview() {
  return h("div", { className: "columns" }, h("div", { className: "column is-6" },
    layout !== "legacy" ? modernSection() : null,
    layout !== "modern" ? legacySection() : null,
    h("section", { "data-testid": "unrelated-section" },
      h("div", { className: "mt-3" }, h("button", null, "Add appointment")))));
}

function Clients() {
  function nativePress() {
    nativeClicks += 1;
    document.querySelector('[data-testid="native-clicks"]').textContent = nativeClicks;
  }
  const props = layout === "legacy"
    ? { "data-testid": "new-client-modal-container" }
    : { className: layout === "bare" ? "client-toolbar" : "add-client-container" };
  return h("section", props,
    params.has("hiddenDecoy") ? h("div", { "data-testid": "new-client-modal-container", style: { display: "none" } },
      h("button", null, "Add client")) : null,
    loaded ? h("button", {
      id: `react-aria-client-${revision}`,
      "data-testid": layout === "legacy" ? "primaryButton" : undefined,
      onClick: nativePress,
      onPointerUp: nativePress,
      onKeyDown: nativePress,
    }, h("svg", null, h("title", null, "Add Icon")), "Add client") : h("p", null, "Loading clients"),
    h("button", { "data-testid": "unrelated-client-control" }, "Add client note"));
}

function renderOverview() {
  revision += 1;
  const component = clients ? Clients : Overview;
  ReactDOM.flushSync(() => root.render(mounted ? h(component, { key: patientId }) : null));
}

function bindAction(id, action) {
  document.getElementById(id).addEventListener("click", () => {
    action();
    document.querySelector('[data-testid="status"]').textContent = `Completed: ${id}`;
  });
}

if (clients) document.getElementById("inject").textContent = "Inject Add client";
bindAction("inject", clients ? waitForAddPatientButton : handleAppointmentsProfileRoute);
bindAction("refresh", () => { loaded = false; renderOverview(); });
bindAction("restore", () => { loaded = true; renderOverview(); });
bindAction("load", () => { mounted = true; loaded = true; renderOverview(); });
bindAction("unmount", () => { mounted = false; renderOverview(); });
bindAction("patient", () => {
  patientId = "456";
  loaded = true;
  mounted = true;
  history.pushState({}, "", `/users/${patientId}/Overview${location.search}`);
  renderOverview();
  handleAppointmentsProfileRoute();
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest('[data-testid="misha-add-appointment-button"]')) {
    bubbledClicks += 1;
    document.querySelector('[data-testid="bubbled-clicks"]').textContent = bubbledClicks;
  }
});
renderOverview();
