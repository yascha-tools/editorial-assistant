// Helpers for "generate options, take feedback, regenerate" flows (headlines,
// social posts, podcast titles, clips...).

const STOP = new Set('a an the and or but of to in on for at by with from as is are was were be its it this that how why what who we our us your their his her'.split(' '));

function wordSet(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(w => w && !STOP.has(w)));
}

// True when two titles are the same or a light rewording of each other.
function tooSimilar(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return false;
  if ([...A].join(' ') === [...B].join(' ')) return true;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  const containment = inter / Math.min(A.size, B.size);
  return dice >= 0.75 || (containment === 1 && Math.min(A.size, B.size) >= 3);
}

function editorNotes(guidance) {
  return guidance && String(guidance).trim()
    ? `\n<editor_notes>\nNotes from the editor. Follow them unless they conflict with accuracy:\n${String(guidance).trim()}\n</editor_notes>\n`
    : '';
}

// Previous rounds of options (with the editor's feedback on each).
function roundsBlock(history, describe) {
  if (!Array.isArray(history) || !history.length) return '';
  return `\n<previous_rounds>\n${history.map((r, i) => `Round ${i + 1} options:\n${(r.options || []).map(o => `- ${describe(o)}`).join('\n')}${r.feedback ? `\nEditor's feedback on round ${i + 1}: ${r.feedback}` : ''}`).join('\n\n')}\n</previous_rounds>\n`;
}

function steeringInstructions({ feedback, variantOf, pinned, describe }) {
  let s = '';
  if (Array.isArray(pinned) && pinned.length) {
    s += `\n<pinned>\nThe editor has pinned these as keepers. Don't repeat them; use them as a signal of what they like:\n${pinned.map(o => `- ${describe(o)}`).join('\n')}\n</pinned>\n`;
  }
  if (variantOf) {
    s += `\n<more_like_this>\nThe editor liked this option and wants variations on it — keep what makes it work while trying different wording and angles:\n${describe(variantOf)}\n</more_like_this>\n`;
  }
  if (feedback && String(feedback).trim()) {
    s += `\n<latest_feedback>\n${String(feedback).trim()}\n</latest_feedback>\nThis feedback is the most important instruction: the new options must clearly respond to it.\n`;
  }
  return s;
}

// Previous versions of a single output (intro copy, summary, clips...) plus
// the feedback on each, for "revise with feedback" flows.
function revisionBlock(history, feedback) {
  let s = '';
  if (Array.isArray(history) && history.length) {
    s += `\n<previous_versions>\n${history.map((h, i) => `Version ${i + 1}:\n${h.result}${h.feedback ? `\nEditor's feedback on version ${i + 1}: ${h.feedback}` : ''}`).join('\n\n---\n\n')}\n</previous_versions>\n`;
  }
  if (feedback && String(feedback).trim()) {
    s += `\n<latest_feedback>\n${String(feedback).trim()}\n</latest_feedback>\nProduce a new version that clearly responds to this feedback (applied to the most recent version), keeping what the editor didn't object to.\n`;
  }
  return s;
}

module.exports = { tooSimilar, wordSet, editorNotes, roundsBlock, steeringInstructions, revisionBlock };
