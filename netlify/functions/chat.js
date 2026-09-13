// ============================================================
// chat.js — Netlify serverless function
// Proxies chat requests from the browser to the Anthropic API,
// and gives Claude tools to query live Supabase data instead of
// reasoning from its own knowledge.
// ============================================================

const { createClient } = require('@supabase/supabase-js');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SYSTEM_PROMPT = `You are RippelAI, an internal financial and production
intelligence assistant for Rippel Effect Systems, a South African firearms
manufacturer. Your users are Fritz (CEO/MD), Siva (Finance), and Michiel
(Technical Manager). Currency is always South African Rand (ZAR).

Product lines: XRGL40, GRN40, and RLL.

IMPORTANT DATA RULES:
- "On Order" quantities are informational only for planning. They do NOT
  count as available stock. Only physically available stock (Main Store or
  pooled COTS Store quantities) counts toward whether something is ready
  to build right now.
- "Holding Store WIP" (holding_wip) is stock that physically exists and
  has already been paid for, but is currently mid-process (e.g. machining,
  anodizing, external service) and is NOT yet usable in a build. Always
  report this separately from available stock and from on-order stock.
  The correct action for a holding_wip shortage is to chase the in-process
  step to completion — NOT to raise a new purchase order. Only report
  "needs sourcing from scratch" (needs_sourcing) for the quantity that is
  genuinely unaccounted for after subtracting available + holding_wip +
  on_order from the effective need.
- If a parent assembly already has partial stock on the shelf, the child
  raw parts only need to cover the parent's REMAINING gap — not the full
  build quantity.
- If a component's immediate parent assembly already has enough stock on
  its own to cover the full need, a raw-material shortage on that component
  is NOT a real build blocker at all.
- "Other store stock" means units of the same part code held in another
  product's store (XRGL, GRN40). NOT automatically available for RLL —
  always flag as "transfer required, management authorisation needed."
- For PO values and payment schedules, always distinguish:
    1. GROSS outstanding = total value of goods not yet received
    2. ALREADY PAID = lines where invoice_paid=true (cash already out,
       goods still en route) — these are NOT future cash obligations
    3. PREPAID DEPOSITS = prepaid_amount already paid on unpaid lines
    4. NET STILL OWED = gross unpaid - prepaid deposits = actual future
       cash obligation
  Always lead with NET STILL OWED for cashflow conversations. The gross
  figure is misleading on its own.
- "committed_date" is the supplier's confirmed delivery ETA and the best
  proxy for when payment will be due. Overdue lines (committed_date in the
  past, still open and unpaid) are a priority — flag them prominently.
- Never guess or estimate figures. Always call the appropriate tool.
- Always state currency as R (ZAR) for any monetary figure.
- Lines with no unit_price are excluded from value totals — always flag
  how many unpriced lines exist so the user knows totals may be understated.
- Be concise and direct. These are busy operational stakeholders who need
  clear answers, not lengthy explanations.`;

const TOOLS = [
  {
    name: 'get_rll_shortfall',
    description: 'Returns the genuine, actionable stock shortages preventing '
      + 'a build of N units of RLL right now (default 1). Excludes '
      + 'structural BOM container nodes, excludes raw-material shortages '
      + 'whose parent assembly already has sufficient stock on hand, and '
      + 'correctly accounts for partial parent coverage. Also reports '
      + 'whether any short parts have stock sitting in other product stores '
      + '(XRGL, GRN40) that could be transferred. Use this whenever asked '
      + 'about RLL stock readiness, build blockers, or what is missing to '
      + 'build RLL.',
    input_schema: {
      type: 'object',
      properties: {
        qty: {
          type: 'integer',
          description: 'Number of RLL units to check readiness for. Defaults to 1.'
        }
      }
    }
  },
  {
    name: 'get_open_po_value',
    description: 'Returns the true cash position on all open purchase orders: '
      + 'gross outstanding value, how much is already paid (invoice settled '
      + 'but goods not yet received), prepaid deposits on unpaid lines, and '
      + 'the net amount still owed. Use this for total open PO exposure, '
      + 'outstanding financial commitments, or cashflow questions about '
      + 'what still needs to be paid.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_payment_schedule',
    description: 'Returns upcoming unpaid supplier deliveries and their net '
      + 'cash requirement within the next N days (default 30), based on '
      + 'committed delivery dates. Only includes lines not yet invoiced and '
      + 'paid. Shows gross value, prepaid deposits already made, and net '
      + 'cash still required. Also separately reports overdue unpaid lines. '
      + 'Use this for upcoming cashflow, what is due from suppliers, or '
      + 'overdue PO lines.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Number of days ahead to look. Defaults to 30.'
        }
      }
    }
  }
];

