/**
 * ---------------------------------------------------------------------------
 * GOOGLE DOCS + GPT-5.2
 * - Process Selected Text (one-shot, via /docs-agent)
 * - Chat Sidebar (ChatGPT-like, via /v2/*)
 * - Chat with Document (legacy threaded, history on backend, via /chat-docs)
 * ---------------------------------------------------------------------------
 */

function onOpen() {
  DocumentApp.getUi().createMenu('Assistant')
    .addItem('Open Chat Sidebar', 'showChatSidebar')
    .addItem('Open Chat (wide window)', 'showChatDialog')
    .addItem('Reset Doc Assist (this document)', 'resetDocAssistForThisDocument')
    .addItem('Reset Server State (this document)', 'resetServerStateForThisDocumentMenu')
    .addSeparator()
    .addItem('Sync Document to Knowledge', 'syncDocumentToKnowledge')
    .addSeparator()
    .addItem('Process Selected Text (legacy)', 'processSelection')
    .addItem('Chat with Document (legacy)', 'chatWithDocument')
    .addToUi();
}

function resetDocAssistForThisDocument() {
  const started = Date.now();
  const ui = DocumentApp.getUi();

  const result = ui.alert(
    'Reset Doc Assist for this document?',
    'This will delete the saved Project Instructions for this Google Doc (DOCASSIST_INSTRUCTIONS).\n\nIt will not change server-side session/history.',
    ui.ButtonSet.YES_NO
  );

  if (result !== ui.Button.YES) {
    log_('doc.reset.cancel', { ms: Date.now() - started });
    return;
  }

  const docProps = PropertiesService.getDocumentProperties();
  docProps.deleteProperty('DOCASSIST_INSTRUCTIONS');

  log_('doc.reset.ok', { ms: Date.now() - started });

  ui.alert(
    'Reset complete',
    'Project Instructions cleared for this document. Open the sidebar to set new instructions.',
    ui.ButtonSet.OK
  );
}

function resetServerStateForThisDocumentMenu() {
  const started = Date.now();
  const ui = DocumentApp.getUi();

  const result = ui.alert(
    'Reset server state for this document?',
    'This will delete server-side session/history for this Google Doc (v2).\n\nIt will not delete your Google Doc content.',
    ui.ButtonSet.YES_NO
  );

  if (result !== ui.Button.YES) {
    log_('v2.reset_doc.cancel', { ms: Date.now() - started });
    return;
  }

  const resp = resetServerStateForThisDocument();
  log_('v2.reset_doc.menu', { ms: Date.now() - started, deleted: resp && resp.deleted ? resp.deleted : {} });
  ui.alert('Reset complete', 'Server state reset for this document.', ui.ButtonSet.OK);
}

// ====== MINIMAL SERVER-SIDE LOGGING ======

function log_(event, meta) {
  try {
    const payload = {
      ts: new Date().toISOString(),
      event: String(event || ''),
      meta: sanitizeForLog_(meta)
    };
    console.log(JSON.stringify(payload));
  } catch (e) {
    // Never fail the user flow because logging failed.
  }
}

function sanitizeForLog_(value) {
  const maxStr = 200;
  const maxKeys = 30;

  const redactKey = (k) => {
    const key = String(k || '').toLowerCase();
    return key.includes('token') || key.includes('authorization') || key.includes('apikey') || key.includes('api_key');
  };

  const clip = (s) => {
    const str = String(s);
    if (str.length <= maxStr) return str;
    return str.slice(0, maxStr) + `…(+${str.length - maxStr} chars)`;
  };

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return clip(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  // Avoid dumping huge blobs
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();

    if (Array.isArray(value)) {
      return {
        _type: 'array',
        length: value.length
      };
    }

    const out = {};
    const keys = Object.keys(value).slice(0, maxKeys);
    keys.forEach((k) => {
      if (redactKey(k)) {
        out[k] = '[REDACTED]';
        return;
      }
      const v = value[k];
      if (k === 'contentBase64') {
        out[k] = v ? `[base64 ${String(v).length} chars]` : '';
        return;
      }
      if (k === 'docText') {
        out[k] = v ? `[docText ${String(v).length} chars]` : '';
        return;
      }
      if (k === 'instructions' || k === 'userMessage') {
        out[k] = v ? clip(v) : '';
        return;
      }
      out[k] = sanitizeForLog_(v);
    });

    if (Object.keys(value).length > keys.length) {
      out._truncatedKeys = Object.keys(value).length - keys.length;
    }
    return out;
  }

  return String(value);
}

// ====== V2 SIDEBAR (ChatGPT-like) ======

function showChatSidebar() {
  const html = HtmlService
    .createHtmlOutput(getChatSidebarHtml_())
    .setTitle('Assistant Chat');
  DocumentApp.getUi().showSidebar(html);
}

function showChatDialog() {
  const html = HtmlService
    .createHtmlOutput(getChatSidebarHtml_())
    .setTitle('Assistant Chat');

  // Dialogs can be wider than sidebars.
  // Note: Docs UI may still enforce max sizes depending on screen.
  html.setWidth(900).setHeight(800);

  DocumentApp.getUi().showModelessDialog(html, 'Assistant Chat');
}

