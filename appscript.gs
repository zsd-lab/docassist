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
    </style>
  </head>
  <body>
    <h2>GPT-5.2 Chat</h2>

    <div class="row">
      <label>Backend URL</label>
      <input id="baseUrl" type="text" placeholder="https://your-server.example.com" />
      <div class="small">Stored in Script Properties as <code>DOCASSIST_BASE_URL</code>.</div>
    </div>

    <div class="row">
      <label>Backend Token (optional)</label>
      <input id="token" type="password" placeholder="Bearer token" />
      <div class="small">Stored in Script Properties as <code>DOCASSIST_TOKEN</code>.</div>
    </div>

    <div class="row controls">
      <button id="saveSettingsBtn">Save Settings</button>
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

      function setStatus(text) {
        el('status').textContent = text || '';
      }

      function addMsg(role, text) {
        const div = document.createElement('div');
        div.className = 'msg';
        const roleSpan = document.createElement('span');
        roleSpan.className = 'role';
        roleSpan.textContent = role + ':';
        const textSpan = document.createElement('span');
        textSpan.textContent = text;
        div.appendChild(roleSpan);
        div.appendChild(textSpan);
        el('chat').appendChild(div);
        el('chat').scrollTop = el('chat').scrollHeight;
      }

      function disableAll(disabled) {
        ['saveSettingsBtn','syncBtn','saveInstrBtn','uploadBtn','sendBtn'].forEach(id => el(id).disabled = disabled);
      }

      function loadState() {
        setStatus('Loading settings...');
        google.script.run.withSuccessHandler((state) => {
          el('baseUrl').value = state.baseUrl || '';
          el('token').value = state.token || '';
          el('instructions').value = state.instructions || '';
          setStatus(state.baseUrl ? 'Ready.' : 'Set Backend URL first.');
        }).withFailureHandler((err) => {
          setStatus('Error loading state: ' + (err && err.message ? err.message : err));
        }).getSidebarState();
      }

      el('saveSettingsBtn').addEventListener('click', () => {
        disableAll(true);
        setStatus('Saving settings...');
        google.script.run.withSuccessHandler(() => {
          setStatus('Settings saved.');
          disableAll(false);
        }).withFailureHandler((err) => {
          setStatus('Error saving settings: ' + (err && err.message ? err.message : err));
          disableAll(false);
        }).saveSidebarSettings(el('baseUrl').value, el('token').value);
      });

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
        setStatus('Syncing document...');
        google.script.run.withSuccessHandler(() => {
          setStatus('Document synced.');
          disableAll(false);
        }).withFailureHandler((err) => {
          setStatus('Error syncing document: ' + (err && err.message ? err.message : err));
          disableAll(false);
        }).syncDocumentToKnowledge(el('instructions').value);
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
          disableAll(false);
        }).withFailureHandler((err) => {
          setStatus('Error uploading: ' + (err && err.message ? err.message : err));
          disableAll(false);
        }).uploadFileToKnowledge(file.name, file.type || 'application/octet-stream', base64, el('instructions').value);
      });

      el('sendBtn').addEventListener('click', () => {
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
            setStatus('Error: ' + (err && err.message ? err.message : err));
            disableAll(false);
          }).sendChatMessage(text, el('instructions').value);
        };

        if (el('autoSync').checked) {
          setStatus('Auto-syncing document...');
          google.script.run.withSuccessHandler(() => doSend())
            .withFailureHandler((err) => {
              setStatus('Auto-sync failed: ' + (err && err.message ? err.message : err));
              disableAll(false);
            })
            .syncDocumentToKnowledge(el('instructions').value);
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