// ============================================================
// chat.js — Netlify serverless function
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SYSTEM_PROMPT = `You are RippelAI, an internal financial and production
intelligence assistant for Rippel Effect Systems, a South African firearms
manufacturer. Your users are Fritz (CEO/MD), Siva (Finance), and Michiel
(Technical Manager). Currency is always South African Rand (ZAR).

Product lines: XRGL40, GRN40, and RLL.

PRODUCT NOTES:
- RLL is a gun build. Components live in RLL Store, COTS Store, Holding Store.
  Cross-store availability from XRGL Store / GRN40 Store is reported when relevant.
- GRN40 is a SIGHT build — not a gun. Components live in GRN40 Store, COTS Store
  (pooled, shared across products), and Holding Store. RLL Store and XRGL Store
  are never relevant for GRN40.

IMPORTANT DATA RULES:
- "Available" = physical store quantity MINUS parts reserved for open Work Orders
  (qty_reserved) MINUS parts currently out on open Service Orders (LSO/ESO,
  qty_outstanding). These are subtracted because they are already committed and
  cannot be used for a new build even though they may still show in stock_qty.
- "WO committed" (wo_committed) = parts reserved to a Partially Complete or other
  open Work Order — still physically in store but earmarked. Action: chase WO
  completion or release the reservation.
- "SO committed" (so_committed) = parts currently out at a local or external
  service facility (LSO/ESO), not yet returned. Action: chase the service order.
- "Holding Store WIP" (holding_wip) = parts mid-process (machining, anodizing,
  external service) — not yet usable. Action: chase the process step, not a new PO.
- "On Order" = not yet received — informational only, does NOT count as available.
- Only report "needs sourcing from scratch" (needs_sourcing) for quantity genuinely
  unaccounted for after: available + holding_wip + on_order vs effective need.
- Parent assembly partial coverage: if a parent assembly already has some units
  built on the shelf, child parts only need to cover the parent's REMAINING gap.
- If a parent assembly fully covers the need, child shortages are not blockers.
- For RLL: report cross-store availability from XRGL/GRN40 stores when relevant.
  For GRN40: do not check RLL or XRGL stores — those components are never there.
- Never guess. Always call the appropriate tool.
- Currency: always R (ZAR).
- Flag unpriced lines so user knows totals may be understated.
- Be concise and direct.`;

const TOOLS = [
  {
    name: 'get_rll_shortfall',
    description: 'Returns genuine, actionable stock shortages preventing a build '
      + 'of N RLL units (default 1). Accounts for WO-committed and service-order- '
      + 'committed stock, parent-assembly partial coverage, Holding Store WIP, '
      + 'on-order quantities, and cross-store availability from other product stores. '
      + 'Use for RLL readiness, build blockers, or ordering questions.',
    input_schema: {
      type: 'object',
      properties: {
        qty: { type: 'integer', description: 'RLL units to check. Defaults to 1.' }
      }
    }
  },
  {
    name: 'get_grn40_shortfall',
    description: 'Returns genuine, actionable stock shortages preventing a build '
      + 'of N GRN40 sights (default 1). GRN40 is a sight build — components in '
      + 'GRN40 Store, COTS Store (pooled), Holding Store. Accounts for WO-committed '
      + 'and service-order-committed stock, parent-assembly partial coverage, WIP, '
      + 'and on-order quantities. Use for GRN40 readiness, what needs to be ordered '
      + 'for GRN40, or what is blocking the GRN40 build.',
    input_schema: {
      type: 'object',
      properties: {
        qty: { type: 'integer', description: 'GRN40 units to check. Defaults to 1.' }
      }
    }
  },
  {
    name: 'get_open_po_value',
    description: 'Total open PO cash position: gross outstanding, already-paid lines, '
      + 'prepaid deposits, and net still owed. Use for PO exposure, outstanding '
      + 'commitments, or cashflow questions.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'get_payment_schedule',
    description: 'Upcoming unpaid supplier deliveries within N days (default 30) '
      + 'with net cash required, plus overdue unpaid lines. Use for cashflow planning '
      + 'or overdue PO follow-up.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days ahead to look. Defaults to 30.' }
      }
    }
  }
];

// ── Shared BOM shortfall logic ──────────────────────────────────────────────

function buildShortfallResult(allRows, qty, needCol) {
  const scaledRows = allRows.map(row => ({
    ...row,
    scaled_need: (row[needCol] || 0) * qty
  }));

  const byId = {};
  for (const row of scaledRows) {
    if (row.component_id) byId[row.component_id] = row;
  }

  function effectiveNeed(row) {
    const parent = row.dependant_code ? byId[row.dependant_code] : null;
    if (!parent) return row.scaled_need;
    if (parent.available_qty >= parent.scaled_need) return 0;
    return Math.max(0, parent.scaled_need - parent.available_qty) * row.req_per_unit;
  }

  const shortages = scaledRows
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
        item_name:      r.item_name,
        stock_code:     r.stock_code,
        storeroom:      r.storeroom,
        available:      r.available_qty,
        holding_wip:    r.holding_qty,
        on_order:       r.on_order_qty,
        supplier_eta:   r.supplier_earliest_eta,
        needed:         need,
        needs_sourcing: needsSourcing,
      };
      if ((r.wo_committed_qty || 0) > 0) out.wo_committed = r.wo_committed_qty;
      if ((r.so_committed_qty || 0) > 0) out.so_committed = r.so_committed_qty;
      return out;
    });

  return shortages;
}

