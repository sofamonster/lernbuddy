window.App = {
  state: {
    auth: null,
    children: [],
    currentChild: null,
    currentChildData: null,
    view: "loading",
    params: {},
  },

  esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },

  jsArg(val) {
    return this.esc(JSON.stringify(val ?? ""));
  },

  toast(message, type = "info") {
    const c = document.getElementById("toast-container");
    if (!c) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = message;
    c.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  },

  async api(path, options = {}) {
    const opts = { credentials: "same-origin", ...options };
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body === "object") {
      opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
      opts.body = JSON.stringify(opts.body);
    }
    const res = await fetch(path, opts);
    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) {
      const msg = data.detail || `Fehler (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = data.error_code || null;
      throw err;
    }
    return data;
  },

  formatDate(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  },

  formatForeignWord(article, term) {
    const a = (article || "").trim();
    const t = (term || "").trim();
    if (!a) return t;
    if (t.toLowerCase().startsWith(a.toLowerCase())) return t;
    if (a.endsWith("'") || a.endsWith("’")) return `${a}${t}`;
    return `${a} ${t}`;
  },

  avatarHtml(child, size = "md") {
    const cls = `avatar-circle avatar-${size}`;
    if (child?.avatar_image) {
      return `<span class="${cls}"><img src="/api/uploads/${this.esc(child.avatar_image)}" alt="${this.esc(child.name || "Profilbild")}" /></span>`;
    }
    return `<span class="${cls}">${this.esc(child?.avatar || "🦊")}</span>`;
  },

  speak(text, lang = "de-DE", rate = 0.95) {
    if (!("speechSynthesis" in window)) {
      this.toast("Vorlesen wird von diesem Browser leider nicht unterstützt.", "error");
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang || "de-DE";
      utter.rate = rate;
      window.speechSynthesis.speak(utter);
    } catch {
      this.toast("Konnte nicht vorlesen.", "error");
    }
  },

  async compressImageFile(file, maxDim = 1600, quality = 0.82) {
    if (!file.type || !file.type.startsWith("image/")) return file;
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width <= maxDim && height <= maxDim && file.size < 900_000) {
          resolve(file);
          return;
        }
        const scale = Math.min(1, maxDim / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) return resolve(file);
            const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
            resolve(new File([blob], name, { type: "image/jpeg" }));
          },
          "image/jpeg",
          quality
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  },

  insertAtCursor(inputId, char) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, start) + char + el.value.slice(end);
    el.focus();
    el.setSelectionRange(start + char.length, start + char.length);
  },

  frenchAccentBarHtml(inputId) {
    const chars = ["é", "è", "ê", "ë", "à", "â", "ç", "ù", "û", "ô", "œ", "'"];
    return `
      <div class="accent-bar" aria-label="Französische Sonderzeichen">
        ${chars
          .map(
            (ch) =>
              `<button type="button" class="accent-key" onclick="App.insertAtCursor('${inputId}', '${
                ch === "'" ? "\\'" : ch
              }')">${this.esc(ch)}</button>`
          )
          .join("")}
      </div>
    `;
  },

  setUiMode(mode) {
    document.body.classList.toggle("ui-junior", mode === "junior");
  },

  closeModal() {
    document.getElementById("modal-root").innerHTML = "";
  },

  openParentPinModal(onSuccess) {
    if (this.state.auth?.parent_unlocked) {
      onSuccess();
      return;
    }
    const root = document.getElementById("modal-root");
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this) App.closeModal()">
        <div class="modal-box stack">
          <div class="row-between">
            <h3>🔒 Elternbereich entsperren</h3>
            <button class="btn btn-ghost btn-sm" onclick="App.closeModal()">✕</button>
          </div>
          <p class="muted small">Bitte gib die 4-stellige Eltern-PIN ein.</p>
          <form id="parent-pin-form" class="stack-sm">
            <input type="password" id="parent-pin-input" inputmode="numeric" autocomplete="off"
                   placeholder="Eltern-PIN" autofocus required />
            <div id="parent-pin-error" class="small" style="color:var(--red);"></div>
            <div class="row" style="justify-content:flex-end;">
              <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Abbrechen</button>
              <button type="submit" class="btn btn-primary">Entsperren</button>
            </div>
          </form>
        </div>
      </div>
    `;
    document.getElementById("parent-pin-input")?.focus();
    document.getElementById("parent-pin-form").onsubmit = async (e) => {
      e.preventDefault();
      const pin = document.getElementById("parent-pin-input").value;
      const errEl = document.getElementById("parent-pin-error");
      errEl.textContent = "";
      try {
        await this.api("/api/auth/parent/unlock", { method: "POST", body: { pin } });
        this.state.auth.parent_unlocked = true;
        this.closeModal();
        this.toast("Elternbereich entsperrt.", "success");
        onSuccess();
      } catch (err) {
        errEl.textContent = err.message;
      }
    };
  },

  renderShell(contentHtml, options = {}) {
    const child = this.state.currentChild;
    const isParent = this.state.view === "parent";
    const rightBtns = [];

    if (child && !isParent) {
      rightBtns.push(`
        <span class="pill pill-amber" title="Gesammelte Sterne">⭐ ${child.stars}</span>
        <span class="pill pill-green" title="Tages-Serie">🔥 ${child.streak_days}d</span>
        <button class="btn btn-secondary btn-sm" onclick="App.go('profiles')">Kind wechseln</button>
      `);
    }

    if (this.state.auth?.authenticated) {
      if (isParent) {
        rightBtns.push(`<button class="btn btn-secondary btn-sm" onclick="App.go('profiles')">Zur Kinder-Auswahl</button>`);
        rightBtns.push(`<button class="btn btn-ghost btn-sm" onclick="App.lockParent()">🔒 Sperren</button>`);
      } else {
        rightBtns.push(`<button class="btn btn-ghost btn-sm" onclick="App.openParentDashboard()">👨‍👩‍👦‍👦 Eltern</button>`);
      }
      rightBtns.push(`<button class="btn btn-ghost btn-sm" onclick="App.logout()">Abmelden</button>`);
    }

    document.getElementById("app").innerHTML = `
      <div class="shell">
        <header class="topbar no-print">
          <div class="topbar-inner">
            <button class="brand" onclick="App.go(App.state.auth?.authenticated ? 'profiles' : 'login')">
              <span class="brand-badge">📚</span>
              <span>LernBuddy</span>
              ${child && !isParent ? `<span class="pill pill-primary">${this.avatarHtml(child, "xs")} ${this.esc(child.name)}</span>` : ""}
            </button>
            <div class="topbar-actions">${rightBtns.join("")}</div>
          </div>
        </header>
        <main class="container ${options.narrow ? "container-narrow" : ""}">
          ${contentHtml}
        </main>
      </div>
    `;
  },

  async init() {
    try {
      this.state.auth = await this.api("/api/auth/status");
      if (!this.state.auth.authenticated) {
        this.go("login");
      } else {
        this.go("profiles");
      }
    } catch (err) {
      document.getElementById("app").innerHTML = `
        <div class="loading-screen">
          <h2>Verbindungsfehler</h2>
          <p class="muted">${this.esc(err.message)}</p>
        </div>
      `;
    }
  },

  async go(view, params = {}) {
    this.state.view = view;
    this.state.params = params;
    window.scrollTo({ top: 0, behavior: "instant" });

    if (view === "login") {
      this.setUiMode("standard");
      this.state.currentChild = null;
      this.renderLogin();
      return;
    }

    if (view === "profiles") {
      this.setUiMode("standard");
      this.state.currentChild = null;
      await this.renderProfiles();
      return;
    }

    if (view === "child_home") {
      await window.ChildViews.renderChildHome(params.childId);
      return;
    }

    if (view === "subject_hub") {
      await window.ChildViews.renderSubjectHub(params.childId, params.subjectId, params.tab || "learn");
      return;
    }

    if (view === "vocab_trainer") {
      await window.ChildViews.renderVocabTrainer(params.childId, params.subjectId);
      return;
    }

    if (view === "practice") {
      await window.ChildViews.renderPracticeRunner(params.childId, params.subjectId, params.examId || null, params.style || "adaptive_mix");
      return;
    }

    if (view === "worksheet") {
      await window.PrintParentViews.renderWorksheetView(params.worksheetId, params.returnChildId || null, params.returnSubjectId || null);
      return;
    }

    if (view === "parent") {
      this.setUiMode("standard");
      await window.PrintParentViews.renderParentDashboard(params.selectedChildId || null);
      return;
    }
  },

  openParentDashboard() {
    this.openParentPinModal(() => this.go("parent"));
  },

  async lockParent() {
    await this.api("/api/auth/parent/lock", { method: "POST" });
    this.state.auth.parent_unlocked = false;
    this.toast("Elternbereich gesperrt.");
    this.go("profiles");
  },

  async logout() {
    await this.api("/api/auth/logout", { method: "POST" });
    this.state.auth = { authenticated: false, parent_unlocked: false };
    this.go("login");
  },

  renderLogin() {
    this.renderShell(
      `
      <div class="card stack" style="max-width:440px; margin: 48px auto;">
        <div style="text-align:center;" class="stack-sm">
          <div style="font-size:3rem;">📚</div>
          <h1>Willkommen bei LernBuddy</h1>
          <p class="muted">Melde dich mit dem Familien-Passwort an, damit eure Lernstände geschützt bleiben.</p>
        </div>
        <form id="login-form" class="stack">
          <div class="field">
            <label for="family-password">Familien-Passwort</label>
            <input type="password" id="family-password" placeholder="Passwort eingeben" autocomplete="current-password" required />
          </div>
          <label class="row small" style="cursor:pointer;">
            <input type="checkbox" id="remember-me" checked style="width:auto; min-height:auto;" />
            <span>Auf diesem Gerät angemeldet bleiben (30 Tage)</span>
          </label>
          <div id="login-error" class="small" style="color:var(--red);"></div>
          <button type="submit" class="btn btn-primary btn-lg btn-block">Anmelden</button>
        </form>
      </div>
      `,
      { narrow: true }
    );

    document.getElementById("login-form").onsubmit = async (e) => {
      e.preventDefault();
      const password = document.getElementById("family-password").value;
      const remember = document.getElementById("remember-me").checked;
      const errEl = document.getElementById("login-error");
      errEl.textContent = "";
      try {
        await this.api("/api/auth/login", { method: "POST", body: { password, remember } });
        this.state.auth = await this.api("/api/auth/status");
        this.go("profiles");
      } catch (err) {
        errEl.textContent = err.message;
      }
    };
  },

  async renderProfiles() {
    const data = await this.api("/api/children");
    this.state.children = data.children;

    const apiWarning = !this.state.auth?.has_gemini_key
      ? `<div class="banner banner-warn">
           <strong>Hinweis für Eltern:</strong> Es ist noch kein <code>GEMINI_API_KEY</code> in der <code>.env</code>-Datei eingetragen.
           Manuelle Vokabeln & Prüfungen funktionieren schon – für Foto-Scanner, KI-Aufgaben & Handschrift-Korrektur bitte den Key in <code>.env</code> eintragen.
         </div>`
      : "";

    const cards = this.state.children
      .map(
        (c) => `
        <div class="card child-card stack-sm" onclick="App.go('child_home', { childId: ${c.id} })">
          <div class="child-avatar">${this.avatarHtml(c, "xl")}</div>
          <h2>${this.esc(c.name)}</h2>
          <p class="muted">${c.age} Jahre · ${this.esc(c.grade)}</p>
          <div class="row" style="justify-content:center; margin-top:6px;">
            <span class="pill pill-amber">⭐ ${c.stars}</span>
            <span class="pill pill-green">🔥 ${c.streak_days} Tage</span>
          </div>
          <div class="row small muted" style="justify-content:center; margin-top:4px;">
            <span>${c.stats.due_vocab} fällige Vokabeln</span>
            <span>·</span>
            <span>${c.stats.active_exams} Prüfungen</span>
          </div>
          <div style="margin-top:8px;">
            <button type="button" class="btn btn-secondary btn-sm"
                    onclick="event.stopPropagation(); ChildViews.openProfileEditorById(${c.id}, 'profiles')">
              ✏️ Profil anpassen
            </button>
          </div>
        </div>
      `
      )
      .join("");

    this.renderShell(
      `
      <div class="stack">
        ${apiWarning}
        <div style="text-align:center;" class="stack-sm">
          <h1>Wer möchte heute lernen?</h1>
          <p class="muted">Tippe einfach auf dein Profil – oder öffne oben den geschützten Elternbereich.</p>
        </div>
        <div class="grid-2">${cards}</div>
      </div>
      `,
      { narrow: true }
    );
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