function getChatSidebarHtml_() {
  return String.raw`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { background: #fff; }
      body { font-family: Arial, sans-serif; font-size: 13px; margin: 0; padding: 12px; box-sizing: border-box; overflow-y: auto; overflow-x: hidden; }
      .row { margin-bottom: 10px; }
      label { display: block; font-weight: 600; margin-bottom: 4px; }
      input[type="text"], input[type="password"], textarea {
        width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid #dadce0; border-radius: 6px;
      }
      textarea { min-height: 70px; resize: vertical; }
      button { padding: 7px 10px; border: 1px solid #dadce0; border-radius: 6px; background: #fff; cursor: pointer; }
      button.primary { background: #1a73e8; color: #fff; border-color: #1a73e8; }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
      .top-area { }
      .chat-row { }
      .chat { border: 1px solid #dadce0; border-radius: 6px; padding: 8px; height: 260px; overflow: auto; background: #fafafa; overflow-wrap: anywhere; word-break: break-word; }
      #msg { min-height: 110px; max-height: 180px; }
      .msg { margin: 8px 0; }
      .role { font-weight: 700; margin-right: 6px; }
      .status { color: #5f6368; font-size: 12px; min-height: 16px; }
      .small { font-size: 12px; color: #5f6368; }
      details { border: 1px solid #dadce0; border-radius: 6px; padding: 8px; background: #fff; }
      summary { cursor: pointer; font-weight: 600; }
      summary::-webkit-details-marker { display: none; }
      .details-body { margin-top: 10px; }

      /* Rendered markdown inside chat */
      .chat p { margin: 6px 0; }
      .chat h1, .chat h2, .chat h3, .chat h4, .chat h5, .chat h6 { margin: 10px 0 6px; font-size: 13px; }
      .chat ul, .chat ol { margin: 6px 0; padding-left: 18px; }
      .chat li { margin: 2px 0; }
      .chat code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
      .chat pre { margin: 8px 0; padding: 8px; border: 1px solid #dadce0; border-radius: 6px; background: #fff; overflow: auto; }
      .chat pre code { white-space: pre; }
    </style>
  </head>
  <body>
    <div class="top-area">
      <div class="row chat-row">
        <label>Chat</label>
        <div id="chat" class="chat"></div>
      </div>

      <div class="row">
        <label>Your message</label>
        <textarea id="msg" placeholder="Ask something about the doc, or request edits..."></textarea>
        <div class="controls" style="margin-top:6px;">
          <button id="sendBtn" class="primary">Send</button>
          <button id="copyLastBtn" title="Copy the most recent Assistant reply">Copy last reply</button>
          <button id="insertMdBtn" title="Insert the most recent Assistant reply with basic Markdown formatting">Insert last reply (Markdown)</button>
        </div>
      </div>
    </div>

    <div class="row controls">
      <button id="syncBtn">Sync current tab</button>
      <button id="syncAllBtn">Sync all tabs</button>
      <label style="display:flex; align-items:center; gap:6px; font-weight:400;">
        Tab
        <select id="tabPicker" style="max-width: 220px;">
          <option value="">Auto (active/first)</option>
        </select>
      </label>
      <label style="display:flex; align-items:center; gap:6px; font-weight:400;">
        <input id="autoSync" type="checkbox" />
        Auto-sync before sending
      </label>
      <label style="display:flex; align-items:center; gap:6px; font-weight:400;">
        <input id="autoAppend" type="checkbox" checked />
        Auto-append to Chat Log
      </label>
      <label style="display:flex; align-items:center; gap:6px; font-weight:400;">
        <input id="replaceKnowledge" type="checkbox" />
        Replace previous knowledge
      </label>
    </div>
    <div class="row">
      <label>Scope (file picker)</label>
      <select id="fileScope">
        <option value="">All files</option>
      </select>
      <div class="small">Pick a file to scope chat to it. Upload/sync creates selectable items.</div>
    </div>

    <div class="row">
      <label>Files</label>
      <input id="fileInput" type="file" />
      <div class="controls" style="margin-top:6px;">
        <button id="uploadBtn">Upload File</button>
      </div>
      <div class="small">Uploads and indexes the file for file search.</div>
    </div>

    <div class="row">
      <details id="instructionsDetails">
        <summary>Project instructions (system message)</summary>
        <div class="details-body">
          <textarea id="instructions" placeholder="Long instructions (like ChatGPT Project instructions)"></textarea>
          <div class="controls" style="margin-top:6px;">
            <button id="saveInstrBtn">Save Instructions</button>
          </div>
        </div>
      </details>
    </div>

    <div class="row">
      <details id="settings">
        <summary>Connection settings</summary>
        <div class="details-body">
          <div class="row">
            <label>Backend info</label>
            <div id="backendInfo" class="small">Not loaded.</div>
            <div class="controls" style="margin-top:6px;">
              <button id="refreshInfoBtn">Refresh</button>
            </div>
          </div>

          <div class="row">
            <label>Backend URL</label>
            <input id="baseUrl" type="text" placeholder="https://your-server.example.com" />
            <div class="small">Stored in Script Properties as <code>DOCASSIST_BASE_URL</code>.</div>
          </div>

          <div class="row">
            <label>Backend Token (optional)</label>
            <input id="token" type="password" placeholder="Token (not including 'Bearer')" />
            <div class="small">Stored in Script Properties as <code>DOCASSIST_TOKEN</code>.</div>
          </div>

          <div class="row controls">
            <button id="saveSettingsBtn">Save Settings</button>
          </div>

          <div class="row">
            <label>Reset server state</label>
            <div class="controls" style="margin-top:6px;">
              <button id="resetServerBtn">Reset Server State</button>
            </div>
            <div class="small">Deletes server-side v2 session/history for this doc.</div>
          </div>
        </div>
      </details>
    </div>

    <div id="status" class="status"></div>

    <script>
      const el = (id) => document.getElementById(id);
      const TICK = String.fromCharCode(96);
      const chatHistory = [];

      function escapeHtml(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function renderInlineMarkdown(text) {
        // Start from escaped text so we never allow raw HTML injection.
        let t = escapeHtml(text);

        // Inline code first to avoid formatting inside code spans.
        const inlineCodeRe = new RegExp(TICK + '([^' + TICK + ']+)' + TICK, 'g');
        t = t.replace(inlineCodeRe, '<code>$1</code>');

        // Bold / italic (simple, common cases)
        t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        t = t.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');

        return t;
      }

      function renderMarkdown(md) {
        const src = String(md || '').replace(/\r\n/g, '\n');
        let out = '';
        let last = 0;

        // Handle fenced code blocks (triple-backtick style)
        const fence = TICK + TICK + TICK;
        const fenceRe = new RegExp(fence + '([a-zA-Z0-9_-]+)?\\n([\\s\\S]*?)' + fence, 'g');

        let m;
        while ((m = fenceRe.exec(src)) !== null) {
          out += renderBlocks_(src.slice(last, m.index));
          const code = escapeHtml(m[2]);
          out += '<pre><code>' + code + '</code></pre>';
          last = fenceRe.lastIndex;
        }
        out += renderBlocks_(src.slice(last));
        return out;
      }

      function renderBlocks_(text) {
        const lines = String(text || '').split('\n');
        let html = '';
        let paragraph = [];
        let inUl = false;
        let inOl = false;

        const flushParagraph = () => {
          if (!paragraph.length) return;
          const content = renderInlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br/>');
          html += '<p>' + content + '</p>';
          paragraph = [];
        };

        const closeLists = () => {
          if (inUl) { html += '</ul>'; inUl = false; }
          if (inOl) { html += '</ol>'; inOl = false; }
        };

        for (const rawLine of lines) {
          const line = rawLine.replace(/\s+$/g, '');

          // Blank line: end paragraph / lists
          if (!line.trim()) {
            flushParagraph();
            closeLists();
            continue;
          }

          // Headings (# .. ######)
          const h = line.match(/^(#{1,6})\s+(.+)$/);
          if (h) {
            flushParagraph();
            closeLists();
            const level = h[1].length;
            html += '<h' + level + '>' + renderInlineMarkdown(h[2].trim()) + '</h' + level + '>';
            continue;
          }

          // Unordered list item
          const ul = line.match(/^\s*[-*]\s+(.+)$/);
          if (ul) {
            flushParagraph();
            if (inOl) { html += '</ol>'; inOl = false; }
            if (!inUl) { html += '<ul>'; inUl = true; }
            html += '<li>' + renderInlineMarkdown(ul[1]) + '</li>';
            continue;
          }

          // Ordered list item
          const ol = line.match(/^\s*\d+\.\s+(.+)$/);
          if (ol) {
            flushParagraph();
            if (inUl) { html += '</ul>'; inUl = false; }
            if (!inOl) { html += '<ol>'; inOl = true; }
            html += '<li>' + renderInlineMarkdown(ol[1]) + '</li>';
            continue;
          }

          // Normal paragraph line
          closeLists();
          paragraph.push(line);
        }

        flushParagraph();
        closeLists();
        return html;
      }

      function setStatus(text) {
        el('status').textContent = text || '';
      }

      async function writeClipboardText_(text) {
        const t = String(text || '');
        if (!t) throw new Error('Nothing to copy.');

        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(t);
          return;
        }

        // Fallback for environments where Clipboard API is unavailable.
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('Copy failed (clipboard not available).');
      }

      function getLastCopyText_() {
        for (let i = chatHistory.length - 1; i >= 0; i--) {
          const msg = chatHistory[i];
          if (!msg) continue;
          const roleLower = String(msg.role || '').toLowerCase();
          if (roleLower === 'assistant' || roleLower.includes('assistant') || roleLower.includes('gpt')) {
            const t = String(msg.text || '').trim();
            if (t) return t;
          }
        }
        const last = chatHistory.length ? chatHistory[chatHistory.length - 1] : null;
        return last ? String(last.text || '').trim() : '';
      }

      async function copyLastReply_() {
        try {
          const text = getLastCopyText_();
          if (!text) {
            setStatus('Nothing to copy yet.');
            return;
          }
          await writeClipboardText_(text);
          setStatus('Copied. Inserting into doc...');
          google.script.run
            .withSuccessHandler(() => {
              setStatus('Copied and inserted into doc.');
            })
            .withFailureHandler((err) => {
              setStatus('Copied, but insert failed: ' + (err && err.message ? err.message : err));
            })
            .insertTextIntoDocFromSidebar(text);
        } catch (e) {
          setStatus('Copy failed: ' + (e && e.message ? e.message : e));
        }
      }

      function addMsg(role, text) {
        chatHistory.push({ role: String(role || ''), text: String(text || '') });
        const div = document.createElement('div');
        div.className = 'msg';
        const roleSpan = document.createElement('span');
        roleSpan.className = 'role';
        roleSpan.textContent = role + ':';
        const textSpan = document.createElement('span');

        // Render assistant as (safe) markdown; keep user as plain text.
        const roleLower = String(role || '').toLowerCase();
        const isAssistant = roleLower === 'assistant' || roleLower.includes('assistant') || roleLower.includes('gpt');
        if (isAssistant) {
          textSpan.innerHTML = renderMarkdown(text);
        } else {
          textSpan.innerHTML = escapeHtml(text).replace(/\n/g, '<br/>');
        }

        div.appendChild(roleSpan);
        div.appendChild(textSpan);
        el('chat').appendChild(div);
        el('chat').scrollTop = el('chat').scrollHeight;
      }

      function addSources_(sources) {
        const list = Array.isArray(sources) ? sources : [];
        if (!list.length) return;
        const div = document.createElement('div');
        div.className = 'msg';
        const roleSpan = document.createElement('span');
        roleSpan.className = 'role';
        roleSpan.textContent = 'Sources:';
        const textSpan = document.createElement('span');

        const lines = list.map((s) => {
          const name = s && s.filename ? String(s.filename) : '(source)';
          const section = s && s.section ? (' — ' + String(s.section)) : '';
          const snippet = s && s.snippet ? (' — "' + String(s.snippet) + '"') : '';
          return '• ' + name + section + snippet;
        });
        textSpan.innerHTML = escapeHtml(lines.join('\n')).replace(/\n/g, '<br/>');

        div.appendChild(roleSpan);
        div.appendChild(textSpan);
        el('chat').appendChild(div);
        el('chat').scrollTop = el('chat').scrollHeight;
      }

      function disableAll(disabled) {
        ['saveSettingsBtn','resetServerBtn','syncBtn','syncAllBtn','saveInstrBtn','uploadBtn','sendBtn','copyLastBtn','insertMdBtn','fileScope'].forEach(id => {
          try { el(id).disabled = disabled; } catch (e) {}
        });
      }

      el('copyLastBtn').addEventListener('click', () => copyLastReply_());

      function insertLastReplyMarkdown_() {
        try {
          const text = getLastCopyText_();
          if (!text) {
            setStatus('Nothing to insert yet.');
            return;
          }

          disableAll(true);
          setStatus('Inserting formatted reply into doc...');

          google.script.run
            .withSuccessHandler(() => {
              setStatus('Inserted formatted reply into doc.');
              disableAll(false);
            })
            .withFailureHandler((err) => {
              setStatus('Insert failed: ' + (err && err.message ? err.message : err));
              disableAll(false);
            })
            .insertMarkdownIntoDocFromSidebar(text);
        } catch (e) {
          setStatus('Insert failed: ' + (e && e.message ? e.message : e));
          try { disableAll(false); } catch (err) {}
        }
      }

      el('insertMdBtn').addEventListener('click', () => insertLastReplyMarkdown_());

      function loadState() {
        setStatus('Loading settings...');
        google.script.run.withSuccessHandler((state) => {
          const settingsEl = document.getElementById('settings');
          el('baseUrl').value = state.baseUrl || '';
          el('token').value = state.token || '';
          el('instructions').value = state.instructions || '';
          try { if (el('autoAppend')) el('autoAppend').checked = true; } catch (e) {}
          try { if (el('fileScope')) el('fileScope').value = (state.fileScopeId != null ? String(state.fileScopeId) : ''); } catch (e) {}
          try { if (el('tabPicker')) el('tabPicker').value = (state.selectedTabId != null ? String(state.selectedTabId) : ''); } catch (e) {}
          if (settingsEl) settingsEl.open = !state.baseUrl;
          setStatus(state.baseUrl ? 'Ready.' : 'Set Backend URL first (open Connection settings).');

          if (state.baseUrl) {
            refreshBackendInfo_();
            refreshFiles_();
            refreshTabs_();
          }
        }).withFailureHandler((err) => {
          setStatus('Error loading state: ' + (err && err.message ? err.message : err));
        }).getSidebarState();
      }

      function setFileScope_(fileId) {
        google.script.run
          .withFailureHandler(() => { /* best-effort */ })
          .setFileScopeIdForThisDocument(fileId);
      }

      function setTabSelection_(tabId) {
        google.script.run
          .withFailureHandler(() => { /* best-effort */ })
          .setSelectedTabIdForThisDocument(tabId);
      }

      function refreshFiles_() {
        const sel = el('fileScope');
        if (!sel) return;
        const current = String(sel.value || '');

        // Keep the first option (All files).
        while (sel.options.length > 1) sel.remove(1);

        google.script.run
          .withSuccessHandler((resp) => {
            const files = (resp && resp.files) ? resp.files : [];
            for (const f of files) {
              if (!f || f.id == null) continue;
              const opt = document.createElement('option');
              opt.value = String(f.id);
              const name = String(f.filename || '(unnamed)');
              const kind = String(f.kind || '');
              opt.textContent = (kind ? ('[' + kind + '] ') : '') + name;
              if (f.hasFileScope === false) {
                opt.textContent += ' (not selectable yet)';
                opt.disabled = true;
              }
              sel.appendChild(opt);
            }

            // Restore selection if still present.
            const maybe = Array.from(sel.options).some(o => o.value === current);
            sel.value = maybe ? current : '';
            setFileScope_(sel.value);
          })
          .withFailureHandler((err) => {
            setStatus('Failed to load files: ' + (err && err.message ? err.message : err));
          })
          .listFilesForThisDocument();
      }

      el('fileScope').addEventListener('change', () => {
        try { setFileScope_(el('fileScope').value); } catch (e) {}
      });

      function refreshTabs_() {
        const sel = el('tabPicker');
        if (!sel) return;
        const current = String(sel.value || '');

        while (sel.options.length > 1) sel.remove(1);

        google.script.run
          .withSuccessHandler((resp) => {
            const tabs = (resp && resp.tabs) ? resp.tabs : [];
            for (const t of tabs) {
              if (!t || !t.tabId) continue;
              const opt = document.createElement('option');
              opt.value = String(t.tabId);
              const title = String(t.title || '').trim();
              opt.textContent = title ? title : ('Tab ' + String(t.tabId).slice(0, 8));
              sel.appendChild(opt);
            }

            const maybe = Array.from(sel.options).some(o => o.value === current);
            sel.value = maybe ? current : (sel.value || '');
            setTabSelection_(sel.value);
          })
          .withFailureHandler((err) => {
            setStatus('Failed to load tabs: ' + (err && err.message ? err.message : err));
          })
          .listTabsForThisDocument();
      }

      el('tabPicker').addEventListener('change', () => {
        try { setTabSelection_(el('tabPicker').value); } catch (e) {}
      });

      function refreshBackendInfo_() {
        const infoEl = document.getElementById('backendInfo');
        if (infoEl) infoEl.textContent = 'Loading...';

        google.script.run
          .withSuccessHandler((info) => {
            try {
              const cfg = (info && info.config) ? info.config : {};
              const model = cfg.model || '';
              const mot = (cfg.maxOutputTokens != null) ? String(cfg.maxOutputTokens) : '';
              const bl = cfg.bodyLimit || '';
              const rl = (cfg.rateLimit && cfg.rateLimit.enabled) ? 'on' : 'off';

              const line = 'model=' + model +
                ' | max_output_tokens=' + mot +
                ' | body_limit=' + bl +
                ' | rate_limit=' + rl;
              if (infoEl) infoEl.textContent = line;
            } catch (e) {
              if (infoEl) infoEl.textContent = 'Loaded, but failed to render.';
            }
          })
          .withFailureHandler((err) => {
            if (infoEl) infoEl.textContent = 'Error: ' + (err && err.message ? err.message : err);
          })
          .getBackendInfo();
      }

      el('saveSettingsBtn').addEventListener('click', () => {
        disableAll(true);
        setStatus('Saving settings...');
        google.script.run.withSuccessHandler(() => {
          setStatus('Settings saved.');
          refreshBackendInfo_();
          disableAll(false);
        }).withFailureHandler((err) => {
          setStatus('Error saving settings: ' + (err && err.message ? err.message : err));
          disableAll(false);
        }).saveSidebarSettings(el('baseUrl').value, el('token').value);
      });

      el('refreshInfoBtn').addEventListener('click', () => refreshBackendInfo_());

      function resetServerState_() {
        const ok = window.confirm('Reset server state for this document? This deletes server-side session/history.');
        if (!ok) return;

        disableAll(true);
        setStatus('Resetting server state...');

        google.script.run
          .withSuccessHandler(() => {
            // Clear local UI history too (best-effort).
            try {
              chatHistory.length = 0;
              const chatEl = el('chat');
              if (chatEl) chatEl.innerHTML = '';
            } catch (e) {}

            setStatus('Server state reset.');
            disableAll(false);
          })
          .withFailureHandler((err) => {
            setStatus('Reset failed: ' + (err && err.message ? err.message : err));
            disableAll(false);
          })
          .resetServerStateForThisDocument();
      }

      el('resetServerBtn').addEventListener('click', () => resetServerState_());

      el('saveInstrBtn').addEventListener('click', () => {
        disableAll(true);
        setStatus('Saving instructions...');
        google.script.run.withSuccessHandler(() => {
          setStatus('Instructions saved.');
          disableAll(false);
        }).withFailureHandler((err) => {
          setStatus('Error saving instructions: ' + (err && err.message ? err.message : err));
          disableAll(false);
        }).saveProjectInstructions(el('instructions').value);
      });

      el('syncBtn').addEventListener('click', () => {
        disableAll(true);
        setStatus('Syncing tab...');
        google.script.run.withSuccessHandler(() => {
          setStatus('Tab synced.');
          try { refreshFiles_(); } catch (e) {}
          disableAll(false);
        }).withFailureHandler((err) => {
          setStatus('Error syncing document: ' + (err && err.message ? err.message : err));
          disableAll(false);
        }).syncDocumentToKnowledge(el('instructions').value, Boolean(el('replaceKnowledge') && el('replaceKnowledge').checked), el('tabPicker') ? el('tabPicker').value : '');
      });

      el('syncAllBtn').addEventListener('click', () => {
        disableAll(true);
        setStatus('Syncing all tabs...');
        google.script.run.withSuccessHandler(() => {
          setStatus('All tabs synced.');
          try { refreshFiles_(); } catch (e) {}
          disableAll(false);
        }).withFailureHandler((err) => {
          setStatus('Error syncing tabs: ' + (err && err.message ? err.message : err));
          disableAll(false);
        }).syncAllTabsToKnowledge(el('instructions').value, Boolean(el('replaceKnowledge') && el('replaceKnowledge').checked));
      });

      el('uploadBtn').addEventListener('click', async () => {
        const file = el('fileInput').files && el('fileInput').files[0];
        if (!file) {
          setStatus('Choose a file first.');
          return;
        }
        disableAll(true);
        setStatus('Reading file...');
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () => reject(reader.error);
          reader.onload = () => {
            const dataUrl = String(reader.result || '');
            const comma = dataUrl.indexOf(',');
            resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
          };
          reader.readAsDataURL(file);
        });

        setStatus('Uploading file...');
        google.script.run.withSuccessHandler(() => {
          setStatus('File uploaded and indexed.');
          try { refreshFiles_(); } catch (e) {}
          disableAll(false);
        }).withFailureHandler((err) => {
          setStatus('Error uploading: ' + (err && err.message ? err.message : err));
          disableAll(false);
        }).uploadFileToKnowledge(file.name, file.type || 'application/octet-stream', base64, el('instructions').value, Boolean(el('replaceKnowledge') && el('replaceKnowledge').checked));
      });

      el('sendBtn').addEventListener('click', () => {
        const text = (el('msg').value || '').trim();
        if (!text) return;
        el('msg').value = '';
        addMsg('You', text);
        disableAll(true);

        const doSend = () => {
          setStatus('Thinking...');
          google.script.run.withSuccessHandler((resp) => {
            const replyText = (resp && typeof resp.reply !== 'undefined') ? resp.reply : resp;
            addMsg('Assistant', replyText || '(empty)');

            if (resp && resp.sources && Array.isArray(resp.sources) && resp.sources.length) {
              addSources_(resp.sources);
            }

            if (el('autoAppend') && el('autoAppend').checked) {
              try {
                google.script.run
                  .withFailureHandler(() => { /* best-effort */ })
                  .appendChatTurnToDoc(text, replyText || '');
              } catch (e) {
                // best-effort
              }
            }

            setStatus('Ready.');
            disableAll(false);
          }).withFailureHandler((err) => {
            setStatus('Error: ' + (err && err.message ? err.message : err));
            disableAll(false);
          }).sendChatMessage(text, el('instructions').value, el('fileScope') ? el('fileScope').value : '');
        };

        if (el('autoSync').checked) {
          setStatus('Auto-syncing tab...');
          google.script.run.withSuccessHandler(() => doSend())
            .withFailureHandler((err) => {
              setStatus('Auto-sync failed: ' + (err && err.message ? err.message : err));
              disableAll(false);
            })
            .syncDocumentToKnowledge(el('instructions').value, Boolean(el('replaceKnowledge') && el('replaceKnowledge').checked), el('tabPicker') ? el('tabPicker').value : '');
        } else {
          doSend();
        }
      });

      loadState();
    </script>
  </body>
</html>
  `.trim();
}

