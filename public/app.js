// Handle Cmd+A / Ctrl+A in output boxes to select just that box's content
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
    const activeEl = document.activeElement;
    if (activeEl && activeEl.classList.contains('output-box')) {
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(activeEl);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
});

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
const taskFlagclaims = document.getElementById('task-flagclaims');
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

const flagclaimsSection = document.getElementById('flagclaims-section');
const flagclaimsOutput = document.getElementById('flagclaims-output');
const flagclaimsListContainer = document.getElementById('flagclaims-list-container');
const flagclaimsList = document.getElementById('flagclaims-list');

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
    flagClaims: taskFlagclaims.checked,
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
      body: JSON.stringify({ text, tasks, styleGuides, factCheckConfirmed: false })
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
  } else if (data.type === 'confirm_required') {
    // Handle confirmation request for large claim counts
    handleConfirmRequired(data);
  }
}

// Handle confirmation request for fact-checking many claims
function handleConfirmRequired(data) {
  if (data.task === 'factCheck') {
    // Show custom Yes/No modal
    showConfirmModal(
      `Found ${data.claimCount} claims to fact-check`,
      'This may take a while and use more API credits. Do you want to proceed?',
      async () => {
        // User clicked Yes - proceed with fact-check
        setLoading(true);
        loadingText.textContent = 'Proceeding with fact-check...';
        resultsSection.classList.remove('hidden');

        const text = articleText.value.trim();
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
            body: JSON.stringify({
              text,
              tasks: { factCheck: true },
              styleGuides,
              factCheckConfirmed: true
            })
          });

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n\n');
            buffer = lines.pop();

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const msgData = JSON.parse(line.slice(6));
                handleSSEMessage(msgData);
              }
            }
          }
        } catch (err) {
          showError(err.message);
        } finally {
          setLoading(false);
        }
      },
      () => {
        // User clicked No - cancel and clear fact-check section
        factcheckSection.classList.add('hidden');
        factcheckOutput.innerHTML = '';
        factcheckClaimsList.innerHTML = '';
        factcheckClaims.classList.add('hidden');
        setLoading(false);
      }
    );
  }
}

// Custom confirmation modal with Yes/No buttons
function showConfirmModal(title, message, onYes, onNo) {
  // Remove any existing modal
  const existingModal = document.getElementById('confirm-modal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'confirm-modal';
  modal.className = 'confirm-modal-overlay';
  modal.innerHTML = `
    <div class="confirm-modal">
      <h3>${title}</h3>
      <p>${message}</p>
      <div class="confirm-modal-buttons">
        <button class="confirm-btn-no">No</button>
        <button class="confirm-btn-yes">Yes</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('.confirm-btn-yes').addEventListener('click', () => {
    modal.remove();
    onYes();
  });

  modal.querySelector('.confirm-btn-no').addEventListener('click', () => {
    modal.remove();
    onNo();
  });
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
  } else if (task === 'flagClaims') {
    flagclaimsSection.classList.remove('hidden');
    renderFlagClaims(data.text);
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

  // FIRST: Parse the issues list to build lookup maps
  const issues = [];
  let match;

  // Split issues text into individual lines for processing
  const issueLines = issuesText.trim().split('\n').filter(l => l.trim());

  // Process each line that starts with a number
  let currentIssue = null;
  for (const line of issueLines) {
    const lineMatch = line.match(/^(\d+)\.\s*(.+)/);
    if (lineMatch) {
      // Save previous issue if exists
      if (currentIssue) {
        issues.push(currentIssue);
      }

      const num = lineMatch[1];
      const content = lineMatch[2];

      // Try to parse structured format: "original" → "fix" (CATEGORY: reason)
      const structuredMatch = content.match(/["„»]([^""„"«»]+)["„"«»]\s*(?:->|→)\s*["„»]([^""„"«»]+)["„"«»]\s*\(([^)]+)\)/);
      if (structuredMatch) {
        currentIssue = {
          index: num,
          original: structuredMatch[1],
          fix: structuredMatch[2],
          reason: structuredMatch[3]
        };
      } else {
        // Try simpler format: "original" → "fix" — reason
        const simpleMatch = content.match(/["„»]([^""„"«»]+)["„"«»]\s*(?:->|→)\s*["„»]([^""„"«»]+)["„"«»]\s*[—\-–]\s*(.+)/);
        if (simpleMatch) {
          currentIssue = {
            index: num,
            original: simpleMatch[1],
            fix: simpleMatch[2],
            reason: simpleMatch[3].trim()
          };
        } else {
          // Fallback: just store the whole line as reason
          currentIssue = {
            index: num,
            original: '',
            fix: '',
            reason: content.trim()
          };
        }
      }
    } else if (currentIssue && line.trim()) {
      // Continuation of previous issue (multi-line reason)
      currentIssue.reason += ' ' + line.trim();
    }
  }
  // Don't forget the last issue
  if (currentIssue) {
    issues.push(currentIssue);
  }

  // Build TWO lookup maps for matching
  const issueByNum = new Map();
  const issueByContent = new Map();

  issues.forEach(issue => {
    let tooltip;
    if (issue.original && issue.fix) {
      tooltip = `"${issue.original}" → "${issue.fix}"\n${issue.reason}`;
      const contentKey = issue.original.trim().toLowerCase();
      issueByContent.set(contentKey, tooltip);
    } else {
      tooltip = issue.reason;
    }
    issueByNum.set(issue.index, tooltip);
  });

  // NOW: Parse [[ISSUE: text]] markers in article with instant tooltips
  const issueRegex = /\[\[ISSUE:\s*(.+?)\]\]/g;
  const seenIssues = new Map();
  let nextIssueNum = 1;

  const html = articleText.replace(issueRegex, (match, problemText) => {
    const normalizedText = problemText.trim().toLowerCase();
    let issueNum;

    if (seenIssues.has(normalizedText)) {
      issueNum = seenIssues.get(normalizedText);
    } else {
      issueNum = nextIssueNum++;
      seenIssues.set(normalizedText, issueNum);
    }

    // Try position-based matching first
    let tooltipText = issueByNum.get(String(issueNum));

    // If not found, try content-based matching
    if (!tooltipText) {
      tooltipText = issueByContent.get(normalizedText);
      if (!tooltipText) {
        // Partial match as fallback
        for (const [key, tip] of issueByContent.entries()) {
          if (key.includes(normalizedText) || normalizedText.includes(key)) {
            tooltipText = tip;
            break;
          }
        }
      }
    }

    if (!tooltipText) {
      tooltipText = `Issue #${issueNum}`;
    }

    const escapedTooltip = escapeHtml(tooltipText).replace(/\n/g, '<br>');

    return `<span class="edit-issue"><span class="instant-tooltip">${escapedTooltip}</span>${escapeHtml(problemText)}</span><sup>[${issueNum}]</sup>`;
  });

  copyeditOutput.innerHTML = html.replace(/\n/g, '<br>');

  // Display issues list
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

