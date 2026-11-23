const fmtUSD = (v) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v || 0);
const fmtInt = (v) => new Intl.NumberFormat("en-US").format(Math.round(v || 0));

const LIVE_KEY = "snowcommerce_live_orders";

const state = {
  baseDaily: [],
  baseInventory: [],
  baseOrders: [],
  daily: [],
  cohort: [],
  inventory: [],
  orders: [],
  charts: {},
  initialized: false,
};

function getLiveStoreOrders() {
  try {
    return JSON.parse(localStorage.getItem(LIVE_KEY) || "[]");
  } catch {
    return [];
  }
}

function applyLiveStoreOrders() {
  const liveItems = getLiveStoreOrders();

  // 1. Merge live store orders into daily revenue
  const dailyMap = new Map();
  state.daily = state.baseDaily.map((r) => {
    const copy = { ...r };
    dailyMap.set(`${copy.ORDER_DATE}|${copy.CATEGORY}|${copy.REGION}`, copy);
    return copy;
  });

  // Group live items by (order_id, category, region) so ORDER_COUNT increments cleanly per order
  const seenOrdCatReg = new Set();
  liveItems.forEach((item) => {
    const k = `${item.ORDER_DATE}|${item.CATEGORY}|${item.REGION}`;
    let row = dailyMap.get(k);
    if (!row) {
      row = {
        ORDER_DATE: item.ORDER_DATE,
        CATEGORY: item.CATEGORY,
        REGION: item.REGION,
        ORDER_COUNT: 0,
        NET_REVENUE: 0,
        NET_MARGIN: 0,
      };
      dailyMap.set(k, row);
      state.daily.push(row);
    }
    const ordKey = `${item.ORDER_ID}|${item.CATEGORY}|${item.REGION}`;
    if (!seenOrdCatReg.has(ordKey)) {
      seenOrdCatReg.add(ordKey);
      row.ORDER_COUNT += 1;
    }
    row.NET_REVENUE = +(row.NET_REVENUE + item.NET_REVENUE).toFixed(2);
    row.NET_MARGIN = +(row.NET_MARGIN + item.NET_MARGIN).toFixed(2);
  });

  // 2. Merge live store purchases into inventory & SKU health
  const skuDelta = {};
  liveItems.forEach((item) => {
    if (!skuDelta[item.SKU_ID]) skuDelta[item.SKU_ID] = { qty: 0, rev: 0, mar: 0 };
    skuDelta[item.SKU_ID].qty += item.QUANTITY;
    skuDelta[item.SKU_ID].rev += item.NET_REVENUE;
    skuDelta[item.SKU_ID].mar += item.NET_MARGIN;
  });

  state.inventory = state.baseInventory.map((s) => {
    const d = skuDelta[s.SKU_ID];
    if (!d) return { ...s };
    const newStock = Math.max(0, s.STOCK_ON_HAND - d.qty);
    const newUnits30 = s.UNITS_SOLD_30D + d.qty;
    const newVel = +(newUnits30 / 30).toFixed(2);
    return {
      ...s,
      STOCK_ON_HAND: newStock,
      UNITS_SOLD_30D: newUnits30,
      DAILY_VELOCITY_30D: newVel,
      DAYS_OF_SUPPLY: +(newStock / Math.max(0.1, newVel)).toFixed(1),
      STOCKOUT_RISK_FLAG: newStock <= s.REORDER_POINT,
      TOTAL_REVENUE: +(s.TOTAL_REVENUE + d.rev).toFixed(2),
      TOTAL_NET_MARGIN: +(s.TOTAL_NET_MARGIN + d.mar).toFixed(2),
    };
  });
  state.inventory.sort((a, b) => (a.STOCKOUT_RISK_FLAG === b.STOCKOUT_RISK_FLAG ? a.DAYS_OF_SUPPLY - b.DAYS_OF_SUPPLY : a.STOCKOUT_RISK_FLAG ? -1 : 1));

  // 3. Prepend live store orders to Order Lookup
  state.orders = [...liveItems, ...state.baseOrders];

  // 4. Update sidebar live sync indicator
  const uniqueLiveOrders = new Set(liveItems.map((x) => x.ORDER_ID)).size;
  const pill = document.getElementById("live-sync-pill");
  if (pill) {
    if (uniqueLiveOrders > 0) {
      document.getElementById("live-sync-count").textContent = uniqueLiveOrders;
      pill.style.display = "block";
    } else {
      pill.style.display = "none";
    }
  }
}