function getSidebarState() {
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  const baseUrl = props.getProperty('DOCASSIST_BASE_URL') || '';
  const token = props.getProperty('DOCASSIST_TOKEN') || '';
  const docProps = PropertiesService.getDocumentProperties();
  const instructions = docProps.getProperty('DOCASSIST_INSTRUCTIONS') || '';
  const fileScopeId = docProps.getProperty('DOCASSIST_FILE_SCOPE_ID') || '';
  const selectedTabId = docProps.getProperty('DOCASSIST_SELECTED_TAB_ID') || '';

  log_('sidebar.get_state', {
    hasBaseUrl: Boolean(baseUrl),
    hasToken: Boolean(token),
    instructionsLen: String(instructions || '').length,
    hasFileScope: Boolean(String(fileScopeId || '').trim()),
    hasSelectedTab: Boolean(String(selectedTabId || '').trim()),
    ms: Date.now() - started
  });

  return { baseUrl: baseUrl, token: token, instructions: instructions, fileScopeId: fileScopeId, selectedTabId: selectedTabId };
}

function setFileScopeIdForThisDocument(fileScopeId) {
  const docProps = PropertiesService.getDocumentProperties();
  const v = String(fileScopeId || '').trim();
  if (!v) {
    docProps.deleteProperty('DOCASSIST_FILE_SCOPE_ID');
  } else {
    docProps.setProperty('DOCASSIST_FILE_SCOPE_ID', v);
  }
}

