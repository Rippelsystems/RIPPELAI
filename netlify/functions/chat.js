// ============================================================
// chat.js — Netlify serverless function  (RippelAI / Rippel Matrix)
// Read-only AI layer over the Matrix Supabase data.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const VAT_RATE = 0.15;

// Business facts used by the tools (stated by Gerhard)
const PROJECT_400      = '2026 400 RLL';
const DEADLINE_400     = '2026-11-30';   // 400 RLLs to be delivered by end November 2026
const DEFAULT_PAY_DAYS = 30;             // suppliers paid 30 days after delivery (subject to QC)

const SYSTEM_PROMPT = `You are RippelAI, an internal financial and production
intelligence assistant for Rippel Effect Systems, a South African firearms
manufacturer. Your users are Fritz (CEO/MD), Siva (Finance), and Michiel
(Technical Manager). Currency is always South African Rand (ZAR). The
system is called Rippel Matrix, or "Matrix" for short.

Product lines: XRGL40, GRN40, and RLL. Projects (e.g. "2026 400 RLL",
"2026 1100 GRN") group POs and spending — a project is not the same as
a product line.

CORE GUARDRAIL (applies to every answer):
Never invent financial, project, schedule, costing or operational data.
Use only data returned by tools. Clearly distinguish actual, budget,
committed, estimated and forecast values. If information needed to answer
a question is unavailable, explicitly state what is missing rather than
guessing or estimating. Never imply a calculation was done in software if
it was not.

PRODUCT NOTES:
- RLL is a gun build. Components live in RLL Store, COTS Store, Holding
  Store. Cross-store availability from XRGL/GRN40 stores reported when relevant.
- GRN40 is a SIGHT build, not a gun. Components live in GRN40 Store, COTS
  Store (pooled), Holding Store only — never RLL/XRGL stores.
- RLL launchers do not carry sights. XRGL40 launchers carry a GRN40 sight.

KEY PROJECT AND DEADLINE:
- Project "2026 400 RLL": 400 RLL units must be DELIVERED by the end of
  November 2026 (30 Nov 2026). It is the first project and the template
  for the others. The tools report days remaining to that deadline.
- For progress, shortage, priority or "will we make the date" questions
  on this project, work from these tools together: get_rll_units_built
  (what is already complete), get_project_progress (material coverage per
  BOM line), get_rll_deadline_risk (what is not ordered, what is ordered
  but late or undated, what is stuck in a process), get_open_work_orders
  (assembly still to do). Quantities to check = 400 minus completed units.
- PRIORITISATION ORDER when recommending what to expedite:
  1) parts NOT ordered at all (nothing on order) — the longest lead time
     first; if the known lead time is longer than the days remaining the
     deadline cannot be met for that part without a shortcut;
  2) parts on order with NO committed date or an ETA AFTER 30 Nov;
  3) parts on order but only partly covering the need;
  4) parts stuck in Holding Store processes (machining, anodizing,
     external service) — chase the process step, do not raise a new PO;
  5) assembly work orders still outstanding.
  Say clearly when a lead time or committed date is missing — never
  estimate one. Say which sub-assemblies gate the final build.
- Do not claim a "% complete" for the whole gun unless a tool returned it.
  The progress tool reports material coverage per BOM line, which is not
  the same as build completion. Build time per sub-build is NOT held in
  the system, so never state a build-time estimate.

STOCK/BUILD READINESS RULES:
- "Available" = physical qty MINUS parts reserved to open Work Orders
  MINUS parts out on open Service Orders (LSO/ESO) — both already committed
  and unusable for a new build even though they may still show in stock_qty.
- "Holding Store WIP" = parts mid-process (machining, anodizing, external
  service) — not yet usable. Action: chase the process step, not a new PO.
- "On Order" = not yet received — informational only, never counts as available.
- Parent-assembly partial coverage: if a parent has some units built on the
  shelf, child parts only need to cover the parent's REMAINING gap.
- If parent fully covers the need, child shortages are not real blockers.

FINANCE / PO RULES (permanent business knowledge):
- PMS/FINANCE GRANULARITY: a single PMS PO can have multiple deliveries/
  batches (separate po_lines rows) to control stock intake timing and
  cashflow. Finance always pays and records against the PO AS A WHOLE
  (po_base) — never against one delivery line. Never compare a Finance
  payment to a single po_lines row; always aggregate PMS data to po_base
  level first, or the comparison is invalid and will show false mismatches.
- VAT: every PMS PO value EXCLUDES 15% VAT. Siva's Finance payment figures
  and all payment/cashflow PLANNING numbers include 15% VAT — that is what
  actually gets paid. ALWAYS show three figures: the amount excl. VAT, the
  VAT amount (15%), and the amount incl. VAT. Never show only one.
- PAYMENT TERMS: suppliers are paid 30 days after delivery, subject to QC
  and any rejections. There is no per-supplier payment-terms field in the
  system, so 30 days after delivery is the DEFAULT assumption — say so
  whenever you give a payment date. Dates derived this way are FORECASTS.
- RECEIPT AGEING: Finance records payments per PO, not per delivery, so
  when ageing unpaid goods the tool applies a PO's payments to its OLDEST
  deliveries first. State that assumption when you give ageing figures.
- THREE PAYABLES BUCKETS (per PO base, excl. VAT):
  received-not-paid (goods in, Finance has not paid it yet),
  paid-not-received (prepaid/deposit, goods not yet in — "limbo"),
  ordered-not-received (still to be delivered, commitment).
  Finance payments that match no PMS PO (non-PMS or UNKNOWN PO) are NOT
  counted in these buckets; they are reported separately.
- Finance payments only exist in the system from when the SharePoint sync
  started. A PO with goods received and no Finance record may have been
  paid before the sync — flag it for review, do not call it unpaid debt.
- "finance_pending" = an amount Finance has SCHEDULED for an upcoming bank
  run. It has NOT been paid yet. It is a planned outflow, not a problem.
- outcome = "AMOUNT DIFFERENCE" is usually NOT an error — it typically
  means more stock was received than the PO originally specified, so the
  invoiced amount legitimately exceeds the original PO value. Report the
  difference factually; do not call it a discrepancy by default.
- PCA vs POA reference prefix: "POA..." = normal payment for goods/stock.
  "PCA..." = a CREDIT reference — either a supplier credit note reducing
  what's owed, OR a penalty deducted because the supplier missed their
  committed delivery date. Never read a PCA as unexplained spend.
- Supplier deposits: some suppliers require an upfront deposit before
  starting a job. A deposit against a PO with no delivery yet is NORMAL,
  not a discrepancy.
- "#" mark on an invoice number: Siva marks legacy (non-PMS) POs with "#"
  — that line is excluded from sync and never reaches the reconciliation.
- outcome = "UNKNOWN PO": the sync could not match a payment to a PMS PO.
  This is a FLAG TO INVESTIGATE, not an automatic error — it may be a
  legacy PO not yet marked "#", something unrelated to current projects,
  or a genuine mapping error. Never dismiss it, never call it a confirmed
  error.
- outcome = "MATCHED": Finance and PMS agree — no action needed.
- PROJECT FINANCIALS: budgets and contract values are NOT yet loaded for
  any project (budget is R0 everywhere; the contracts and deposits tables
  are empty). Never state profit, margin or budget remaining for a project
  until a tool returns real values. Say the data has not been captured yet.

Never guess. Always call the appropriate tool. Always state currency as
R (ZAR). Be concise and direct — these are busy operational stakeholders.`;