const PRUNING_MODES = {
  baseline: {
    partitions: "8 / 8",
    pruned: "0.0% pruned (Full Table Scan)",
    bytes: "46.88 MB",
    bytesNote: "Baseline I/O (USE_CACHED_RESULT = FALSE)",
    time: "664 ms",
    compute: "ECOMM_APP_WH (X-Small)",
    depth: "9.0 / 8.0",
    depthNote: "Every partition overlaps",
    img: "images/query_profile_baseline.png",
  },
  sorted: {
    partitions: "1 / 8",
    pruned: "87.5% partitions pruned",
    bytes: "2.09 MB",
    bytesNote: "-95.5% bytes scanned vs baseline",
    time: "210 ms",
    compute: "ECOMM_APP_WH (X-Small, -68.4%)",
    depth: "1.0 / 0.0",
    depthNote: "Ideal clustering via ORDER BY",
    img: "images/query_profile_pruned.png",
  },
  cached: {
    partitions: "0 (Result Reuse)",
    pruned: "100% pruned",
    bytes: "0 B",
    bytesNote: "Served from 24h Result Cache",
    time: "1 ms",
    compute: "0 Warehouse Compute (Cloud Services)",
    depth: "1.0 / 0.0",
    depthNote: "Zero warehouse wakeup",
    img: "images/query_profile_cached.png",
  },
};

function setupTabs() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

function makeOrUpdateChart(id, config) {
  if (state.charts[id]) {
    state.charts[id].destroy();
  }
  const ctx = document.getElementById(id).getContext("2d");
  state.charts[id] = new Chart(ctx, config);
}

function initKpiFilters() {
  const dates = state.daily.map((r) => r.ORDER_DATE).sort();
  const minD = dates[0];
  const maxD = dates[dates.length - 1];
  const maxObj = new Date(maxD);
  const start90 = new Date(maxObj.getTime() - 90 * 86400000).toISOString().slice(0, 10);

  const startEl = document.getElementById("kpi-start");
  const endEl = document.getElementById("kpi-end");
  startEl.min = minD;
  startEl.max = maxD;
  endEl.min = minD;
  endEl.max = maxD;
  startEl.value = start90 > minD ? start90 : minD;
  endEl.value = maxD;

  const cats = [...new Set(state.daily.map((r) => r.CATEGORY))].sort();
  const regs = [...new Set(state.daily.map((r) => r.REGION))].sort();

  const catSel = document.getElementById("kpi-category");
  cats.forEach((c) => catSel.add(new Option(c, c)));

  const regSel = document.getElementById("kpi-region");
  regs.forEach((r) => regSel.add(new Option(r, r)));

  [startEl, endEl, catSel, regSel].forEach((el) => el.addEventListener("change", renderKpiView));
  renderKpiView();
}

function summarize(rows) {
  let rev = 0;
  let ord = 0;
  let margin = 0;
  rows.forEach((r) => {
    rev += r.NET_REVENUE;
    ord += r.ORDER_COUNT;
    margin += r.NET_MARGIN;
  });
  return {
    rev,
    ord,
    margin,
    aov: ord > 0 ? rev / ord : 0,
    marginPct: rev > 0 ? (margin / rev) * 100 : 0,
  };
}

