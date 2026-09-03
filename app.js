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

  function defaultRepo() {
    return {
      owner: DEFAULT_OWNER,
      repo: DEFAULT_REPO,
      path: DEFAULT_PATH,
      branch: DEFAULT_BRANCH,
    };
  }

  const els = {
    submitButton: document.getElementById("submit-button"),
    rebaseButton: document.getElementById("rebase-button"),
    revisionLabel: document.getElementById("revision-label"),
    revisionHash: document.getElementById("revision-hash"),
    revisionMessage: document.getElementById("revision-message"),
    commitLog: document.getElementById("commit-log"),
    editor: document.getElementById("editor"),
    wordCount: document.getElementById("word-count"),
    settingsButton: document.getElementById("settings-button"),
    selectionTools: document.getElementById("selection-tools"),
    downloadButton: document.getElementById("download-button"),
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

  // The markdown as last synced with GitHub — distinct from the draft, which
  // tracks live (possibly unsynced) edits. Used to compute what changed
  // locally so it can be rebased onto someone else's intervening push.
  function baseKey(repo) {
    return repo ? `verso:base:${repo.owner}/${repo.repo}/${repo.path}` : "verso:base:local";
  }

  function shaKey(repo) {
    return repo ? `verso:sha:${repo.owner}/${repo.repo}/${repo.path}` : "verso:sha:local";
  }

  function headKey(repo) {
    return repo ? `verso:head:${repo.owner}/${repo.repo}/${repo.path}` : "verso:head:local";
  }

  // ---------- state ----------

  const state = {
    repo: store.get(REPO_KEY, null), // { owner, repo, path, branch }
    token: store.get(TOKEN_KEY, ""),
    oauthClientId: store.get(OAUTH_CLIENT_ID_KEY, DEFAULT_OAUTH_CLIENT_ID),
    oauthRelayUrl: store.get(OAUTH_RELAY_URL_KEY, DEFAULT_OAUTH_RELAY_URL),
    sha: null, // blob SHA of the last successful sync (matches baseMarkdown)
    syncedCommitSha: null, // commit SHA we last synced to
    behind: false,
    baseMarkdown: "",
    commits: [],
    viewingSha: null,
  };

  let devicePollTimer = null;
  let remotePollTimer = null;
  let remotePeekInFlight = false;
  let lastRemotePeekAt = 0;
  let pushInFlight = false;
  let pendingPushAfterAuth = false;

  const REMOTE_POLL_MS = 45_000;
  const REMOTE_POLL_MS_UNAUTH = 180_000;

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

  // Round-trips markdown through the same marked→HTML→turndown pipeline the
  // editor itself uses. Needed because that pipeline reflows line breaks
  // (markdown joins soft-wrapped lines within a paragraph into one line), so
  // raw GitHub content and editorMarkdown() output aren't line-comparable
  // otherwise — every push would look like it touched every wrapped line.
  function canonicalMarkdown(markdown) {
    return turndown.turndown(marked.parse(markdown || "")).trim() + "\n";
  }

  // Splits on whitespace runs, keeping them as their own tokens so the
  // array rejoins (with "") into exactly the original text. Word-level,
  // not line-level: a flowing paragraph is one "line" to a line-diff, so
  // two edits to different sentences in the same paragraph would otherwise
  // look like the same line changed twice and register as a false conflict.
  function tokenizeWords(text) {
    return text.split(/(\s+)/).filter((token) => token !== "");
  }

  function countLines(text) {
    if (!text) return 0;
    const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
    return withoutTrailingNewline === "" ? 0 : withoutTrailingNewline.split("\n").length;
  }

  // Buckets a line-level diff into created/edited/deleted counts: a removed
  // block immediately followed by an added block reads as an edit (up to
  // the smaller side's line count); anything left over is a pure add/delete.
  function summarizeLineChanges(oldText, newText) {
    const parts = Diff.diffLines(oldText, newText);
    let created = 0;
    let edited = 0;
    let deleted = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.removed) {
        const next = parts[i + 1];
        if (next?.added) {
          const removedLines = countLines(part.value);
          const addedLines = countLines(next.value);
          edited += Math.min(removedLines, addedLines);
          created += Math.max(0, addedLines - removedLines);
          deleted += Math.max(0, removedLines - addedLines);
          i++; // the paired added part is already accounted for
        } else {
          deleted += countLines(part.value);
        }
      } else if (part.added) {
        created += countLines(part.value);
      }
    }
    return { created, edited, deleted };
  }

  function formatCommitSummary({ created, edited, deleted }) {
    const segments = [];
    if (created) segments.push(`C:${created}`);
    if (edited) segments.push(`E:${edited}`);
    if (deleted) segments.push(`D:${deleted}`);
    return segments.length ? segments.join(" ") : "No line changes";
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

  async function fetchHeadCommitSha(repo) {
    const url = `${GITHUB_API}/repos/${repo.owner}/${repo.repo}/commits?path=${encodeURIComponentPath(repo.path)}&sha=${encodeURIComponent(repo.branch)}&per_page=1`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    return data[0]?.sha || null;
  }

  // Three-way merge of the live draft onto a newer remote, using the last
  // synced text as the ancestor. Same helper for the rebase button and the
  // last-chance merge at push time.
  function mergeDraftWithRemote(draft, base, remote) {
    if (!remote || remote === base) {
      return { conflict: false, markdown: draft, rebased: false };
    }
    const merged = Diff3.merge(
      tokenizeWords(draft),
      tokenizeWords(base),
      tokenizeWords(remote)
    );
    if (merged.conflict) return { conflict: true };
    return { conflict: false, markdown: merged.result.join(""), rebased: true };
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
      const err = new Error("Someone pushed at the exact same moment. Push again — this time your edits will rebase onto theirs automatically.");
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
  // push will create it. Throws on any other failure. Pass silent to skip
  // toasts (used for the unauthenticated first-load of the public manuscript).
  async function connectToRepo(repo, opts = {}) {
    try {
      const { markdown, sha } = await fetchFile(repo);
      state.repo = repo;
      state.sha = sha;
      state.baseMarkdown = canonicalMarkdown(markdown);
      store.set(REPO_KEY, repo);
      setEditorFromMarkdown(markdown);
      store.set(draftKey(repo), markdown);
      store.set(baseKey(repo), state.baseMarkdown);
      state.viewingSha = null;
      els.revisionLabel.hidden = true;
      updateWordCount();
      await refreshCommitLog();
      persistSync(sha, state.commits[0]?.sha || null);
      startRemoteWatch();
      if (!opts.silent) showToast(`Loaded ${repo.path} from ${repo.owner}/${repo.repo}`);
    } catch (err) {
      if (err.code !== "not_found") throw err;
      state.repo = repo;
      state.sha = null;
      state.baseMarkdown = "";
      store.set(REPO_KEY, repo);
      store.set(baseKey(repo), "");
      persistSync(null, null);
      await refreshCommitLog();
      startRemoteWatch();
      if (!opts.silent) {
        showToast(`Connected. ${repo.path} doesn't exist yet — your first push will create it.`);
      }
    }
  }

  function hasUnsyncedLocalEdits(repo) {
    const savedDraft = store.get(draftKey(repo), "");
    if (!savedDraft) return false;
    const savedBase = store.get(baseKey(repo), "");
    return canonicalMarkdown(savedDraft) !== (savedBase || canonicalMarkdown(""));
  }

  async function bootManuscript() {
    const repo = state.repo || defaultRepo();
    if (hasUnsyncedLocalEdits(repo)) {
      state.repo = repo;
      setEditorFromMarkdown(store.get(draftKey(repo), ""));
      updateWordCount();
      state.baseMarkdown = store.get(baseKey(repo), "");
      state.sha = store.get(shaKey(repo), null);
      state.syncedCommitSha = store.get(headKey(repo), null);
      refreshCommitLog();
      startRemoteWatch();
      return;
    }

    try {
      await connectToRepo(repo, { silent: true });
    } catch (err) {
      setEditorFromMarkdown(store.get(draftKey(repo), ""));
      updateWordCount();
      showToast(`Couldn't load the manuscript: ${err.message}`, true);
    }
  }

  function persistSync(blobSha, commitSha) {
    state.sha = blobSha || null;
    if (commitSha !== undefined) state.syncedCommitSha = commitSha || null;
    if (!state.repo) return;
    store.set(shaKey(state.repo), state.sha);
    if (commitSha !== undefined) store.set(headKey(state.repo), state.syncedCommitSha);
  }

  function setBehind(behind) {
    state.behind = !!behind;
    els.rebaseButton.hidden = !state.behind;
  }

  function stopRemoteWatch() {
    clearInterval(remotePollTimer);
    remotePollTimer = null;
  }

  function startRemoteWatch() {
    stopRemoteWatch();
    setBehind(false);
    if (!state.repo) return;
    peekRemote({ force: true });
    const interval = state.token ? REMOTE_POLL_MS : REMOTE_POLL_MS_UNAUTH;
    remotePollTimer = setInterval(() => peekRemote(), interval);
  }

  // Compare origin to the last synced commit without touching the draft or
  // the remembered base. The base is the merge ancestor and must stay frozen
  // until a rebase (or push) succeeds.
  async function peekRemote(opts = {}) {
    if (!state.repo || remotePeekInFlight) return;
    const now = Date.now();
    if (!opts.force && now - lastRemotePeekAt < 2000) return;
    lastRemotePeekAt = now;
    remotePeekInFlight = true;
    try {
      const headSha = await fetchHeadCommitSha(state.repo);
      if (headSha && state.syncedCommitSha) {
        if (headSha === state.syncedCommitSha) {
          setBehind(false);
          return;
        }
        if (state.behind) return;
      }

      let remote;
      try {
        remote = await fetchFile(state.repo);
      } catch (err) {
        if (err.code === "not_found") {
          if (!state.sha && !state.baseMarkdown) setBehind(false);
          return;
        }
        throw err;
      }

      const remoteCanonical = canonicalMarkdown(remote.markdown);
      if (remoteCanonical === state.baseMarkdown) {
        persistSync(remote.sha, headSha);
        setBehind(false);
        return;
      }

      setBehind(true);
    } catch {
      // Offline or rate-limited: keep the last behind/synced state.
    } finally {
      remotePeekInFlight = false;
    }
  }

  async function rebaseOntoRemote() {
    if (!state.repo) return;
    if (state.viewingSha) {
      showToast("Return to your draft before rebasing.", true);
      return;
    }

    els.rebaseButton.disabled = true;
    try {
      let remote;
      try {
        remote = await fetchFile(state.repo);
      } catch (err) {
        if (err.code === "not_found") {
          setBehind(false);
          showToast("The file is gone on GitHub.");
          return;
        }
        throw err;
      }

      const remoteCanonical = canonicalMarkdown(remote.markdown);
      const draft = editorMarkdown();
      const merged = mergeDraftWithRemote(draft, state.baseMarkdown, remoteCanonical);
      if (merged.conflict) {
        showToast(
          "Your edits overlap a new revision on GitHub. Copy your draft somewhere safe, then Load from GitHub and reapply it by hand.",
          true
        );
        return;
      }

      state.baseMarkdown = remoteCanonical;
      store.set(baseKey(state.repo), remoteCanonical);
      store.set(draftKey(state.repo), merged.markdown);
      if (merged.markdown !== draft) {
        setEditorFromMarkdown(merged.markdown);
        updateWordCount();
      }

      await refreshCommitLog();
      persistSync(remote.sha, state.commits[0]?.sha || null);
      setBehind(false);
      showToast(merged.rebased ? "Rebased onto the latest revision." : "Already on the latest revision.");
    } catch (err) {
      showToast(`Couldn't rebase: ${err.message}`, true);
    } finally {
      els.rebaseButton.disabled = false;
    }
  }

  function resetConnection() {
    stopRemoteWatch();
    setBehind(false);
    if (state.repo) {
      store.set(shaKey(state.repo), null);
      store.set(headKey(state.repo), null);
    }
    state.repo = null;
    state.sha = null;
    state.syncedCommitSha = null;
    state.commits = [];
    state.viewingSha = null;
    store.set(REPO_KEY, null);

    els.editor.contentEditable = "true";
    els.revisionLabel.hidden = true;
    renderCommitLog();
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

    // Authorization was the only missing piece — load the manuscript and push.
    if (!state.repo) {
      try {
        await connectToRepo(repoFromForm());
      } catch (err) {
        els.settingsError.textContent = err.message;
        els.settingsError.hidden = false;
        els.manualSetup.open = true;
        return;
      }
    } else {
      startRemoteWatch();
    }
    els.settingsModal.close();
    if (pendingPushAfterAuth && state.token) requestPush();
    pendingPushAfterAuth = false;
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
      if (pendingPushAfterAuth && state.token) requestPush();
      pendingPushAfterAuth = false;
    } catch (err) {
      els.settingsError.textContent = err.message;
      els.settingsError.hidden = false;
    } finally {
      els.connectButton.disabled = false;
      els.connectButton.textContent = "Load from GitHub";
    }
  }

  // ---------- push-to-GitHub flow ----------

  function openSettings() {
    pendingPushAfterAuth = false;
    populateSettingsForm();
    openModal(els.settingsModal);
  }

  function requestPush() {
    if (!state.repo || !state.token) {
      pendingPushAfterAuth = true;
      showToast("Connect with GitHub to push.", true);
      populateSettingsForm();
      openModal(els.settingsModal);
      return;
    }
    handlePush();
  }

  async function handlePush() {
    if (pushInFlight) return;
    if (state.viewingSha) {
      showToast("Return to your draft before pushing.", true);
      return;
    }

    const wordCount = currentWordCount();
    if (wordCount >= MAX_WORD_COUNT) {
      showToast(`This manuscript is ${wordCount} words — must stay under ${MAX_WORD_COUNT} to push.`, true);
      return;
    }

    pushInFlight = true;
    els.submitButton.disabled = true;
    const previousLabel = els.submitButton.textContent;
    els.submitButton.textContent = "Pushing…";

    try {
      const currentMarkdown = editorMarkdown();
      const message = formatCommitSummary(summarizeLineChanges(state.baseMarkdown, currentMarkdown));

      let remote = null;
      try {
        remote = await fetchFile(state.repo);
      } catch (err) {
        if (err.code !== "not_found") throw err;
        remote = null;
      }
      const remoteCanonical = remote ? canonicalMarkdown(remote.markdown) : null;

      let markdownToPush = currentMarkdown;
      const sha = remote ? remote.sha : null;

      if (remote && remoteCanonical !== state.baseMarkdown) {
        const merged = mergeDraftWithRemote(currentMarkdown, state.baseMarkdown, remoteCanonical);
        if (merged.conflict) {
          const err = new Error(
            "Your edits overlap a new revision on GitHub. Copy your draft somewhere safe, then Load from GitHub and reapply it by hand."
          );
          err.code = "conflict";
          throw err;
        }
        markdownToPush = merged.markdown;
        if (merged.rebased) showToast("Rebased your edits onto the latest version on GitHub.");
      }

      if (remoteCanonical && markdownToPush === remoteCanonical) {
        state.baseMarkdown = remoteCanonical;
        store.set(baseKey(state.repo), remoteCanonical);
        store.set(draftKey(state.repo), markdownToPush);
        if (markdownToPush !== currentMarkdown) {
          setEditorFromMarkdown(markdownToPush);
          updateWordCount();
        }
        await refreshCommitLog();
        persistSync(remote.sha, state.commits[0]?.sha || null);
        setBehind(false);
        showToast("Nothing to push.");
        return;
      }

      const result = await pushFile(state.repo, markdownToPush, message, sha);
      state.baseMarkdown = markdownToPush;
      store.set(draftKey(state.repo), markdownToPush);
      store.set(baseKey(state.repo), markdownToPush);
      persistSync(result.fileSha, result.commitSha);
      setBehind(false);

      if (markdownToPush !== currentMarkdown) {
        setEditorFromMarkdown(markdownToPush);
        updateWordCount();
      }

      const parentSha = state.commits[0]?.sha || null;
      state.commits.unshift({ sha: result.commitSha, shortSha: result.commitSha.slice(0, 7), message, parentSha });
      renderCommitLog();

      showToast("Pushed to GitHub.");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      pushInFlight = false;
      els.submitButton.disabled = false;
      els.submitButton.textContent = previousLabel;
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

    els.submitButton.addEventListener("click", requestPush);
    els.rebaseButton.addEventListener("click", rebaseOntoRemote);
    els.settingsButton.addEventListener("click", openSettings);
    els.downloadButton.addEventListener("click", handleDownload);

    els.revisionLabel.addEventListener("click", returnToDraft);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") peekRemote();
    });
    window.addEventListener("focus", () => peekRemote());

    bootManuscript();
  }

  init();
})();