const TOOLS = [
  {
    name: 'get_rll_shortfall',
    description: 'Genuine, actionable stock shortages preventing a build of N '
      + 'RLL units (default 1). Accounts for WO/service-order commitments, '
      + 'parent-assembly partial coverage, Holding Store WIP, on-order '
      + 'quantities, and cross-store availability. Use for RLL readiness, '
      + 'build blockers, or ordering questions.',
    input_schema: { type: 'object', properties: {
      qty: { type: 'integer', description: 'RLL units to check. Defaults to 1.' }
    }}
  },
  {
    name: 'get_grn40_shortfall',
    description: 'Genuine, actionable stock shortages preventing a build of N '
      + 'GRN40 sights (default 1). Components in GRN40 Store, COTS Store '
      + '(pooled), Holding Store. Accounts for WO/service-order commitments, '
      + 'parent-assembly partial coverage, WIP, on-order. Use for GRN40 '
      + 'readiness or what needs to be ordered.',
    input_schema: { type: 'object', properties: {
      qty: { type: 'integer', description: 'GRN40 units to check. Defaults to 1.' }
    }}
  },
  {
    name: 'get_rll_units_built',
    description: 'How many RLL units are already built/completed, from the '
      + 'Blue Card serial register, with the 400-unit target and the '
      + 'remaining quantity still to build. Use FIRST for any 2026 400 RLL '
      + 'progress question so shortages are checked against the REMAINING '
      + 'quantity, not 400.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_project_progress',
    description: 'Material coverage for the 2026 400 RLL build per BOM line: '
      + 'how much of the total need is ready, in Holding Store WIP, on order '
      + 'or still a gap, with the worst lines listed. This is material '
      + 'coverage, NOT a % complete of finished guns. Use for "how far are '
      + 'we" and "what is still short" questions on the 400 RLL project.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_rll_deadline_risk',
    description: 'Deadline-risk view for the RLL build against 30 Nov 2026: '
      + 'parts NOT ordered (with known lead time vs days remaining), parts '
      + 'on order with no committed date or an ETA after the deadline, '
      + 'partially ordered parts, and parts stuck in Holding Store '
      + 'processes. Use for "what must be prioritised/expedited", "will we '
      + 'make the date" and "what processes are outstanding". qty defaults '
      + 'to the remaining units (400 minus completed).',
    input_schema: { type: 'object', properties: {
      qty: { type: 'integer', description: 'RLL units to plan for. Defaults to remaining units to build.' }
    }}
  },
  {
    name: 'get_open_work_orders',
    description: 'Open work orders for a project (final assembly still '
      + 'outstanding) plus open service orders (external processes out at '
      + 'suppliers). Use for "what processes still need to be done" and '
      + 'assembly-status questions.',
    input_schema: { type: 'object', properties: {
      project_name: { type: 'string', description: 'Project name. Defaults to "2026 400 RLL".' }
    }}
  },
  {
    name: 'get_open_po_value',
    description: 'True cash position on open POs, aggregated per PO base and '
      + 'counting only POs that exist in the PMS: committed, already paid, '
      + 'scheduled-pending, and net still owed — excl VAT, VAT and incl VAT. '
      + 'Finance payments that match no PMS PO are reported separately, not '
      + 'subtracted. Use for PO exposure, outstanding commitments, cashflow.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_payables_summary',
    description: 'Three-bucket payables per PO base: received-not-paid, '
      + 'paid-not-received (prepaid/limbo) and ordered-not-received, with '
      + 'the biggest POs and suppliers in each bucket, all excl VAT, VAT and '
      + 'incl VAT. Optional project filter. Use for "what do we owe", '
      + '"what have we received but not paid", payables questions.',
    input_schema: { type: 'object', properties: {
      project_name: { type: 'string', description: 'Optional project name to filter by.' }
    }}
  },
  {
    name: 'get_prepaid_limbo',
    description: 'POs where Finance has paid more than has been received — '
      + 'deposits/prepayments with goods still outstanding — with supplier, '
      + 'amount, and whether the committed delivery date has passed. Use for '
      + '"what money is tied up in deposits" or "what have we paid for but '
      + 'not received".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_supplier_spend',
    description: 'Per-supplier totals: PO count, committed, received, paid, '
      + 'still outstanding, received-not-paid and prepaid, excl VAT, VAT and '
      + 'incl VAT. Optional supplier name filter (partial match). Use for '
      + '"how much have we spent with X" or "who are our biggest suppliers".',
    input_schema: { type: 'object', properties: {
      supplier: { type: 'string', description: 'Optional supplier name (partial match).' }
    }}
  },
  {
    name: 'get_receipt_ageing',
    description: 'Ageing of goods RECEIVED but not yet paid, using the actual '
      + 'delivery (receipt) dates from po_deliveries. Finance pays per PO, so '
      + 'payments are applied oldest delivery first within each PO. Shows how '
      + 'many days since receipt, what is past the 30-day term, and by '
      + 'supplier, excl VAT, VAT and incl VAT. Use for "which suppliers are '
      + 'we late paying", "what is overdue for payment", "ageing of '
      + 'creditors".',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_payment_schedule',
    description: 'FORECAST cash required for supplier payments, using the '
      + 'default term of 30 days after delivery: amounts already received '
      + 'but not paid, forecast payments by month for deliveries still to '
      + 'come (net of any prepaid deposit), and late deliveries whose '
      + 'payment date cannot be forecast, with the supplier named. Use for '
      + 'cashflow planning and "which suppliers are late" questions.',
    input_schema: { type: 'object', properties: {
      days: { type: 'integer', description: 'Days ahead for the near-term window. Defaults to 30.' }
    }}
  },
  {
    name: 'get_po_reconciliation_summary',
    description: 'Summary of PMS-vs-Finance PO reconciliation: count and total '
      + 'value per outcome category (MATCHED, AMOUNT DIFFERENCE, UNKNOWN PO, '
      + 'NOT YET PAID PER FINANCE). Use for overall reconciliation health or '
      + '"do our numbers match Finance" questions.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_po_reconciliation_issues',
    description: 'Detailed list of POs needing attention in the Finance '
      + 'reconciliation, filtered by outcome category. Includes supplier, '
      + 'difference amount, credit notes, and finance documents per line. '
      + 'Use when asked to list, investigate, or explain specific '
      + 'reconciliation problems (not just the summary count).',
    input_schema: { type: 'object', properties: {
      outcome_filter: {
        type: 'string',
        description: 'One of: AMOUNT DIFFERENCE, UNKNOWN PO, NOT YET PAID PER FINANCE, MATCHED. Omit to return all non-MATCHED issues.'
      }
    }}
  },
  {
    name: 'get_project_financial_summary',
    description: 'Financial summary for a named project: approved budget, '
      + 'total ordered, total received, total committed (incl. any '
      + 'over-receipt), remaining budget, and % of budget consumed. Also '
      + 'breaks committed value down by product. Use for project financial '
      + 'health, cost-to-complete, or budget-vs-actual questions.',
    input_schema: { type: 'object', properties: {
      project_name: {
        type: 'string',
        description: 'Exact project name/code as used in the PMS, e.g. "2026 400 RLL", "2026 1100 GRN". Required.'
      }
    }, required: ['project_name'] }
  },
  {
    name: 'list_projects',
    description: 'Returns all project names/codes currently in the system, '
      + 'with their budget and status. Use when the user asks what projects '
      + 'exist, or names a project ambiguously and you need to find the '
      + 'exact project_name to pass to get_project_financial_summary.',
    input_schema: { type: 'object', properties: {} }
  }
];

// ── Helpers ─────────────────────────────────────────────────────────────────

const num = v => Number(v) || 0;
const r2  = v => Math.round((v + Number.EPSILON) * 100) / 100;

// Three-figure VAT presentation: excl, VAT, incl
function vat3(excl) {
  const e = num(excl);
  return { excl_vat_zar: r2(e), vat_zar: r2(e * VAT_RATE), incl_vat_zar: r2(e * (1 + VAT_RATE)) };
}

