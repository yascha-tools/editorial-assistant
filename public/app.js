// DOM elements
const toggleStyleGuidesBtn = document.getElementById('toggle-style-guides');
const styleGuidesPanel = document.getElementById('style-guides-panel');
const headlinesGuide = document.getElementById('headlines-guide');
const socialGuide = document.getElementById('social-guide');
const copyeditGuide = document.getElementById('copyedit-guide');
const factcheckGuide = document.getElementById('factcheck-guide');

const docUrl = document.getElementById('doc-url');
const fetchDocBtn = document.getElementById('fetch-doc-btn');
const docStatus = document.getElementById('doc-status');
const articleText = document.getElementById('article-text');

const taskHeadlines = document.getElementById('task-headlines');
const taskSocial = document.getElementById('task-social');
const taskCopyedit = document.getElementById('task-copyedit');
const taskFactcheck = document.getElementById('task-factcheck');

const processBtn = document.getElementById('process-btn');
const loading = document.getElementById('loading');
const loadingText = document.getElementById('loading-text');
const error = document.getElementById('error');

const resultsSection = document.getElementById('results');
const headlinesSection = document.getElementById('headlines-section');
const headlinesList = document.getElementById('headlines-list');
const regenerateBtn = document.getElementById('regenerate-btn');

const socialSection = document.getElementById('social-section');
const socialContent = document.getElementById('social-content');
const tabButtons = document.querySelectorAll('.tab-btn');
const regenerateSocialBtn = document.getElementById('regenerate-social-btn');

const copyeditSection = document.getElementById('copyedit-section');
const copyeditOutput = document.getElementById('copyedit-output');
const copyeditIssues = document.getElementById('copyedit-issues');
const copyeditIssuesList = document.getElementById('copyedit-issues-list');

const factcheckSection = document.getElementById('factcheck-section');
const factcheckOutput = document.getElementById('factcheck-output');
const factcheckClaims = document.getElementById('factcheck-claims');
const factcheckClaimsList = document.getElementById('factcheck-claims-list');

// State
let socialData = { substack: [], twitter: [], instagram: [] };
let currentPlatform = 'substack';

// Load style guides
async function loadStyleGuides() {
  try {
    const response = await fetch('/api/style-guides');
    const data = await response.json();
    headlinesGuide.value = data.headlines || '';
    socialGuide.value = data.socialMedia || '';
    copyeditGuide.value = data.copyEdit || '';
    factcheckGuide.value = data.factCheck || '';
  } catch (err) {
    console.error('Failed to load style guides:', err);
  }
}

loadStyleGuides();

// Toggle style guides panel
toggleStyleGuidesBtn.addEventListener('click', () => {
  styleGuidesPanel.classList.toggle('hidden');
  toggleStyleGuidesBtn.classList.toggle('active');
});

// Fetch Google Doc
fetchDocBtn.addEventListener('click', async () => {
  const url = docUrl.value.trim();
  if (!url) {
    docStatus.textContent = 'Please enter a URL';
    docStatus.className = 'doc-status error';
    return;
  }

  docStatus.textContent = 'Fetching document...';
  docStatus.className = 'doc-status';
  fetchDocBtn.disabled = true;

  try {
    const response = await fetch('/api/fetch-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    articleText.value = data.content;
    docStatus.textContent = 'Document loaded!';
    docStatus.className = 'doc-status success';
  } catch (err) {
    docStatus.textContent = err.message;
    docStatus.className = 'doc-status error';
  } finally {
    fetchDocBtn.disabled = false;
  }
});

// Social media tabs
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPlatform = btn.dataset.platform;
    renderSocialPosts();
  });
});

function renderSocialPosts() {
  const posts = socialData[currentPlatform] || [];
  socialContent.innerHTML = posts.map((post, i) => `
    <div class="social-post">
      <p>${escapeHtml(post)}</p>
      <button class="copy-btn secondary-btn" onclick="copyText('${escapeForOnclick(post)}')">Copy</button>
    </div>
  `).join('') || '<p style="color: #666;">No posts generated yet.</p>';
}

// Copy function
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    // Could add visual feedback here
  });
}

