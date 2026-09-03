(() => {
  "use strict";

  const GITHUB_API = "https://api.github.com";

  // Public identifiers for this deployment — not secrets. An OAuth Client ID
  // is meant to be public (only the client secret is confidential, and
  // device flow never uses one), and the relay URL is just an endpoint.
  const DEFAULT_OAUTH_CLIENT_ID = "Ov23liUgG4S7nbL9Bv54";
  const DEFAULT_OAUTH_RELAY_URL = "https://gpuworld-oauth-relay.civonamo.workers.dev";
  const DEFAULT_OWNER = "hellojomp";
  const DEFAULT_REPO = "gpuworld";
  const DEFAULT_BRANCH = "master";
  const DEFAULT_PATH = "test.md";

  const els = {
    submitButton: document.getElementById("submit-button"),
    revisionLabel: document.getElementById("revision-label"),
    revisionHash: document.getElementById("revision-hash"),
    revisionMessage: document.getElementById("revision-message"),
    commitLog: document.getElementById("commit-log"),
    editor: document.getElementById("editor"),
    wordCount: document.getElementById("word-count"),
    selectionTools: document.getElementById("selection-tools"),
    submitModal: document.getElementById("submit-modal"),
    pushMessage: document.getElementById("push-message"),
    repoTarget: document.getElementById("repo-target"),
    pushError: document.getElementById("push-error"),
    downloadButton: document.getElementById("download-button"),
    pushButton: document.getElementById("push-button"),
    settingsModal: document.getElementById("settings-modal"),
    settingsForm: document.getElementById("settings-form"),
    repoOwner: document.getElementById("repo-owner"),
    repoName: document.getElementById("repo-name"),
    repoPath: document.getElementById("repo-path"),
    repoBranch: document.getElementById("repo-branch"),
    repoToken: document.getElementById("repo-token"),
    settingsError: document.getElementById("settings-error"),
    connectButton: document.getElementById("connect-button"),
    manualSetup: document.getElementById("manual-setup"),
    resetButton: document.getElementById("reset-button"),
    changeRepoButton: document.getElementById("change-repo-button"),
    oauthClientId: document.getElementById("oauth-client-id"),
    oauthRelayUrl: document.getElementById("oauth-relay-url"),
    deviceConnectButton: document.getElementById("device-connect-button"),
    deviceFlowPanel: document.getElementById("device-flow-panel"),
    deviceFlowStatus: document.getElementById("device-flow-status"),
    deviceFlowCode: document.getElementById("device-flow-code"),
    deviceFlowLink: document.getElementById("device-flow-link"),
    deviceFlowCancel: document.getElementById("device-flow-cancel"),
    toast: document.getElementById("toast"),
  };

  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

  // ---------- persistence ----------

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* storage unavailable or full; edits stay in-memory for this session */
      }
    },
  };

  const REPO_KEY = "verso:repo";
  const TOKEN_KEY = "verso:token";
  const OAUTH_CLIENT_ID_KEY = "verso:oauthClientId";
  const OAUTH_RELAY_URL_KEY = "verso:oauthRelayUrl";

  function draftKey(repo) {
    return repo ? `verso:draft:${repo.owner}/${repo.repo}/${repo.path}` : "verso:draft:local";
  }

  // ---------- state ----------

  const state = {
    repo: store.get(REPO_KEY, null), // { owner, repo, path, branch }
    token: store.get(TOKEN_KEY, ""),
    oauthClientId: store.get(OAUTH_CLIENT_ID_KEY, DEFAULT_OAUTH_CLIENT_ID),
    oauthRelayUrl: store.get(OAUTH_RELAY_URL_KEY, DEFAULT_OAUTH_RELAY_URL),
    sha: null, // sha of the file's current blob, needed to push the next update
    commits: [],
    viewingSha: null,
  };

  let devicePollTimer = null;

  // ---------- utilities ----------

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
  }

  function base64ToUtf8(b64) {
    const binary = atob(b64.replace(/\n/g, ""));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  }

  function editorMarkdown() {
    return turndown.turndown(els.editor.innerHTML).trim() + "\n";
  }

  function setEditorFromMarkdown(markdown) {
    els.editor.innerHTML = marked.parse(markdown || "");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  let toastTimer = null;
  function showToast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle("is-error", isError);
    els.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 3200);
  }

  function currentWordCount() {
    const text = els.editor.textContent.trim();
    return text ? text.split(/\s+/).length : 0;
  }

  function updateWordCount() {
    const count = currentWordCount();
    els.wordCount.textContent = `${count} word${count === 1 ? "" : "s"}`;
  }

  function updateRepoTarget() {
    els.repoTarget.textContent = state.repo
      ? `Pushing to ${state.repo.owner}/${state.repo.repo} · ${state.repo.path} on ${state.repo.branch}`
      : "No GitHub repository connected.";
  }

  // ---------- GitHub API ----------

  function authHeaders() {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;
    return headers;
  }

  function encodeURIComponentPath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  async function fetchFile(repo, ref) {
    const url = `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/contents/${encodeURIComponentPath(repo.path)}?ref=${encodeURIComponent(ref || repo.branch)}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (res.status === 404) {
      const err = new Error("File not found at that path/branch.");
      err.code = "not_found";
      throw err;
    }
    if (!res.ok) throw await apiError(res);
    const data = await res.json();
    if (Array.isArray(data)) {
      const err = new Error("That path is a directory, not a file.");
      err.code = "is_directory";
      throw err;
    }
    return { markdown: base64ToUtf8(data.content), sha: data.sha };
  }

  async function pushFile(repo, markdown, message, sha) {
    const url = `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/contents/${encodeURIComponentPath(repo.path)}`;
    const body = {
      message,
      content: utf8ToBase64(markdown),
      branch: repo.branch,
    };
    if (sha) body.sha = sha;
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await apiError(res);
    const data = await res.json();
    return { fileSha: data.content.sha, commitSha: data.commit.sha, commitUrl: data.commit.html_url };
  }

  async function fetchCommitLog(repo) {
    const url = `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/commits?path=${encodeURIComponentPath(repo.path)}&sha=${encodeURIComponent(repo.branch)}&per_page=20`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return [];
    const data = await res.json();
    return data.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.commit.message.split("\n")[0],
      parentSha: c.parents?.[0]?.sha || null,
    }));
  }

  async function apiError(res) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data.message || "";
    } catch {
      /* body wasn't JSON; fall back to the status text below */
    }
    if (res.status === 401) return new Error("Token was rejected. Reconnect with GitHub.");
    if (res.status === 403) return new Error(detail || "Forbidden — the token may lack write access to this repo.");
    if (res.status === 409) {
      const err = new Error("The file changed on GitHub since you loaded it. Reload, then push again.");
      err.code = "conflict";
      return err;
    }
    if (res.status === 422) return new Error(detail || "GitHub rejected the request (422).");
    return new Error(detail || `GitHub API error (${res.status}).`);
  }

  // ---------- commit log (real GitHub history for this file) ----------

  async function refreshCommitLog() {
    state.commits = state.repo ? await fetchCommitLog(state.repo) : [];
    renderCommitLog();
  }

  function renderCommitLog() {
    els.commitLog.innerHTML = "";
    for (const commit of state.commits) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "commit-row" + (state.viewingSha === commit.sha ? " is-active" : "");
      row.innerHTML = `<span class="commit-hash">${commit.shortSha}</span>${escapeHtml(commit.message)}`;
      row.addEventListener("click", () => previewCommit(commit));
      els.commitLog.appendChild(row);
    }
  }

  // Renders the word-level diff introduced by a commit (vs. its parent) as
  // plain highlighted text — not rendered markdown, since splicing <ins>/<del>
  // spans into arbitrary markdown and re-parsing it would break on any diff
  // that lands mid-syntax (a split heading marker, an unbalanced list, etc).
  function renderDiff(oldText, newText) {
    const parts = Diff.diffWords(oldText, newText);
    els.editor.innerHTML = parts
      .map((part) => {
        const text = escapeHtml(part.value);
        if (part.added) return `<ins class="diff-add">${text}</ins>`;
        if (part.removed) return `<del class="diff-del">${text}</del>`;
        return text;
      })
      .join("");
  }

  async function previewCommit(commit) {
    if (!state.repo) return;
    try {
      const { markdown: newMarkdown } = await fetchFile(state.repo, commit.sha);

      let oldMarkdown = "";
      if (commit.parentSha) {
        try {
          oldMarkdown = (await fetchFile(state.repo, commit.parentSha)).markdown;
        } catch (err) {
          if (err.code !== "not_found") throw err; // parent existed; file just didn't yet — empty is correct
        }
      }

      state.viewingSha = commit.sha;
      els.editor.contentEditable = "false";
      els.editor.classList.add("is-diff");
      renderDiff(oldMarkdown, newMarkdown);
      els.revisionHash.textContent = commit.shortSha;
      els.revisionMessage.textContent = commit.message;
      els.revisionLabel.hidden = false;
      renderCommitLog();
    } catch (err) {
      showToast(`Couldn't load that revision: ${err.message}`, true);
    }
  }

  function returnToDraft() {
    state.viewingSha = null;
    els.editor.contentEditable = "true";
    els.editor.classList.remove("is-diff");
    els.revisionLabel.hidden = true;
    setEditorFromMarkdown(store.get(draftKey(state.repo), ""));
    updateWordCount();
    renderCommitLog();
  }

  // ---------- draft autosave ----------

  let autosaveTimer = null;
  function scheduleAutosave() {
    if (state.viewingSha) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      store.set(draftKey(state.repo), editorMarkdown());
    }, 500);
  }

  // ---------- selection toolbar ----------

  function updateSelectionToolbar() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !els.editor.contains(sel.anchorNode)) {
      els.selectionTools.hidden = true;
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      els.selectionTools.hidden = true;
      return;
    }
    els.selectionTools.hidden = false;
    const toolbarRect = els.selectionTools.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - toolbarRect.width / 2),
      window.innerWidth - toolbarRect.width - 8
    );
    const top = Math.max(8, rect.top - toolbarRect.height - 10);
    els.selectionTools.style.left = `${left}px`;
    els.selectionTools.style.top = `${top}px`;
  }

  // ---------- modal helpers ----------

  function openModal(dialog) {
    dialog.showModal();
  }

  // ---------- settings / connect flow ----------

  function populateSettingsForm() {
    els.repoOwner.value = state.repo?.owner || DEFAULT_OWNER;
    els.repoName.value = state.repo?.repo || DEFAULT_REPO;
    els.repoPath.value = state.repo?.path || DEFAULT_PATH;
    els.repoBranch.value = state.repo?.branch || DEFAULT_BRANCH;
    els.repoToken.value = state.token || "";
    els.oauthClientId.value = state.oauthClientId || "";
    els.oauthRelayUrl.value = state.oauthRelayUrl || "";
    els.settingsError.hidden = true;
  }

  function repoFromForm() {
    return {
      owner: els.repoOwner.value.trim() || DEFAULT_OWNER,
      repo: els.repoName.value.trim() || DEFAULT_REPO,
      path: els.repoPath.value.trim().replace(/^\/+/, "") || DEFAULT_PATH,
      branch: els.repoBranch.value.trim() || DEFAULT_BRANCH,
    };
  }

  // Loads a file from GitHub into the editor and updates all connection
  // state. A missing file still counts as a valid connection — the first
  // push will create it. Throws on any other failure.
  async function connectToRepo(repo) {
    try {
      const { markdown, sha } = await fetchFile(repo);
      state.repo = repo;
      state.sha = sha;
      store.set(REPO_KEY, repo);
      setEditorFromMarkdown(markdown);
      store.set(draftKey(repo), markdown);
      state.viewingSha = null;
      els.revisionLabel.hidden = true;
      updateWordCount();
      updateRepoTarget();
      await refreshCommitLog();
      showToast(`Loaded ${repo.path} from ${repo.owner}/${repo.repo}`);
    } catch (err) {
      if (err.code !== "not_found") throw err;
      state.repo = repo;
      state.sha = null;
      store.set(REPO_KEY, repo);
      updateRepoTarget();
      await refreshCommitLog();
      showToast(`Connected. ${repo.path} doesn't exist yet — your first push will create it.`);
    }
  }

  function resetConnection() {
    state.repo = null;
    state.sha = null;
    state.commits = [];
    state.viewingSha = null;
    store.set(REPO_KEY, null);

    els.editor.contentEditable = "true";
    els.revisionLabel.hidden = true;
    renderCommitLog();
    updateRepoTarget();
    populateSettingsForm();
    showToast("Connection reset. Reconnect below.");
  }

  // ---------- GitHub OAuth device flow ----------
  // GitHub's device-flow endpoints don't allow direct browser CORS requests,
  // so a tiny relay Worker (see oauth-relay/) just forwards these two POSTs.
  // No client secret is ever involved — device flow doesn't use one.

  function setDeviceFlowStatus(text, isError = false) {
    els.deviceFlowStatus.textContent = text;
    els.deviceFlowStatus.classList.toggle("is-error", isError);
  }

  function showDeviceFlowPanel() {
    els.deviceFlowPanel.hidden = false;
    els.deviceFlowCode.hidden = true;
    els.deviceFlowLink.hidden = true;
  }

  function hideDeviceFlowPanel() {
    clearTimeout(devicePollTimer);
    els.deviceFlowPanel.hidden = true;
  }

  async function startDeviceFlow() {
    const clientId = els.oauthClientId.value.trim();
    const relayUrl = els.oauthRelayUrl.value.trim().replace(/\/+$/, "");

    if (!clientId || !relayUrl) {
      showToast("Add an OAuth client ID and relay URL first.", true);
      return;
    }

    state.oauthClientId = clientId;
    state.oauthRelayUrl = relayUrl;
    store.set(OAUTH_CLIENT_ID_KEY, clientId);
    store.set(OAUTH_RELAY_URL_KEY, relayUrl);

    showDeviceFlowPanel();
    setDeviceFlowStatus("Requesting a code from GitHub…");

    try {
      const res = await fetch(`${relayUrl}/device/code`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, scope: "repo" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error_description || data.error || `Relay returned ${res.status}`);

      els.deviceFlowCode.textContent = data.user_code;
      els.deviceFlowCode.hidden = false;
      els.deviceFlowLink.href = data.verification_uri;
      els.deviceFlowLink.hidden = false;
      setDeviceFlowStatus("Enter this code on GitHub to connect.");

      pollForDeviceToken(clientId, relayUrl, data.device_code, data.interval || 5, Date.now() + data.expires_in * 1000);
    } catch (err) {
      setDeviceFlowStatus(`Couldn't start: ${err.message}`, true);
    }
  }

  function pollForDeviceToken(clientId, relayUrl, deviceCode, intervalSeconds, expiresAt) {
    clearTimeout(devicePollTimer);

    const poll = async () => {
      if (Date.now() > expiresAt) {
        setDeviceFlowStatus("Code expired. Try again.", true);
        return;
      }
      try {
        const res = await fetch(`${relayUrl}/token`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        const data = await res.json();

        if (data.access_token) {
          await onDeviceFlowSuccess(data.access_token);
          return;
        }
        if (data.error === "authorization_pending") {
          devicePollTimer = setTimeout(poll, intervalSeconds * 1000);
        } else if (data.error === "slow_down") {
          intervalSeconds = data.interval || intervalSeconds + 5;
          devicePollTimer = setTimeout(poll, intervalSeconds * 1000);
        } else if (data.error === "expired_token") {
          setDeviceFlowStatus("Code expired. Try again.", true);
        } else if (data.error === "access_denied") {
          setDeviceFlowStatus("Authorization was denied.", true);
        } else if (data.error) {
          setDeviceFlowStatus(data.error_description || data.error, true);
        } else {
          throw new Error(`Unexpected response (${res.status})`);
        }
      } catch (err) {
        setDeviceFlowStatus(`Network error while waiting: ${err.message}`, true);
      }
    };

    poll();
  }

  async function onDeviceFlowSuccess(token) {
    state.token = token;
    store.set(TOKEN_KEY, token);
    els.repoToken.value = token;
    hideDeviceFlowPanel();

    let login = null;
    try {
      const res = await fetch(`${GITHUB_API}/user`, { headers: authHeaders() });
      if (res.ok) login = (await res.json()).login;
    } catch {
      /* fall through to the generic message below */
    }
    showToast(login ? `Connected as ${login}.` : "Connected to GitHub.");

    // Authorization was the only missing piece — load the manuscript and go
    // straight to the commit dialog instead of making the user do more.
    if (!state.repo) {
      try {
        await connectToRepo(repoFromForm());
      } catch (err) {
        els.settingsError.textContent = err.message;
        els.settingsError.hidden = false;
        els.manualSetup.open = true;
        return;
      }
    }
    els.settingsModal.close();
    openPushModal();
  }

  function cancelDeviceFlow() {
    hideDeviceFlowPanel();
  }

  async function handleConnectSubmit(event) {
    event.preventDefault();
    const repo = repoFromForm();
    const token = els.repoToken.value.trim();

    els.connectButton.disabled = true;
    els.connectButton.textContent = "Loading…";
    els.settingsError.hidden = true;

    try {
      if (token) {
        state.token = token;
        store.set(TOKEN_KEY, token);
      }
      await connectToRepo(repo);
      els.settingsModal.close();
      if (state.token) openPushModal();
    } catch (err) {
      els.settingsError.textContent = err.message;
      els.settingsError.hidden = false;
    } finally {
      els.connectButton.disabled = false;
      els.connectButton.textContent = "Load from GitHub";
    }
  }

  // ---------- push-to-GitHub flow ----------

  function openPushModal() {
    updateRepoTarget();
    els.pushError.hidden = true;
    els.pushMessage.value = "";
    if (!state.repo) {
      showToast("Connect a repository first.", true);
      openModal(els.settingsModal);
      return;
    }
    if (!state.token) {
      showToast("Connect with GitHub to push.", true);
      openModal(els.settingsModal);
      return;
    }
    openModal(els.submitModal);
    els.pushMessage.focus();
  }

  function openSettingsFromPush() {
    els.submitModal.close();
    populateSettingsForm();
    openModal(els.settingsModal);
  }

  async function handlePush() {
    const message = els.pushMessage.value.trim();
    if (!message) {
      els.pushError.textContent = "Give this commit a message.";
      els.pushError.hidden = false;
      els.pushMessage.focus();
      return;
    }

    const wordCount = currentWordCount();
    if (wordCount >= MAX_WORD_COUNT) {
      els.pushError.textContent = `This manuscript is ${wordCount} words — must stay under ${MAX_WORD_COUNT} to push. (See constants.js.)`;
      els.pushError.hidden = false;
      return;
    }

    els.pushButton.disabled = true;
    els.pushButton.textContent = "Pushing…";
    els.pushError.hidden = true;

    try {
      // Refetch the latest sha immediately before writing, so a concurrent
      // edit on GitHub can't silently be clobbered.
      let sha = state.sha;
      try {
        const latest = await fetchFile(state.repo);
        sha = latest.sha;
      } catch (err) {
        if (err.code !== "not_found") throw err;
        sha = null; // file doesn't exist yet; this push will create it
      }

      const markdown = editorMarkdown();
      const result = await pushFile(state.repo, markdown, message, sha);
      state.sha = result.fileSha;
      store.set(draftKey(state.repo), markdown);

      const parentSha = state.commits[0]?.sha || null;
      state.commits.unshift({ sha: result.commitSha, shortSha: result.commitSha.slice(0, 7), message, parentSha });
      renderCommitLog();

      els.submitModal.close();
      showToast("Pushed to GitHub.");
    } catch (err) {
      els.pushError.textContent = err.message;
      els.pushError.hidden = false;
    } finally {
      els.pushButton.disabled = false;
      els.pushButton.textContent = "Push commit";
    }
  }

  function handleDownload() {
    const markdown = editorMarkdown();
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = state.repo ? state.repo.path.split("/").pop() : "manuscript.md";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- formatting toolbar ----------

  function handleToolbarClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    els.editor.focus();
    if (button.dataset.command === "createLink") {
      const url = window.prompt("Link URL");
      if (url) document.execCommand("createLink", false, url);
    } else if (button.dataset.command) {
      document.execCommand(button.dataset.command, false, null);
    } else if (button.dataset.block) {
      document.execCommand("formatBlock", false, button.dataset.block);
    }
    scheduleAutosave();
  }

  // ---------- wiring ----------

  function init() {
    populateSettingsForm();
    updateRepoTarget();
    setEditorFromMarkdown(store.get(draftKey(state.repo), ""));
    updateWordCount();
    if (state.repo) refreshCommitLog();

    els.editor.addEventListener("input", () => {
      updateWordCount();
      scheduleAutosave();
    });
    document.addEventListener("selectionchange", () => {
      if (document.activeElement === els.editor || els.editor.contains(document.activeElement)) {
        updateSelectionToolbar();
      }
    });
    document.addEventListener("mouseup", (e) => {
      if (els.editor.contains(e.target)) updateSelectionToolbar();
    });

    els.selectionTools.addEventListener("mousedown", (e) => e.preventDefault());
    els.selectionTools.addEventListener("click", handleToolbarClick);

    els.settingsForm.addEventListener("submit", handleConnectSubmit);
    els.resetButton.addEventListener("click", resetConnection);
    els.settingsModal.addEventListener("close", cancelDeviceFlow);
    els.deviceConnectButton.addEventListener("click", startDeviceFlow);
    els.deviceFlowCancel.addEventListener("click", cancelDeviceFlow);

    els.submitButton.addEventListener("click", openPushModal);
    els.pushButton.addEventListener("click", handlePush);
    els.changeRepoButton.addEventListener("click", openSettingsFromPush);
    els.downloadButton.addEventListener("click", handleDownload);

    els.revisionLabel.addEventListener("click", returnToDraft);
  }

  init();
})();