function setSelectedTabIdForThisDocument(tabId) {
  const docProps = PropertiesService.getDocumentProperties();
  const v = String(tabId || '').trim();
  if (!v) {
    docProps.deleteProperty('DOCASSIST_SELECTED_TAB_ID');
  } else {
    docProps.setProperty('DOCASSIST_SELECTED_TAB_ID', v);
  }
}

function listFilesForThisDocument() {
  const docId = DocumentApp.getActiveDocument().getId();
  const resp = callBackendV2Get_('/v2/list-files?docId=' + encodeURIComponent(String(docId)));
  return resp;
}

function listTabsForThisDocument() {
  const doc = DocumentApp.getActiveDocument();
  const tabs = getTabsWithTextForActiveDocument_().map((t) => ({
    tabId: String(t.tabId),
    title: String(t.title || '')
  }));
  return { ok: true, docId: doc.getId(), tabs: tabs };
}

function saveSidebarSettings(baseUrl, token) {
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('DOCASSIST_BASE_URL', String(baseUrl || '').trim());
  props.setProperty('DOCASSIST_TOKEN', String(token || '').trim());

  log_('sidebar.save_settings', {
    hasBaseUrl: Boolean(String(baseUrl || '').trim()),
    hasToken: Boolean(String(token || '').trim()),
    ms: Date.now() - started
  });
}

function saveProjectInstructions(instructions) {
  const started = Date.now();
  const docProps = PropertiesService.getDocumentProperties();
  docProps.setProperty('DOCASSIST_INSTRUCTIONS', String(instructions || ''));

  log_('sidebar.save_instructions', {
    instructionsLen: String(instructions || '').length,
    ms: Date.now() - started
  });
}

function getProjectInstructions_() {
  const docProps = PropertiesService.getDocumentProperties();
  return docProps.getProperty('DOCASSIST_INSTRUCTIONS') || '';
}

