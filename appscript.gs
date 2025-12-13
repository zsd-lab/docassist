/**
 * ---------------------------------------------------------------------------
 * GOOGLE DOCS + GPT-5.2
 * - Process Selected Text (one-shot, via /docs-agent)
 * - Chat Sidebar (ChatGPT-like, via /v2/*)
 * - Chat with Document (legacy threaded, history on backend, via /chat-docs)
 * ---------------------------------------------------------------------------
 */

function onOpen() {
  DocumentApp.getUi().createMenu('GPT-5.2')
    .addItem('Open Chat Sidebar', 'showChatSidebar')
    .addSeparator()
    .addItem('Sync Document to Knowledge', 'syncDocumentToKnowledge')
    .addSeparator()
    .addItem('Process Selected Text (legacy)', 'processSelection')
    .addItem('Chat with Document (legacy)', 'chatWithDocument')
    .addToUi();
}

// ====== V2 SIDEBAR (ChatGPT-like) ======

function showChatSidebar() {
  const html = HtmlService
    .createHtmlOutput(getChatSidebarHtml_())
    .setTitle('GPT-5.2 Chat');
  DocumentApp.getUi().showSidebar(html);
}

function getChatSidebarHtml_() {
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: Arial, sans-serif; font-size: 13px; margin: 12px; }
      h2 { font-size: 14px; margin: 0 0 8px; }
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
      .chat { border: 1px solid #dadce0; border-radius: 6px; padding: 8px; height: 260px; overflow: auto; background: #fafafa; }
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
    <h2>GPT-5.2 Chat</h2>

    <div class="row">
      <details id="settings">
        <summary>Connection settings</summary>
        <div class="details-body">
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
        </div>
      </details>
    </div>

    <div class="row controls">
      <button id="syncBtn">Sync Document</button>
      <label style="display:flex; align-items:center; gap:6px; font-weight:400;">
        <input id="autoSync" type="checkbox" />
        Auto-sync before sending
      </label>
    </div>

    <div class="row">
      <label>Project instructions (system message)</label>
      <textarea id="instructions" placeholder="Long instructions (like ChatGPT Project instructions)"></textarea>
      <div class="controls" style="margin-top:6px;">
        <button id="saveInstrBtn">Save Instructions</button>
      </div>
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
      <label>Chat</label>
      <div id="chat" class="chat"></div>
    </div>

    <div class="row">
      <label>Your message</label>
      <textarea id="msg" placeholder="Ask something about the doc, or request edits..."></textarea>
      <div class="controls" style="margin-top:6px;">
        <button id="sendBtn" class="primary">Send</button>
      </div>
    </div>

    <div id="status" class="status"></div>

    <script>
      const el = (id) => document.getElementById(id);
      const TICK = String.fromCharCode(96);

      function safeMsg_(v) {
        try {
          if (v && typeof v === 'object' && 'message' in v) return String(v.message);
          return String(v);
        } catch (e) {
          return 'Unknown error';
        }
      }

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

      window.addEventListener('error', (ev) => {
        setStatus('JS error: ' + safeMsg_(ev && ev.message ? ev.message : ev));
      });

      window.addEventListener('unhandledrejection', (ev) => {
        setStatus('Promise error: ' + safeMsg_(ev && ev.reason ? ev.reason : ev));
      });

      function addMsg(role, text) {
        const div = document.createElement('div');
        div.className = 'msg';
        const roleSpan = document.createElement('span');
        roleSpan.className = 'role';
        roleSpan.textContent = role + ':';
        const textSpan = document.createElement('span');

        // Render assistant as (safe) markdown; keep user as plain text.
        if (role && String(role).toLowerCase().includes('gpt')) {
          textSpan.innerHTML = renderMarkdown(text);
        } else {
          textSpan.innerHTML = escapeHtml(text).replace(/\n/g, '<br/>');
        }

        div.appendChild(roleSpan);
        div.appendChild(textSpan);
        el('chat').appendChild(div);
        el('chat').scrollTop = el('chat').scrollHeight;
      }

      function disableAll(disabled) {
        ['saveSettingsBtn','syncBtn','saveInstrBtn','uploadBtn','sendBtn'].forEach((id) => {
          const node = el(id);
          if (node) node.disabled = disabled;
        });
      }

      function loadState() {
        setStatus('Loading settings...');
        google.script.run.withSuccessHandler((state) => {
          const settingsEl = document.getElementById('settings');
          el('baseUrl').value = state.baseUrl || '';
          el('token').value = state.token || '';
          el('instructions').value = state.instructions || '';
          if (settingsEl) settingsEl.open = !state.baseUrl;
          setStatus(state.baseUrl ? 'Ready.' : 'Set Backend URL first (open Connection settings).');
        }).withFailureHandler((err) => {
          setStatus('Error loading state: ' + (err && err.message ? err.message : err));
        }).getSidebarState();
      }

      function init() {
        try {
          if (!(window.google && google.script && google.script.run)) {
            setStatus('Sidebar error: google.script.run is unavailable (not running in Apps Script context).');
            return;
          }

          const saveSettingsBtn = el('saveSettingsBtn');
          const saveInstrBtn = el('saveInstrBtn');
          const syncBtn = el('syncBtn');
          const uploadBtn = el('uploadBtn');
          const sendBtn = el('sendBtn');

          if (!saveSettingsBtn || !saveInstrBtn || !syncBtn || !uploadBtn || !sendBtn) {
            setStatus('Sidebar error: missing UI elements. Try closing and reopening the sidebar.');
            return;
          }

          saveSettingsBtn.addEventListener('click', () => {
            disableAll(true);
            setStatus('Saving settings...');
            google.script.run.withSuccessHandler(() => {
              setStatus('Settings saved.');
              disableAll(false);
            }).withFailureHandler((err) => {
              setStatus('Error saving settings: ' + safeMsg_(err));
              disableAll(false);
            }).saveSidebarSettings(el('baseUrl').value, el('token').value);
          });

          saveInstrBtn.addEventListener('click', () => {
            disableAll(true);
            setStatus('Saving instructions...');
            google.script.run.withSuccessHandler(() => {
              setStatus('Instructions saved.');
              disableAll(false);
            }).withFailureHandler((err) => {
              setStatus('Error saving instructions: ' + safeMsg_(err));
              disableAll(false);
            }).saveProjectInstructions(el('instructions').value);
          });

          syncBtn.addEventListener('click', () => {
            disableAll(true);
            setStatus('Syncing document...');
            google.script.run.withSuccessHandler(() => {
              setStatus('Document synced.');
              disableAll(false);
            }).withFailureHandler((err) => {
              setStatus('Error syncing document: ' + safeMsg_(err));
              disableAll(false);
            }).syncDocumentToKnowledge(el('instructions').value);
          });

          uploadBtn.addEventListener('click', async () => {
            try {
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
                disableAll(false);
              }).withFailureHandler((err) => {
                setStatus('Error uploading: ' + safeMsg_(err));
                disableAll(false);
              }).uploadFileToKnowledge(file.name, file.type || 'application/octet-stream', base64, el('instructions').value);
            } catch (err) {
              setStatus('Upload failed: ' + safeMsg_(err));
              disableAll(false);
            }
          });

          sendBtn.addEventListener('click', () => {
            const text = (el('msg').value || '').trim();
            if (!text) return;
            el('msg').value = '';
            addMsg('You', text);
            disableAll(true);

            const doSend = () => {
              setStatus('Thinking...');
              google.script.run.withSuccessHandler((reply) => {
                addMsg('GPT-5.2', reply || '(empty)');
                setStatus('Ready.');
                disableAll(false);
              }).withFailureHandler((err) => {
                setStatus('Error: ' + safeMsg_(err));
                disableAll(false);
              }).sendChatMessage(text, el('instructions').value);
            };

            if (el('autoSync') && el('autoSync').checked) {
              setStatus('Auto-syncing document...');
              google.script.run.withSuccessHandler(() => doSend())
                .withFailureHandler((err) => {
                  setStatus('Auto-sync failed: ' + safeMsg_(err));
                  disableAll(false);
                })
                .syncDocumentToKnowledge(el('instructions').value);
            } else {
              doSend();
            }
          });

          loadState();
        } catch (err) {
          setStatus('Init error: ' + safeMsg_(err));
        }
      }

      init();
    </script>
  </body>