// Parse and render flag claims results
function renderFlagClaims(text) {
  const claims = [];

  // Split article from claims list
  const parts = text.split(/---CLAIMS---/i);
  const articleText = parts[0].trim();
  const claimsText = parts[1] || '';

  // Helper to get CSS class suffix from category
  function getCategoryClass(category) {
    const cat = category.trim().toLowerCase();
    const validCategories = ['statistic', 'quote', 'historical', 'scientific', 'biographical', 'current', 'legal', 'policy', 'sensitive'];
    return validCategories.includes(cat) ? cat : 'historical'; // default fallback
  }

  // Parse [[CLAIM: text | category | reason]] markers
  const claimRegex = /\[\[CLAIM:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\]\]/g;

  let html = articleText.replace(claimRegex, (match, claim, category, reason) => {
    const catClass = getCategoryClass(category);
    claims.push({ claim, category: category.trim(), reason, catClass });
    const tooltipText = `${escapeHtml(category)}: ${escapeHtml(reason)}`;
    return `<span class="claim-to-verify claim-category-${catClass}"><span class="instant-tooltip">${tooltipText}</span>${escapeHtml(claim)}</span>`;
  });

  flagclaimsOutput.innerHTML = html.replace(/\n/g, '<br>');

  // Parse the claims list
  if (claimsText.trim()) {
    const listRegex = /(\d+)\.\s*"([^"]+)"\s*\(([^)]+)\)\s*[-–—]\s*(.+?)(?=\n\d+\.|$)/gs;
    const parsedClaims = [];
    let match;
    while ((match = listRegex.exec(claimsText)) !== null) {
      const catClass = getCategoryClass(match[3]);
      parsedClaims.push({
        index: match[1],
        claim: match[2],
        category: match[3].trim(),
        verify: match[4].trim(),
        catClass
      });
    }

    if (parsedClaims.length > 0) {
      flagclaimsList.innerHTML = parsedClaims.map(c =>
        `<li class="claim-item-${c.catClass}"><span class="claim-category claim-category-badge-${c.catClass}">${escapeHtml(c.category)}</span> "${escapeHtml(c.claim)}" — ${escapeHtml(c.verify)}</li>`
      ).join('');
      flagclaimsListContainer.classList.remove('hidden');
    } else if (claims.length > 0) {
      // Fallback: use inline claims
      flagclaimsList.innerHTML = claims.map(c =>
        `<li class="claim-item-${c.catClass}"><span class="claim-category claim-category-badge-${c.catClass}">${escapeHtml(c.category)}</span> "${escapeHtml(c.claim)}" — ${escapeHtml(c.reason)}</li>`
      ).join('');
      flagclaimsListContainer.classList.remove('hidden');
    } else {
      flagclaimsListContainer.classList.add('hidden');
    }
  } else {
    flagclaimsListContainer.classList.add('hidden');
  }
}