function getBackendBaseUrl_() {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = props.getProperty('DOCASSIST_BASE_URL');
  if (!baseUrl) {
    throw new Error("Missing DOCASSIST_BASE_URL. Open the sidebar and set it first.");
  }
  return String(baseUrl).replace(/\/$/, '');
}

function getBackendToken_() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty('DOCASSIST_TOKEN') || '';
}

function callBackendV2_(path, payload) {
  const started = Date.now();
  const url = getBackendBaseUrl_() + path;
  const token = getBackendToken_();

  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  let json;
  try {
    json = JSON.parse(responseText);
  } catch (err) {
    log_('v2.call.invalid_json', {
      path: path,
      url: url,
      responseCode: responseCode,
      responseTextSample: String(responseText || '').slice(0, 300),
      ms: Date.now() - started
    });
    throw new Error('Backend returned invalid JSON: ' + responseText);
  }

  if (responseCode < 200 || responseCode >= 300) {
    const errorMsg = json && json.error ? json.error : responseText;

    log_('v2.call.error', {
      path: path,
      url: url,
      responseCode: responseCode,
      error: errorMsg,
      ms: Date.now() - started
    });

    throw new Error(errorMsg + ' (HTTP ' + responseCode + ')');
  }

  log_('v2.call.ok', {
    path: path,
    url: url,
    responseCode: responseCode,
    ms: Date.now() - started
  });

  return json;
}