</html>
  `.trim();
}

function getSidebarState() {
  const props = PropertiesService.getScriptProperties();
  const baseUrl = props.getProperty('DOCASSIST_BASE_URL') || '';
  const token = props.getProperty('DOCASSIST_TOKEN') || '';
  const docProps = PropertiesService.getDocumentProperties();
  const instructions = docProps.getProperty('DOCASSIST_INSTRUCTIONS') || '';
  return { baseUrl: baseUrl, token: token, instructions: instructions };
}

function saveSidebarSettings(baseUrl, token) {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('DOCASSIST_BASE_URL', String(baseUrl || '').trim());
  props.setProperty('DOCASSIST_TOKEN', String(token || '').trim());
}

function saveProjectInstructions(instructions) {
  const docProps = PropertiesService.getDocumentProperties();
  docProps.setProperty('DOCASSIST_INSTRUCTIONS', String(instructions || ''));
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
    throw new Error('Backend returned invalid JSON: ' + responseText);
  }

  if (responseCode < 200 || responseCode >= 300) {
    const errorMsg = json && json.error ? json.error : responseText;
    throw new Error(errorMsg + ' (HTTP ' + responseCode + ')');
  }

  return json;
}

function ensureV2Session_(instructionsOverride) {
  const doc = DocumentApp.getActiveDocument();
  const instructions = typeof instructionsOverride === 'string' ? instructionsOverride : getProjectInstructions_();
  return callBackendV2_('/v2/init', {
    docId: doc.getId(),
    instructions: instructions
  });
}

function syncDocumentToKnowledge(instructionsOverride) {
  const doc = DocumentApp.getActiveDocument();
  const docText = doc.getBody().getText();
  if (!docText || !docText.trim()) {
    throw new Error('This document is empty.');
  }

  const instructions = typeof instructionsOverride === 'string' ? instructionsOverride : getProjectInstructions_();
  ensureV2Session_(instructions);

  return callBackendV2_('/v2/sync-doc', {
    docId: doc.getId(),
    docTitle: doc.getName(),
    docText: docText,
    instructions: instructions
  });
}

function uploadFileToKnowledge(filename, mimeType, contentBase64, instructionsOverride) {
  const doc = DocumentApp.getActiveDocument();
  const instructions = typeof instructionsOverride === 'string' ? instructionsOverride : getProjectInstructions_();
  ensureV2Session_(instructions);

  return callBackendV2_('/v2/upload-file', {
    docId: doc.getId(),
    filename: filename,
    mimeType: mimeType,
    contentBase64: contentBase64,
    instructions: instructions
  });
}

function sendChatMessage(userMessage, instructionsOverride) {
  const doc = DocumentApp.getActiveDocument();
  const instructions = typeof instructionsOverride === 'string' ? instructionsOverride : getProjectInstructions_();
  ensureV2Session_(instructions);

  const resp = callBackendV2_('/v2/chat', {
    docId: doc.getId(),
    userMessage: String(userMessage || ''),
    instructions: instructions
  });

  return String(resp.reply || '');
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
    'GPT-5.2 Instructions',
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
    const labelPara = body.appendParagraph("GPT-5.2 Response:");
    
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