// Supabase returns max ~1000 rows per request — page through everything.
async function fetchAll(table, cols, opts = {}) {
  const out = [];
  const size = 1000;
  for (let from = 0; from < 50000; from += size) {
    let q = supabase.from(table).select(cols).range(from, from + size - 1);
    if (opts.order) q = q.order(opts.order, { ascending: true });
    if (opts.mod)   q = opts.mod(q);
    const { data, error } = await q;
    if (error) return { error: `Query on ${table} failed: ${error.message}` };
    out.push(...data);
    if (data.length < size) break;
  }
  return { data: out };
}

function pick(row, keys) {
  const o = {};
  for (const k of keys) if (row[k] !== undefined && row[k] !== null) o[k] = row[k];
  return o;
}

function daysUntil(isoDate) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(isoDate + 'T00:00:00');
  return Math.round((d - today) / 86400000);
}

// ── Shared BOM shortfall logic (unchanged behaviour) ────────────────────────

function buildShortfallResult(allRows, qty, needCol) {
  const scaledRows = allRows.map(row => ({
    ...row,
    scaled_need: (row[needCol] || 0) * qty
  }));
  const byId = {};
  for (const row of scaledRows) if (row.component_id) byId[row.component_id] = row;

  function effectiveNeed(row) {
    const parent = row.dependant_code ? byId[row.dependant_code] : null;
    if (!parent) return row.scaled_need;
    if (parent.available_qty >= parent.scaled_need) return 0;
    return Math.max(0, parent.scaled_need - parent.available_qty) * row.req_per_unit;
  }

  return scaledRows
    .filter(row => {
      if (row.build_status === 'CONTAINER') return false;
      const parent = row.dependant_code ? byId[row.dependant_code] : null;
      if (parent && parent.available_qty >= parent.scaled_need) return false;
      const need = effectiveNeed(row);
      return Math.max(0, need - row.available_qty - row.holding_qty - row.on_order_qty) > 0;
    })
    .map(r => {
      const need = effectiveNeed(r);
      const needsSourcing = Math.max(0, need - r.available_qty - r.holding_qty - r.on_order_qty);
      const out = {
        item_name: r.item_name, stock_code: r.stock_code, storeroom: r.storeroom,
        available: r.available_qty, holding_wip: r.holding_qty, on_order: r.on_order_qty,
        supplier_eta: r.supplier_earliest_eta, needed: need, needs_sourcing: needsSourcing,
      };
      if ((r.wo_committed_qty || 0) > 0) out.wo_committed = r.wo_committed_qty;
      if ((r.so_committed_qty || 0) > 0) out.so_committed = r.so_committed_qty;
      return out;
    });
}

// Same effective-need logic, but returns every non-container row with its need
function computeNeeds(allRows, qty, needCol) {
  const scaled = allRows.map(row => ({ ...row, scaled_need: (row[needCol] || 0) * qty }));
  const byId = {};
  for (const row of scaled) if (row.component_id) byId[row.component_id] = row;
  const out = [];
  for (const row of scaled) {
    if (row.build_status === 'CONTAINER') continue;
    const parent = row.dependant_code ? byId[row.dependant_code] : null;
    let need;
    if (!parent) need = row.scaled_need;
    else if (parent.available_qty >= parent.scaled_need) need = 0;
    else need = Math.max(0, parent.scaled_need - parent.available_qty) * row.req_per_unit;
    out.push({ row, need });
  }
  return out;
}

async function getCrossStoreMap() {
  const { data } = await supabase
    .from('stock_items').select('stock_code, stock_qty, storeroom')
    .in('storeroom', ['XRGL Store', 'GRN40 Store', 'RLL Legacy Store']).gt('stock_qty', 0);
  const map = {};
  for (const row of (data || [])) {
    const code = row.stock_code ? row.stock_code.split('_')[0] : '';
    if (code) map[code] = (map[code] || 0) + row.stock_qty;
  }
  return map;
}

const RLL_READINESS_COLS =
  'component_id, dependant_code, item_name, stock_code, storeroom, '
  + 'available_qty, wo_committed_qty, so_committed_qty, holding_qty, '
  + 'on_order_qty, supplier_earliest_eta, need_for_1_rll, req_per_unit, '
  + 'shortfall, build_status, is_assembly_group';

// ── Stock tools ──────────────────────────────────────────────────────────────

async function get_rll_shortfall(qty = 1) {
  const { data: allRows, error } = await supabase
    .from('v_rll_build_readiness').select(RLL_READINESS_COLS);
  if (error) return { error: `Query failed: ${error.message}` };

  const crossStoreMap = await getCrossStoreMap();

  const shortages = buildShortfallResult(allRows, qty, 'need_for_1_rll').map(r => {
    const crossStore = crossStoreMap[r.stock_code] || 0;
    return {
      ...r,
      other_store_stock: crossStore || undefined,
      other_store_note: crossStore >= r.needs_sourcing && crossStore > 0
        ? 'Fully covered by other product store stock — management transfer required'
        : crossStore > 0
          ? `${crossStore} available in other product stores — partial cover, transfer required`
          : undefined
    };
  });

  return { product: 'RLL', build_qty: qty, total_shortages: shortages.length, shortages };
}

async function get_grn40_shortfall(qty = 1) {
  const { data: allRows, error } = await supabase
    .from('v_grn40_build_readiness')
    .select('component_id, dependant_code, item_name, stock_code, storeroom, '
          + 'available_qty, wo_committed_qty, so_committed_qty, holding_qty, '
          + 'on_order_qty, supplier_earliest_eta, need_for_1_grn40, req_per_unit, '
          + 'shortfall, build_status, is_assembly_group');
  if (error) return { error: `Query failed: ${error.message}` };
  const shortages = buildShortfallResult(allRows, qty, 'need_for_1_grn40');
  return { product: 'GRN40', build_qty: qty, total_shortages: shortages.length, shortages };
}

// ── 2026 400 RLL project tools ──────────────────────────────────────────────