function callBackendV2Get_(path) {
  const started = Date.now();
  const url = getBackendBaseUrl_() + path;
  const token = getBackendToken_();

  const headers = { Accept: 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const options = {
    method: 'get',
    headers: headers,
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  let json;
  try {
    json = responseText ? JSON.parse(responseText) : {};
  } catch (err) {
    log_('v2.call_get.invalid_json', {
      path: path,
      url: url,
      responseCode: responseCode,
      responseTextSample: String(responseText || '').slice(0, 300),
      ms: Date.now() - started
    });
    throw new Error('Backend returned invalid JSON: ' + responseText);
  }

  if (responseCode < 200 || responseCode >= 300) {
    const errorMsg = json && json.error ? json.error : responseText;

    log_('v2.call_get.error', {
      path: path,
      url: url,
      responseCode: responseCode,
      error: errorMsg,
      ms: Date.now() - started
    });

    throw new Error(errorMsg + ' (HTTP ' + responseCode + ')');
  }

  log_('v2.call_get.ok', {
    path: path,
    url: url,
    responseCode: responseCode,
    ms: Date.now() - started
  });

  return json;
}

function getBackendInfo() {
  return callBackendV2Get_('/v2/info');
}

function resetServerStateForThisDocument() {
  const started = Date.now();
  const doc = DocumentApp.getActiveDocument();

  const resp = callBackendV2_('/v2/reset-doc', {
    docId: doc.getId(),
    cleanupOpenAI: true,
  });

  log_('v2.reset_doc', {
    docId: doc.getId(),
    deleted: resp && resp.deleted ? resp.deleted : {},
    ms: Date.now() - started,
  });

  return resp;
}

function ensureV2Session_(instructionsOverride) {
  const started = Date.now();
  const doc = DocumentApp.getActiveDocument();
  const instructions = typeof instructionsOverride === 'string' ? instructionsOverride : getProjectInstructions_();

  const result = callBackendV2_('/v2/init', {
    docId: doc.getId(),
    instructions: instructions
  });

  log_('v2.ensure_session', {
    docId: doc.getId(),
    instructionsLen: String(instructions || '').length,
    ms: Date.now() - started
  });

  return result;
}

// ====== GOOGLE DOCS TABS (REST API) ======

function fetchDocsDocumentRest_(docId) {
  const started = Date.now();
  const url = 'https://docs.googleapis.com/v1/documents/' + encodeURIComponent(String(docId)) + '?includeTabsContent=true';
  const headers = {
    Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
    Accept: 'application/json'
  };

  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: headers,
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  const text = resp.getContentText();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error('Docs API returned invalid JSON (HTTP ' + code + ')');
  }

  if (code < 200 || code >= 300) {
    const msg = (json && json.error && json.error.message) ? json.error.message : (text || 'Docs API error');
    log_('docs.rest.error', { docId: String(docId), code: code, msg: String(msg).slice(0, 300), ms: Date.now() - started });
    throw new Error('Failed to read tabs via Docs API: ' + msg + ' (HTTP ' + code + ')');
  }

  log_('docs.rest.ok', { docId: String(docId), ms: Date.now() - started });
  return json;
}

function flattenTabs_(tabs, out) {
  const arr = Array.isArray(tabs) ? tabs : [];
  for (const t of arr) {
    if (!t) continue;
    out.push(t);
    // Some docs may have nested/child tabs.
    if (Array.isArray(t.childTabs) && t.childTabs.length) {
      flattenTabs_(t.childTabs, out);
    }
  }
}

function extractPlainTextFromElements_(elements) {
  const els = Array.isArray(elements) ? elements : [];
  const out = [];
  for (const el of els) {
    if (!el) continue;
    if (el.paragraph && Array.isArray(el.paragraph.elements)) {
      for (const pe of el.paragraph.elements) {
        const tr = pe && pe.textRun;
        if (tr && typeof tr.content === 'string') {
          out.push(tr.content);
        }
      }
      continue;
    }
    if (el.table && Array.isArray(el.table.tableRows)) {
      for (const row of el.table.tableRows) {
        const cells = row && Array.isArray(row.tableCells) ? row.tableCells : [];
        for (const cell of cells) {
          out.push(extractPlainTextFromElements_(cell && cell.content ? cell.content : []));
        }
      }
      continue;
    }
    if (el.tableOfContents && Array.isArray(el.tableOfContents.content)) {
      out.push(extractPlainTextFromElements_(el.tableOfContents.content));
      continue;
    }
  }
  return out.join('').replace(/\s+/g, ' ').trim();
}

function renderTableAsMarkdown_(table, lines) {
  const rows = table && Array.isArray(table.tableRows) ? table.tableRows : [];
  if (!rows.length) return;

  const renderedRows = rows.map((row) => {
    const cells = row && Array.isArray(row.tableCells) ? row.tableCells : [];
    const values = cells.map((cell) => extractPlainTextFromElements_(cell && cell.content ? cell.content : []));
    return values;
  });

  for (let r = 0; r < renderedRows.length; r++) {
    const vals = renderedRows[r];
    lines.push('| ' + vals.join(' | ') + ' |');
    if (r === 0) {
      const sep = vals.map(() => '---').join(' | ');
      lines.push('| ' + sep + ' |');
    }
  }
  lines.push('');
}

function collectStructuralMarkdownLines_(elements, lines) {
  const els = Array.isArray(elements) ? elements : [];
  for (const el of els) {
    if (!el) continue;

    if (el.paragraph && Array.isArray(el.paragraph.elements)) {
      const para = el.paragraph;
      const text = extractPlainTextFromElements_([{ paragraph: para }]).replace(/\s+$/g, '');
      if (!text) continue;

      const style = para.paragraphStyle && para.paragraphStyle.namedStyleType
        ? String(para.paragraphStyle.namedStyleType)
        : '';

      if (style.indexOf('HEADING_') === 0) {
        const lvl = Number(style.replace('HEADING_', '')) || 1;
        const hashes = '#'.repeat(Math.min(3, Math.max(1, lvl)));
        lines.push(hashes + ' ' + text.trim());
        lines.push('');
        continue;
      }

      if (para.bullet) {
        const nesting = Number(para.bullet.nestingLevel || 0);
        const indent = '  '.repeat(Math.min(3, Math.max(0, nesting)));
        lines.push(indent + '- ' + text.trim());
        continue;
      }

      lines.push(text.trim());
      lines.push('');
      continue;
    }

    if (el.table) {
      renderTableAsMarkdown_(el.table, lines);
      continue;
    }

    if (el.tableOfContents && Array.isArray(el.tableOfContents.content)) {
      collectStructuralMarkdownLines_(el.tableOfContents.content, lines);
      continue;
    }
  }
}

function getTabsWithTextForActiveDocument_() {
  const doc = DocumentApp.getActiveDocument();
  const docId = doc.getId();
  const d = fetchDocsDocumentRest_(docId);
  const flat = [];
  flattenTabs_(d && d.tabs ? d.tabs : [], flat);

  const results = [];
  for (const t of flat) {
    const props = t && t.tabProperties ? t.tabProperties : {};
    const tabId = props && props.tabId ? String(props.tabId) : '';
    if (!tabId) continue;

    const title = props && props.title ? String(props.title) : '';
    const body = t && t.documentTab && t.documentTab.body ? t.documentTab.body : null;
    const lines = [];
    collectStructuralMarkdownLines_(body && body.content ? body.content : [], lines);
    const text = lines.join('\n').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    results.push({ tabId: tabId, title: title, text: text });
  }

  return results;
}

function getActiveTabIdBestEffort_(doc) {
  try {
    if (doc && typeof doc.getActiveTab === 'function') {
      const t = doc.getActiveTab();
      if (t && typeof t.getId === 'function') return String(t.getId());
      if (t && typeof t.getTabId === 'function') return String(t.getTabId());
    }
  } catch (e) {
    // ignore
  }

  try {
    if (doc && typeof doc.getTabs === 'function') {
      const tabs = doc.getTabs();
      if (tabs && tabs.length) {
        for (const t of tabs) {
          try {
            const selected = (t && typeof t.isSelected === 'function') ? t.isSelected() : false;
            if (selected) {
              if (t && typeof t.getId === 'function') return String(t.getId());
              if (t && typeof t.getTabId === 'function') return String(t.getTabId());
            }
          } catch (err) {
            // ignore
          }
        }
      }
    }
  } catch (e2) {
    // ignore
  }

  return '';
}

function syncDocumentToKnowledge(instructionsOverride, replaceKnowledge, tabIdOverride) {
  const started = Date.now();
  const doc = DocumentApp.getActiveDocument();
  const instructions = typeof instructionsOverride === 'string' ? instructionsOverride : getProjectInstructions_();
  ensureV2Session_(instructions);

  const tabs = getTabsWithTextForActiveDocument_();
  if (!tabs.length) {
    // Fallback to legacy behavior (best-effort).
    const legacy = doc.getBody().getText();
    if (!legacy || !legacy.trim()) {
      log_('v2.sync_tab.empty', { docId: doc.getId(), mode: 'legacy_fallback' });
      throw new Error('This tab is empty.');
    }

    const respLegacy = callBackendV2_('/v2/sync-doc', {
      docId: doc.getId(),
      docTitle: doc.getName(),
      docText: legacy,
      instructions: instructions,
      replaceKnowledge: Boolean(replaceKnowledge)
    });

    log_('v2.sync_doc.legacy', {
      docId: doc.getId(),
      docTitle: doc.getName(),
      docTextLen: String(legacy || '').length,
      instructionsLen: String(instructions || '').length,
      replaceKnowledge: Boolean(replaceKnowledge),
      reused: Boolean(respLegacy && respLegacy.reused),
      ms: Date.now() - started
    });

    return respLegacy;
  }

  const activeTabId = getActiveTabIdBestEffort_(doc);
  const docProps = PropertiesService.getDocumentProperties();
  const storedTabId = docProps.getProperty('DOCASSIST_SELECTED_TAB_ID') || '';
  const requestedTabId = String((typeof tabIdOverride === 'string' ? tabIdOverride : '') || storedTabId || '').trim();

  const chosen =
    (requestedTabId && tabs.find(t => t.tabId === requestedTabId))
      ? tabs.find(t => t.tabId === requestedTabId)
      : ((activeTabId && tabs.find(t => t.tabId === activeTabId))
          ? tabs.find(t => t.tabId === activeTabId)
          : tabs[0]);

  const tabText = chosen && chosen.text ? String(chosen.text) : '';
  if (!tabText || !tabText.trim()) {
    log_('v2.sync_tab.empty', { docId: doc.getId(), tabId: chosen ? chosen.tabId : '', activeTabId: activeTabId });
    throw new Error('This tab is empty.');
  }

  const resp = callBackendV2_('/v2/sync-tab', {
    docId: doc.getId(),
    tabId: chosen.tabId,
    tabTitle: chosen.title || '',
    tabText: tabText,
    instructions: instructions,
    replaceKnowledge: Boolean(replaceKnowledge)
  });

  log_('v2.sync_tab', {
    docId: doc.getId(),
    tabId: chosen.tabId,
    tabTitle: chosen.title || '',
    tabTextLen: String(tabText || '').length,
    instructionsLen: String(instructions || '').length,
    replaceKnowledge: Boolean(replaceKnowledge),
    reused: Boolean(resp && resp.reused),
    activeTabId: activeTabId,
    requestedTabId: requestedTabId,
    usedFallbackFirstTab: Boolean(!requestedTabId && (!activeTabId || activeTabId !== chosen.tabId)),
    ms: Date.now() - started
  });

  return resp;
}

function syncAllTabsToKnowledge(instructionsOverride, replaceKnowledge) {
  const started = Date.now();
  const doc = DocumentApp.getActiveDocument();
  const instructions = typeof instructionsOverride === 'string' ? instructionsOverride : getProjectInstructions_();
  ensureV2Session_(instructions);

  const tabs = getTabsWithTextForActiveDocument_();
  if (!tabs.length) {
    throw new Error('No tabs found (Docs API did not return tabs).');
  }

  let replaceApplied = false;
  let synced = 0;
  let skippedEmpty = 0;

  for (const t of tabs) {
    const text = t && t.text ? String(t.text) : '';
    if (!text || !text.trim()) {
      skippedEmpty += 1;
      continue;
    }

    const rk = Boolean(replaceKnowledge) && !replaceApplied;
    const resp = callBackendV2_('/v2/sync-tab', {
      docId: doc.getId(),
      tabId: String(t.tabId),
      tabTitle: t.title || '',
      tabText: text,
      instructions: instructions,
      replaceKnowledge: rk
    });

    synced += 1;
    if (rk) replaceApplied = true;

    log_('v2.sync_tab.batch_item', {
      docId: doc.getId(),
      tabId: String(t.tabId),
      tabTitle: t.title || '',
      tabTextLen: String(text || '').length,
      replaceKnowledge: rk,
      reused: Boolean(resp && resp.reused)
    });
  }

  log_('v2.sync_tab.batch', {
    docId: doc.getId(),
    tabsTotal: tabs.length,
    synced: synced,
    skippedEmpty: skippedEmpty,
    replaceKnowledgeRequested: Boolean(replaceKnowledge),
    replaceApplied: replaceApplied,
    ms: Date.now() - started
  });

  return { ok: true, tabsTotal: tabs.length, synced: synced, skippedEmpty: skippedEmpty };
}

function uploadFileToKnowledge(filename, mimeType, contentBase64, instructionsOverride, replaceKnowledge) {
  const started = Date.now();
  const doc = DocumentApp.getActiveDocument();
  const instructions = typeof instructionsOverride === 'string' ? instructionsOverride : getProjectInstructions_();
  ensureV2Session_(instructions);

  const resp = callBackendV2_('/v2/upload-file', {
    docId: doc.getId(),
    filename: filename,
    mimeType: mimeType,
    contentBase64: contentBase64,
    instructions: instructions,
    replaceKnowledge: Boolean(replaceKnowledge)
  });

  log_('v2.upload_file', {
    docId: doc.getId(),
    filename: filename,
    mimeType: mimeType,
    base64Len: String(contentBase64 || '').length,
    instructionsLen: String(instructions || '').length,
    replaceKnowledge: Boolean(replaceKnowledge),
    reused: Boolean(resp && resp.reused),
    ms: Date.now() - started
  });

  return resp;
}

function sendChatMessage(userMessage, instructionsOverride, fileScopeIdOverride) {
  const started = Date.now();
  const doc = DocumentApp.getActiveDocument();
  const instructions = typeof instructionsOverride === 'string' ? instructionsOverride : getProjectInstructions_();
  ensureV2Session_(instructions);

  const docProps = PropertiesService.getDocumentProperties();
  const storedFileScopeId = docProps.getProperty('DOCASSIST_FILE_SCOPE_ID') || '';
  const fileScopeId = String(
    (typeof fileScopeIdOverride === 'string' ? fileScopeIdOverride : '') || storedFileScopeId || ''
  ).trim();

  const resp = callBackendV2_('/v2/chat', {
    docId: doc.getId(),
    userMessage: String(userMessage || ''),
    instructions: instructions,
    fileId: fileScopeId
  });

  log_('v2.chat', {
    docId: doc.getId(),
    userMessageLen: String(userMessage || '').length,
    instructionsLen: String(instructions || '').length,
    replyLen: resp && resp.reply ? String(resp.reply).length : 0,
    ms: Date.now() - started
  });

  return resp;
}

function appendChatTurnToDoc(userText, assistantText) {
  const started = Date.now();
  const doc = DocumentApp.getActiveDocument();
  const body = doc.getBody();

  const marker = 'Chat Log';
  const markerLine = '=== ' + marker + ' ===';

  // Find the last marker paragraph (exact match), if any.
  let markerIdx = -1;
  const n = body.getNumChildren();
  for (let i = 0; i < n; i++) {
    const child = body.getChild(i);
    if (!child || typeof child.getType !== 'function') continue;
    if (child.getType() !== DocumentApp.ElementType.PARAGRAPH) continue;
    const p = child.asParagraph();
    const t = String(p.getText() || '').trim();
    if (t === markerLine) markerIdx = i;
  }

  // If no marker, append it at the bottom.
  if (markerIdx < 0) {
    const p = body.appendParagraph(markerLine);
    try { p.setHeading(DocumentApp.ParagraphHeading.HEADING2); } catch (e) {}
    body.appendParagraph('');
    markerIdx = body.getNumChildren() - 2;
  }

  // Insert immediately after the marker section start.
  let insertAt = markerIdx + 1;
  const ts = new Date().toISOString();

  const setAllBold_ = (paragraph, isBold) => {
    try {
      const t = paragraph && paragraph.editAsText ? paragraph.editAsText() : null;
      if (t && typeof t.setBold === 'function') t.setBold(Boolean(isBold));
    } catch (e) {
      // best-effort
    }
  };

  const insertPlainParagraph_ = (text) => {
    const p = body.insertParagraph(insertAt, String(text || ''));
    insertAt++;
    setAllBold_(p, false);
    return p;
  };

  const insertLabelParagraph_ = (label) => {
    // Prevent bold “carryover” into the next paragraph by ending with a non-bold ZWSP.
    const zwsp = '\u200B';
    const full = String(label || '') + zwsp;
    const p = body.insertParagraph(insertAt, full);
    insertAt++;
    try {
      const t = p.editAsText();
      // Default to non-bold
      t.setBold(false);
      // Bold only the label characters, keep trailing ZWSP non-bold.
      const labelLen = String(label || '').length;
      if (labelLen > 0) {
        t.setBold(0, labelLen - 1, true);
      }
      t.setBold(labelLen, labelLen, false);
    } catch (e) {
      // best-effort
    }
    return p;
  };

  // Timestamp once for the whole turn, on its own line.
  insertPlainParagraph_('[' + ts + ']');

  // Labels on their own lines; only the label is bold.
  insertLabelParagraph_('YOU:');
  insertPlainParagraph_('');
  insertPlainParagraph_(String(userText || ''));

  // Two blank lines between YOU and ASSISTANT sections.
  insertPlainParagraph_('');
  insertPlainParagraph_('');

  insertLabelParagraph_('ASSISTANT:');
  insertPlainParagraph_('');
  insertPlainParagraph_(String(assistantText || ''));

  // Spacer line
  insertPlainParagraph_('');

  log_('doc.chat_log.append', { ms: Date.now() - started });
}

function insertTextIntoDocFromSidebar(text) {
  const started = Date.now();
  const doc = DocumentApp.getActiveDocument();
  const t = String(text || '');

  if (!t) {
    throw new Error('Nothing to insert.');
  }

  const cursor = doc.getCursor();
  if (cursor) {
    const el = cursor.getElement();
    const offset = cursor.getOffset();

    // Most commonly the cursor is inside a Text element.
    if (el && typeof el.editAsText === 'function') {
      el.editAsText().insertText(offset, t);
      log_('doc.insert_text.cursor_text', { len: t.length, ms: Date.now() - started });
      return;
    }

    // Fallback: insert a new paragraph after the current element.
    try {
      const parent = el.getParent();
      const idx = parent.getChildIndex(el);
      parent.insertParagraph(idx + 1, t);
      log_('doc.insert_text.cursor_paragraph', { len: t.length, ms: Date.now() - started });
      return;
    } catch (e) {
      // Last-resort append below.
    }
  }

  doc.getBody().appendParagraph(t);
  log_('doc.insert_text.append', { len: t.length, ms: Date.now() - started });
}

function insertMarkdownIntoDocFromSidebar(markdown) {
  const started = Date.now();
  const doc = DocumentApp.getActiveDocument();
  const md = normalizeNewlines_(String(markdown || ''));

  if (!md || !md.trim()) {
    throw new Error('Nothing to insert.');
  }

  let container = doc.getBody();
  let insertAt = container.getNumChildren();

  const cursor = doc.getCursor();
  if (cursor) {
    try {
      const el = cursor.getElement();
      const para = findClosestBlockElement_(el);
      if (para) {
        const p = para.getParent();
        if (p && typeof p.getChildIndex === 'function') {
          container = p;
          insertAt = p.getChildIndex(para) + 1;
        }
      }
    } catch (e) {
      // Fallback: append to body.
    }
  }

  const insertedCount = insertMarkdownIntoContainer_(container, insertAt, md);
  log_('doc.insert_markdown', { chars: md.length, insertedCount: insertedCount, ms: Date.now() - started });
}

function normalizeNewlines_(s) {
  return String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function findClosestBlockElement_(el) {
  let cur = el;
  for (let i = 0; i < 30 && cur; i++) {
    try {
      const t = cur.getType && cur.getType();
      if (t === DocumentApp.ElementType.PARAGRAPH || t === DocumentApp.ElementType.LIST_ITEM) {
        return cur;
      }
      cur = cur.getParent && cur.getParent();
    } catch (e) {
      return null;
    }
  }
  return null;
}

function insertMarkdownIntoContainer_(container, insertAt, md) {
  const lines = normalizeNewlines_(md).split('\n');
  let idx = insertAt;
  let inserted = 0;
  let inCodeBlock = false;

  const canInsertListItem = container && typeof container.insertListItem === 'function';
  const canInsertParagraph = container && typeof container.insertParagraph === 'function';
  if (!canInsertParagraph) {
    // Safety fallback.
    container = DocumentApp.getActiveDocument().getBody();
    idx = container.getNumChildren();
  }

  const insertParagraph_ = (text) => {
    const p = container.insertParagraph(idx, String(text || ''));
    idx += 1;
    inserted += 1;
    return p;
  };

  const insertListItem_ = (text, glyphType) => {
    if (!canInsertListItem) {
      return insertParagraph_(String(text || ''));
    }
    const li = container.insertListItem(idx, String(text || ''));
    try {
      if (glyphType) li.setGlyphType(glyphType);
    } catch (e) {}
    idx += 1;
    inserted += 1;
    return li;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = String(lines[i] || '');
    const line = rawLine;
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      const p = insertParagraph_(line);
      try {
        const t = p.editAsText();
        t.setAttributes({
          [DocumentApp.Attribute.FONT_FAMILY]: 'Courier New',
        });
      } catch (e) {}
      continue;
    }

    if (!trimmed) {
      insertParagraph_('');
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const p = insertParagraph_(stripInlineMdMarkers_(text));
      try {
        const map = {
          1: DocumentApp.ParagraphHeading.HEADING1,
          2: DocumentApp.ParagraphHeading.HEADING2,
          3: DocumentApp.ParagraphHeading.HEADING3,
          4: DocumentApp.ParagraphHeading.HEADING4,
          5: DocumentApp.ParagraphHeading.HEADING5,
          6: DocumentApp.ParagraphHeading.HEADING6,
        };
        p.setHeading(map[level] || DocumentApp.ParagraphHeading.NORMAL);
      } catch (e) {}
      continue;
    }

    const ulMatch = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (ulMatch) {
      const text = stripInlineMdMarkers_(ulMatch[1]);
      const li = insertListItem_(text, DocumentApp.GlyphType.BULLET);
      applyInlineMarkdownFormatting_(li, ulMatch[1]);
      continue;
    }

    const olMatch = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (olMatch) {
      const text = stripInlineMdMarkers_(olMatch[1]);
      const li = insertListItem_(text, DocumentApp.GlyphType.NUMBER);
      applyInlineMarkdownFormatting_(li, olMatch[1]);
      continue;
    }

    const p = insertParagraph_(stripInlineMdMarkers_(line));
    applyInlineMarkdownFormatting_(p, line);
  }

  return inserted;
}

function stripInlineMdMarkers_(s) {
  // Minimal marker stripping used to set paragraph text before applying attributes.
  // Keeps the underlying text content while dropping **, *, and ` markers.
  return String(s || '').replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '');
}