function renderKpiView() {
  const s = document.getElementById("kpi-start").value;
  const e = document.getElementById("kpi-end").value;
  const cat = document.getElementById("kpi-category").value;
  const reg = document.getElementById("kpi-region").value;

  const matchesDim = (r) => (cat === "ALL" || r.CATEGORY === cat) && (reg === "ALL" || r.REGION === reg);
  const curRows = state.daily.filter((r) => r.ORDER_DATE >= s && r.ORDER_DATE <= e && matchesDim(r));

  const days = Math.max(1, Math.round((new Date(e) - new Date(s)) / 86400000) + 1);
  const prevEnd = new Date(new Date(s).getTime() - 86400000).toISOString().slice(0, 10);
  const prevStart = new Date(new Date(prevEnd).getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const prevRows = state.daily.filter((r) => r.ORDER_DATE >= prevStart && r.ORDER_DATE <= prevEnd && matchesDim(r));

  const k = summarize(curRows);
  const pk = summarize(prevRows);

  const deltaText = (cur, prev) => {
    if (prev <= 0) return { text: "No prior window", cls: "" };
    const pct = ((cur - prev) / prev) * 100;
    return { text: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs prior`, cls: pct < 0 ? "neg" : "" };
  };

  document.getElementById("m-revenue").textContent = fmtUSD(k.rev);
  document.getElementById("m-orders").textContent = fmtInt(k.ord);
  document.getElementById("m-aov").textContent = fmtUSD(k.aov);
  document.getElementById("m-margin").textContent = `${fmtUSD(k.margin)} (${k.marginPct.toFixed(1)}%)`;

  const dRev = deltaText(k.rev, pk.rev);
  const dOrd = deltaText(k.ord, pk.ord);
  const dMar = deltaText(k.margin, pk.margin);

  const setDelta = (id, d) => {
    const el = document.getElementById(id);
    el.textContent = d.text;
    el.className = `kpi-delta ${d.cls}`;
  };
  setDelta("d-revenue", dRev);
  setDelta("d-orders", dOrd);
  setDelta("d-margin", dMar);

  const byDate = {};
  const byCat = {};
  const byReg = {};
  curRows.forEach((r) => {
    byDate[r.ORDER_DATE] = (byDate[r.ORDER_DATE] || 0) + r.NET_REVENUE;
    byCat[r.CATEGORY] = (byCat[r.CATEGORY] || 0) + r.NET_REVENUE;
    byReg[r.REGION] = (byReg[r.REGION] || 0) + r.NET_REVENUE;
  });

  const sortedDates = Object.keys(byDate).sort();
  makeOrUpdateChart("chart-trend", {
    type: "line",
    data: {
      labels: sortedDates,
      datasets: [{
        label: "Net Revenue ($)",
        data: sortedDates.map((d) => Math.round(byDate[d])),
        borderColor: "#0284c7",
        backgroundColor: "rgba(2, 132, 199, 0.10)",
        fill: true,
        tension: 0.2,
        pointRadius: 0,
      }],
    },
    options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: "#475569" }, grid: { color: "rgba(15, 23, 42, 0.06)" } }, y: { ticks: { color: "#475569" }, grid: { color: "rgba(15, 23, 42, 0.06)" } } } },
  });

  const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  makeOrUpdateChart("chart-category", {
    type: "bar",
    data: {
      labels: catEntries.map((x) => x[0]),
      datasets: [{ data: catEntries.map((x) => Math.round(x[1])), backgroundColor: "#0284c7" }],
    },
    options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { color: "#475569" }, grid: { color: "rgba(15, 23, 42, 0.06)" } }, y: { ticks: { color: "#475569" }, grid: { display: false } } } },
  });

  const regEntries = Object.entries(byReg).sort((a, b) => b[1] - a[1]);
  makeOrUpdateChart("chart-region", {
    type: "bar",
    data: {
      labels: regEntries.map((x) => x[0]),
      datasets: [{ data: regEntries.map((x) => Math.round(x[1])), backgroundColor: "#059669" }],
    },
    options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { color: "#475569" }, grid: { color: "rgba(15, 23, 42, 0.06)" } }, y: { ticks: { color: "#475569" }, grid: { display: false } } } },
  });
}

function setupPruningToggle() {
  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const m = PRUNING_MODES[btn.dataset.mode];
      document.getElementById("p-partitions").textContent = m.partitions;
      document.getElementById("p-pruned").textContent = m.pruned;
      document.getElementById("p-bytes").textContent = m.bytes;
      document.getElementById("p-bytes-note").textContent = m.bytesNote;
      document.getElementById("p-time").textContent = m.time;
      document.getElementById("p-compute").textContent = m.compute;
      document.getElementById("p-depth").textContent = m.depth;
      document.getElementById("p-depth-note").textContent = m.depthNote;
      document.getElementById("p-img").src = m.img;
    });
  });
}

function renderCohort() {
  const maxM = Number(document.getElementById("cohort-months").value);
  document.getElementById("cohort-months-val").textContent = maxM;

  const filtered = state.cohort.filter((r) => r.MONTHS_SINCE_SIGNUP <= maxM);
  const cohorts = [...new Set(filtered.map((r) => r.COHORT_MONTH))].sort();
  const lookup = {};
  filtered.forEach((r) => {
    lookup[`${r.COHORT_MONTH}|${r.MONTHS_SINCE_SIGNUP}`] = r.RETENTION_RATE;
  });

  let html = "<thead><tr><th>Signup Cohort</th>";
  for (let m = 0; m <= maxM; m++) html += `<th>M${m}</th>`;
  html += "</tr></thead><tbody>";

  cohorts.forEach((c) => {
    html += `<tr><td>${c}</td>`;
    for (let m = 0; m <= maxM; m++) {
      const val = lookup[`${c}|${m}`];
      if (val === undefined) {
        html += "<td>—</td>";
      } else {
        const alpha = Math.min(0.88, Math.max(0.10, val / 45));
        const textColor = alpha >= 0.45 ? "#ffffff" : "#0f172a";
        html += `<td style="background:rgba(2,132,199,${alpha.toFixed(2)});color:${textColor}">${val.toFixed(1)}%</td>`;
      }
    }
    html += "</tr>";
  });
  html += "</tbody>";
  document.getElementById("cohort-table").innerHTML = html;
}

function initInventory() {
  const cats = [...new Set(state.inventory.map((r) => r.CATEGORY))].sort();
  const sel = document.getElementById("inv-category");
  cats.forEach((c) => sel.add(new Option(c, c)));

  const riskEl = document.getElementById("inv-risk-only");
  [sel, riskEl].forEach((el) => el.addEventListener("change", renderInventory));
  renderInventory();
}

function renderInventory() {
  const cat = document.getElementById("inv-category").value;
  const riskOnly = document.getElementById("inv-risk-only").checked;
  const rows = state.inventory.filter(
    (r) => (cat === "ALL" || r.CATEGORY === cat) && (!riskOnly || r.STOCKOUT_RISK_FLAG)
  );

  const riskCount = rows.filter((r) => r.STOCKOUT_RISK_FLAG).length;
  const avgMargin = rows.length
    ? rows.reduce((acc, r) => acc + r.UNIT_MARGIN_PCT, 0) / rows.length
    : 0;

  document.getElementById("inv-count").textContent = fmtInt(rows.length);
  document.getElementById("inv-risk").textContent = fmtInt(riskCount);
  document.getElementById("inv-margin").textContent = `${avgMargin.toFixed(1)}%`;

  const top10 = [...rows].sort((a, b) => b.TOTAL_NET_MARGIN - a.TOTAL_NET_MARGIN).slice(0, 10);
  makeOrUpdateChart("chart-top-skus", {
    type: "bar",
    data: {
      labels: top10.map((r) => r.PRODUCT_NAME),
      datasets: [{ data: top10.map((r) => Math.round(r.TOTAL_NET_MARGIN)), backgroundColor: "#059669" }],
    },
    options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { color: "#475569" }, grid: { color: "rgba(15, 23, 42, 0.06)" } }, y: { ticks: { color: "#475569" }, grid: { display: false } } } },
  });

  const bot10 = [...rows].sort((a, b) => a.UNIT_MARGIN_PCT - b.UNIT_MARGIN_PCT).slice(0, 10);
  makeOrUpdateChart("chart-bot-skus", {
    type: "bar",
    data: {
      labels: bot10.map((r) => r.PRODUCT_NAME),
      datasets: [{ data: bot10.map((r) => r.UNIT_MARGIN_PCT), backgroundColor: "#e11d48" }],
    },
    options: { indexAxis: "y", plugins: { legend: { display: false } }, scales: { x: { ticks: { color: "#475569" }, grid: { color: "rgba(15, 23, 42, 0.06)" } }, y: { ticks: { color: "#475569" }, grid: { display: false } } } },
  });

  let html = "<thead><tr><th>SKU</th><th>Product</th><th>Category</th><th>On Hand</th><th>Reorder Pt</th><th>30d Vel/Day</th><th>Margin %</th><th>Status</th></tr></thead><tbody>";
  rows.slice(0, 50).forEach((r) => {
    const badge = r.STOCKOUT_RISK_FLAG
      ? '<span class="badge-risk">At Risk</span>'
      : '<span class="badge-ok">Healthy</span>';
    html += `<tr><td><code>${r.SKU_ID}</code></td><td>${r.PRODUCT_NAME}</td><td>${r.CATEGORY}</td><td>${r.STOCK_ON_HAND}</td><td>${r.REORDER_POINT}</td><td>${r.DAILY_VELOCITY_30D}</td><td>${r.UNIT_MARGIN_PCT}%</td><td>${badge}</td></tr>`;
  });
  html += "</tbody>";
  document.getElementById("inv-table").innerHTML = html;
}

function refreshLookupChips() {
  const sampleOrd = [...new Set(state.orders.map((r) => r.ORDER_ID))].slice(0, 4);
  const sampleCust = [...new Set(state.orders.map((r) => r.CUSTOMER_ID))].slice(0, 2);
  const chips = document.getElementById("sample-chips");
  chips.innerHTML = '<span style="font-size:0.8rem;color:#52637a">Quick lookup IDs:</span>';

  sampleOrd.forEach((id) => {
    const btn = document.createElement("button");
    btn.className = "chip-btn";
    btn.textContent = id.startsWith("ORD-LIVE-") ? `● ${id}` : id;
    if (id.startsWith("ORD-LIVE-")) {
      btn.style.borderColor = "#059669";
      btn.style.color = "#059669";
    }
    btn.onclick = () => {
      document.getElementById("lookup-type").value = "ORDER_ID";
      document.getElementById("lookup-input").value = id;
      renderLookup();
    };
    chips.appendChild(btn);
  });

  sampleCust.forEach((id) => {
    const btn = document.createElement("button");
    btn.className = "chip-btn";
    btn.textContent = id;
    btn.onclick = () => {
      document.getElementById("lookup-type").value = "CUSTOMER_ID";
      document.getElementById("lookup-input").value = id;
      renderLookup();
    };
    chips.appendChild(btn);
  });

  document.getElementById("lookup-input").value = sampleOrd[0] || "";
}

function initLookup() {
  refreshLookupChips();
  document.getElementById("lookup-input").addEventListener("input", renderLookup);
  document.getElementById("lookup-type").addEventListener("change", renderLookup);
  renderLookup();
}

function renderLookup() {
  const type = document.getElementById("lookup-type").value;
  const val = document.getElementById("lookup-input").value.trim();
  const rows = val ? state.orders.filter((r) => r[type] === val) : [];

  if (!rows.length) {
    document.getElementById("lookup-table").innerHTML =
      "<tbody><tr><td style='color:#52637a'>No matching sample rows. Click one of the sample IDs above.</td></tr></tbody>";
    return;
  }

  let html = "<thead><tr><th>Order ID</th><th>Customer</th><th>Date</th><th>Status</th><th>Product</th><th>Qty</th><th>Net Revenue</th><th>Net Margin</th></tr></thead><tbody>";
  rows.forEach((r) => {
    html += `<tr><td><code>${r.ORDER_ID}</code></td><td><code>${r.CUSTOMER_ID}</code></td><td>${r.ORDER_DATE}</td><td>${r.ORDER_STATUS}</td><td>${r.PRODUCT_NAME}</td><td>${r.QUANTITY}</td><td>${fmtUSD(r.NET_REVENUE)}</td><td>${fmtUSD(r.NET_MARGIN)}</td></tr>`;
  });
  html += "</tbody>";
  document.getElementById("lookup-table").innerHTML = html;
}

async function boot() {
  setupTabs();
  setupPruningToggle();

  const [daily, cohort, inventory, orders] = await Promise.all([
    fetch("data/daily_revenue.json").then((r) => r.json()),
    fetch("data/cohort_retention.json").then((r) => r.json()),
    fetch("data/inventory_health.json").then((r) => r.json()),
    fetch("data/sample_orders.json").then((r) => r.json()),
  ]);

  state.baseDaily = daily;
  state.cohort = cohort;
  state.baseInventory = inventory;
  state.baseOrders = orders;
  applyLiveStoreOrders();

  initKpiFilters();
  document.getElementById("cohort-months").addEventListener("input", renderCohort);
  renderCohort();
  initInventory();
  initLookup();
  state.initialized = true;

  // Live cross-tab sync when orders are placed on /store
  window.addEventListener("storage", (e) => {
    if (e.key === LIVE_KEY && state.initialized) {
      applyLiveStoreOrders();
      renderKpiView();
      renderInventory();
      refreshLookupChips();
      renderLookup();
    }
  });

  const resetBtn = document.getElementById("reset-sync-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      localStorage.removeItem(LIVE_KEY);
      applyLiveStoreOrders();
      renderKpiView();
      renderInventory();
      refreshLookupChips();
      renderLookup();
    });
  }
}

boot();