async function get_rll_shortfall(qty = 1) {
  const { data: allRows, error } = await supabase
    .from('v_rll_build_readiness')
    .select('component_id, dependant_code, item_name, stock_code, storeroom, available_qty, holding_qty, on_order_qty, supplier_earliest_eta, need_for_1_rll, req_per_unit, shortfall, build_status, is_assembly_group');

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

  const scaledRows = allRows.map(row => ({
    ...row,
    scaled_need: row.need_for_1_rll * qty
  }));

  const byComponentId = {};
  for (const row of scaledRows) {
    if (row.component_id) byComponentId[row.component_id] = row;
  }

  function getEffectiveNeed(row) {
    const parent = row.dependant_code ? byComponentId[row.dependant_code] : null;
    if (!parent) return row.scaled_need;
    if (parent.available_qty >= parent.scaled_need) return 0;
    return Math.max(0, parent.scaled_need - parent.available_qty) * row.req_per_unit;
  }

  const realShortages = scaledRows
    .filter(row => {
      if (row.build_status === 'CONTAINER') return false;
      const parent = row.dependant_code ? byComponentId[row.dependant_code] : null;
      if (parent && parent.available_qty >= parent.scaled_need) return false;
      const need = getEffectiveNeed(row);
      const needsSourcing = Math.max(0, need - row.available_qty - row.holding_qty - row.on_order_qty);
      return needsSourcing > 0;
    })
    .map(r => {
      const need = getEffectiveNeed(r);
      const needsSourcing = Math.max(0, need - r.available_qty - r.holding_qty - r.on_order_qty);
      const crossStore = crossStoreMap[r.stock_code] || 0;
      return {
        item_name: r.item_name,
        stock_code: r.stock_code,
        available: r.available_qty,
        holding_wip: r.holding_qty,
        on_order: r.on_order_qty,
        supplier_eta: r.supplier_earliest_eta,
        needed: need,
        needs_sourcing: needsSourcing,
        other_store_stock: crossStore,
        other_store_note: crossStore >= needsSourcing
          ? 'Fully covered by other product store stock — management transfer required'
          : crossStore > 0
            ? `${crossStore} available in other product stores — partial cover, transfer required`
            : null
      };
    });

  return {
    product: 'RLL',
    build_qty: qty,
    total_shortages: realShortages.length,
    shortages: realShortages
  };
}

async function get_open_po_value() {
  const { data, error } = await supabase
    .from('v_open_po_value')
    .select('po_number, description, line_status, qty_outstanding, unit_price, line_value, committed_date, invoice_paid, prepaid_amount');

  if (error) return { error: `Query failed: ${error.message}` };

  // Split: already paid (invoice settled, goods still en route) vs unpaid
  const paidLines   = data.filter(r => r.invoice_paid === true);
  const unpaidLines = data.filter(r => r.invoice_paid !== true);

  const grossTotal        = data.reduce((sum, r)       => sum + (r.line_value     || 0), 0);
  const alreadyPaidValue  = paidLines.reduce((sum, r)  => sum + (r.line_value     || 0), 0);
  const grossUnpaid       = unpaidLines.reduce((sum, r) => sum + (r.line_value    || 0), 0);
  const totalPrepaid      = unpaidLines.reduce((sum, r) => sum + (r.prepaid_amount || 0), 0);
  const netStillOwed      = Math.max(0, grossUnpaid - totalPrepaid);
  const unpricedCount     = data.filter(r => !r.unit_price || r.unit_price === 0).length;

  return {
    net_still_owed_zar: netStillOwed,
    breakdown: {
      gross_outstanding_zar: grossTotal,
      already_invoiced_and_paid_zar: alreadyPaidValue,
      prepaid_deposits_on_unpaid_lines_zar: totalPrepaid,
      gross_unpaid_zar: grossUnpaid
    },
    line_counts: {
      total_open_lines: data.length,
      already_paid_lines: paidLines.length,
      unpaid_lines: unpaidLines.length,
      unpriced_lines: unpricedCount
    },
    notes: [
      paidLines.length > 0
        ? `${paidLines.length} line(s) totalling R${alreadyPaidValue.toFixed(2)} are invoiced and paid — cash already out, goods still en route`
        : null,
      totalPrepaid > 0
        ? `R${totalPrepaid.toFixed(2)} in prepaid deposits already made on unpaid lines — deducted from net owed`
        : null,
      unpricedCount > 0
        ? `${unpricedCount} line(s) have no unit price and are excluded from all totals — actual exposure is higher`
        : null
    ].filter(Boolean)
  };
}