// ── Tool functions ──────────────────────────────────────────────────────────

async function get_rll_shortfall(qty = 1) {
  const { data: allRows, error } = await supabase
    .from('v_rll_build_readiness')
    .select('component_id, dependant_code, item_name, stock_code, storeroom, '
          + 'available_qty, wo_committed_qty, so_committed_qty, holding_qty, '
          + 'on_order_qty, supplier_earliest_eta, need_for_1_rll, req_per_unit, '
          + 'shortfall, build_status, is_assembly_group');

  if (error) return { error: `Query failed: ${error.message}` };

  const { data: crossStoreRows } = await supabase
    .from('stock_items')
    .select('stock_code, stock_qty, storeroom')
    .in('storeroom', ['XRGL Store', 'GRN40 Store', 'RLL Legacy Store'])
    .gt('stock_qty', 0);

  const crossStoreMap = {};
  for (const row of (crossStoreRows || [])) {
    const code = row.stock_code ? row.stock_code.split('_')[0] : '';
    if (code) crossStoreMap[code] = (crossStoreMap[code] || 0) + row.stock_qty;
  }

  const shortages = buildShortfallResult(allRows, qty, 'need_for_1_rll')
    .map(r => {
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

async function get_open_po_value() {
  const { data, error } = await supabase
    .from('v_open_po_value')
    .select('po_number, description, line_status, qty_outstanding, unit_price, '
          + 'line_value, committed_date, invoice_paid, prepaid_amount');

  if (error) return { error: `Query failed: ${error.message}` };

  const paid   = data.filter(r => r.invoice_paid === true);
  const unpaid = data.filter(r => r.invoice_paid !== true);
  const sum    = (arr, f) => arr.reduce((s, r) => s + (r[f] || 0), 0);

  return {
    net_still_owed_zar: Math.max(0, sum(unpaid,'line_value') - sum(unpaid,'prepaid_amount')),
    breakdown: {
      gross_outstanding_zar:                sum(data,  'line_value'),
      already_invoiced_and_paid_zar:        sum(paid,  'line_value'),
      prepaid_deposits_on_unpaid_lines_zar: sum(unpaid,'prepaid_amount'),
      gross_unpaid_zar:                     sum(unpaid,'line_value'),
    },
    line_counts: {
      total_open_lines:   data.length,
      already_paid_lines: paid.length,
      unpaid_lines:       unpaid.length,
      unpriced_lines:     data.filter(r => !r.unit_price || r.unit_price === 0).length,
    }
  };
}

async function get_payment_schedule(days = 30) {
  const { data, error } = await supabase
    .from('v_payment_schedule')
    .select('po_number, description, line_status, committed_date, qty_outstanding, '
          + 'unit_price, line_value, prepaid_amount, invoice_paid');

  if (error) return { error: `Query failed: ${error.message}` };

  const unpaid = data.filter(r => r.invoice_paid !== true);
  const today  = new Date(); today.setHours(0,0,0,0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + days);

  const due      = unpaid.filter(r => { const d=new Date(r.committed_date); return d>=today && d<=cutoff; });
  const overdue  = unpaid.filter(r => new Date(r.committed_date) < today);
  const sum      = (arr, f) => arr.reduce((s,r) => s+(r[f]||0), 0);

  const byDate = {};
  for (const r of due) {
    if (!byDate[r.committed_date])
      byDate[r.committed_date] = { date:r.committed_date, line_count:0, gross_zar:0, net_zar:0 };
    byDate[r.committed_date].line_count++;
    byDate[r.committed_date].gross_zar += r.line_value||0;
    byDate[r.committed_date].net_zar   += Math.max(0,(r.line_value||0)-(r.prepaid_amount||0));
  }

  return {
    period_days: days,
    due_in_period: {
      line_count:            due.length,
      gross_value_zar:       sum(due,'line_value'),
      prepaid_deposits_zar:  sum(due,'prepaid_amount'),
      net_cash_required_zar: Math.max(0, sum(due,'line_value')-sum(due,'prepaid_amount')),
      unpriced_lines:        due.filter(r => !r.unit_price||r.unit_price===0).length,
      by_date: Object.values(byDate).sort((a,b)=>a.date.localeCompare(b.date))
    },
    overdue_unpaid: {
      line_count:            overdue.length,
      gross_value_zar:       sum(overdue,'line_value'),
      net_cash_required_zar: Math.max(0,sum(overdue,'line_value')-sum(overdue,'prepaid_amount')),
      note: overdue.length > 0
        ? 'Past committed delivery date, unpaid, still open — follow up with suppliers urgently'
        : 'No overdue unpaid lines'
    }
  };
}

// ── Router ──────────────────────────────────────────────────────────────────

async function runTool(name, input) {
  if (name === 'get_rll_shortfall')    return get_rll_shortfall(input.qty || 1);
  if (name === 'get_grn40_shortfall')  return get_grn40_shortfall(input.qty || 1);
  if (name === 'get_open_po_value')    return get_open_po_value();
  if (name === 'get_payment_schedule') return get_payment_schedule(input.days || 30);
  return { error: `Unknown tool: ${name}` };
}

// ── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST')
    return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    const { messages } = JSON.parse(event.body);
    let conversation  = [...messages];
    let finalResponse = null;

    for (let i = 0; i < 5; i++) {
      const res  = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model:      'claude-sonnet-4-6',
          max_tokens: 1500,
          system:     SYSTEM_PROMPT,
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