function applyInlineMarkdownFormatting_(paragraphOrListItem, originalLine) {
  try {
    const parsed = parseInlineMarkdownRuns_(String(originalLine || ''));
    const t = paragraphOrListItem.editAsText();
    t.setText(parsed.text);
    for (let i = 0; i < parsed.runs.length; i++) {
      const run = parsed.runs[i];
      if (!run || run.start >= run.end) continue;

      const attrs = {};
      if (run.bold) attrs[DocumentApp.Attribute.BOLD] = true;
      if (run.italic) attrs[DocumentApp.Attribute.ITALIC] = true;
      if (run.code) attrs[DocumentApp.Attribute.FONT_FAMILY] = 'Courier New';
      if (Object.keys(attrs).length === 0) continue;

      t.setAttributes(run.start, run.end - 1, attrs);
    }
  } catch (e) {
    // Best-effort: if formatting fails, keep inserted plain text.
  }
}

function parseInlineMarkdownRuns_(line) {
  const s = String(line || '');
  let out = '';
  let bold = false;
  let italic = false;
  let code = false;

  const runs = [];
  let runStart = 0;
  let runBold = false;
  let runItalic = false;
  let runCode = false;

  const startRun_ = () => {
    runStart = out.length;
    runBold = bold;
    runItalic = italic;
    runCode = code;
  };

  const endRun_ = () => {
    const end = out.length;
    if (end > runStart) {
      runs.push({ start: runStart, end: end, bold: runBold, italic: runItalic, code: runCode });
    }
    runStart = end;
    runBold = bold;
    runItalic = italic;
    runCode = code;
  };

  startRun_();

  for (let i = 0; i < s.length; ) {
    const ch = s[i];

    if (ch === '`') {
      endRun_();
      code = !code;
      startRun_();
      i += 1;
      continue;
    }

    if (!code && s.slice(i, i + 2) === '**') {
      endRun_();
      bold = !bold;
      startRun_();
      i += 2;
      continue;
    }

    if (!code && ch === '*') {
      endRun_();
      italic = !italic;
      startRun_();
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  endRun_();
  return { text: out, runs: runs };
}

/**
 * ========== ONE-SHOT MODE: PROCESS SELECTED TEXT ==========
 */
function processSelection() {
  const doc = DocumentApp.getActiveDocument();
  const selection = doc.getSelection();
  const ui = DocumentApp.getUi();

  // 1. Check for selection
  if (!selection) {
    ui.alert('Please select some text first.');
    return;
  }

  // 2. Extract text from selection
  const elements = selection.getRangeElements();
  let selectedText = "";
  
  for (let i = 0; i < elements.length; i++) {
    const rangeElement = elements[i];
    const element = rangeElement.getElement();
    
    if (element.editAsText) {
      const text = element.editAsText().getText();
      if (rangeElement.isPartial()) {
        const startOffset = rangeElement.getStartOffset();
        const endOffset = rangeElement.getEndOffsetInclusive();
        selectedText += text.substring(startOffset, endOffset + 1);
      } else {
        selectedText += text;
      }
      selectedText += "\n";
    }
  }

  if (!selectedText.trim()) {
    ui.alert('Selection contains no text.');
    return;
  }

  // 3. Get instructions from user
  const response = ui.prompt(
    'Assistant Instructions',
    'Enter instruction (e.g. "Summarize", "Translate to Hungarian", "Improve style"):',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  const userInstruction = response.getResponseText();

  // 4. Call backend (one-shot)
  try {
    const generatedText = callOpenAI(selectedText, userInstruction);
    
    // 5. Output result in document
    const body = doc.getBody();
    
    // Separator
    body.appendHorizontalRule();
    
    // Label paragraph
    const labelPara = body.appendParagraph("Assistant Response:");
    
    // Use bold instead of heading (safer styling)
    try {
      labelPara.setBold(true);
    } catch (styleError) {
      console.log("Could not bold label: " + styleError);
    }
    
    // Append AI response
    body.appendParagraph(generatedText);
    
  } catch (e) {
    ui.alert('Error: ' + e.toString());
  }
}

/**
 * ========== CHAT WITH DOCUMENT MODE ==========
 * History: backend szerveren, docId alapján.
 */
function chatWithDocument() {
  const doc = DocumentApp.getActiveDocument();
  const ui = DocumentApp.getUi();

  // 1. Full document text as context
  const docText = doc.getBody().getText();

  if (!docText.trim()) {
    ui.alert('This document is empty.');
    return;
  }

  // 2. Ask user for their message / question
  const response = ui.prompt(
    'Chat with this document',
    'What would you like to ask or do?',
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  const userMessage = response.getResponseText().trim();
  if (!userMessage) {
    ui.alert('Please enter a question or instruction.');
    return;
  }

  // 3. Call backend: docId + docText + userMessage
  try {
    const reply = callChatBackend(doc.getId(), docText, userMessage);

    // 4. Show result in document
    const body = doc.getBody();
    body.appendHorizontalRule();
    const labelPara = body.appendParagraph("ChatGPT answer:");
    try {
      labelPara.setBold(true);
    } catch (e) {}
    body.appendParagraph(reply);

  } catch (e) {
    ui.alert('Error: ' + e.toString());
  }
}

/**
 * ========== BACKEND CALLS ==========
 * 1) callOpenAI: /docs-agent (one-shot)
 * 2) callChatBackend: /chat-docs (threaded, backend history)
 */

function callOpenAI(textToProcess, instruction) {
  const BACKEND_URL = PropertiesService.getScriptProperties().getProperty('DOCS_AGENT_URL');
  if (!BACKEND_URL) {
    throw new Error("Backend URL missing. Set 'DOCS_AGENT_URL' in Project Settings → Script Properties (key: DOCS_AGENT_URL).");
  }

  const payload = {
    text: textToProcess,
    instruction: instruction
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(BACKEND_URL, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  let json;
  try {
    json = JSON.parse(responseText);
  } catch (err) {
    throw new Error("Backend returned invalid JSON: " + responseText);
  }

  if (responseCode !== 200) {
    const errorMsg = json && json.error ? json.error : responseText;
    throw new Error("Backend Error (" + responseCode + "): " + errorMsg);
  }

  if (!json.resultText) {
    throw new Error("Backend returned no 'resultText'. Raw response: " + responseText);
  }

  return String(json.resultText).trim();
}

function callChatBackend(docId, docText, userMessage) {
  const BACKEND_URL = PropertiesService.getScriptProperties().getProperty('DOCS_AGENT_CHAT_URL');
  if (!BACKEND_URL) {
    throw new Error("Chat backend URL missing. Set 'DOCS_AGENT_CHAT_URL' in Project Settings → Script Properties (key: DOCS_AGENT_CHAT_URL).");
  }

  const payload = {
    docId: docId,
    docText: docText,
    userMessage: userMessage
  };

  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(BACKEND_URL, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  let json;
  try {
    json = JSON.parse(responseText);
  } catch (err) {
    throw new Error("Chat backend returned invalid JSON: " + responseText);
  }

  if (responseCode !== 200) {
    const errorMsg = json && json.error ? json.error : responseText;
    throw new Error("Chat backend Error (" + responseCode + "): " + errorMsg);
  }

  if (!json.reply) {
    throw new Error("Chat backend returned no 'reply'. Raw response: " + responseText);
  }

  return String(json.reply).trim();
}