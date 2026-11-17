/* Northstar: three analytical levels and real, reviewed contextual actions.
 * The server owns destinations, authoritative records and provider credentials.
 */
(() => {
  "use strict";
  const API = "/api/actions";
  const HISTORY_KEY = "northstar-dashboard:v2:actions";
  const MAX_HISTORY = 150;
  const ACTION_NAMES = {
    email: "Email summary",
    trello: "Trello task",
    supabase: "Numeric correction",
    github: "GitHub issue",
  };
  const SERVICES = {
    email: { provider: "resend", label: "Email · Resend" },
    trello: { provider: "trello", label: "Trello · Card" },
    github: { provider: "github", label: "GitHub · Issue" },
    supabase: { provider: "supabase", label: "Supabase · Database" },
  };
  const RESULTS = {
    verified: "Verified",
    accepted: "Accepted · not delivered",
    unknown: "Outcome unknown",
    rejected: "Rejected",
    not_configured: "Missing configuration",
    conflict: "Data changed · refresh",
    unavailable: "Current data unavailable",
    sending: "Request in progress",
  };
  const SIGNALS = {
    negative: { label: "Negative contribution", short: "Negative margin" },
    late: { label: "Late delivery", short: "Late delivery" },
    refund: { label: "High refund", short: "High refund" },
  };
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const $ = (selector) => document.querySelector(selector);
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  const exactMoney = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
  const sourceMoney = (value) =>
    Number.isInteger(value * 100)
      ? exactMoney.format(value)
      : `${String(value)} USD`;
  const state = {
    orders: [],
    asOf: "2026-11-17",
    revision: 0,
    source: "unavailable",
    database: {},
    integrations: {},
    level: "overview",
    selectedId: null,
    filters: {
      search: "",
      signal: "all",
      status: "all",
      region: "",
      category: "",
      channel: "",
    },
    accessPhrase: "",
    history: [],
    historyExpanded: false,
    pending: null,
    menu: null,
    inlineEdit: null,
    submitting: false,
    refreshing: false,
    storageAvailable: true,
  };
  let toastTimer;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }
  function text(selector, value) {
    $(selector).textContent = String(value ?? "");
  }
  function serviceBadge(action) {
    const service = SERVICES[action];
    const badge = node("span", "service-badge");
    badge.dataset.service = service.provider;
    const logo = node("img", "service-logo");
    logo.src = new URL(
      `./icons/${service.provider}.svg`,
      document.baseURI,
    ).href;
    logo.alt = "";
    logo.width = 18;
    logo.height = 18;
    badge.append(logo, node("span", "service-label", service.label));
    return badge;
  }
  function net(order) {
    return order.revenue - order.refund;
  }
  function profit(order) {
    return net(order) - order.cost;
  }
  function margin(order) {
    return net(order) === 0 ? null : profit(order) / net(order);
  }
  function dateLabel(iso) {
    return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  function describeStatus(status) {
    return (
      {
        delivered: "Delivered",
        in_transit: "In transit",
        processing: "Processing",
      }[status] || status
    );
  }
  function signals(order) {
    const list = [];
    if (profit(order) < 0) list.push("negative");
    if ((order.deliveredDate || state.asOf) > order.promisedDate)
      list.push("late");
    if (order.revenue > 0 && order.refund / order.revenue >= 0.25)
      list.push("refund");
    return list;
  }
  function metrics(orders) {
    const sum = (key) => orders.reduce((value, order) => value + order[key], 0);
    const revenue = sum("revenue"),
      refund = sum("refund"),
      cost = sum("cost");
    return {
      count: orders.length,
      revenue,
      refund,
      cost,
      netRevenue: revenue - refund,
      profit: revenue - refund - cost,
      attention: orders.filter((order) => signals(order).length).length,
    };
  }
  function currentScope() {
    return Object.fromEntries(
      Object.entries(state.filters)
        .map(([key, value]) => [key, key === "search" ? value.trim() : value])
        .filter(([, value]) => value && value !== "all"),
    );
  }
  function scopeLabel(scope = currentScope()) {
    if (!scope || typeof scope !== "object") scope = {};
    const parts = [];
    if (scope.region) parts.push(scope.region);
    if (scope.category) parts.push(scope.category);
    if (scope.channel) parts.push(scope.channel);
    if (scope.status) parts.push(describeStatus(scope.status));
    if (scope.signal)
      parts.push(
        SIGNALS[scope.signal]?.label ||
          (scope.signal === "attention" ? "Needs attention" : "No signals"),
      );
    if (scope.search) parts.push(`Search: ${scope.search}`);
    return parts.join(" · ") || "All orders";
  }
  function ordersForScope(scope) {
    const f = {
      search: "",
      signal: "all",
      status: "all",
      region: "",
      category: "",
      channel: "",
      ...scope,
    };
    return state.orders.filter((order) => {
      const search = [
        order.id,
        order.product,
        order.category,
        order.region,
        order.channel,
        order.owner,
      ]
        .join(" ")
        .toLowerCase();
      const flags = signals(order);
      const signalMatch =
        f.signal === "all" ||
        (f.signal === "attention" && flags.length) ||
        (f.signal === "clear" && !flags.length) ||
        flags.includes(f.signal);
      return (
        search.includes(f.search.trim().toLowerCase()) &&
        signalMatch &&
        (f.status === "all" || order.status === f.status) &&
        (!f.region || order.region === f.region) &&
        (!f.category || order.category === f.category) &&
        (!f.channel || order.channel === f.channel)
      );
    });
  }
  function visibleOrders() {
    return ordersForScope(currentScope());
  }
  function freezeSelection(selection) {
    return Object.freeze({
      ...selection,
      scope: Object.freeze({ ...selection.scope }),
    });
  }
  function recordSelection(order, field) {
    return freezeSelection({
      kind: field ? "cell" : "record",
      label: field
        ? `${order.id} · ${field}`
        : `${order.id} · ${order.product}`,
      scope: { search: order.id },
      recordId: order.id,
      field,
    });
  }
  function metricValue(metric, totals) {
    if (["count", "attention"].includes(metric))
      return `${totals[metric]} orders`;
    return exactMoney.format(totals[metric]);
  }
  function selectionSummary(selection, totals) {
    return `${selection.label}${selection.metric ? ` · ${metricValue(selection.metric, totals)}` : ""}`;
  }
  function closeContext(returnFocus = true) {
    const trigger = state.menu?.trigger;
    state.menu = null;
    $("#context-menu").hidden = true;
    trigger?.setAttribute("aria-expanded", "false");
    if (returnFocus && trigger?.isConnected)
      trigger.focus({ preventScroll: true });
  }
  function openContext(selection, trigger, point) {
    if (state.pending || state.submitting) return;
    closeContext(false);
    const menu = $("#context-menu"),
      frozen = freezeSelection(selection);
    const totals = metrics(ordersForScope(frozen.scope));
    state.menu = { selection: frozen, trigger };
    trigger?.setAttribute("aria-expanded", "true");
    menu.replaceChildren();
    const heading = node(
      "div",
      "context-menu-heading",
      selectionSummary(frozen, totals),
    );
    heading.id = "context-selection-title";
    menu.setAttribute("aria-labelledby", heading.id);
    menu.append(
      heading,
      node(
        "p",
        "context-menu-meta",
        `${totals.count} records · ${scopeLabel(frozen.scope)}`,
      ),
    );
    const options = frozen.recordId
      ? [
          ["details", "Inspect record", "Source values and audit"],
          ["email", "Share finding", "Email · editable message"],
          ["github", "Report data issue", "GitHub · source follow-up"],
        ]
      : [
          ["explore", "Explore segment", "Open the records behind this value"],
          ["email", "Share finding", "Email · editable message"],
          [
            "trello",
            "Assign investigation",
            "Trello · a task for this selection",
          ],
        ];
    for (const [action, label, hint] of options) {
      const button = node("button", "context-option");
      button.type = "button";
      button.dataset.contextAction = action;
      button.setAttribute("role", "menuitem");
      button.append(
        node("strong", "", label),
        SERVICES[action] ? serviceBadge(action) : node("span", "", hint),
      );
      button.addEventListener("click", () => {
        const origin = state.menu?.trigger;
        closeContext(false);
        if (action === "explore") {
          state.filters = {
            search: "",
            signal: "all",
            status: "all",
            region: "",
            category: "",
            channel: "",
            ...frozen.scope,
          };
          state.level = "segment";
          state.selectedId = null;
          syncFilters();
          render();
          focusView();
        } else if (action === "details") selectOrder(frozen.recordId);
        else openAction(action, "cost", { ...frozen, returnFocus: origin });
      });
      menu.append(button);
    }
    const dismiss = node("button", "context-dismiss", "Close");
    dismiss.type = "button";
    dismiss.setAttribute("role", "menuitem");
    dismiss.addEventListener("click", () => closeContext());
    menu.append(dismiss);
    menu.hidden = false;
    const rect = trigger?.getBoundingClientRect() || { left: 16, bottom: 16 };
    const width = menu.offsetWidth,
      height = menu.offsetHeight;
    menu.style.left = `${Math.max(12, Math.min(point?.x ?? rect.left, window.innerWidth - width - 12))}px`;
    menu.style.top = `${Math.max(12, Math.min(point?.y ?? rect.bottom + 8, window.innerHeight - height - 12))}px`;
    menu.querySelector("button")?.focus({ preventScroll: true });
  }
  function bindContextTrigger(trigger, getSelection) {
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", () =>
      openContext(getSelection(), trigger),
    );
    trigger.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openContext(getSelection(), trigger, {
        x: event.clientX,
        y: event.clientY,
      });
    });
  }
  function decorateDraft(draft, selection, totals, action) {
    if (!selection.metric) return draft;
    const finding = selectionSummary(selection, totals);
    const result = { ...draft };
    const titleKey = action === "email" ? "subject" : "title";
    const bodyKey = action === "trello" ? "description" : "body";
    result[titleKey] =
      `${action === "trello" ? "Investigate" : "Finding"}: ${finding}`.slice(
        0,
        140,
      );
    result[bodyKey] =
      `Selected finding: ${finding}\nScope: ${scopeLabel(selection.scope)}\n\n${result[bodyKey] || ""}`;
    return result;
  }
  function selectedOrder() {
    return state.orders.find((order) => order.id === state.selectedId);
  }
  function statusBadge(signal) {
    return node(
      "span",
      `signal-badge ${signal || ""}`,
      signal ? SIGNALS[signal].short : "No signals",
    );
  }
  function notify(message) {
    window.clearTimeout(toastTimer);
    text("#toast", message);
    $("#toast").hidden = false;
    toastTimer = window.setTimeout(() => {
      $("#toast").hidden = true;
    }, 6500);
  }
  function setFormStatus(message, tone = "") {
    text("#form-status", message);
    $("#form-status").dataset.state = tone;
  }
  function validOrder(order) {
    return (
      order &&
      [
        "id",
        "product",
        "category",
        "region",
        "channel",
        "status",
        "owner",
        "note",
        "orderDate",
        "promisedDate",
      ].every((key) => typeof order[key] === "string") &&
      ["quantity", "revenue", "cost", "refund"].every(
        (key) => Number.isFinite(order[key]) && order[key] >= 0,
      )
    );
  }
  async function api(body, timeout = 20000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(API, {
        method: body ? "POST" : "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(state.accessPhrase
            ? { Authorization: `Bearer ${state.accessPhrase}` }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!data || typeof data !== "object")
        throw new Error("The server returned an invalid response.");
      return { ok: response.ok, status: response.status, data };
    } finally {
      window.clearTimeout(timer);
    }
  }
  function serverMessage(data, fallback) {
    const names = Array.isArray(data?.missing)
      ? data.missing.filter(
          (value) =>
            typeof value === "string" && /^[A-Z][A-Z0-9_]+$/.test(value),
        )
      : [];
    return `${typeof data?.message === "string" ? data.message : fallback}${names.length ? ` Missing settings: ${names.join(", ")}.` : ""}`;
  }
  function applyRecords(data) {
    if (
      Array.isArray(data.records) &&
      data.records.length &&
      data.records.every(validOrder) &&
      new Set(data.records.map((order) => order.id)).size ===
        data.records.length
    ) {
      state.orders = data.records;
    } else if (validOrder(data.record)) {
      state.orders = state.orders.map((order) =>
        order.id === data.record.id ? data.record : order,
      );
    } else return false;
    if (data.revision !== undefined) state.revision = data.revision;
    if (typeof data.source === "string") state.source = data.source;
    if (typeof data.asOf === "string") state.asOf = data.asOf;
    return true;
  }
  async function refreshData({ quiet = false } = {}) {
    if (state.refreshing) return false;
    state.refreshing = true;
    $("#refresh-data").disabled = true;
    if (!quiet)
      text("#data-status", "Reading the current dataset from the server…");
    try {
      const result = await api();
      if (!result.ok || !applyRecords(result.data))
        throw new Error(
          serverMessage(result.data, "The current dataset could not be read."),
        );
      state.database = result.data.database || {};
      state.integrations = result.data.integrations || {};
      text(
        "#data-status",
        `${state.orders.length} synthetic orders · ${state.source === "supabase" ? "read from Supabase" : "bundled starting dataset"}`,
      );
      const names = ["email", "trello", "supabase", "github"].filter(
        (key) => integration(key)?.configured,
      );
      text(
        "#connection-status",
        `${names.length} of 4 connections configured. Every action can be tried; the server reports missing settings. ${state.database.message || ""}`,
      );
      $("#load-error").hidden = true;
      render();
      return true;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The dataset could not be read.";
      text("#data-status", "Server read unavailable · no fresh data claimed");
      text(
        "#load-error",
        `${message} No values were changed. Refresh after checking the server connection.`,
      );
      $("#load-error").hidden = false;
      if (!state.orders.length) {
        // Keep the analytical base inspectable when previewing static files. It is
        // explicitly labelled; execute still requires an authoritative server snapshot.
        try {
          const response = await fetch(
            new URL("./data.json", document.baseURI),
          );
          const seed = await response.json();
          if (Array.isArray(seed.orders) && seed.orders.every(validOrder)) {
            state.orders = seed.orders;
            state.asOf = seed.meta.asOf;
            state.source = "offline";
            render();
            text(
              "#data-status",
              "Bundled dataset · server unavailable; no external action verified",
            );
          }
        } catch {
          /* The visible error already explains the unavailable source. */
        }
      }
      return false;
    } finally {
      state.refreshing = false;
      $("#refresh-data").disabled = false;
    }
  }
  function integration(action) {
    return (
      state.integrations[action] ||
      (action === "supabase" ? state.integrations.supa : undefined)
    );
  }

  function renderBreadcrumbs() {
    const nav = $("#breadcrumbs");
    nav.replaceChildren();
    const overview = node(
      "button",
      state.level === "overview" ? "current" : "",
      "01 · Overview",
    );
    overview.type = "button";
    overview.addEventListener("click", goOverview);
    nav.append(overview);
    if (state.level !== "overview") {
      nav.append(node("span", "breadcrumb-separator", "/"));
      const segment = node(
        "button",
        state.level === "segment" ? "current" : "",
        `02 · ${scopeLabel()}`,
      );
      segment.type = "button";
      segment.addEventListener("click", () => {
        state.level = "segment";
        state.selectedId = null;
        render();
        focusView();
      });
      nav.append(segment);
    }
    if (state.level === "record") {
      nav.append(
        node("span", "breadcrumb-separator", "/"),
        node("span", "current", `03 · ${state.selectedId}`),
      );
    }
    nav.querySelector(".current")?.setAttribute("aria-current", "page");
  }
  function renderMetrics(orders) {
    const totals = metrics(orders);
    for (const [selector, metric, label] of [
      ["#metric-revenue", "netRevenue", "Net revenue"],
      ["#metric-profit", "profit", "Contribution"],
      ["#metric-orders", "count", "Orders in view"],
      ["#metric-attention", "attention", "Orders needing attention"],
    ]) {
      const card = $(selector).closest("article");
      card.classList.add("interactive-metric");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute(
        "aria-label",
        `${label}: ${metricValue(metric, totals)}. Open actions for this finding.`,
      );
      card.setAttribute("aria-haspopup", "menu");
      const chooseMetric = (point) => {
        const scope = currentScope();
        if (metric === "attention") {
          if (!totals.attention) {
            notify("No orders need attention in the current filtered view.");
            return;
          }
          // Existing negative/late/refund filters already select a subset of
          // attention records. Preserve them instead of broadening the view.
          if (!scope.signal) scope.signal = "attention";
        }
        openContext({ kind: "metric", label, metric, scope }, card, point);
      };
      card.onclick = () => chooseMetric();
      card.oncontextmenu = (event) => {
        event.preventDefault();
        chooseMetric({ x: event.clientX, y: event.clientY });
      };
      card.onkeydown = (event) => {
        if (["Enter", " "].includes(event.key)) {
          event.preventDefault();
          card.click();
        }
      };
    }
    text("#metric-revenue", money.format(totals.netRevenue));
    text("#metric-profit", money.format(totals.profit));
    text("#metric-orders", String(totals.count).padStart(2, "0"));
    text("#metric-attention", String(totals.attention).padStart(2, "0"));
    text("#metric-order-note", `${state.orders.length} total · current scope`);
    text(
      "#scope-summary",
      state.level === "record"
        ? `1 record · ${state.selectedId}`
        : `${totals.count} ${totals.count === 1 ? "order" : "orders"} · ${scopeLabel()}`,
    );
    const chips = $("#scope-chips");
    chips.replaceChildren();
    Object.entries(currentScope()).forEach(([key, value]) => {
      const button = node("button", "scope-chip", `${key}: ${value} ×`);
      button.type = "button";
      button.setAttribute("aria-label", `Remove ${key} filter ${value}`);
      button.addEventListener("click", () => {
        state.filters[key] = ["status", "signal"].includes(key) ? "all" : "";
        syncFilters();
        render();
      });
      chips.append(button);
    });
  }
  function renderBreakdown(selector, orders, field, measure) {
    const values = [...new Set(orders.map((order) => order[field]))].sort();
    const totals = values.map((value) => ({
      value,
      total: orders
        .filter((order) => order[field] === value)
        .reduce(
          (sum, order) =>
            sum + (measure === "profit" ? profit(order) : net(order)),
          0,
        ),
    }));
    const max = Math.max(1, ...totals.map((item) => Math.abs(item.total)));
    $(selector).replaceChildren(
      ...totals.map(({ value, total }) => {
        const button = node("button", "region-row");
        button.type = "button";
        button.dataset.dimension = field;
        button.dataset.value = value;
        button.setAttribute(
          "aria-label",
          `Select ${field} ${value}: ${money.format(total)}. Open finding actions.`,
        );
        const track = node("span", "bar-track"),
          fill = node("span", `bar-fill${total < 0 ? " negative" : ""}`);
        track.setAttribute("aria-hidden", "true");
        fill.style.width = `${Math.max(2, (Math.abs(total) / max) * 100)}%`;
        track.append(fill);
        button.append(
          node("span", "region-label", value),
          track,
          node("span", "region-value", money.format(total)),
        );
        bindContextTrigger(button, () => ({
          kind: "bar",
          label: `${measure === "profit" ? "Contribution" : "Net revenue"} · ${value}`,
          metric: measure === "profit" ? "profit" : "netRevenue",
          scope: { ...currentScope(), [field]: value },
        }));
        return button;
      }),
    );
    if (!totals.length)
      $(selector).append(node("p", "chart-note", "No records in this scope."));
  }
  function renderCharts(orders) {
    renderBreakdown("#region-chart", orders, "region", "net");
    renderBreakdown("#category-chart", orders, "category", "profit");
    const dimension = !state.filters.category
      ? "category"
      : !state.filters.region
        ? "region"
        : "channel";
    text(
      "#segment-chart-title",
      `${dimension[0].toUpperCase() + dimension.slice(1)} breakdown · net revenue`,
    );
    renderBreakdown("#segment-chart", orders, dimension, "net");
    $("#signal-chart").replaceChildren(
      ...Object.entries(SIGNALS).map(([key, signal]) => {
        const count = orders.filter((order) =>
          signals(order).includes(key),
        ).length;
        const button = node("button", `signal-tile ${key}`);
        button.type = "button";
        button.setAttribute(
          "aria-label",
          `${signal.label}: ${count} orders. Investigate this signal.`,
        );
        button.append(
          node("span", "", signal.label),
          node("strong", "", String(count).padStart(2, "0")),
        );
        bindContextTrigger(button, () => ({
          kind: "signal",
          label: signal.label,
          metric: "count",
          scope: { ...currentScope(), signal: key },
        }));
        return button;
      }),
    );
    const featured = state.orders.find((order) => order.id === "NS-1041");
    if (featured) {
      text(
        "#case-title",
        `${featured.id} · ${money.format(profit(featured))} contribution`,
      );
      text(
        "#case-summary",
        `${featured.region} / ${featured.category}. Inspect the source cost and the classroom audit note before deciding what to change.`,
      );
    }
  }
  function renderOrders(orders) {
    text(
      "#order-count",
      `${orders.length} ${orders.length === 1 ? "order" : "orders"}`,
    );
    $("#empty-orders").hidden = orders.length > 0;
    $("#orders-body").replaceChildren(
      ...orders.map((order) => {
        const row = node("tr");
        row.dataset.orderId = order.id;
        row.dataset.selected = String(state.selectedId === order.id);
        const identity = node("td"),
          link = node("button", "order-link", order.id);
        link.type = "button";
        link.setAttribute(
          "aria-label",
          `Inspect order ${order.id}, ${order.product}`,
        );
        link.addEventListener("click", () => selectOrder(order.id));
        identity.append(link, node("span", "product-name", order.product));
        const value = margin(order),
          flagCell = node("td"),
          flags = signals(order);
        flagCell.append(statusBadge(flags[0]));
        if (flags.length > 1)
          flagCell.append(node("span", "signal-extra", `+${flags.length - 1}`));
        const detailsCell = node("td"),
          details = node("button", "quiet-button", "Details →");
        details.type = "button";
        details.setAttribute(
          "aria-label",
          `View details and actions for ${order.id}`,
        );
        details.addEventListener("click", () => selectOrder(order.id));
        const more = node("button", "row-menu-button", "⋯");
        more.type = "button";
        more.dataset.orderId = order.id;
        more.setAttribute("aria-label", `Open finding actions for ${order.id}`);
        bindContextTrigger(more, () => recordSelection(order));
        detailsCell.append(details, more);
        row.append(
          identity,
          node("td", "money-cell", money.format(net(order))),
          node(
            "td",
            `money-cell ${profit(order) < 0 ? "margin-negative" : ""}`,
            value === null ? "—" : `${(value * 100).toFixed(1)}%`,
          ),
          flagCell,
          detailsCell,
        );
        row.addEventListener("click", (event) => {
          if (!event.target.closest("button,a")) selectOrder(order.id);
        });
        row.addEventListener("dblclick", () => selectOrder(order.id));
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          openContext(recordSelection(order), more, {
            x: event.clientX,
            y: event.clientY,
          });
        });
        return row;
      }),
    );
  }
  function inlineEditor(edit) {
    const form = node("form", "inline-value-editor");
    form.append(
      node(
        "p",
        "inline-current-value",
        `Current ${edit.field}: ${sourceMoney(edit.original[edit.field])} · revision ${edit.original.revision ?? state.revision}`,
      ),
    );
    const valueLabel = node("label", "", "New value · USD"),
      value = node("input");
    value.id = "inline-edit-value";
    value.type = "number";
    value.min = "0";
    value.max = "1000000000";
    value.step = "any";
    value.required = true;
    value.value = edit.newValue;
    valueLabel.append(value);
    const reasonLabel = node("label", "", "Reason / evidence"),
      reason = node("textarea");
    reason.id = "inline-edit-reason";
    reason.required = true;
    reason.minLength = 5;
    reason.maxLength = 600;
    reason.rows = 2;
    reason.value = edit.reason;
    reasonLabel.append(reason);
    const preview = node("p", "inline-editor-preview");
    preview.id = "inline-change-preview";
    preview.setAttribute("aria-live", "polite");
    function calculate() {
      edit.newValue = value.value;
      edit.reason = reason.value;
      const proposed = Number(value.value);
      preview.textContent =
        value.value && Number.isFinite(proposed) && proposed >= 0
          ? `Contribution ${exactMoney.format(profit(edit.original))} → ${exactMoney.format(profit({ ...edit.original, [edit.field]: proposed }))}. Preview only; not saved.`
          : "Enter a valid numeric value to preview its effect.";
    }
    value.addEventListener("input", calculate);
    reason.addEventListener("input", calculate);
    const actions = node("div", "inline-editor-actions"),
      review = node("button", "button primary small", "Review change →"),
      cancel = node("button", "button secondary small", "Cancel");
    review.id = "inline-review-change";
    review.type = "submit";
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      state.inlineEdit = null;
      renderDetail();
      $(`.numeric-value-button[data-field="${edit.field}"]`)?.focus();
    });
    actions.append(serviceBadge("supabase"), review, cancel);
    form.append(valueLabel, reasonLabel, preview, actions);
    calculate();
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const change = {
        field: edit.field,
        newValue: Number(edit.newValue),
        expectedValue: edit.original[edit.field],
        expectedRevision: edit.original.revision ?? state.revision,
        reason: edit.reason.trim(),
      };
      if (change.newValue === change.expectedValue) {
        preview.textContent =
          "Enter a different value before reviewing a change.";
        value.focus();
        return;
      }
      openAction(
        "supabase",
        edit.field,
        { ...recordSelection(edit.original, edit.field), returnFocus: value },
        { change, original: edit.original },
      );
    });
    return form;
  }
  function renderDetail() {
    const detail = $("#order-detail"),
      order = selectedOrder();
    detail.replaceChildren();
    detail.hidden = state.level !== "record" || !order;
    if (detail.hidden) return;
    const top = node("div", "detail-top");
    top.append(
      node("span", "detail-kicker", "LEVEL 03 · SOURCE RECORD"),
      node("span", "detail-status", describeStatus(order.status)),
    );
    const heading = node("h2", "", order.id);
    heading.id = "record-title";
    heading.tabIndex = -1;
    const flags = node("div", "detail-flags");
    (signals(order).length ? signals(order) : [null]).forEach((signal) =>
      flags.append(statusBadge(signal)),
    );
    const context = node("dl", "detail-context");
    [
      ["Contribution", exactMoney.format(profit(order))],
      ["Net sales", exactMoney.format(net(order))],
      ["Region / category", `${order.region} / ${order.category}`],
      ["Responsible team", order.owner],
      ["Revision", String(order.revision ?? state.revision)],
    ].forEach(([label, value]) => {
      const item = node("div");
      item.append(node("dt", "", label), node("dd", "", value));
      context.append(item);
    });
    const values = node("table", "record-values");
    const caption = node(
      "caption",
      "sr-only",
      "Select a source value to review a numeric correction in its cell",
    );
    const head = node("thead"),
      header = node("tr");
    for (const label of ["Source field", "Current value · select to edit"]) {
      const th = node("th", "", label);
      th.scope = "col";
      header.append(th);
    }
    head.append(header);
    const body = node("tbody");
    for (const [field, label] of [
      ["revenue", "Revenue"],
      ["cost", "Product cost"],
      ["refund", "Refund"],
    ]) {
      const row = node("tr"),
        cell = node("td", "source-value-cell"),
        th = node("th", "", label);
      th.scope = "row";
      const edit = state.inlineEdit;
      if (edit?.recordId === order.id && edit.field === field) {
        row.className = "inline-edit-row";
        cell.append(inlineEditor(edit));
      } else {
        const button = node(
          "button",
          "numeric-value-button",
          sourceMoney(order[field]),
        );
        button.type = "button";
        button.dataset.field = field;
        button.setAttribute(
          "aria-label",
          `Edit ${field} for ${order.id}: ${sourceMoney(order[field])}`,
        );
        button.append(node("span", "numeric-edit-cue", "Edit ↗"));
        button.addEventListener("click", () => {
          state.inlineEdit = {
            recordId: order.id,
            field,
            original: { ...order },
            newValue: String(order[field]),
            reason: "",
          };
          renderDetail();
          $("#inline-edit-value").focus();
          $("#inline-edit-value").select();
        });
        cell.append(button);
      }
      row.append(th, cell);
      body.append(row);
    }
    values.append(caption, head, body);
    const note = node("button", "detail-note source-context-trigger");
    note.type = "button";
    note.setAttribute(
      "aria-label",
      `Open actions for the source audit of ${order.id}`,
    );
    note.append(
      node("strong", "", "Source context / classroom audit ⋯"),
      node("span", "source-audit-text", order.note),
      node(
        "span",
        "source-context-hint",
        "Select this evidence to share or report a data issue",
      ),
    );
    bindContextTrigger(note, () => recordSelection(order));
    detail.append(
      top,
      heading,
      node("p", "detail-product", `${order.product} · ${order.quantity} units`),
      flags,
      context,
      values,
      note,
      node(
        "p",
        "detail-footnote",
        "Select a number to correct its source value. Select the audit evidence to report the underlying data issue.",
      ),
    );
    if (!visibleOrders().some((item) => item.id === order.id))
      detail.append(
        node(
          "p",
          "state-banner",
          "This record no longer matches the current filters after its values changed. The KPIs reflect the remaining filtered records.",
        ),
      );
  }
  function render() {
    closeContext(false);
    const orders = visibleOrders();
    $("#main").dataset.level = state.level;
    text(
      "#view-level",
      state.level === "overview"
        ? "LEVEL 01 · OVERVIEW"
        : state.level === "segment"
          ? "LEVEL 02 · SEGMENT"
          : "LEVEL 03 · RECORD",
    );
    text(
      "#view-title",
      state.level === "overview"
        ? "Operating performance"
        : state.level === "segment"
          ? scopeLabel()
          : "Order detail",
    );
    text("#snapshot-date", dateLabel(state.asOf));
    $("#snapshot-date").dateTime = state.asOf;
    $("#overview-view").hidden = state.level !== "overview";
    $("#segment-view").hidden = state.level !== "segment";
    $("#metrics").hidden = state.level !== "overview";
    $("#workspace").hidden = false;
    $("#orders-panel").hidden = state.level === "record";
    $("#global-filters").hidden = state.level === "record";
    text(
      "#download-csv",
      state.level === "record"
        ? "Download record CSV ↓"
        : "Download scope CSV ↓",
    );
    for (const level of ["overview", "segment", "record"]) {
      if (state.level === level)
        $(`#nav-${level}`).setAttribute("aria-current", "page");
      else $(`#nav-${level}`).removeAttribute("aria-current");
    }
    text("#segment-title", scopeLabel());
    const totals = metrics(orders);
    text(
      "#segment-description",
      `${totals.count} records · ${money.format(totals.netRevenue)} net revenue · ${money.format(totals.profit)} contribution. Select a bar or a row’s ⋯ menu to act on that exact finding. Open a record to inspect its source values.`,
    );
    renderBreadcrumbs();
    renderMetrics(orders);
    renderCharts(orders);
    const priority = orders.filter((order) => signals(order).length);
    const tableOrders =
      state.level === "overview"
        ? (priority.length ? priority : orders).slice(0, 6)
        : orders;
    text(
      "#orders-title",
      state.level === "overview"
        ? priority.length
          ? "Priority review"
          : "Orders in view"
        : "Segment records",
    );
    text(
      "#table-scope-note",
      state.level === "overview"
        ? `${tableOrders.length} shown · ${orders.length} orders in this view · Open Segments for the full list`
        : `${orders.length} matching synthetic orders · No customer data`,
    );
    renderOrders(tableOrders);
    renderDetail();
  }
  function syncFilters() {
    $("#search").value = state.filters.search;
    $("#signal-filter").value = state.filters.signal;
    $("#status-filter").value = state.filters.status;
  }
  function focusView() {
    $("#view-title").focus({ preventScroll: true });
    $("#overview").scrollIntoView({ block: "start", behavior: "instant" });
  }
  function goOverview() {
    state.level = "overview";
    state.selectedId = null;
    state.filters.region = "";
    state.filters.category = "";
    state.filters.channel = "";
    render();
    focusView();
  }
  function selectOrder(id) {
    state.inlineEdit = null;
    state.selectedId = id;
    state.level = "record";
    render();
    $("#record-title")?.focus({ preventScroll: true });
    $("#order-detail").scrollIntoView({
      block: "nearest",
      behavior: "instant",
    });
  }

  function readHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      state.history = Array.isArray(saved)
        ? saved
            .filter(
              (entry) =>
                entry &&
                UUID.test(entry.requestId || "") &&
                Object.hasOwn(ACTION_NAMES, entry.action) &&
                Object.hasOwn(RESULTS, entry.state) &&
                typeof entry.createdAt === "string",
            )
            .slice(0, MAX_HISTORY)
            .map((entry) =>
              entry.state === "sending"
                ? {
                    ...entry,
                    state: "unknown",
                    message:
                      "The page closed while this request was pending. Inspect the destination before considering another send.",
                  }
                : entry,
            )
        : [];
      saveHistory();
    } catch {
      state.history = [];
      state.storageAvailable = false;
    }
  }
  function saveHistory() {
    try {
      localStorage.setItem(
        HISTORY_KEY,
        JSON.stringify(state.history.slice(0, MAX_HISTORY)),
      );
      state.storageAvailable = true;
    } catch {
      state.storageAvailable = false;
    }
    text(
      "#storage-warning",
      state.storageAvailable
        ? ""
        : "Local storage is unavailable. Export the request IDs before closing the page; do not repeat an uncertain action.",
    );
    $("#storage-warning").hidden = state.storageAvailable;
  }
  function safeProviderUrl(action, value) {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      const hosts = {
        email: ["resend.com"],
        trello: ["trello.com", "www.trello.com"],
        supabase: ["supabase.com"],
        github: ["github.com", "www.github.com"],
      };
      return url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        hosts[action].includes(url.hostname)
        ? url.href
        : null;
    } catch {
      return null;
    }
  }
  function renderHistory() {
    text("#nav-count", state.history.length);
    text(
      "#history-summary-count",
      state.history.length
        ? `${state.history.length} request${state.history.length === 1 ? "" : "s"} · latest results`
        : "No actions yet",
    );
    $("#history").open = state.history.length > 0;
    $("#show-history-toggle").hidden = state.history.length <= 2;
    text(
      "#show-history-toggle",
      state.historyExpanded
        ? "Show latest two"
        : `Show all ${state.history.length} requests`,
    );
    $("#export-history").disabled = !state.history.length;
    const list = $("#history-list");
    list.replaceChildren();
    if (!state.history.length) {
      const empty = node("div", "history-empty");
      empty.append(
        node("span", "empty-icon", "↗"),
        node(
          "p",
          "",
          "No actions yet. Select a KPI, chart bar or row to act on that finding. Select a source value to review a correction.",
        ),
      );
      list.append(empty);
      return;
    }
    (state.historyExpanded ? state.history : state.history.slice(0, 2)).forEach(
      (entry) => {
        const row = node("article", "activity-row"),
          copy = node("div");
        copy.append(
          node("h3", "activity-title", ACTION_NAMES[entry.action]),
          node(
            "p",
            "activity-meta",
            `${entry.recordId || scopeLabel(entry.scope)} · ${entry.createdAt}`,
          ),
          node(
            "p",
            "activity-description",
            entry.message ||
              "Keep this request ID and inspect the provider result.",
          ),
        );
        const evidence = node("details", "activity-request");
        evidence.append(
          node("summary", "", "Request and evidence"),
          node("p", "activity-ref", `Request ID: ${entry.requestId}`),
        );
        if (entry.providerId !== undefined)
          evidence.append(
            node("p", "activity-ref", `Provider ID: ${entry.providerId}`),
          );
        if (entry.change)
          evidence.append(
            node(
              "p",
              "",
              `${entry.change.field}: ${exactMoney.format(entry.change.expectedValue)} → ${exactMoney.format(entry.change.newValue)} · ${entry.change.reason}`,
            ),
          );
        if (entry.snapshot)
          evidence.append(
            node(
              "p",
              "activity-ref",
              `${entry.snapshot.recordIds?.length ?? "—"} records · ${scopeLabel(entry.scope)} · snapshot ${entry.snapshot.fingerprint || "not provided"}`,
            ),
          );
        if (entry.draft)
          evidence.append(
            node("pre", "proposal-diff", JSON.stringify(entry.draft, null, 2)),
          );
        copy.append(evidence);
        const href = safeProviderUrl(entry.action, entry.url);
        if (href) {
          const link = node("a", "text-link", "Inspect provider result ↗");
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          copy.append(link);
        }
        if (entry.state === "accepted")
          copy.append(
            node(
              "p",
              "state-banner",
              "Provider acceptance does not prove inbox delivery. Check the recipient inbox; do not send the same summary again just to check it.",
            ),
          );
        if (["unknown", "rejected"].includes(entry.state) && !entry.retryable)
          copy.append(
            node(
              "p",
              "state-banner",
              "Do not repeat this request. Inspect the provider first; a failed response may follow a partial external action.",
            ),
          );
        row.append(
          node(
            "span",
            `activity-icon ${entry.state}`,
            entry.state === "verified"
              ? "✓"
              : entry.state === "accepted"
                ? "↗"
                : "!",
          ),
          copy,
          node("div", `activity-result ${entry.state}`, RESULTS[entry.state]),
        );
        list.append(row);
      },
    );
  }
  function exportHistory() {
    const blob = new Blob(
      [
        JSON.stringify(
          {
            application: "Northstar Action Lab",
            exportedAt: new Date().toISOString(),
            dataSource: state.source,
            actions: state.history,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob),
      link = node("a");
    link.href = url;
    link.download = "northstar-action-history.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(value) {
    let textValue = value === null || value === undefined ? "" : String(value);
    // Keep text from becoming a spreadsheet formula when the export is opened.
    if (typeof value === "string" && /^[\s]*[=+\-@]/.test(textValue))
      textValue = `'${textValue}`;
    return `"${textValue.replaceAll('"', '""')}"`;
  }
  function downloadCsv() {
    const records =
      state.level === "record" && selectedOrder()
        ? [selectedOrder()]
        : visibleOrders();
    const fields = [
      "id",
      "product",
      "category",
      "region",
      "channel",
      "status",
      "quantity",
      "revenue",
      "cost",
      "refund",
      "netRevenue",
      "contribution",
      "marginRate",
      "revision",
      "note",
    ];
    const lines = [
      fields.map(csvCell).join(","),
      ...records.map((order) => {
        const row = {
          ...order,
          netRevenue: net(order),
          contribution: profit(order),
          marginRate: margin(order),
        };
        return fields.map((key) => csvCell(row[key])).join(",");
      }),
    ];
    const blob = new Blob([`\uFEFF${lines.join("\r\n")}\r\n`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob),
      link = node("a");
    link.href = url;
    link.download = `northstar-${state.level === "record" ? state.selectedId : "current-scope"}-${state.asOf}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(
      `Downloaded ${records.length} ${records.length === 1 ? "record" : "records"} from the current ${state.level === "record" ? "record" : "filtered scope"}.`,
    );
  }

  function localDraft(action, scope, order) {
    const scopedOrders = ordersForScope(scope);
    const totals = metrics(scopedOrders);
    const summary = `Synthetic Northstar operations · ${state.asOf}\nScope: ${scopeLabel(scope)}\nOrders: ${totals.count}\nNet revenue: ${exactMoney.format(totals.netRevenue)}\nContribution: ${exactMoney.format(totals.profit)}\nRecords: ${scopedOrders
      .map((item) => item.id)
      .join(", ")}`;
    if (action === "email")
      return {
        to: "",
        subject: `Operations summary · ${scopeLabel(scope)}`,
        body: `${summary}\n\nPlease review this view and the records behind it.`,
      };
    if (action === "trello")
      return {
        title: `Investigate ${scopeLabel(scope)}`,
        description: `${summary}\n\nInvestigate the selected segment and record the next step.`,
      };
    if (action === "github")
      return {
        title: `Investigate the source import for ${order.id}`,
        body: `Synthetic source-record investigation: ${order.id} · ${order.product}\n\nCurrent revenue: ${exactMoney.format(order.revenue)}\nCurrent cost: ${exactMoney.format(order.cost)}\nCurrent refund: ${exactMoney.format(order.refund)}\nContribution: ${exactMoney.format(profit(order))}\n\nClassroom audit: ${order.note}\n\nCheck the source import so that a corrected value is not overwritten and the same error does not recur. Opening this issue does not change transaction data.`,
      };
    return {};
  }
  function setDraftFields(action, draft) {
    $("#action-recipient").value = draft.to || "";
    $("#action-title").value = draft.subject || draft.title || "";
    $("#action-reason").value =
      draft.body || draft.description || (action === "supabase" ? "" : "");
  }
  function draftFromFields(action) {
    const title = $("#action-title").value.trim(),
      body = $("#action-reason").value.trim();
    if (action === "email")
      return { to: $("#action-recipient").value.trim(), subject: title, body };
    if (action === "trello") return { title, description: body };
    if (action === "github") return { title, body };
    return undefined;
  }
  function currentChange() {
    const order = state.pending?.original;
    if (!order) return null;
    const field = $("#edit-field").value;
    return {
      field,
      newValue: Number($("#edit-value").value),
      expectedValue: order[field],
      expectedRevision: order.revision ?? state.revision,
      reason: $("#action-reason").value.trim(),
    };
  }
  function renderCalculation() {
    const original = state.pending?.original,
      target = $("#calculation-preview");
    target.replaceChildren();
    if (!original) return;
    const field = $("#edit-field").value,
      raw = $("#edit-value").value,
      value = Number(raw);
    target.append(
      node(
        "p",
        "",
        `Current ${field}: ${sourceMoney(original[field])} · revision ${original.revision ?? state.revision}`,
      ),
    );
    if (!raw || !Number.isFinite(value) || value < 0) return;
    const changed = { ...original, [field]: value },
      delta = profit(changed) - profit(original);
    target.append(
      node(
        "p",
        "",
        `Contribution: ${exactMoney.format(profit(original))} → ${exactMoney.format(profit(changed))}`,
      ),
      node(
        "p",
        "metric-delta",
        `Proposed change: ${delta >= 0 ? "+" : ""}${exactMoney.format(delta)}. This is a preview; no source value has been saved.`,
      ),
    );
  }
  function editableStage() {
    $("#action-fields").hidden = false;
    $("#exact-preview").hidden = true;
    $("#back-to-edit").hidden = true;
    $("#prepare-action").hidden = Boolean(state.pending?.inlineChange);
    if (state.pending?.inlineChange) {
      $("#back-to-edit").hidden = false;
      text("#back-to-edit", "Return to cell");
    }
    $("#confirm-action").hidden = true;
    $("#confirm-consent").checked = false;
    if (state.pending) {
      state.pending.reviewed = null;
      state.pending.snapshot = null;
    }
  }
  async function openAction(action, field = "cost", selection, inline) {
    if (
      state.submitting ||
      state.pending ||
      !Object.hasOwn(ACTION_NAMES, action)
    )
      return;
    if (!selection) return;
    const order = selection.recordId
      ? state.orders.find((item) => item.id === selection.recordId)
      : null;
    if (["supabase", "github"].includes(action) && !order) {
      notify("Open a record before taking this action.");
      return;
    }
    const scope = Object.freeze({ ...selection.scope });
    const pending = {
      action,
      scope,
      selection: freezeSelection(selection),
      returnFocus: selection.returnFocus,
      recordId: selection.recordId,
      original: inline ? { ...inline.original } : order ? { ...order } : null,
      inlineChange: inline?.change,
      dirty: false,
      preparing: false,
      reviewed: null,
      snapshot: null,
    };
    state.pending = pending;
    $("#dialog-service").replaceChildren(serviceBadge(action));
    editableStage();
    setFormStatus("");
    const numeric = action === "supabase";
    text(
      "#dialog-title",
      {
        email: "Share this finding",
        trello: "Assign this investigation",
        supabase: `Review ${order?.id} · ${field}`,
        github: "Report this data issue",
      }[action],
    );
    text(
      "#dialog-description",
      {
        email:
          "Edit the recipient, subject and message. The summary follows the filters in this view. Acceptance is not proof of inbox delivery.",
        trello:
          "Edit the task title and description. The selected segment and record IDs stay attached to the reviewed task.",
        supabase:
          "Review the change entered in the source cell. Check the old value, new value and reason before saving. Only a verified read-back updates the dashboard.",
        github:
          "Edit an issue for this source record. Include the audit evidence and the follow-up that prevents the import error from recurring. An issue does not change source values.",
      }[action],
    );
    text(
      "#review-context",
      `${selectionSummary(selection, metrics(ordersForScope(scope)))} · ${scopeLabel(scope)} · ${ordersForScope(scope).length} records in scope`,
    );
    $("#recipient-field").hidden = action !== "email";
    $("#action-recipient").disabled = action !== "email";
    $("#action-recipient").required = action === "email";
    $("#reason-field").hidden = Boolean(inline);
    $("#title-field").hidden = numeric;
    $("#action-title").disabled = numeric;
    $("#action-title").required = !numeric;
    text("#title-label", action === "email" ? "Subject" : "Title");
    text(
      "#reason-label",
      numeric
        ? "Reason for this correction"
        : action === "email"
          ? "Email message"
          : "Description / evidence",
    );
    $("#action-reason").minLength = numeric ? 5 : 10;
    $("#action-reason").maxLength = numeric ? 600 : 8000;
    $("#numeric-editor").hidden = true;
    $("#edit-field").disabled = true;
    $("#edit-value").disabled = true;
    $("#edit-value").required = false;
    $("#action-reason").disabled = Boolean(inline);
    $("#dialog-access").value = state.accessPhrase;
    $("#dialog-access-field").hidden = Boolean(state.accessPhrase);
    setDraftFields(
      action,
      decorateDraft(
        localDraft(action, scope, order),
        selection,
        metrics(ordersForScope(scope)),
        action,
      ),
    );
    if (numeric) {
      $("#edit-field").value = field;
      $("#edit-value").value = String(order[field]);
      renderCalculation();
    }
    $("#action-dialog").returnValue = "";
    $("#action-dialog").showModal();
    if (numeric) {
      $("#prepare-action").hidden = true;
      $("#back-to-edit").hidden = false;
      text("#back-to-edit", "Return to cell");
      await prepareAction({ preventDefault() {} });
      return;
    }
    text("#back-to-edit", "Edit request");
    pending.preparing = true;
    $("#prepare-action").disabled = true;
    setFormStatus("Loading a draft from the current server data…");
    try {
      const result = await api({
        operation: "preview",
        action,
        scope,
        ...(pending.recordId ? { recordId: pending.recordId } : {}),
      });
      if (state.pending !== pending) return;
      if (!result.ok || result.data.state !== "preview") {
        setFormStatus(
          serverMessage(
            result.data,
            "The server could not prepare this view. No action was sent.",
          ),
          "rejected",
        );
        return;
      }
      if (!pending.dirty) {
        const defaults = decorateDraft(
          result.data.defaults || {},
          selection,
          result.data.metrics,
          action,
        );
        setDraftFields(action, defaults);
        text(
          "#review-context",
          `${selectionSummary(selection, result.data.metrics)} · ${scopeLabel(scope)} · ${result.data.recordsInScope.length} records in scope`,
        );
      }
      setFormStatus(
        result.data.missing?.length
          ? `You can review and try this action. Missing server settings: ${result.data.missing.join(", ")}.`
          : "Draft prepared from the current scope. Edit it, then review the exact action.",
      );
    } catch {
      if (state.pending === pending)
        setFormStatus(
          "The server preview is unavailable. No action was sent. You can edit the draft and try the review again.",
          "rejected",
        );
    } finally {
      if (state.pending === pending) {
        pending.preparing = false;
        $("#prepare-action").disabled = false;
      }
    }
  }
  function closeAction() {
    if (state.submitting) return;
    const pending = state.pending;
    $("#action-dialog").close();
    state.pending = null;
    const target = pending?.inlineChange
      ? $("#inline-edit-value")
      : pending?.returnFocus;
    if (target?.isConnected) target.focus({ preventScroll: true });
    else $("#view-title").focus({ preventScroll: true });
  }
  function reviewFingerprint(payload) {
    return JSON.stringify({
      action: payload.action,
      scope: payload.scope,
      recordId: payload.recordId,
      draft: payload.draft,
      change: payload.change,
      snapshot: payload.snapshot?.fingerprint,
    });
  }
  async function prepareAction(event) {
    event.preventDefault();
    const pending = state.pending;
    if (!pending || pending.preparing || state.submitting) return;
    const payload = {
      operation: "preview",
      action: pending.action,
      scope: pending.scope,
      ...(pending.recordId ? { recordId: pending.recordId } : {}),
    };
    if (pending.action === "supabase") {
      const change = pending.inlineChange || currentChange();
      if (
        (!pending.inlineChange && !$("#edit-value").value) ||
        !Number.isFinite(change.newValue) ||
        change.newValue < 0 ||
        change.newValue === change.expectedValue
      ) {
        setFormStatus(
          "Enter a different, valid numeric value before reviewing the correction.",
          "rejected",
        );
        $("#edit-value").focus();
        return;
      }
      payload.change = change;
    } else payload.draft = draftFromFields(pending.action);
    pending.preparing = true;
    $("#prepare-action").disabled = true;
    setFormStatus("Reading the current data and preparing the exact action…");
    try {
      const result = await api(payload);
      if (state.pending !== pending) return;
      if (
        !result.ok ||
        result.data.state !== "preview" ||
        !result.data.snapshot?.fingerprint
      ) {
        setFormStatus(
          serverMessage(
            result.data,
            "The server could not establish a preview. No action was sent.",
          ),
          "rejected",
        );
        if (result.status === 401) $("#dialog-access-field").hidden = false;
        return;
      }
      const preview = result.data;
      const reviewed = {
        ...payload,
        ...(pending.action === "supabase"
          ? { change: preview.change }
          : { draft: preview.defaults }),
        snapshot: preview.snapshot,
      };
      const fingerprint = reviewFingerprint(reviewed);
      const prior = state.history.find(
        (entry) => entry.fingerprint === fingerprint && !entry.retryable,
      );
      if (prior) {
        setFormStatus(
          `This exact action already has a request: ${prior.requestId} (${RESULTS[prior.state]}). Inspect its activity entry before trying anything again.`,
          "unknown",
        );
        return;
      }
      pending.reviewed = reviewed;
      pending.snapshot = preview.snapshot;
      pending.fingerprint = fingerprint;
      $("#action-fields").hidden =
        !pending.inlineChange || Boolean(state.accessPhrase);
      $("#exact-preview").hidden = false;
      $("#prepare-action").hidden = true;
      $("#back-to-edit").hidden = false;
      $("#confirm-action").hidden = false;
      $("#confirm-consent").checked = false;
      $("#confirm-action").disabled = true;
      text(
        "#preview-title",
        pending.action === "supabase"
          ? `${pending.recordId} · numeric correction`
          : preview.defaults.subject || preview.defaults.title,
      );
      text(
        "#review-context",
        `${selectionSummary(pending.selection, preview.metrics)} · ${scopeLabel(pending.scope)} · ${preview.recordsInScope.length} records in scope`,
      );
      text(
        "#preview-destination",
        `Destination: ${pending.action === "email" ? preview.defaults.to : preview.destination || "Checked by the server"}`,
      );
      const summary = `${preview.metrics.count} records · ${scopeLabel(preview.snapshot.scope)}\nNet revenue: ${exactMoney.format(preview.metrics.netRevenue)} · Contribution: ${exactMoney.format(preview.metrics.profit)}\nRecord IDs: ${preview.snapshot.recordIds.join(", ")}`;
      text(
        "#preview-body",
        pending.action === "supabase"
          ? `${summary}\n\nReason: ${preview.change.reason}`
          : `${preview.defaults.body || preview.defaults.description}\n\n${preview.metadataNote || ""}`,
      );
      $("#preview-diff").hidden = pending.action !== "supabase";
      if (pending.action === "supabase")
        text(
          "#preview-diff",
          `${preview.change.field}\n− ${sourceMoney(preview.change.expectedValue)} (revision ${preview.change.expectedRevision})\n+ ${sourceMoney(preview.change.newValue)}\n\nSource amounts change only after a confirmed, verified save.`,
        );
      text(
        "#confirm-action",
        {
          email: "Send this email →",
          trello: "Create this Trello task →",
          supabase: "Save correction to Supabase →",
          github: "Create this GitHub issue →",
        }[pending.action],
      );
      setFormStatus(
        preview.missing?.length
          ? `The action can be tried; the server will report missing settings: ${preview.missing.join(", ")}. No provider call has been made yet.`
          : "Review the exact scope and content. Nothing is sent until you confirm.",
      );
    } catch {
      if (state.pending === pending)
        setFormStatus(
          "The preview could not be loaded. No external action was requested. Try the preview again when the connection is available.",
          "rejected",
        );
    } finally {
      if (state.pending === pending) {
        pending.preparing = false;
        $("#prepare-action").disabled = false;
      }
    }
  }
  async function executeAction() {
    const pending = state.pending;
    if (
      !pending?.reviewed ||
      state.submitting ||
      !$("#confirm-consent").checked
    )
      return;
    state.submitting = true;
    $("#confirm-action").disabled = true;
    $("#back-to-edit").disabled = true;
    $("#cancel-action").disabled = true;
    $("#close-dialog").disabled = true;
    const requestId = crypto.randomUUID();
    const entry = {
      action: pending.action,
      requestId,
      createdAt: new Date().toISOString(),
      scope: pending.scope,
      ...(pending.recordId ? { recordId: pending.recordId } : {}),
      ...(pending.reviewed.draft ? { draft: pending.reviewed.draft } : {}),
      ...(pending.reviewed.change ? { change: pending.reviewed.change } : {}),
      snapshot: pending.snapshot,
      fingerprint: pending.fingerprint,
      state: "sending",
      retryable: false,
      message: "The confirmed action is in progress. Do not resend.",
    };
    state.history.unshift(entry);
    state.history = state.history.slice(0, MAX_HISTORY);
    saveHistory();
    renderHistory();
    setFormStatus(
      `Request ${requestId} is in progress. Do not reload or resend.`,
    );
    let status = 0,
      data;
    try {
      const result = await api(
        {
          ...pending.reviewed,
          operation: "execute",
          requestId,
          confirmed: true,
        },
        60000,
      );
      status = result.status;
      data = result.data;
      if (data.requestId && data.requestId !== requestId)
        data = {
          state: "unknown",
          message:
            "The result did not match this request ID. Inspect the destination before another action.",
        };
    } catch {
      data = {
        state: "unknown",
        message:
          "The connection ended before the outcome was established. The action may already have occurred. Inspect the provider before sending anything again.",
      };
    }
    entry.state = Object.hasOwn(RESULTS, data.state) ? data.state : "unknown";
    entry.message = serverMessage(
      data,
      "The outcome could not be established. Inspect the provider using the request ID.",
    );
    entry.providerId =
      data.id ?? data.emailId ?? data.cardId ?? data.issueNumber;
    entry.url = data.url ?? data.cardUrl ?? data.issueUrl;
    entry.retryable =
      (status === 401 && data.state === "rejected") ||
      (status === 503 && data.state === "not_configured");
    if (data.deliveryState) entry.deliveryState = data.deliveryState;
    if (data.checkedAt) entry.checkedAt = data.checkedAt;
    if (data.verification) entry.verification = data.verification;
    if (pending.action === "supabase" && data.state === "verified") {
      const saved = data.record;
      const savedInDataset = Array.isArray(data.records)
        ? data.records.find((record) => record.id === pending.recordId)
        : null;
      if (
        !validOrder(saved) ||
        saved.id !== pending.recordId ||
        saved[pending.reviewed.change.field] !==
          pending.reviewed.change.newValue ||
        !validOrder(savedInDataset) ||
        savedInDataset[pending.reviewed.change.field] !==
          pending.reviewed.change.newValue ||
        data.records.length !== state.orders.length ||
        !state.orders.every((record) =>
          data.records.some((current) => current.id === record.id),
        ) ||
        !applyRecords(data)
      ) {
        entry.state = "unknown";
        entry.message =
          "The response did not establish the expected saved numeric value. Dashboard source values were not changed. Refresh from the server before another attempt.";
      } else {
        entry.message =
          "The numeric correction was saved and independently read back from Supabase. All current KPIs and chart calculations now use the saved values.";
        text(
          "#data-status",
          `${state.orders.length} synthetic orders · read from Supabase`,
        );
        state.inlineEdit = null;
        render();
      }
    }
    saveHistory();
    renderHistory();
    state.submitting = false;
    $("#back-to-edit").disabled = false;
    $("#cancel-action").disabled = false;
    $("#close-dialog").disabled = false;
    if (entry.retryable) {
      editableStage();
      setFormStatus(
        `${entry.message} No external action was performed. Correct the settings or access phrase, then review again.`,
        "rejected",
      );
      if (status === 401) {
        $("#dialog-access-field").hidden = false;
        $("#dialog-access").focus();
      }
    } else {
      closeAction();
      notify(
        `${ACTION_NAMES[entry.action]}: ${RESULTS[entry.state]}. ${entry.state === "verified" ? "Evidence saved in Activity." : "Inspect the activity result before taking another step."}`,
      );
    }
  }
  function bindEvents() {
    document.addEventListener("pointerdown", (event) => {
      if (
        state.menu &&
        !$("#context-menu").contains(event.target) &&
        !state.menu.trigger?.contains(event.target)
      )
        closeContext(false);
    });
    document.addEventListener("keydown", (event) => {
      if (!state.menu) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeContext();
        return;
      }
      if (event.key === "Tab") {
        closeContext();
        return;
      }
      const buttons = [...$("#context-menu").querySelectorAll("button")];
      let index = buttons.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length;
        buttons[index].focus();
      }
    });
    window.addEventListener("resize", () => closeContext(false));

    $("#nav-overview").addEventListener("click", (event) => {
      event.preventDefault();
      goOverview();
    });
    $("#nav-segment").addEventListener("click", () => {
      state.level = "segment";
      state.selectedId = null;
      render();
      focusView();
    });
    $("#nav-record").addEventListener("click", () => {
      const order = selectedOrder() || visibleOrders()[0];
      if (order) selectOrder(order.id);
      else
        notify(
          "No records match this scope. Change the filters before opening a record.",
        );
    });
    $("#download-csv").addEventListener("click", downloadCsv);
    $("#search").addEventListener("input", (event) => {
      state.filters.search = event.target.value;
      render();
    });
    $("#signal-filter").addEventListener("change", (event) => {
      state.filters.signal = event.target.value;
      render();
    });
    $("#status-filter").addEventListener("change", (event) => {
      state.filters.status = event.target.value;
      render();
    });
    $("#clear-filters").addEventListener("click", () => {
      state.filters = {
        search: "",
        signal: "all",
        status: "all",
        region: "",
        category: "",
        channel: "",
      };
      state.level = "overview";
      state.selectedId = null;
      syncFilters();
      render();
    });
    $("#explore-case").addEventListener("click", () => {
      const order = state.orders.find((item) => item.id === "NS-1041");
      if (!order) return;
      state.filters.region = order.region;
      state.filters.category = order.category;
      state.filters.search = "";
      state.filters.signal = "all";
      state.filters.status = "all";
      state.level = "segment";
      state.selectedId = null;
      syncFilters();
      render();
      focusView();
    });
    $("#lab-access").addEventListener("input", (event) => {
      state.accessPhrase = event.target.value.trim();
      $("#dialog-access").value = state.accessPhrase;
    });
    $("#dialog-access").addEventListener("input", (event) => {
      state.accessPhrase = event.target.value.trim();
      $("#lab-access").value = state.accessPhrase;
    });
    $("#clear-access").addEventListener("click", () => {
      state.accessPhrase = "";
      $("#lab-access").value = "";
      $("#dialog-access").value = "";
      notify("Lab access phrase cleared from memory.");
    });
    $("#refresh-data").addEventListener("click", () => refreshData());
    ["#action-recipient", "#action-title", "#action-reason"].forEach(
      (selector) =>
        $(selector).addEventListener("input", () => {
          if (state.pending) state.pending.dirty = true;
        }),
    );
    $("#edit-field").addEventListener("change", () => {
      if (!state.pending?.original) return;
      $("#edit-value").value = String(
        state.pending.original[$("#edit-field").value],
      );
      renderCalculation();
    });
    $("#edit-value").addEventListener("input", renderCalculation);
    $("#action-form").addEventListener("submit", prepareAction);
    $("#confirm-consent").addEventListener("change", () => {
      $("#confirm-action").disabled =
        !$("#confirm-consent").checked || state.submitting;
    });
    $("#confirm-action").addEventListener("click", executeAction);
    $("#back-to-edit").addEventListener("click", () => {
      if (!state.submitting) {
        if (state.pending?.inlineChange) {
          closeAction();
          return;
        }
        editableStage();
        setFormStatus("Edit the request, then review it again.");
      }
    });
    $("#cancel-action").addEventListener("click", closeAction);
    $("#close-dialog").addEventListener("click", closeAction);
    $("#action-dialog").addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!state.submitting) closeAction();
    });
    $("#action-dialog").addEventListener("close", () => {
      if (!state.submitting) state.pending = null;
    });
    $("#export-history").addEventListener("click", exportHistory);
    $("#show-history-toggle").addEventListener("click", () => {
      state.historyExpanded = !state.historyExpanded;
      renderHistory();
    });
    $(".top-nav a[href='#history']").addEventListener("click", () => {
      $("#history").open = true;
    });
    window.addEventListener("pagehide", () => {
      state.accessPhrase = "";
      $("#lab-access").value = "";
      $("#dialog-access").value = "";
    });
  }
  async function start() {
    bindEvents();
    readHistory();
    renderHistory();
    await refreshData();
  }
  start();
})();