// Make copyText available globally
window.copyText = copyText;

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeForOnclick(text) {
  return text.replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

// Process article
processBtn.addEventListener('click', async () => {
  const text = articleText.value.trim();

  if (!text) {
    showError('Please enter article text');
    return;
  }

  const tasks = {
    headlines: taskHeadlines.checked,
    social: taskSocial.checked,
    copyEdit: taskCopyedit.checked,
    factCheck: taskFactcheck.checked
  };

  if (!Object.values(tasks).some(v => v)) {
    showError('Please select at least one task');
    return;
  }

  hideError();
  setLoading(true);
  clearResults();

  const styleGuides = {
    headlines: headlinesGuide.value,
    socialMedia: socialGuide.value,
    copyEdit: copyeditGuide.value,
    factCheck: factcheckGuide.value
  };

  try {
    const response = await fetch('/api/process-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, tasks, styleGuides })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    resultsSection.classList.remove('hidden');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          handleSSEMessage(data);
        }
      }
    }
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

function handleSSEMessage(data) {
  if (data.type === 'progress') {
    loadingText.textContent = data.message;
  } else if (data.type === 'result') {
    handleResult(data.task, data.data);
  } else if (data.type === 'error') {
    console.error(`Error in ${data.task}:`, data.error);
  }
}

function handleResult(task, data) {
  if (task === 'headlines') {
    headlinesSection.classList.remove('hidden');
    renderHeadlines(data);
  } else if (task === 'social') {
    socialSection.classList.remove('hidden');
    socialData[data.platform] = data.suggestions;
    if (data.platform === currentPlatform) {
      renderSocialPosts();
    }
  } else if (task === 'copyEdit') {
    copyeditSection.classList.remove('hidden');
    renderCopyEdit(data.text);
  } else if (task === 'factCheck') {
    factcheckSection.classList.remove('hidden');
    renderFactCheck(data.text);
  }
}

function renderHeadlines(suggestions) {
  headlinesList.innerHTML = suggestions.map((s, i) => `
    <div class="headline-card">
      <span class="headline-style">${escapeHtml(s.style || ['Straight', 'Provocative', 'Creative'][i])}</span>
      <h3>${escapeHtml(s.headline)}</h3>
      <p>${escapeHtml(s.dek)}</p>
      <button class="copy-btn secondary-btn" onclick="copyText('${escapeForOnclick(s.headline + '\\n\\n' + s.dek)}')">Copy</button>
    </div>
  `).join('');
}

// Regenerate headlines
regenerateBtn.addEventListener('click', async () => {
  const text = articleText.value.trim();
  if (!text) return;

  regenerateBtn.disabled = true;
  regenerateBtn.textContent = 'Generating...';

  try {
    const response = await fetch('/api/regenerate-headlines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, styleGuide: headlinesGuide.value })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    renderHeadlines(data.suggestions);
  } catch (err) {
    console.error('Regenerate error:', err);
  } finally {
    regenerateBtn.disabled = false;
    regenerateBtn.textContent = 'Regenerate';
  }
});

// Regenerate social media posts
regenerateSocialBtn.addEventListener('click', async () => {
  const text = articleText.value.trim();
  if (!text) return;

  regenerateSocialBtn.disabled = true;
  regenerateSocialBtn.textContent = 'Generating...';

  try {
    const response = await fetch('/api/regenerate-social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, styleGuide: socialGuide.value })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error);

    // Update all platforms
    socialData = data.suggestions;
    renderSocialPosts();
  } catch (err) {
    console.error('Regenerate social error:', err);
  } finally {
    regenerateSocialBtn.disabled = false;
    regenerateSocialBtn.textContent = 'Regenerate';
  }
});

// Parse and render copy-edit results
function renderCopyEdit(text) {
  // Split article from issues list
  const parts = text.split(/---ISSUES---/i);
  const articleText = parts[0].trim();
  const issuesText = parts[1] || '';

  // Parse [[ISSUE: text]] markers in article
  // Track unique issues so repeated text gets the same number
  const issueRegex = /\[\[ISSUE:\s*(.+?)\]\]/g;
  const seenIssues = new Map(); // Map of issue text -> assigned number
  let nextIssueNum = 1;
  const uniqueIssues = []; // Track unique issues in order of first appearance

  const html = articleText.replace(issueRegex, (match, problemText) => {
    const normalizedText = problemText.trim().toLowerCase();
    let issueNum;

    if (seenIssues.has(normalizedText)) {
      // Same issue seen before - reuse its number
      issueNum = seenIssues.get(normalizedText);
    } else {
      // New issue - assign next number
      issueNum = nextIssueNum++;
      seenIssues.set(normalizedText, issueNum);
      uniqueIssues.push({ num: issueNum, text: problemText.trim() });
    }

    return `<span class="edit-issue" title="See issue #${issueNum}">${escapeHtml(problemText)}</span><sup>[${issueNum}]</sup>`;
  });

  copyeditOutput.innerHTML = html.replace(/\n/g, '<br>');

  // Parse the issues list from AI response - try multiple formats
  const issues = [];

  // Try strict format first: 1. "original" -> "fix" (reason)
  const strictRegex = /(\d+)\.\s*[""]([^""]+)[""]\s*(?:->|→)\s*[""]([^""]+)[""]\s*\(([^)]+)\)/g;
  let match;
  while ((match = strictRegex.exec(issuesText)) !== null) {
    issues.push({
      index: match[1],
      original: match[2],
      fix: match[3],
      reason: match[4]
    });
  }

  // If strict parsing found fewer issues than marked in text, try looser parsing
  if (issues.length < seenIssues.size) {
    // Try: 1. "text" → "fix" — reason (or with dashes/colons)
    const looseRegex = /(\d+)\.\s*[""]([^""]+)[""]\s*(?:->|→|:)\s*[""]([^""]+)[""]\s*[—\-–:]\s*(.+?)(?=\n\d+\.|$)/gs;
    issues.length = 0; // Reset
    while ((match = looseRegex.exec(issuesText)) !== null) {
      issues.push({
        index: match[1],
        original: match[2],
        fix: match[3],
        reason: match[4].trim()
      });
    }
  }

  // Final fallback: just show numbered lines as-is
  if (issues.length === 0 && issuesText.trim()) {
    const lines = issuesText.trim().split('\n').filter(l => /^\d+\./.test(l.trim()));
    lines.forEach((line, i) => {
      issues.push({
        index: String(i + 1),
        original: '',
        fix: '',
        reason: line.replace(/^\d+\.\s*/, '')
      });
    });
  }

  if (issues.length > 0) {
    copyeditIssuesList.innerHTML = issues.map(issue => {
      if (issue.original && issue.fix) {
        return `<li><strong>[${issue.index}]</strong> "${escapeHtml(issue.original)}" → "${escapeHtml(issue.fix)}" — ${escapeHtml(issue.reason)}</li>`;
      } else {
        return `<li><strong>[${issue.index}]</strong> ${escapeHtml(issue.reason)}</li>`;
      }
    }).join('');
    copyeditIssues.classList.remove('hidden');
  } else {
    copyeditIssues.classList.add('hidden');
  }
}

// Parse and render fact-check results
function renderFactCheck(text) {
  const claims = [];

  // Parse different claim types
  const verifiedRegex = /\[\[VERIFIED:\s*(.+?)\]\]/g;
  const questionableRegex = /\[\[QUESTIONABLE:\s*(.+?)\s*\|\s*(.+?)\]\]/g;
  const incorrectRegex = /\[\[INCORRECT:\s*(.+?)\s*\|\s*(.+?)\]\]/g;
  const checkCurrentRegex = /\[\[CHECK_CURRENT:\s*(.+?)\s*\|\s*(.+?)\]\]/g;

  let html = text;

  // Replace verified claims
  html = html.replace(verifiedRegex, (match, claim) => {
    claims.push({ type: 'verified', claim, detail: null });
    return `<span class="claim-verified">${escapeHtml(claim)}</span>`;
  });

  // Replace questionable claims
  html = html.replace(questionableRegex, (match, claim, concern) => {
    claims.push({ type: 'questionable', claim, detail: concern });
    return `<span class="claim-questionable" title="${escapeHtml(concern)}">${escapeHtml(claim)}</span>`;
  });

  // Replace incorrect claims
  html = html.replace(incorrectRegex, (match, claim, correction) => {
    claims.push({ type: 'incorrect', claim, detail: correction });
    return `<span class="claim-incorrect" title="${escapeHtml(correction)}">${escapeHtml(claim)}</span>`;
  });

  // Replace check-current claims (time-sensitive, need verification)
  html = html.replace(checkCurrentRegex, (match, claim, whatToCheck) => {
    claims.push({ type: 'check-current', claim, detail: whatToCheck });
    return `<span class="claim-check-current" title="${escapeHtml(whatToCheck)}">${escapeHtml(claim)}</span>`;
  });

  factcheckOutput.innerHTML = html.replace(/\n/g, '<br>');

  if (claims.length > 0) {
    factcheckClaimsList.innerHTML = claims.map(c => {
      const detail = c.detail ? ` — ${escapeHtml(c.detail)}` : '';
      const icon = c.type === 'verified' ? '✓' : c.type === 'questionable' ? '?' : c.type === 'incorrect' ? '✗' : '⏱';
      return `<li class="claim-item-${c.type}"><span class="claim-icon">${icon}</span> ${escapeHtml(c.claim)}${detail}</li>`;
    }).join('');
    factcheckClaims.classList.remove('hidden');
  } else {
    factcheckClaims.classList.add('hidden');
  }
}

function setLoading(isLoading) {
  loading.classList.toggle('hidden', !isLoading);
  processBtn.disabled = isLoading;
}

function showError(message) {
  error.textContent = message;
  error.classList.remove('hidden');
}

function hideError() {
  error.classList.add('hidden');
}

function clearResults() {
  headlinesSection.classList.add('hidden');
  socialSection.classList.add('hidden');
  copyeditSection.classList.add('hidden');
  factcheckSection.classList.add('hidden');
  headlinesList.innerHTML = '';
  socialData = { substack: [], twitter: [], instagram: [] };
  socialContent.innerHTML = '';
  copyeditOutput.innerHTML = '';
  copyeditIssuesList.innerHTML = '';
  copyeditIssues.classList.add('hidden');
  factcheckOutput.innerHTML = '';
  factcheckClaimsList.innerHTML = '';
  factcheckClaims.classList.add('hidden');
}
