// ============================================================
// chat-background.js — RippelBot, long questions (Netlify Background Function)
// 11-10-2026
//
// Netlify runs any function whose name ends in "-background" in the
// background: the chat page gets an immediate 202, and this function may run
// for up to 15 minutes (we stop at 5). The answer is written to
// public.bot_jobs; the page asks chat.js {mode:"status", job_id} every few
// seconds and shows it when it is there.
//
// Same engine, tools and rules as chat.js (runConversation is imported from
// it) — only the time budget differs. Read-only on Matrix data; writes only
// bot_jobs and bot_question_log.
//
// Retry guard: Netlify re-runs a background function that throws. A job that
// is already finished is never answered twice; a job that is still marked
// running from an earlier attempt is closed with an error instead of re-run.
// ============================================================

const { runConversation, isUuid, supabase } = require('./chat');

const BG_BUDGET_MS = 290000;   // 4 min 50 s
const BG_MAX_ROUNDS = 12;

exports.handler = async function (event) {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return; }
  const id = body.job_id;
  if (!isUuid(id) || !Array.isArray(body.messages) || !body.messages.length) {
    console.log('[chat-bg] ignored: bad job_id or no messages');
    return;
  }
  const user = String(body.user || '').trim().slice(0, 80) || null;
  const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
  const question = lastUser && typeof lastUser.content === 'string' ? lastUser.content.slice(0, 4000) : '';

  try {
    const { data: existing } = await supabase.from('bot_jobs').select('status').eq('id', id).limit(1);
    const prior = existing && existing[0];
    if (prior && prior.status !== 'running') {
      console.log(`[chat-bg] job ${id} already ${prior.status} — not answered twice`);
      return;
    }
    if (prior && prior.status === 'running') {
      await supabase.from('bot_jobs').update({ status: 'error', error: 'Interrupted — please ask again.',
        finished_at: new Date().toISOString() }).eq('id', id);
      console.log(`[chat-bg] job ${id} was interrupted earlier — closed, not re-run`);
      return;
    }
    const { error: insErr } = await supabase.from('bot_jobs').insert({ id, asked_by: user, question,
      status: 'running', started_at: new Date().toISOString() });
    if (insErr) { console.log(`[chat-bg] bot_jobs insert failed: ${insErr.message}`); return; }

    const { response, outcome } = await runConversation({ messages: body.messages, user,
      budgetMs: BG_BUDGET_MS, maxRounds: BG_MAX_ROUNDS, tag: 'chat-bg' });

    const upd = outcome === 'error'
      ? { status: 'error', error: String(response.error || 'error').slice(0, 2000), outcome }
      : { status: 'done', result: response, outcome };
    const { error: updErr } = await supabase.from('bot_jobs')
      .update({ ...upd, finished_at: new Date().toISOString() }).eq('id', id);
    if (updErr) console.log(`[chat-bg] bot_jobs update failed: ${updErr.message}`);
  } catch (e) {
    console.log(`[chat-bg] job ${id} failed: ${e.message}`);
    try {
      await supabase.from('bot_jobs').update({ status: 'error', error: e.message.slice(0, 2000),
        finished_at: new Date().toISOString() }).eq('id', id);
    } catch { /* nothing more to do */ }
  }
};