// Parse and render fact-check results
function renderFactCheck(text) {
  const claims = [];

  // Helper to extract URL from text
  function extractUrl(text) {
    const urlMatch = text.match(/https?:\/\/[^\s\]]+/);
    return urlMatch ? urlMatch[0] : null;
  }

  // Helper to format detail with link
  function formatDetailWithLink(detail, url) {
    if (!detail) return '';
    // Remove URL from detail text if it's at the end
    let cleanDetail = detail.replace(/\s*https?:\/\/[^\s]+\s*$/, '').trim();
    if (url) {
      return ` — ${escapeHtml(cleanDetail)} <a href="${escapeHtml(url)}" target="_blank" class="source-link">[source]</a>`;
    }
    return ` — ${escapeHtml(cleanDetail)}`;
  }

  // Helper to create tooltip span
  function makeTooltip(content) {
    if (!content) return '';
    return `<span class="instant-tooltip">${escapeHtml(content)}</span>`;
  }

  // Parse different claim types - now with 3 parts: claim | detail | url
  const verifiedRegex = /\[\[VERIFIED:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\]\]/g;
  const verifiedSimpleRegex = /\[\[VERIFIED:\s*(.+?)\s*\|\s*(.+?)\]\]/g;
  const verifiedBasicRegex = /\[\[VERIFIED:\s*(.+?)\]\]/g;
  const questionableRegex = /\[\[QUESTIONABLE:\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\]\]/g;
  const incorrectRegex = /\[\[INCORRECT:\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\]\]/g;
  const checkCurrentRegex = /\[\[CHECK_CURRENT:\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\]\]/g;

  let html = text;

  // Replace verified claims (with evidence and URL)
  html = html.replace(verifiedRegex, (match, claim, evidence, url) => {
    const cleanUrl = extractUrl(url) || extractUrl(evidence);
    claims.push({ type: 'verified', claim, detail: evidence, url: cleanUrl });
    const tooltipContent = evidence || 'Verified';
    return `<span class="claim-verified">${makeTooltip(tooltipContent)}${escapeHtml(claim)}</span>`;
  });

  // Replace verified claims (with evidence, no URL)
  html = html.replace(verifiedSimpleRegex, (match, claim, evidence) => {
    const url = extractUrl(evidence);
    claims.push({ type: 'verified', claim, detail: evidence, url });
    return `<span class="claim-verified">${makeTooltip(evidence)}${escapeHtml(claim)}</span>`;
  });

  // Replace verified claims (basic - no evidence)
  html = html.replace(verifiedBasicRegex, (match, claim) => {
    claims.push({ type: 'verified', claim, detail: null, url: null });
    return `<span class="claim-verified">${makeTooltip('Verified')}${escapeHtml(claim)}</span>`;
  });

  // Replace questionable claims
  html = html.replace(questionableRegex, (match, claim, concern, url) => {
    const cleanUrl = url ? extractUrl(url) : extractUrl(concern);
    claims.push({ type: 'questionable', claim, detail: concern, url: cleanUrl });
    return `<span class="claim-questionable">${makeTooltip(concern)}${escapeHtml(claim)}</span>`;
  });

  // Replace incorrect claims
  html = html.replace(incorrectRegex, (match, claim, correction, url) => {
    const cleanUrl = url ? extractUrl(url) : extractUrl(correction);
    claims.push({ type: 'incorrect', claim, detail: correction, url: cleanUrl });
    return `<span class="claim-incorrect">${makeTooltip(correction)}${escapeHtml(claim)}</span>`;
  });

  // Replace check-current claims
  html = html.replace(checkCurrentRegex, (match, claim, whatToCheck, url) => {
    const cleanUrl = url ? extractUrl(url) : extractUrl(whatToCheck);
    claims.push({ type: 'check-current', claim, detail: whatToCheck, url: cleanUrl });
    return `<span class="claim-check-current">${makeTooltip(whatToCheck)}${escapeHtml(claim)}</span>`;
  });

  factcheckOutput.innerHTML = html.replace(/\n/g, '<br>');

  if (claims.length > 0) {
    factcheckClaimsList.innerHTML = claims.map(c => {
      const icon = c.type === 'verified' ? '✓' : c.type === 'questionable' ? '?' : c.type === 'incorrect' ? '✗' : '⏱';
      const detailHtml = formatDetailWithLink(c.detail, c.url);
      return `<li class="claim-item-${c.type}"><span class="claim-icon">${icon}</span> ${escapeHtml(c.claim)}${detailHtml}</li>`;
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
  flagclaimsSection.classList.add('hidden');
  factcheckSection.classList.add('hidden');
  headlinesList.innerHTML = '';
  socialData = { substack: [], twitter: [], instagram: [] };
  socialContent.innerHTML = '';
  copyeditOutput.innerHTML = '';
  copyeditIssuesList.innerHTML = '';
  copyeditIssues.classList.add('hidden');
  flagclaimsOutput.innerHTML = '';
  flagclaimsList.innerHTML = '';
  flagclaimsListContainer.classList.add('hidden');
  factcheckOutput.innerHTML = '';
  factcheckClaimsList.innerHTML = '';
  factcheckClaims.classList.add('hidden');
}