async function get_payment_schedule(days = 30) {
  const { data, error } = await supabase
    .from('v_payment_schedule')
    .select('po_number, description, line_status, committed_date, qty_outstanding, unit_price, line_value, prepaid_amount, invoice_paid');

  if (error) return { error: `Query failed: ${error.message}` };

  // Only unpaid lines are future cash obligations
  const unpaidData = data.filter(r => r.invoice_paid !== true);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + days);

  const dueLines = unpaidData.filter(r => {
    const d = new Date(r.committed_date);
    return d >= today && d <= cutoff;
  });

  const overdueLines = unpaidData.filter(r => {
    const d = new Date(r.committed_date);
    return d < today;
  });

  const dueGross      = dueLines.reduce((sum, r)      => sum + (r.line_value     || 0), 0);
  const duePrepaid    = dueLines.reduce((sum, r)      => sum + (r.prepaid_amount  || 0), 0);
  const dueNet        = Math.max(0, dueGross - duePrepaid);
  const overdueGross  = overdueLines.reduce((sum, r)  => sum + (r.line_value     || 0), 0);
  const overduePrepaid = overdueLines.reduce((sum, r) => sum + (r.prepaid_amount  || 0), 0);
  const overdueNet    = Math.max(0, overdueGross - overduePrepaid);
  const unpricedDue   = dueLines.filter(r => !r.unit_price || r.unit_price === 0).length;

  // Group due lines by date
  const byDate = {};
  for (const r of dueLines) {
    const d = r.committed_date;
    if (!byDate[d]) byDate[d] = { date: d, line_count: 0, gross_zar: 0, net_zar: 0 };
    byDate[d].line_count++;
    byDate[d].gross_zar += r.line_value || 0;
    byDate[d].net_zar   += Math.max(0, (r.line_value || 0) - (r.prepaid_amount || 0));
  }

  return {
    period_days: days,
    due_in_period: {
      line_count: dueLines.length,
      gross_value_zar: dueGross,
      prepaid_deposits_zar: duePrepaid,
      net_cash_required_zar: dueNet,
      unpriced_lines: unpricedDue,
      by_date: Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
    },
    overdue_unpaid: {
      line_count: overdueLines.length,
      gross_value_zar: overdueGross,
      net_cash_required_zar: overdueNet,
      note: overdueLines.length > 0
        ? 'Past committed delivery date, unpaid, still open — follow up with suppliers urgently'
        : 'No overdue unpaid lines'
    }
  };
}

async function runTool(name, input) {
  if (name === 'get_rll_shortfall')    return get_rll_shortfall(input.qty || 1);
  if (name === 'get_open_po_value')    return get_open_po_value();
  if (name === 'get_payment_schedule') return get_payment_schedule(input.days || 30);
  return { error: `Unknown tool: ${name}` };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { messages } = JSON.parse(event.body);

    let conversation = [...messages];
    let finalResponse = null;

    for (let i = 0; i < 5; i++) {
      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: conversation
        })
      });

      const data = await apiResponse.json();

      if (data.stop_reason === 'tool_use') {
        const toolUseBlocks = data.content.filter(b => b.type === 'tool_use');
        conversation.push({ role: 'assistant', content: data.content });

        const toolResults = [];
        for (const block of toolUseBlocks) {
          const result = await runTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        }

        conversation.push({ role: 'user', content: toolResults });
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
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