async function get_rll_units_built() {
  const { data: proj } = await supabase
    .from('projects').select('project_name, target_qty, status, end_date')
    .eq('project_name', PROJECT_400).limit(1);
  const target = proj && proj[0] ? num(proj[0].target_qty) : 0;

  const { data, error } = await supabase
    .from('weapon_serials').select('*').eq('card_type', 'RLL').limit(5000);
  if (error) {
    return { target_qty: target || null, error: `Could not read the serial register: ${error.message}` };
  }
  if (!data || data.length === 0) {
    return {
      target_qty: target || null,
      note: 'No RLL rows came back from the serial register. Either none exist, or the table has no read policy for the bot (RLS returns zero rows silently). Built count unknown.'
    };
  }

  const statusKey = ['status', 'build_status', 'state'].find(k => k in data[0]);
  if (!statusKey) {
    return {
      target_qty: target || null, serials_in_register: data.length,
      note: 'The serial register has no recognisable status column, so the built count cannot be determined.',
      columns_found: Object.keys(data[0])
    };
  }

  const byStatus = {};
  for (const r of data) {
    const s = String(r[statusKey] ?? 'BLANK').toUpperCase();
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  const doneRe = /(COMPLETE|RELEASED|SHIPPED|DELIVERED|DONE|PASSED|FINISHED)/;
  let completed = 0, inProgress = 0, unbuilt = 0;
  for (const [s, n] of Object.entries(byStatus)) {
    if (s === 'UNBUILT') unbuilt += n;
    else if (doneRe.test(s)) completed += n;
    else inProgress += n;
  }

  return {
    project: PROJECT_400,
    target_qty: target || null,
    serials_in_register: data.length,
    status_column: statusKey,
    counts_by_status: byStatus,
    completed_units: completed,
    in_progress_units: inProgress,
    unbuilt_units: unbuilt,
    remaining_to_build: target ? Math.max(0, target - completed) : null,
    days_to_deadline: daysUntil(DEADLINE_400),
    deadline: DEADLINE_400,
    note: 'completed_units counts statuses that look like COMPLETE/RELEASED/SHIPPED/DELIVERED/DONE/PASSED. Check counts_by_status if the labels differ. This is the serial register for card type RLL (one contract: 400 units).'
  };
}

async function get_project_progress() {
  const { data: proj } = await supabase
    .from('projects').select('project_name, target_qty, status, start_date, end_date, manager')
    .eq('project_name', PROJECT_400).limit(1);

  const prog = await fetchAll('v_rll_build_progress', '*');
  if (prog.error) return { error: prog.error };
  const rows = prog.data;
  if (rows.length === 0) return { error: 'v_rll_build_progress returned no rows.' };

  const colsFound = Object.keys(rows[0]);
  const idKeys = ['item_name', 'stock_code', 'storeroom', 'supplier_earliest_eta'];
  const bands = ['need_total', 'band_ready', 'band_wip', 'band_on_order', 'band_gap'];
  const missing = bands.filter(k => !(k in rows[0]));
  if (missing.length) {
    return { error: `Progress view is missing expected columns: ${missing.join(', ')}`, columns_found: colsFound };
  }

  const lines = rows.filter(r => num(r.need_total) > 0);
  const fullyReady = lines.filter(r => num(r.band_ready) >= num(r.need_total)).length;
  const withGap    = lines.filter(r => num(r.band_gap) > 0);
  const withWip    = lines.filter(r => num(r.band_wip) > 0);
  const onOrder    = lines.filter(r => num(r.band_on_order) > 0);
  const pctReadyAvg = lines.length
    ? r2(lines.reduce((s, r) => s + Math.min(1, num(r.band_ready) / num(r.need_total)), 0) / lines.length * 100)
    : null;
  const pctSecuredAvg = lines.length
    ? r2(lines.reduce((s, r) =>
        s + Math.min(1, (num(r.band_ready) + num(r.band_wip) + num(r.band_on_order)) / num(r.need_total)), 0)
        / lines.length * 100)
    : null;

  const worst = withGap
    .sort((a, b) => num(b.band_gap) - num(a.band_gap))
    .slice(0, 40)
    .map(r => ({ ...pick(r, idKeys), need_total: num(r.need_total), ready: num(r.band_ready),
                 wip: num(r.band_wip), on_order: num(r.band_on_order), gap: num(r.band_gap),
                 eta_overdue: r.eta_overdue ?? undefined }));

  return {
    project: PROJECT_400,
    target_qty: proj && proj[0] ? proj[0].target_qty : null,
    deadline: DEADLINE_400,
    days_to_deadline: daysUntil(DEADLINE_400),
    bom_lines_checked: lines.length,
    lines_fully_ready: fullyReady,
    lines_with_gap_not_ordered: withGap.length,
    lines_with_holding_wip: withWip.length,
    lines_with_open_orders: onOrder.length,
    average_line_pct_ready: pctReadyAvg,
    average_line_pct_secured_incl_wip_and_on_order: pctSecuredAvg,
    eta_overdue_lines: lines.filter(r => r.eta_overdue === true).length,
    largest_gaps: worst,
    note: 'This is MATERIAL COVERAGE per BOM line (ready / in Holding Store process / on order / gap), not a % complete of finished guns. Build time per sub-build is not held in the system. Lines unlinked in the BOM tree are invisible here.'
  };
}

async function get_rll_deadline_risk(qtyArg) {
  const built = await get_rll_units_built();
  let qty = qtyArg;
  let qtyBasis = 'qty supplied by caller';
  if (!qty) {
    if (built && built.remaining_to_build != null) {
      qty = built.remaining_to_build;
      qtyBasis = `remaining = target ${built.target_qty} minus ${built.completed_units} completed`;
    } else {
      qty = (built && built.target_qty) || 400;
      qtyBasis = 'completed-unit count unavailable, so the full target was used — shortages may be overstated';
    }
  }

  const { data: allRows, error } = await supabase
    .from('v_rll_build_readiness').select(RLL_READINESS_COLS);
  if (error) return { error: `Query failed: ${error.message}` };

  const crossStoreMap = await getCrossStoreMap();

  const { data: ltData } = await supabase
    .from('part_lead_times').select('stock_code, item_name, supplier, lead_days').limit(5000);
  const leadMap = {};
  for (const l of (ltData || [])) if (l.stock_code) leadMap[l.stock_code] = l;

  const daysLeft = daysUntil(DEADLINE_400);
  const needs = computeNeeds(allRows, qty, 'need_for_1_rll');

  const notOrdered = [], partlyOrdered = [], onOrderRisk = [], wipToChase = [];

  for (const { row: r, need } of needs) {
    if (need <= 0) continue;
    const avail = num(r.available_qty), hold = num(r.holding_qty), oo = num(r.on_order_qty);
    const gapAfterStockAndWip = Math.max(0, need - avail - hold);
    const base = { item_name: r.item_name, stock_code: r.stock_code, storeroom: r.storeroom, needed: need };

    // Process-stuck: Holding Store WIP is what bridges the gap
    if (hold > 0 && need - avail > 0) {
      wipToChase.push({ ...base, available: avail, in_holding_process: hold,
        action: 'Chase the process step (machining/anodize/external service) — no new PO' });
    }

    if (gapAfterStockAndWip <= 0) continue;
    const eta = r.supplier_earliest_eta ? String(r.supplier_earliest_eta).slice(0, 10) : null;
    const lt  = leadMap[r.stock_code] || leadMap[(r.stock_code || '').split('_')[0]];
    const cross = crossStoreMap[(r.stock_code || '').split('_')[0]] || 0;
    const uncovered = Math.max(0, gapAfterStockAndWip - oo);

    if (oo === 0) {
      notOrdered.push({ ...base, available: avail, short_by: gapAfterStockAndWip,
        lead_days: lt ? lt.lead_days : null,
        lead_time_supplier: lt ? lt.supplier : null,
        cannot_meet_deadline_if_ordered_today: lt && lt.lead_days != null ? lt.lead_days > daysLeft : undefined,
        lead_time_missing: lt ? undefined : true,
        other_store_stock: cross || undefined });
    } else if (uncovered > 0) {
      partlyOrdered.push({ ...base, available: avail, on_order: oo, still_to_order: uncovered,
        supplier_eta: eta, eta_after_deadline: eta ? eta > DEADLINE_400 : undefined,
        other_store_stock: cross || undefined });
    } else {
      // Fully covered by the order, but is the date safe?
      let risk = null;
      if (!eta) risk = 'NO COMMITTED DATE';
      else if (eta > DEADLINE_400) risk = 'ETA AFTER DEADLINE';
      else if (daysUntil(eta) < 0) risk = 'ETA ALREADY PASSED — LATE';
      else if (daysLeft - daysUntil(eta) < 14) risk = 'TIGHT — less than 14 days before the deadline';
      if (risk) onOrderRisk.push({ ...base, available: avail, on_order: oo, supplier_eta: eta, risk });
    }
  }

  const byGap = (a, b) => (b.short_by || b.still_to_order || 0) - (a.short_by || a.still_to_order || 0);
  const byLead = (a, b) => (b.lead_days ?? -1) - (a.lead_days ?? -1);

  return {
    project: PROJECT_400,
    deadline: DEADLINE_400,
    days_remaining: daysLeft,
    quantity_planned_for: qty,
    quantity_basis: qtyBasis,
    units_completed: built && built.completed_units != null ? built.completed_units : null,
    summary: {
      not_ordered_parts: notOrdered.length,
      partly_ordered_parts: partlyOrdered.length,
      on_order_but_date_risk: onOrderRisk.length,
      parts_in_holding_processes: wipToChase.length,
      not_ordered_with_no_lead_time_on_file: notOrdered.filter(x => x.lead_time_missing).length,
    },
    not_ordered: notOrdered.sort(byLead).slice(0, 40),
    partly_ordered: partlyOrdered.sort(byGap).slice(0, 40),
    on_order_date_risk: onOrderRisk.slice(0, 40),
    holding_store_processes_to_chase: wipToChase.slice(0, 40),
    notes: [
      'Lead times come from part_lead_times, which is only partly filled (GRN40 entries by Lodewikus). A missing lead time is shown as lead_time_missing, never estimated.',
      'Parts fully covered by other product stores (other_store_stock) need a management transfer, not a PO.',
      'Raw material is not included. Seven RLL BOM parts that are unlinked in the BOM tree are invisible here.',
    ]
  };
}

async function get_open_work_orders(projectName) {
  const project = projectName || PROJECT_400;
  const closedRe = /^(complete|completed|closed|cancelled|canceled)$/i;

  const out = { project };

  const wo = await supabase.from('work_orders').select('*').eq('customer', project).limit(1000);
  if (wo.error) {
    out.work_orders = { error: `Could not read work_orders: ${wo.error.message}` };
  } else {
    const rows = wo.data || [];
    const statusKey = rows[0] && ['status', 'wo_status'].find(k => k in rows[0]);
    const open = statusKey ? rows.filter(r => !closedRe.test(String(r[statusKey] || '').trim())) : rows;
    out.work_orders = {
      total_rows: rows.length,
      open_count: open.length,
      status_column: statusKey || 'none found — all rows returned',
      rows: open.slice(0, 60).map(r => {
        const o = {};
        for (const [k, v] of Object.entries(r)) {
          if (v !== null && v !== '' && !/(^id$|_at$|created|updated)/i.test(k)) o[k] = typeof v === 'string' ? v.slice(0, 80) : v;
        }
        return o;
      }),
      note: rows.length === 0
        ? 'No rows returned. Either there are no work orders for this project, or the bot has no read access to work_orders (RLS returns zero rows silently).'
        : '"Partially Complete" means parts are fully issued but assembly work is still outstanding.'
    };
  }

  const so = await supabase.from('service_orders').select('*').limit(1000);
  if (so.error) {
    out.service_orders = { error: `Could not read service_orders: ${so.error.message}` };
  } else {
    const rows = so.data || [];
    const statusKey = rows[0] && ['status', 'so_status'].find(k => k in rows[0]);
    const open = statusKey ? rows.filter(r => !closedRe.test(String(r[statusKey] || '').trim())) : rows;
    out.service_orders = {
      total_rows: rows.length,
      open_count: open.length,
      status_column: statusKey || 'none found — all rows returned',
      rows: open.slice(0, 60).map(r => {
        const o = {};
        for (const [k, v] of Object.entries(r)) {
          if (v !== null && v !== '' && !/(^id$|_at$|created|updated)/i.test(k)) o[k] = typeof v === 'string' ? v.slice(0, 80) : v;
        }
        return o;
      }),
      note: 'Service orders are not filtered by project (no project link confirmed) — all open ones are shown.'
    };
  }
  return out;
}

// ── Finance / PO tools ───────────────────────────────────────────────────────

const PAYABLES_COLS =
  'po_base, supplier, project, po_type, line_count, open_lines, next_committed_date, '
  + 'received_excl, outstanding_excl, committed_excl, finance_paid_excl, finance_pending, '
  + 'recon_outcome, has_finance_record, received_not_paid_excl, paid_not_received_excl, '
  + 'ordered_not_received_excl';

async function loadPayables(projectName) {
  const res = await fetchAll('v_po_payables', PAYABLES_COLS, {
    order: 'po_base',
    mod: projectName ? q => q.ilike('project', projectName) : null
  });
  return res;
}

async function get_open_po_value() {
  const pay = await loadPayables();
  if (pay.error) return { error: pay.error };
  const rows = pay.data;

  const sum = f => rows.reduce((s, r) => s + num(r[f]), 0);
  const committed = sum('committed_excl');
  const paid      = sum('finance_paid_excl');
  const pending   = sum('finance_pending');
  // per-PO still owed: an overpaid PO must not offset another PO's debt
  const stillOwed = rows.reduce((s, r) => s + Math.max(0, num(r.committed_excl) - num(r.finance_paid_excl)), 0);
  const overpaid  = rows.reduce((s, r) => s + Math.max(0, num(r.finance_paid_excl) - num(r.committed_excl)), 0);

  // Finance payments that match no PMS PO — reported, never subtracted
  const rec = await fetchAll('v_finance_po_reconciliation', 'po_base, finance_net_paid_excl, outcome',
    { order: 'po_base', mod: q => q.eq('outcome', 'UNKNOWN PO') });

  return {
    basis: 'Aggregated per PO base, PMS POs only. Committed = greater of ordered and received. Finance paid = payments matched to those POs.',
    pms_pos_counted: rows.length,
    gross_committed: vat3(committed),
    already_paid_per_finance: vat3(paid),
    scheduled_pending_not_yet_paid: vat3(pending),
    net_still_owed: vat3(stillOwed),
    overpaid_pos_value: vat3(overpaid),
    finance_payments_not_matched_to_a_pms_po: rec.error
      ? { error: rec.error }
      : { count: rec.data.length, ...vat3(rec.data.reduce((s, r) => s + num(r.finance_net_paid_excl), 0)),
          note: 'UNKNOWN PO — legacy, unrelated, or a mapping error. EXCLUDED from the figures above; needs review.' },
    caveat: 'Payments made before the Finance sync started are not in the system, so older fully-delivered POs without a Finance record can make net_still_owed look higher than reality.',
    vat_note: 'PMS figures exclude 15% VAT; payment planning must use incl_vat_zar.'
  };
}

async function get_payables_summary(projectName) {
  const pay = await loadPayables(projectName);
  if (pay.error) return { error: pay.error };
  const rows = pay.data;
  if (rows.length === 0) {
    return { error: projectName
      ? `No POs found for project "${projectName}". Use list_projects for valid names.`
      : 'No PO data returned.' };
  }

  const sum = (arr, f) => arr.reduce((s, r) => s + num(r[f]), 0);
  const rnp = rows.filter(r => num(r.received_not_paid_excl) > 1);
  const pnr = rows.filter(r => num(r.paid_not_received_excl) > 1);
  const onr = rows.filter(r => num(r.ordered_not_received_excl) > 1);

  const topPOs = (arr, f) => arr
    .sort((a, b) => num(b[f]) - num(a[f])).slice(0, 15)
    .map(r => ({ po_base: r.po_base, supplier: r.supplier, project: r.project,
      excl_vat_zar: r2(num(r[f])), incl_vat_zar: r2(num(r[f]) * (1 + VAT_RATE)),
      has_finance_record: r.has_finance_record, recon_outcome: r.recon_outcome || undefined }));

  const bySupplier = (arr, f) => {
    const m = {};
    for (const r of arr) {
      const k = r.supplier || 'Unknown supplier';
      if (!m[k]) m[k] = { supplier: k, po_count: 0, excl_vat_zar: 0 };
      m[k].po_count++; m[k].excl_vat_zar += num(r[f]);
    }
    return Object.values(m).sort((a, b) => b.excl_vat_zar - a.excl_vat_zar).slice(0, 12)
      .map(s => ({ ...s, excl_vat_zar: r2(s.excl_vat_zar), incl_vat_zar: r2(s.excl_vat_zar * (1 + VAT_RATE)) }));
  };

  const noFin = rnp.filter(r => !r.has_finance_record);

  return {
    project_filter: projectName || 'all projects',
    pos_counted: rows.length,
    basis: 'Per PO base, PMS POs only, all values excl. 15% VAT unless shown. Receipt dates are not in this view, so received-not-paid cannot be aged; default term is 30 days after delivery.',
    received_not_paid: {
      po_count: rnp.length, ...vat3(sum(rnp, 'received_not_paid_excl')),
      of_which_no_finance_record_at_all: { po_count: noFin.length, ...vat3(sum(noFin, 'received_not_paid_excl')),
        note: 'May have been paid before the Finance sync started — verify with Siva, do not treat as confirmed debt.' },
      scheduled_by_finance_not_yet_paid: vat3(sum(rnp, 'finance_pending')),
      largest_pos: topPOs(rnp, 'received_not_paid_excl'),
      by_supplier: bySupplier(rnp, 'received_not_paid_excl'),
    },
    paid_not_received_prepaid_limbo: {
      po_count: pnr.length, ...vat3(sum(pnr, 'paid_not_received_excl')),
      largest_pos: topPOs(pnr, 'paid_not_received_excl'),
      note: 'Deposits/prepayments are normal; late ones need chasing.'
    },
    ordered_not_received: {
      po_count: onr.length, ...vat3(sum(onr, 'ordered_not_received_excl')),
      largest_pos: topPOs(onr, 'ordered_not_received_excl'),
      by_supplier: bySupplier(onr, 'ordered_not_received_excl'),
    }
  };
}

async function get_prepaid_limbo() {
  const pay = await loadPayables();
  if (pay.error) return { error: pay.error };
  const today = new Date().toISOString().slice(0, 10);
  const rows = pay.data.filter(r => num(r.paid_not_received_excl) > 1)
    .sort((a, b) => num(b.paid_not_received_excl) - num(a.paid_not_received_excl));

  const list = rows.slice(0, 40).map(r => ({
    po_base: r.po_base, supplier: r.supplier, project: r.project,
    paid_excl_vat_zar: r2(num(r.finance_paid_excl)),
    received_excl_vat_zar: r2(num(r.received_excl)),
    prepaid_not_yet_delivered_excl_vat_zar: r2(num(r.paid_not_received_excl)),
    prepaid_incl_vat_zar: r2(num(r.paid_not_received_excl) * (1 + VAT_RATE)),
    open_lines: r.open_lines,
    next_committed_date: r.next_committed_date || null,
    delivery_date_passed: r.next_committed_date ? r.next_committed_date < today : undefined,
    no_committed_date: r.open_lines > 0 && !r.next_committed_date ? true : undefined,
  }));

  const late = rows.filter(r => r.next_committed_date && r.next_committed_date < today);
  return {
    po_count: rows.length,
    total_prepaid_not_received: vat3(rows.reduce((s, r) => s + num(r.paid_not_received_excl), 0)),
    of_which_delivery_date_already_passed: { po_count: late.length,
      ...vat3(late.reduce((s, r) => s + num(r.paid_not_received_excl), 0)) },
    largest: list,
    note: 'Paid per Finance exceeds goods received per PMS. A deposit before delivery is normal; POs with a passed delivery date are the ones to chase. If paid is well above even the PO commitment, check for a mapping error.'
  };
}

async function get_supplier_spend(supplierName) {
  const pay = await loadPayables();
  if (pay.error) return { error: pay.error };
  let rows = pay.data;
  if (supplierName) {
    const t = supplierName.toLowerCase();
    rows = rows.filter(r => (r.supplier || '').toLowerCase().includes(t));
    if (rows.length === 0) return { error: `No supplier matching "${supplierName}" found on PMS POs.` };
  }

  const m = {};
  for (const r of rows) {
    const k = r.supplier || 'Unknown supplier';
    if (!m[k]) m[k] = { supplier: k, po_count: 0, committed: 0, received: 0, paid: 0, outstanding: 0, rnp: 0, prepaid: 0 };
    const s = m[k];
    s.po_count++;
    s.committed += num(r.committed_excl); s.received += num(r.received_excl);
    s.paid += num(r.finance_paid_excl);   s.outstanding += num(r.outstanding_excl);
    s.rnp += num(r.received_not_paid_excl); s.prepaid += num(r.paid_not_received_excl);
  }
  const list = Object.values(m).sort((a, b) => b.committed - a.committed).slice(0, supplierName ? 20 : 25)
    .map(s => ({
      supplier: s.supplier, po_count: s.po_count,
      committed: vat3(s.committed), received: vat3(s.received), paid_per_finance: vat3(s.paid),
      ordered_not_received: vat3(s.outstanding),
      received_not_paid: vat3(s.rnp), prepaid_not_received: vat3(s.prepaid),
    }));

  const out = {
    filter: supplierName || 'all suppliers (top by committed value)',
    suppliers: list,
    caveat: 'PMS POs only, aggregated per PO base. Payments before the Finance sync started and non-PMS payments are not included.'
  };
  if (supplierName) {
    out.pos = rows.sort((a, b) => num(b.committed_excl) - num(a.committed_excl)).slice(0, 25).map(r => ({
      po_base: r.po_base, project: r.project, committed_excl_zar: r2(num(r.committed_excl)),
      received_excl_zar: r2(num(r.received_excl)), paid_excl_zar: r2(num(r.finance_paid_excl)),
      outstanding_excl_zar: r2(num(r.outstanding_excl)), recon_outcome: r.recon_outcome || undefined,
    }));
  }
  return out;
}

// Ageing of received-but-unpaid goods. Finance pays per PO, so we apply the
// PO's total Finance payments to its deliveries OLDEST FIRST (an assumption,
// stated in the output) and age whatever is left from the receipt date.
async function get_receipt_ageing() {
  let del = await fetchAll('po_deliveries', '*', { order: 'id' });
  if (del.error) del = await fetchAll('po_deliveries', '*');
  if (del.error) return { error: del.error };
  const dRows = del.data;
  if (dRows.length === 0) {
    return { error: 'po_deliveries returned no rows — either empty or the bot has no read access (RLS returns zero rows silently).' };
  }

  const cols = Object.keys(dRows[0]);
  const poKey   = ['po_number', 'po_ref', 'po_line', 'po'].find(k => cols.includes(k));
  const dateKey = ['delivery_date', 'received_date', 'date_received', 'receipt_date', 'arrival_date', 'created_at'].find(k => cols.includes(k));
  const qtyKey  = ['qty_received', 'qty_delivered', 'qty', 'quantity', 'delivered_qty'].find(k => cols.includes(k));
  if (!poKey || !dateKey || !qtyKey) {
    return {
      error: 'Could not identify the PO, date and quantity columns in po_deliveries.',
      columns_found: cols,
      detected: { po: poKey || null, date: dateKey || null, qty: qtyKey || null }
    };
  }

  const lines = await fetchAll('po_lines', 'po_number, unit_price', { order: 'po_number' });
  if (lines.error) return { error: lines.error };
  const price = {};
  const priceByBase = {};
  for (const l of lines.data) {
    if (l.po_number && price[l.po_number] === undefined) price[l.po_number] = num(l.unit_price);
    const b = String(l.po_number || '').split('/')[0];
    if (b && priceByBase[b] === undefined) priceByBase[b] = num(l.unit_price);
  }

  const pay = await loadPayables();
  if (pay.error) return { error: pay.error };
  const payMap = {};
  for (const r of pay.data) payMap[r.po_base] = r;

  // Group deliveries by PO base
  const byBase = {};
  let unvalued = 0, undated = 0;
  for (const d of dRows) {
    const po = String(d[poKey] || '');
    const base = po.split('/')[0];
    if (!base) continue;
    const qty = num(d[qtyKey]);
    if (qty <= 0) continue;
    const unit = price[po] !== undefined ? price[po] : priceByBase[base];
    if (unit === undefined) { unvalued++; continue; }
    const dt = d[dateKey] ? String(d[dateKey]).slice(0, 10) : null;
    if (!dt) { undated++; continue; }
    (byBase[base] = byBase[base] || []).push({ date: dt, value: qty * unit });
  }

  const today = new Date().toISOString().slice(0, 10);
  const ageDays = dt => Math.round((new Date(today) - new Date(dt)) / 86400000);

  const buckets = { '0-30 days (not yet due)': 0, '31-60 days': 0, '61-90 days': 0, 'over 90 days': 0 };
  const unpaidPOs = [];
  const bySupplier = {};
  let noFinTotal = 0, noFinCount = 0;

  for (const [base, arr] of Object.entries(byBase)) {
    const meta = payMap[base];
    if (!meta) continue; // not a PMS PO in the payables view
    arr.sort((a, b) => a.date.localeCompare(b.date));
    let paid = num(meta.finance_paid_excl);
    const open = [];
    for (const x of arr) {
      if (paid >= x.value - 0.01) { paid -= x.value; continue; }
      open.push({ date: x.date, value: x.value - paid });
      paid = 0;
    }
    if (open.length === 0) continue;
    const openTotal = open.reduce((s, x) => s + x.value, 0);

    if (!meta.has_finance_record) { noFinTotal += openTotal; noFinCount++; continue; }

    const oldest = open[0].date;
    let overdue = 0;
    for (const x of open) {
      const a = ageDays(x.date);
      if (a <= 30) buckets['0-30 days (not yet due)'] += x.value;
      else if (a <= 60) buckets['31-60 days'] += x.value;
      else if (a <= 90) buckets['61-90 days'] += x.value;
      else buckets['over 90 days'] += x.value;
      if (a > 30) overdue += x.value;
    }
    unpaidPOs.push({ po_base: base, supplier: meta.supplier, project: meta.project,
      unpaid_received_excl: openTotal, overdue_excl: overdue,
      oldest_receipt: oldest, days_since_oldest_receipt: ageDays(oldest),
      finance_scheduled_pending: num(meta.finance_pending) });
    const k = meta.supplier || 'Unknown supplier';
    if (!bySupplier[k]) bySupplier[k] = { supplier: k, po_count: 0, unpaid: 0, overdue: 0, oldest: oldest };
    bySupplier[k].po_count++; bySupplier[k].unpaid += openTotal; bySupplier[k].overdue += overdue;
    if (oldest < bySupplier[k].oldest) bySupplier[k].oldest = oldest;
  }

  const totUnpaid  = unpaidPOs.reduce((s, r) => s + r.unpaid_received_excl, 0);
  const totOverdue = unpaidPOs.reduce((s, r) => s + r.overdue_excl, 0);

  return {
    basis: 'Receipt dates from po_deliveries; PO-level Finance payments applied to the OLDEST deliveries first (Finance does not record which delivery a payment covers, so this is an assumption). Term = 30 days after receipt, subject to QC and rejections — QC status is not considered here.',
    columns_used: { po: poKey, date: dateKey, qty: qtyKey },
    received_unpaid_with_finance_record: { po_count: unpaidPOs.length, ...vat3(totUnpaid) },
    past_30_day_term: vat3(totOverdue),
    ageing_buckets: Object.entries(buckets).map(([bucket, v]) => ({ bucket, ...vat3(v) })),
    by_supplier_overdue_first: Object.values(bySupplier).sort((a, b) => b.overdue - a.overdue).slice(0, 15).map(s => ({
      supplier: s.supplier, po_count: s.po_count, oldest_receipt: s.oldest,
      unpaid: vat3(s.unpaid), past_term: vat3(s.overdue) })),
    oldest_unpaid_pos: unpaidPOs.sort((a, b) => b.days_since_oldest_receipt - a.days_since_oldest_receipt).slice(0, 15).map(r => ({
      po_base: r.po_base, supplier: r.supplier, project: r.project, oldest_receipt: r.oldest_receipt,
      days_since_oldest_receipt: r.days_since_oldest_receipt, unpaid_excl_vat_zar: r2(r.unpaid_received_excl),
      unpaid_incl_vat_zar: r2(r.unpaid_received_excl * (1 + VAT_RATE)),
      past_term_excl_vat_zar: r2(r.overdue_excl), finance_scheduled_pending_zar: r2(r.finance_scheduled_pending) })),
    no_finance_record_at_all: { po_count: noFinCount, ...vat3(noFinTotal),
      note: 'Received but Finance has no record for the PO. May have been paid before the sync started — verify with Siva; not counted above.' },
    data_quality: { deliveries_without_a_price: unvalued, deliveries_without_a_date: undated }
  };
}

async function get_payment_schedule(days = 30) {
  const [pay, fc] = await Promise.all([
    loadPayables(),
    fetchAll('v_payment_forecast_lines',
      'po_base, po_number, supplier, project, description, committed_date, expected_pay_date, outstanding_excl',
      { order: 'po_number' })
  ]);
  if (pay.error) return { error: pay.error };
  if (fc.error)  return { error: fc.error };

  // Prepaid deposit reduces what is still to be paid on that PO base
  const factor = {};
  for (const r of pay.data) {
    const out = num(r.outstanding_excl);
    factor[r.po_base] = out > 0 ? Math.max(0, out - num(r.paid_not_received_excl)) / out : 0;
  }

  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const late = [], noDate = [], future = [];
  for (const l of fc.data) {
    const f = factor[l.po_base] !== undefined ? factor[l.po_base] : 1;
    const net = num(l.outstanding_excl) * f;
    const item = { ...l, net_excl: net };
    if (!l.committed_date) noDate.push(item);
    else if (l.committed_date < today) late.push(item);
    else future.push(item);
  }
  const tot = arr => arr.reduce((s, r) => s + r.net_excl, 0);

  // Late deliveries by supplier
  const lateBySup = {};
  for (const l of late) {
    const k = l.supplier || 'Unknown supplier';
    if (!lateBySup[k]) lateBySup[k] = { supplier: k, line_count: 0, net_excl: 0, gross_excl: 0, oldest_committed_date: l.committed_date };
    lateBySup[k].line_count++; lateBySup[k].net_excl += l.net_excl; lateBySup[k].gross_excl += num(l.outstanding_excl);
    if (l.committed_date < lateBySup[k].oldest_committed_date) lateBySup[k].oldest_committed_date = l.committed_date;
  }
  const lateList = Object.values(lateBySup).sort((a, b) => b.net_excl - a.net_excl).map(s => ({
    supplier: s.supplier, line_count: s.line_count, oldest_committed_date: s.oldest_committed_date,
    days_late_oldest: -daysUntil(s.oldest_committed_date),
    outstanding_order_value_excl_vat_zar: r2(s.gross_excl),
    net_after_prepaid: vat3(s.net_excl)
  }));

  // Forecast by month (delivery + 30 days)
  const byMonth = {};
  for (const l of future) {
    const k = String(l.expected_pay_date).slice(0, 7);
    byMonth[k] = (byMonth[k] || 0) + l.net_excl;
  }
  const monthList = Object.keys(byMonth).sort().map(k => ({ month: k, ...vat3(byMonth[k]) }));
  const nearTerm = future.filter(l => l.expected_pay_date <= cutoffStr);

  const rnp = pay.data.filter(r => num(r.received_not_paid_excl) > 1);

  return {
    basis: `FORECAST. Payment date = committed delivery date + ${DEFAULT_PAY_DAYS} days (default term, subject to QC and rejections). Net of any prepaid deposit on the PO.`,
    received_not_paid_now: {
      po_count: rnp.length, ...vat3(rnp.reduce((s, r) => s + num(r.received_not_paid_excl), 0)),
      already_scheduled_by_finance: vat3(rnp.reduce((s, r) => s + num(r.finance_pending), 0)),
      note: 'Goods already received per PMS but not covered by Finance payments. Receipt dates are not available here, so these cannot be dated — Finance decides timing. Some may have been paid before the Finance sync started.'
    },
    near_term_window: { days, up_to: cutoffStr, line_count: nearTerm.length, ...vat3(tot(nearTerm)) },
    forecast_by_month_future_deliveries: monthList,
    late_deliveries_payment_date_unknown: {
      line_count: late.length, ...vat3(tot(late)), by_supplier: lateList,
      note: 'Committed delivery date has passed and the goods are not received. Payment falls 30 days after ACTUAL delivery, so it cannot be forecast until the supplier gives a new date. Chase these suppliers.'
    },
    no_committed_date: { line_count: noDate.length, ...vat3(tot(noDate)),
      note: 'Open lines with no committed date — cannot be placed on the forecast.' },
    vat_note: 'PMS values exclude 15% VAT; payment planning must use incl_vat_zar.'
  };
}

async function get_po_reconciliation_summary() {
  const res = await fetchAll('v_finance_po_reconciliation',
    'po_base, outcome, finance_net_paid_excl, finance_pending, difference', { order: 'po_base' });
  if (res.error) return { error: res.error };
  const data = res.data;

  const byOutcome = {};
  for (const r of data) {
    const key = r.outcome || 'UNKNOWN';
    if (!byOutcome[key]) byOutcome[key] = { outcome: key, count: 0, total_paid_excl_zar: 0, total_pending_zar: 0, total_difference_zar: 0 };
    byOutcome[key].count++;
    byOutcome[key].total_paid_excl_zar += r.finance_net_paid_excl || 0;
    byOutcome[key].total_pending_zar   += r.finance_pending || 0;
    byOutcome[key].total_difference_zar += r.difference || 0;
  }

  return {
    total_pos: data.length,
    by_outcome: Object.values(byOutcome).sort((a,b) => b.count - a.count),
  };
}

async function get_po_reconciliation_issues(outcome_filter) {
  let query = supabase
    .from('v_finance_po_reconciliation')
    .select('po_base, pms_po_number, mapped_supplier, finance_net_paid_excl, '
          + 'finance_pending, difference, credit_notes, finance_documents, outcome')
    .limit(1000);

  if (outcome_filter) {
    query = query.eq('outcome', outcome_filter);
  } else {
    query = query.neq('outcome', 'MATCHED');
  }

  const { data, error } = await query;
  if (error) return { error: `Query failed: ${error.message}` };

  return {
    filter: outcome_filter || 'all non-MATCHED',
    count: data.length,
    issues: data.map(r => ({
      po_base:        r.po_base,
      pms_po_number:  r.pms_po_number,
      supplier:       r.mapped_supplier,
      paid_excl_vat_zar: r.finance_net_paid_excl,
      pending_zar:    r.finance_pending,
      difference_zar: r.difference,
      credit_notes:   r.credit_notes,
      finance_documents: r.finance_documents,
      outcome:        r.outcome,
    }))
  };
}

async function list_projects() {
  const { data, error } = await supabase
    .from('projects')
    .select('project_name, product, status, budget, start_date, end_date, manager');
  if (error) return { error: `Query failed: ${error.message}` };
  return { projects: data };
}

async function get_project_financial_summary(project_name) {
  if (!project_name) return { error: 'project_name is required' };

  const { data: proj, error: projErr } = await supabase
    .from('projects')
    .select('project_name, product, status, budget, start_date, end_date, manager')
    .eq('project_name', project_name)
    .maybeSingle();
  if (projErr) return { error: `Query failed: ${projErr.message}` };
  if (!proj) return { error: `No project found named "${project_name}". Use list_projects to see valid names.` };

  const lr = await fetchAll('v_po_line_commitment',
    'product, ordered_value, received_value, committed_value, over_receipt_value, is_over_receipt, is_cancelled',
    { mod: q => q.eq('project', project_name) });
  if (lr.error) return { error: lr.error };

  const active = (lr.data || []).filter(r => !r.is_cancelled);
  const sum = (arr, f) => arr.reduce((s,r) => s+(r[f]||0), 0);

  const totalOrdered    = sum(active, 'ordered_value');
  const totalReceived   = sum(active, 'received_value');
  const totalCommitted  = sum(active, 'committed_value');
  const totalOverReceipt = sum(active, 'over_receipt_value');
  const overReceiptLines = active.filter(r => r.is_over_receipt).length;

  const budget = proj.budget || 0;
  const remaining = budget - totalCommitted;
  const pctConsumed = budget > 0 ? (totalCommitted / budget) * 100 : null;

  const byProduct = {};
  for (const r of active) {
    const p = r.product || 'Unspecified';
    if (!byProduct[p]) byProduct[p] = { product: p, ordered_value: 0, received_value: 0, committed_value: 0 };
    byProduct[p].ordered_value   += r.ordered_value || 0;
    byProduct[p].received_value  += r.received_value || 0;
    byProduct[p].committed_value += r.committed_value || 0;
  }

  return {
    project_name: proj.project_name,
    status: proj.status,
    manager: proj.manager,
    budget_zar: budget,
    total_ordered_excl_vat_zar:   totalOrdered,
    total_received_excl_vat_zar:  totalReceived,
    total_committed_excl_vat_zar: totalCommitted,
    remaining_budget_zar: remaining,
    percent_budget_consumed: pctConsumed !== null ? Math.round(pctConsumed * 10) / 10 : null,
    over_receipt: overReceiptLines > 0
      ? { line_count: overReceiptLines, total_value_zar: totalOverReceipt,
          note: 'Received more stock than originally ordered on these lines — already included in total_committed, not an error.' }
      : null,
    breakdown_by_product: Object.values(byProduct),
    caveats: budget === 0
      ? ['This project has no budget captured in the PMS — remaining budget and % consumed cannot be calculated.']
      : []
  };
}

// ── Router ──────────────────────────────────────────────────────────────────

async function runTool(name, input) {
  try {
    if (name === 'get_rll_shortfall')             return await get_rll_shortfall(input.qty || 1);
    if (name === 'get_grn40_shortfall')           return await get_grn40_shortfall(input.qty || 1);
    if (name === 'get_rll_units_built')           return await get_rll_units_built();
    if (name === 'get_project_progress')          return await get_project_progress();
    if (name === 'get_rll_deadline_risk')         return await get_rll_deadline_risk(input.qty);
    if (name === 'get_open_work_orders')          return await get_open_work_orders(input.project_name);
    if (name === 'get_open_po_value')             return await get_open_po_value();
    if (name === 'get_payables_summary')          return await get_payables_summary(input.project_name);
    if (name === 'get_prepaid_limbo')             return await get_prepaid_limbo();
    if (name === 'get_supplier_spend')            return await get_supplier_spend(input.supplier);
    if (name === 'get_receipt_ageing')            return await get_receipt_ageing();
    if (name === 'get_payment_schedule')          return await get_payment_schedule(input.days || 30);
    if (name === 'get_po_reconciliation_summary') return await get_po_reconciliation_summary();
    if (name === 'get_po_reconciliation_issues')  return await get_po_reconciliation_issues(input.outcome_filter);
    if (name === 'get_project_financial_summary') return await get_project_financial_summary(input.project_name);
    if (name === 'list_projects')                 return await list_projects();
    return { error: `Unknown tool: ${name}` };
  } catch (err) {
    return { error: `Tool ${name} failed: ${err.message}` };
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { messages } = JSON.parse(event.body);
    let conversation  = [...messages];
    let finalResponse = null;

    const todayStr = new Date().toISOString().slice(0, 10);
    const systemWithDate = SYSTEM_PROMPT
      + `\n\nTODAY'S DATE: ${todayStr}. Days remaining to the 2026 400 RLL delivery deadline (${DEADLINE_400}): ${daysUntil(DEADLINE_400)}.`;

    for (let i = 0; i < 8; i++) {
      const res  = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 2500,
          system:     systemWithDate,
          tools:      TOOLS,
          messages:   conversation
        })
      });
      const data = await res.json();

      if (data.stop_reason === 'tool_use') {
        conversation.push({ role: 'assistant', content: data.content });
        const results = [];
        for (const block of data.content.filter(b => b.type === 'tool_use')) {
          results.push({
            type: 'tool_result', tool_use_id: block.id,
            content: JSON.stringify(await runTool(block.name, block.input))
          });
        }
        conversation.push({ role: 'user', content: results });
        continue;
      }
      finalResponse = data;
      break;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(finalResponse)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
