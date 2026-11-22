window.ChildViews = {
  _scanFiles: [],
  _scanPreview: null,
  _vocabState: null,
  _practiceState: null,

  async loadChild(childId) {
    const data = await App.api(`/api/children/${childId}`);
    App.state.currentChild = data.child;
    App.state.currentChildData = data;
    App.setUiMode(data.child.ui_mode);
    return data;
  },

  editExamById(examId, childId, subjectId = null, returnView = "subject_hub") {
    const exams = App.state.currentChildData?.exams || [];
    const exam = exams.find((x) => x.id === examId);
    if (!exam) return;
    App.openExamEditModal(exam, async () => {
      if (returnView === "child_home") {
        await App.go("child_home", { childId });
      } else {
        await App.go("subject_hub", { childId, subjectId: subjectId || exam.subject_id, tab: "learn" });
      }
    });
  },

  async openProfileEditorById(childId, returnView = "child_home") {
    let child =
      (App.state.currentChild && App.state.currentChild.id === childId ? App.state.currentChild : null) ||
      (App.state.children || []).find((x) => x.id === childId);
    if (!child) {
      const data = await App.api(`/api/children/${childId}`);
      child = data.child;
    }
    this.openProfileEditor(child, returnView);
  },

  openProfileEditor(child, returnView = "child_home") {
    const emojis = ["🦊", "🦉", "🦁", "🐯", "🐻", "🐼", "🦖", "🚀", "⚽", "🎸", "🎮", "🐉", "🐺", "🦅", "🤖", "🛹"];
    let selectedEmoji = child.avatar || "🦊";
    let pendingPhotoFile = null;
    let pendingPhotoUrl = null;
    let clearExistingImage = false;

    const root = document.getElementById("modal-root");
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this) App.closeModal()">
        <div class="modal-box stack" style="max-width:480px; max-height:92vh; overflow-y:auto;">
          <div class="row-between">
            <h3>✏️ Mein Profil anpassen</h3>
            <button type="button" class="btn btn-ghost btn-sm" onclick="App.closeModal()">✕</button>
          </div>

          <div style="display:flex; justify-content:center;" id="prof-avatar-preview">
            ${App.avatarHtml(child, "xl")}
          </div>

          <form id="child-self-profile-form" class="stack">
            <div class="grid-2">
              <div class="field">
                <label for="sp-name">Dein Name</label>
                <input type="text" id="sp-name" value="${App.esc(child.name)}" maxlength="40" required />
              </div>
              <div class="field">
                <label for="sp-age">Dein Alter (in Jahren)</label>
                <input type="number" id="sp-age" value="${child.age}" min="5" max="18" required />
              </div>
            </div>

            <div class="stack-sm">
              <label style="font-weight:600; font-size:0.9rem;">Profilbild auswählen (Emoji)</label>
              <div class="emoji-grid" id="sp-emoji-grid">
                ${emojis
                  .map(
                    (em) => `
                  <button type="button" class="emoji-btn ${!child.avatar_image && selectedEmoji === em ? "active" : ""}" data-emoji="${em}">
                    ${em}
                  </button>
                `
                  )
                  .join("")}
              </div>
            </div>

            <div class="stack-sm">
              <label style="font-weight:600; font-size:0.9rem;">Oder eigenes Profilbild (Foto)</label>
              <div class="row">
                <label class="btn btn-secondary btn-sm" style="cursor:pointer;">
                  📷 Foto wählen / aufnehmen
                  <input type="file" id="sp-photo-input" accept="image/*" style="display:none;" />
                </label>
                <span id="sp-photo-label" class="small muted">${child.avatar_image ? "Eigenes Foto aktiv" : "Kein eigenes Foto"}</span>
              </div>
            </div>

            <div id="sp-error" class="small" style="color:var(--red);"></div>

            <div class="row" style="justify-content:flex-end;">
              <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Abbrechen</button>
              <button type="submit" id="sp-save-btn" class="btn btn-primary">💾 Speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;

    const previewEl = document.getElementById("prof-avatar-preview");
    const photoLabel = document.getElementById("sp-photo-label");
    const emojiButtons = Array.from(document.querySelectorAll("#sp-emoji-grid .emoji-btn"));

    const refreshPreview = () => {
      if (pendingPhotoUrl) {
        previewEl.innerHTML = `<span class="avatar-circle avatar-xl"><img src="${pendingPhotoUrl}" alt="Vorschau" /></span>`;
      } else if (child.avatar_image && !clearExistingImage) {
        previewEl.innerHTML = App.avatarHtml(child, "xl");
      } else {
        previewEl.innerHTML = `<span class="avatar-circle avatar-xl">${App.esc(selectedEmoji)}</span>`;
      }
      emojiButtons.forEach((btn) => {
        const active = !pendingPhotoUrl && (clearExistingImage || !child.avatar_image) && btn.dataset.emoji === selectedEmoji;
        btn.classList.toggle("active", active);
      });
    };

    emojiButtons.forEach((btn) => {
      btn.onclick = () => {
        selectedEmoji = btn.dataset.emoji;
        if (pendingPhotoUrl) {
          URL.revokeObjectURL(pendingPhotoUrl);
          pendingPhotoUrl = null;
        }
        pendingPhotoFile = null;
        clearExistingImage = true;
        photoLabel.textContent = "Emoji ausgewählt";
        refreshPreview();
      };
    });

    document.getElementById("sp-photo-input").onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      photoLabel.textContent = "Foto wird vorbereitet…";
      const compressed = await App.compressImageFile(file, 480, 0.85);
      if (pendingPhotoUrl) URL.revokeObjectURL(pendingPhotoUrl);
      pendingPhotoFile = compressed;
      pendingPhotoUrl = URL.createObjectURL(compressed);
      clearExistingImage = false;
      photoLabel.textContent = "Neues Foto bereit";
      refreshPreview();
    };

    document.getElementById("child-self-profile-form").onsubmit = async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById("sp-save-btn");
      const errEl = document.getElementById("sp-error");
      errEl.textContent = "";
      saveBtn.disabled = true;

      try {
        const name = document.getElementById("sp-name").value.trim();
        const age = Number(document.getElementById("sp-age").value);
        await App.api(`/api/children/${child.id}/profile`, {
          method: "PATCH",
          body: {
            name,
            age,
            avatar: selectedEmoji,
            clear_avatar_image: clearExistingImage && !pendingPhotoFile,
          },
        });

        if (pendingPhotoFile) {
          const fd = new FormData();
          fd.append("file", pendingPhotoFile);
          await App.api(`/api/children/${child.id}/profile/avatar`, {
            method: "POST",
            body: fd,
          });
        }

        if (pendingPhotoUrl) URL.revokeObjectURL(pendingPhotoUrl);
        App.closeModal();
        App.toast("Profil gespeichert!", "success");

        if (returnView === "profiles") {
          await App.go("profiles");
        } else {
          await App.go("child_home", { childId: child.id });
        }
      } catch (err) {
        errEl.textContent = err.message;
        saveBtn.disabled = false;
      }
    };
  },

  async renderChildHome(childId) {
    const data = await this.loadChild(childId);
    const c = data.child;
    const isJunior = c.ui_mode === "junior";
    const enabledSubjects = data.subjects.filter((s) => s.enabled);
    const activeExams = data.exams.filter((e) => e.status === "active");

    const subjectCards = enabledSubjects
      .map((s) => {
        const subExams = activeExams.filter((e) => e.subject_id === s.id).length;
        return `
          <div class="card subject-card stack-sm" style="border-left-color:${App.esc(s.color)}"
               onclick="App.go('subject_hub', { childId: ${c.id}, subjectId: ${s.id}, tab: 'learn' })">
            <div class="row-between">
              <div class="row">
                <span class="subject-icon">${App.esc(s.icon)}</span>
                <div>
                  <h3>${App.esc(s.name)}</h3>
                  <div class="small muted">${s.subject_type === "language" ? "Vokabeln & Prüfungen" : "Üben & Prüfungen"}</div>
                </div>
              </div>
              ${subExams > 0 ? `<span class="pill pill-primary">${subExams} Prüfung${subExams > 1 ? "en" : ""}</span>` : ""}
            </div>
          </div>
        `;
      })
      .join("");

    const examList = activeExams.length
      ? activeExams
          .map((e) => {
            const r = e.readiness;
            const daysText =
              r.days_left === null
                ? "Kein Datum"
                : r.days_left < 0
                ? "Vergangen"
                : r.days_left === 0
                ? "Heute!"
                : `in ${r.days_left} Tagen`;
            return `
              <div class="card-soft row-between" style="cursor:pointer;"
                   onclick="App.go('subject_hub', { childId: ${c.id}, subjectId: ${e.subject_id}, tab: 'learn' })">
                <div class="stack-sm" style="gap:4px;">
                  <div class="row">
                    <span>${App.esc(e.subject_icon)}</span>
                    <strong>${App.esc(e.title)}</strong>
                    <button type="button" class="pill" style="border:none; cursor:pointer;" title="Prüfungsdatum anpassen"
                            onclick="event.stopPropagation(); ChildViews.editExamById(${e.id}, ${c.id}, ${e.subject_id}, 'child_home')">
                      📅 ${App.esc(daysText)} ✏️
                    </button>
                  </div>
                  <div class="row small muted">
                    <span class="light-dot light-${r.traffic_light}"></span>
                    <span>${App.esc(r.label)} (${r.avg_mastery}%) · ${e.topics.length} Themen</span>
                  </div>
                </div>
                <button class="btn btn-primary btn-sm"
                        onclick="event.stopPropagation(); App.go('practice', { childId: ${c.id}, subjectId: ${e.subject_id}, examId: ${e.id}, style: 'adaptive_mix' })">
                  Jetzt üben
                </button>
              </div>
            `;
          })
          .join("")
      : `<p class="muted small">Noch keine anstehenden Prüfungen. Fotografiere einfach eine Buchseite in einem Fach!</p>`;

    const wsList = data.recent_worksheets.length
      ? data.recent_worksheets
          .slice(0, 4)
          .map(
            (w) => `
            <div class="row-between card-soft" style="cursor:pointer;"
                 onclick="App.go('worksheet', { worksheetId: ${w.id}, returnChildId: ${c.id}, returnSubjectId: ${w.subject_id} })">
              <div>
                <strong>${App.esc(w.subject_icon)} ${App.esc(w.title)}</strong>
                <div class="small muted">${App.esc(w.code)} · ${App.formatDate(w.created_at)}</div>
              </div>
              ${
                w.graded_at
                  ? `<span class="pill pill-green">✓ ${w.score}/${w.max_score} Pkt.</span>`
                  : `<span class="pill pill-amber">Drucken / Foto prüfen</span>`
              }
            </div>
          `
          )
          .join("")
      : `<p class="muted small">Noch keine Arbeitsblätter erstellt.</p>`;

    App.renderShell(`
      <div class="stack">
        <div class="card row-between" style="background: linear-gradient(135deg, #ffffff 0%, #eef2ff 100%);">
          <div class="row" style="gap:16px;">
            <div style="cursor:pointer;" title="Profilbild & Name ändern"
                 onclick="ChildViews.openProfileEditorById(${c.id}, 'child_home')">
              ${App.avatarHtml(c, "lg")}
            </div>
            <div class="stack-sm" style="gap:4px;">
              <div class="row" style="gap:10px;">
                <h1>Hallo ${App.esc(c.name)}!</h1>
                <span class="pill">${c.age} Jahre</span>
              </div>
              <p class="muted">
                ${
                  isJunior
                    ? "Wähle ein Fach aus – zusammen schaffen wir das locker!"
                    : "Wähle ein Fach, scanne neue Seiten ein oder trainiere gezielt für die nächste Prüfung."
                }
              </p>
            </div>
          </div>
          <div class="row">
            <span class="pill pill-amber">⭐ ${c.stars} Sterne</span>
            <span class="pill pill-green">🔥 ${c.streak_days} Tage Serie</span>
            ${
              data.vocab.due > 0
                ? `<span class="pill pill-primary">🃏 ${data.vocab.due} Vokabeln fällig</span>`
                : ""
            }
            <button type="button" class="btn btn-secondary btn-sm"
                    onclick="ChildViews.openProfileEditorById(${c.id}, 'child_home')">
              ✏️ Mein Profil
            </button>
          </div>
        </div>

        <section class="stack-sm">
          <h2>Deine Fächer</h2>
          <div class="grid-3">${subjectCards}</div>
        </section>

        <div class="grid-2">
          <section class="card stack-sm">
            <h3>📅 Anstehende Prüfungen</h3>
            ${examList}
          </section>
          <section class="card stack-sm">
            <h3>🖨️ Letzte Papier-Arbeitsblätter</h3>
            ${wsList}
          </section>
        </div>
      </div>
    `);
  },

  async renderSubjectHub(childId, subjectId, activeTab = "learn") {
    const data = await this.loadChild(childId);
    const c = data.child;
    const subject = data.subjects.find((s) => s.id === subjectId) || data.subjects[0];
    const exams = data.exams.filter((e) => e.subject_id === subject.id);
    const weaknesses = data.weaknesses.filter((w) => w.subject_id === subject.id && !w.resolved);

    let vocabInfo = null;
    if (subject.subject_type === "language") {
      vocabInfo = await App.api(`/api/children/${c.id}/vocab?subject_id=${subject.id}`);
    }
    const wsData = await App.api(`/api/children/${c.id}/worksheets?subject_id=${subject.id}`);
    const matData = await App.api(`/api/children/${c.id}/materials?subject_id=${subject.id}`);

    let tabHtml = "";
    if (activeTab === "learn") {
      tabHtml = this._renderSubjectLearnTab(c, subject, exams, weaknesses, vocabInfo);
    } else if (activeTab === "scan") {
      tabHtml = this._renderSubjectScanTab(c, subject, exams, matData.materials);
    } else {
      tabHtml = this._renderSubjectPaperTab(c, subject, exams, wsData.worksheets);
    }

    App.renderShell(`
      <div class="stack">
        <div class="row-between">
          <div class="row">
            <button class="btn btn-secondary btn-sm" onclick="App.go('child_home', { childId: ${c.id} })">← Fächer</button>
            <h1>${App.esc(subject.icon)} ${App.esc(subject.name)}</h1>
          </div>
        </div>

        <div class="tabs">
          <button class="tab ${activeTab === "learn" ? "active" : ""}"
                  onclick="App.go('subject_hub', { childId: ${c.id}, subjectId: ${subject.id}, tab: 'learn' })">
            🎯 Üben & Prüfungen
          </button>
          <button class="tab ${activeTab === "scan" ? "active" : ""}"
                  onclick="App.go('subject_hub', { childId: ${c.id}, subjectId: ${subject.id}, tab: 'scan' })">
            📷 Foto scannen & Stoff
          </button>
          <button class="tab ${activeTab === "paper" ? "active" : ""}"
                  onclick="App.go('subject_hub', { childId: ${c.id}, subjectId: ${subject.id}, tab: 'paper' })">
            🖨️ Papier-Prüfungen (${wsData.worksheets.length})
          </button>
        </div>

        ${tabHtml}
      </div>
    `);

    if (activeTab === "learn") this._bindLearnTabEvents(c, subject);
    if (activeTab === "scan") this._bindScanTabEvents(c, subject, exams);
    if (activeTab === "paper") this._bindPaperTabEvents(c, subject);
  },

  _renderSubjectLearnTab(c, subject, exams, weaknesses, vocabInfo) {
    const isLang = subject.subject_type === "language";
    const slug = subject.slug;

    const vocabBlock = isLang
      ? `
        <div class="card stack-sm" style="border-top: 4px solid ${App.esc(subject.color)}">
          <div class="row-between">
            <div>
              <h2>🃏 Vokabeltrainer (${App.esc(subject.name)})</h2>
              <p class="muted small">5-Fächer-Karteikasten · ${vocabInfo.total} Vokabeln gesamt · ${vocabInfo.due_count} fällig</p>
            </div>
            <div class="row">
              <button class="btn btn-primary" ${vocabInfo.total === 0 ? "disabled" : ""}
                      onclick="App.go('vocab_trainer', { childId: ${c.id}, subjectId: ${subject.id} })">
                Vokabeln üben
              </button>
              <button class="btn btn-secondary btn-sm" onclick="document.getElementById('manual-vocab-card').classList.toggle('hidden-box')">
                + Manuell
              </button>
            </div>
          </div>
          <div class="leitner-boxes">
            ${[1, 2, 3, 4, 5]
              .map(
                (b) => `
              <div class="leitner-box">
                <span class="small muted">Fach ${b}</span>
                <strong>${vocabInfo.box_counts[String(b)] || 0}</strong>
              </div>
            `
              )
              .join("")}
          </div>
          <div id="manual-vocab-card" class="card-soft stack-sm hidden-box" style="display:none;">
            <h4>Einzelne Vokabel hinzufügen</h4>
            <form id="manual-vocab-form" class="grid-2">
              <div class="field">
                <label>${App.esc(subject.name)} (Wort)</label>
                <input type="text" id="mv-foreign" required placeholder="${slug === "franzoesisch" ? "z.B. école" : "z.B. library"}" />
                ${slug === "franzoesisch" ? App.frenchAccentBarHtml("mv-foreign") : ""}
              </div>
              <div class="field">
                <label>Deutsch</label>
                <input type="text" id="mv-german" required placeholder="z.B. Schule" />
              </div>
              <div class="field">
                <label>Artikel (optional)</label>
                <input type="text" id="mv-article" placeholder="${slug === "franzoesisch" ? "z.B. l' / le / la" : "optional"}" />
              </div>
              <div class="field">
                <label>Lektion / Unit</label>
                <input type="text" id="mv-unit" value="Allgemein" />
              </div>
              <div style="grid-column:1/-1;" class="row">
                <button type="submit" class="btn btn-primary btn-sm">Speichern</button>
              </div>
            </form>
          </div>
        </div>
      `
      : "";

    const styleButtons = [];
    styleButtons.push({ id: "adaptive_mix", label: "🎯 Adaptiver Mix (70% Schwachstellen)", primary: true });
    if (slug === "mathe") {
      styleButtons.push({ id: "math_steps", label: "🧮 Rechenweg-Training (Sokrates-Tipps)" });
    }
    if (slug === "deutsch") {
      styleButtons.push({ id: "dictation", label: "🎧 Diktat-Modus (Vorlesen)" });
    }
    if (["sachunterricht", "biologie", "deutsch", "englisch", "franzoesisch"].includes(slug)) {
      styleButtons.push({ id: "cloze_match", label: "🧩 Lückentext & Zuordnung" });
    }
    styleButtons.push({ id: "open_explain", label: "💬 Erkläre in eigenen Worten" });

    const examOptions = exams
      .filter((e) => e.status === "active")
      .map((e) => `<option value="${e.id}">${App.esc(e.title)} (${e.topics.length} Themen)</option>`)
      .join("");

    const examsHtml = exams.length
      ? exams
          .map((e) => {
            const r = e.readiness;
            const topicsHtml = e.topics.length
              ? e.topics
                  .map(
                    (t) => `
                  <div class="stack-sm" style="gap:4px;">
                    <div class="row-between small">
                      <span><strong>${App.esc(t.title)}</strong> ${t.description ? `<span class="muted">– ${App.esc(t.description)}</span>` : ""}</span>
                      <span class="muted">${t.mastery_score}%</span>
                    </div>
                    <div class="progress-track">
                      <div class="progress-fill ${t.mastery_score >= 75 ? "green" : t.mastery_score >= 45 ? "amber" : "red"}"
                           style="width:${t.mastery_score}%"></div>
                    </div>
                  </div>
                `
                  )
                  .join("")
              : `<p class="small muted">Noch keine Unterthemen – scanne Buchseiten im Tab „Foto scannen“.</p>`;

            return `
              <div class="card stack-sm">
                <div class="row-between">
                  <div>
                    <div class="row">
                      <h3>${App.esc(e.title)}</h3>
                      <span class="pill">
                        <span class="light-dot light-${r.traffic_light}"></span>
                        ${App.esc(r.label)}
                      </span>
                      <button type="button" class="pill pill-primary" style="border:none; cursor:pointer;"
                              title="Prüfungsdatum oder Titel ändern"
                              onclick="ChildViews.editExamById(${e.id}, ${c.id}, ${subject.id}, 'subject_hub')">
                        📅 ${e.exam_date ? App.formatDate(e.exam_date) : "Datum setzen"} ✏️
                      </button>
                      ${e.status === "completed" ? `<span class="pill pill-green">✓ Erledigt</span>` : ""}
                    </div>
                  </div>
                  <div class="row">
                    <button class="btn btn-primary btn-sm"
                            onclick="App.go('practice', { childId: ${c.id}, subjectId: ${subject.id}, examId: ${e.id}, style: 'adaptive_mix' })">
                      Interaktiv üben
                    </button>
                    <button class="btn btn-secondary btn-sm"
                            onclick="ChildViews.editExamById(${e.id}, ${c.id}, ${subject.id}, 'subject_hub')">
                      📅 Datum
                    </button>
                    <button class="btn btn-secondary btn-sm"
                            onclick="App.go('subject_hub', { childId: ${c.id}, subjectId: ${subject.id}, tab: 'paper' })">
                      🖨️ Drucken
                    </button>
                  </div>
                </div>
                ${topicsHtml}
              </div>
            `;
          })
          .join("")
      : `<div class="card-soft muted small">Noch keine Prüfung in ${App.esc(subject.name)} angelegt. Du kannst unten eine anlegen oder direkt Buchseiten fotografieren!</div>`;

    const weakHtml = weaknesses.length
      ? `
        <div class="card stack-sm">
          <h3>🎯 Aktuelle Fokus-Schwachstellen in ${App.esc(subject.name)}</h3>
          ${weaknesses
            .slice(0, 5)
            .map(
              (w) => `
            <div class="card-soft stack-sm" style="gap:3px;">
              <strong>${App.esc(w.summary)}</strong>
              ${w.example_mistake ? `<span class="small muted">Beispiel: ${App.esc(w.example_mistake)}</span>` : ""}
            </div>
          `
            )
            .join("")}
        </div>
      `
      : "";

    return `
      <div class="stack">
        ${vocabBlock}

        <div class="card stack-sm">
          <div class="row-between">
            <div>
              <h2>⚡ Interaktive Übung starten</h2>
              <p class="muted small">Die KI stellt Aufgaben gezielt aus deinem Lernstoff und deinen Schwachstellen zusammen.</p>
            </div>
          </div>
          <div class="field" style="max-width:380px;">
            <label for="quick-practice-exam">Prüfung / Bereich</label>
            <select id="quick-practice-exam">
              <option value="">Allgemein (${App.esc(subject.name)})</option>
              ${examOptions}
            </select>
          </div>
          <div class="row">
            ${styleButtons
              .map(
                (b) => `
              <button class="btn ${b.primary ? "btn-primary" : "btn-secondary"}"
                      onclick="ChildViews.startPracticeFromHub(${c.id}, ${subject.id}, '${b.id}')">
                ${b.label}
              </button>
            `
              )
              .join("")}
          </div>
        </div>

        ${weakHtml}

        <div class="stack-sm">
          <div class="row-between">
            <h2>📚 Prüfungen & Themen</h2>
            <button class="btn btn-secondary btn-sm" onclick="document.getElementById('new-exam-box').style.display = document.getElementById('new-exam-box').style.display === 'none' ? 'block' : 'none'">
              + Neue Prüfung anlegen
            </button>
          </div>

          <div id="new-exam-box" class="card-soft stack-sm" style="display:none;">
            <h4>Neue Prüfung manuell anlegen</h4>
            <form id="manual-exam-form" class="stack-sm">
              <div class="grid-2">
                <div class="field">
                  <label>Titel der Prüfung</label>
                  <input type="text" id="me-title" required placeholder="z.B. Klassenarbeit Bruchrechnung" />
                </div>
                <div class="field">
                  <label>Prüfungsdatum (optional)</label>
                  <input type="date" id="me-date" />
                </div>
              </div>
              <div class="field">
                <label>Themen (eins pro Zeile)</label>
                <textarea id="me-topics" placeholder="Erweitern und Kürzen&#10;Brüche addieren&#10;Textaufgaben"></textarea>
              </div>
              <div class="row">
                <button type="submit" class="btn btn-primary btn-sm">Prüfung speichern</button>
              </div>
            </form>
          </div>

          ${examsHtml}
        </div>
      </div>
    `;
  },

  startPracticeFromHub(childId, subjectId, style) {
    const sel = document.getElementById("quick-practice-exam");
    const examId = sel && sel.value ? Number(sel.value) : null;
    App.go("practice", { childId, subjectId, examId, style });
  },

  _bindLearnTabEvents(c, subject) {
    const mvBtn = document.querySelector("#manual-vocab-card");
    if (mvBtn) {
      // toggle helper via display
      const toggleBtn = document.querySelector("[onclick*='manual-vocab-card']");
      if (toggleBtn) {
        toggleBtn.onclick = () => {
          mvBtn.style.display = mvBtn.style.display === "none" ? "flex" : "none";
        };
      }
    }

    const mvForm = document.getElementById("manual-vocab-form");
    if (mvForm) {
      mvForm.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await App.api(`/api/children/${c.id}/vocab/bulk`, {
            method: "POST",
            body: {
              subject_id: subject.id,
              items: [
                {
                  term_foreign: document.getElementById("mv-foreign").value,
                  term_german: document.getElementById("mv-german").value,
                  article: document.getElementById("mv-article").value,
                  unit_name: document.getElementById("mv-unit").value || "Allgemein",
                },
              ],
            },
          });
          App.toast("Vokabel gespeichert!", "success");
          App.go("subject_hub", { childId: c.id, subjectId: subject.id, tab: "learn" });
        } catch (err) {
          App.toast(err.message, "error");
        }
      };
    }

    const meForm = document.getElementById("manual-exam-form");
    if (meForm) {
      meForm.onsubmit = async (e) => {
        e.preventDefault();
        const rawTopics = document.getElementById("me-topics").value
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((title) => ({ title, description: "", key_concepts: [] }));
        try {
          await App.api(`/api/children/${c.id}/exams`, {
            method: "POST",
            body: {
              subject_id: subject.id,
              title: document.getElementById("me-title").value,
              exam_date: document.getElementById("me-date").value || null,
              topics: rawTopics,
            },
          });
          App.toast("Prüfung angelegt!", "success");
          App.go("subject_hub", { childId: c.id, subjectId: subject.id, tab: "learn" });
        } catch (err) {
          App.toast(err.message, "error");
        }
      };
    }
  },

  _renderSubjectScanTab(c, subject, exams, materials) {
    this._scanFiles = [];
    this._scanPreview = null;
    const defaultType = subject.subject_type === "language" ? "vocab" : "exam_topic";

    const matsHtml = materials.length
      ? materials
          .map(
            (m) => `
          <div class="card-soft stack-sm">
            <div class="row-between">
              <div>
                <strong>${App.esc(m.title)}</strong>
                <span class="pill">${m.material_type === "vocab" ? "Vokabeln" : "Prüfungsstoff"}</span>
              </div>
              <span class="small muted">${App.formatDate(m.created_at)}</span>
            </div>
            ${
              m.image_paths?.length
                ? `<div class="thumb-grid">${m.image_paths
                    .map(
                      (p) =>
                        `<a href="/api/uploads/${App.esc(p)}" target="_blank" class="thumb-item"><img src="/api/uploads/${App.esc(p)}" alt="Scan" /></a>`
                    )
                    .join("")}</div>`
                : ""
            }
          </div>
        `
          )
          .join("")
      : `<p class="small muted">Noch keine gescannten Seiten in diesem Fach.</p>`;

    return `
      <div class="stack">
        <div class="card stack">
          <div>
            <h2>📷 Buchseite oder Heft abfotografieren</h2>
            <p class="muted small">Fotografiere eine oder mehrere Seiten. Gemini liest den Stoff aus und zeigt dir eine Vorschau zum Prüfen.</p>
          </div>

          <div class="grid-2">
            <div class="field">
              <label for="scan-type">Was ist auf den Fotos?</label>
              <select id="scan-type">
                <option value="vocab" ${defaultType === "vocab" ? "selected" : ""}>Vokabelliste (Sprache)</option>
                <option value="exam_topic" ${defaultType === "exam_topic" ? "selected" : ""}>Prüfungsstoff / Buchseite / Arbeitsblatt</option>
              </select>
            </div>
            <div class="field">
              <label for="scan-note">Hinweis (optional)</label>
              <input type="text" id="scan-note" placeholder="z.B. Unit 4, Seite 38 oder Thema Brüche" />
            </div>
          </div>

          <label class="upload-zone stack-sm" for="scan-file-input">
            <div style="font-size:2rem;">📸</div>
            <strong>Fotos aufnehmen oder auswählen</strong>
            <span class="small muted">Du kannst mehrere Seiten nacheinander hinzufügen (Handy-Kamera oder Galerie)</span>
            <input type="file" id="scan-file-input" accept="image/*" capture="environment" multiple style="display:none;" />
          </label>
          <div id="scan-thumbs" class="thumb-grid"></div>

          <div class="row">
            <button id="scan-run-btn" class="btn btn-primary btn-lg" disabled>
              ✨ Mit Gemini auslesen
            </button>
            <span id="scan-status" class="small muted"></span>
          </div>
        </div>

        <div id="scan-preview-container"></div>

        <div class="card stack-sm">
          <h3>📂 Bereits gespeicherte Materialien</h3>
          ${matsHtml}
        </div>
      </div>
    `;
  },

  _bindScanTabEvents(c, subject, exams) {
    const input = document.getElementById("scan-file-input");
    const thumbs = document.getElementById("scan-thumbs");
    const runBtn = document.getElementById("scan-run-btn");
    const statusEl = document.getElementById("scan-status");

    const renderThumbs = () => {
      thumbs.innerHTML = this._scanFiles
        .map(
          (item, idx) => `
        <div class="thumb-item">
          <img src="${item.url}" alt="Foto ${idx + 1}" />
          <button type="button" class="thumb-remove" onclick="ChildViews.removeScanFile(${idx})">✕</button>
        </div>
      `
        )
        .join("");
      runBtn.disabled = this._scanFiles.length === 0;
    };

    this.removeScanFile = (idx) => {
      const removed = this._scanFiles.splice(idx, 1);
      if (removed[0]?.url) URL.revokeObjectURL(removed[0].url);
      renderThumbs();
    };

    input.onchange = async () => {
      const picked = Array.from(input.files || []);
      statusEl.textContent = "Bilder werden optimiert…";
      for (const f of picked) {
        const compressed = await App.compressImageFile(f);
        this._scanFiles.push({ file: compressed, url: URL.createObjectURL(compressed) });
      }
      input.value = "";
      statusEl.textContent = `${this._scanFiles.length} Foto(s) bereit.`;
      renderThumbs();
    };

    runBtn.onclick = async () => {
      if (!this._scanFiles.length) return;
      runBtn.disabled = true;
      const count = this._scanFiles.length;
      const startedAt = Date.now();
      const updateTimer = () => {
        const secs = Math.floor((Date.now() - startedAt) / 1000);
        statusEl.textContent = `Gemini liest ${count} Foto(s) aus… (${secs} Sek.)`;
      };
      updateTimer();
      const timerId = setInterval(updateTimer, 1000);
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 150_000);

      try {
        const fd = new FormData();
        fd.append("subject_id", String(subject.id));
        fd.append("material_type", document.getElementById("scan-type").value);
        fd.append("extra_note", document.getElementById("scan-note").value);
        for (const item of this._scanFiles) {
          fd.append("files", item.file);
        }
        const res = await App.api(`/api/children/${c.id}/scan`, {
          method: "POST",
          body: fd,
          signal: controller.signal,
        });
        this._scanPreview = res;
        const totalSecs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        statusEl.textContent = `Fertig in ${totalSecs} Sek.! Bitte kurz prüfen und speichern.`;
        this._renderScanPreview(c, subject, exams, res);
      } catch (err) {
        const msg =
          err.name === "AbortError"
            ? "Zeitüberschreitung beim Auslesen. Tipp: Probiere es mit 3–5 Seiten pro Durchgang oder prüfe das Fast-Modell im Elternbereich."
            : err.message;
        statusEl.textContent = `Fehler: ${msg}`;
        App.toast(msg, "error");
        runBtn.disabled = false;
      } finally {
        clearInterval(timerId);
        clearTimeout(abortTimer);
      }
    };
  },

  _renderScanPreview(c, subject, exams, scanRes) {
    const container = document.getElementById("scan-preview-container");
    const p = scanRes.preview;

    if (scanRes.material_type === "vocab") {
      const rows = (p.items || [])
        .map(
          (it, idx) => `
          <tr data-row="${idx}">
            <td><input type="text" class="pv-art" value="${App.esc(it.article || "")}" placeholder="le/la" style="min-width:64px;" /></td>
            <td><input type="text" class="pv-for" value="${App.esc(it.term_foreign || "")}" /></td>
            <td><input type="text" class="pv-ger" value="${App.esc(it.term_german || "")}" /></td>
            <td><input type="text" class="pv-hint" value="${App.esc(it.hint || "")}" /></td>
            <td><button type="button" class="btn btn-danger btn-sm" onclick="this.closest('tr').remove()">✕</button></td>
          </tr>
        `
        )
        .join("");

      container.innerHTML = `
        <div class="card stack" style="border: 2px solid var(--primary);">
          <h3>✅ Erkannte Vokabeln prüfen & speichern</h3>
          <div class="grid-2">
            <div class="field">
              <label>Titel</label>
              <input type="text" id="commit-title" value="${App.esc(p.suggested_title || "Vokabel-Scan")}" />
            </div>
            <div class="field">
              <label>Lektion / Unit</label>
              <input type="text" id="commit-unit" value="${App.esc(p.unit_name || "Scan")}" />
            </div>
          </div>
          <div class="table-wrap">
            <table class="clean-table">
              <thead><tr><th>Artikel</th><th>${App.esc(subject.name)}</th><th>Deutsch</th><th>Merkhilfe</th><th></th></tr></thead>
              <tbody id="pv-vocab-body">${rows}</tbody>
            </table>
          </div>
          <div class="row">
            <button type="button" class="btn btn-primary btn-lg" id="commit-scan-btn">💾 In Vokabelkasten speichern</button>
          </div>
        </div>
      `;

      document.getElementById("commit-scan-btn").onclick = async () => {
        const trs = Array.from(document.querySelectorAll("#pv-vocab-body tr"));
        const unit = document.getElementById("commit-unit").value || "Scan";
        const vocab_items = trs
          .map((tr) => ({
            unit_name: unit,
            article: tr.querySelector(".pv-art").value,
            term_foreign: tr.querySelector(".pv-for").value,
            term_german: tr.querySelector(".pv-ger").value,
            hint: tr.querySelector(".pv-hint").value,
            example_sentence: "",
          }))
          .filter((x) => x.term_foreign.trim() && x.term_german.trim());

        try {
          const out = await App.api(`/api/children/${c.id}/materials/commit`, {
            method: "POST",
            body: {
              subject_id: subject.id,
              material_type: "vocab",
              title: document.getElementById("commit-title").value,
              image_paths: scanRes.image_paths,
              extracted_markdown: p.extracted_markdown || "",
              unit_name: unit,
              vocab_items,
            },
          });
          App.toast(`${out.created_vocab} Vokabeln gespeichert!`, "success");
          App.go("subject_hub", { childId: c.id, subjectId: subject.id, tab: "learn" });
        } catch (err) {
          App.toast(err.message, "error");
        }
      };
    } else {
      const activeExams = exams.filter((e) => e.status === "active");
      const topicRows = (p.topics || [])
        .map(
          (t) => `
          <div class="card-soft stack-sm pv-topic-row">
            <div class="row-between">
              <input type="text" class="pt-title" value="${App.esc(t.title)}" placeholder="Thema" />
              <button type="button" class="btn btn-danger btn-sm" onclick="this.closest('.pv-topic-row').remove()">✕</button>
            </div>
            <input type="text" class="pt-desc" value="${App.esc(t.description || "")}" placeholder="Kurzbeschreibung" />
          </div>
        `
        )
        .join("");

      container.innerHTML = `
        <div class="card stack" style="border: 2px solid var(--primary);">
          <h3>✅ Erkannte Prüfungsthemen prüfen & speichern</h3>
          <div class="grid-2">
            <div class="field">
              <label>Bestehende Prüfung oder neu anlegen</label>
              <select id="commit-exam-id">
                <option value="">+ Neue Prüfung anlegen</option>
                ${activeExams.map((e) => `<option value="${e.id}">${App.esc(e.title)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Name der neuen Prüfung / des Materials</label>
              <input type="text" id="commit-title" value="${App.esc(p.suggested_title || "Neue Prüfung")}" />
            </div>
          </div>
          <div class="field" style="max-width:260px;">
            <label>Prüfungsdatum (optional)</label>
            <input type="date" id="commit-exam-date" />
          </div>
          <div class="stack-sm">
            <strong>Erkannte Unterthemen:</strong>
            <div id="pv-topics-list" class="stack-sm">${topicRows}</div>
          </div>
          <div class="row">
            <button type="button" class="btn btn-primary btn-lg" id="commit-scan-btn">💾 Lernstoff speichern</button>
          </div>
        </div>
      `;

      document.getElementById("commit-scan-btn").onclick = async () => {
        const examIdVal = document.getElementById("commit-exam-id").value;
        const topics = Array.from(document.querySelectorAll(".pv-topic-row"))
          .map((el) => ({
            title: el.querySelector(".pt-title").value,
            description: el.querySelector(".pt-desc").value,
            key_concepts: [],
          }))
          .filter((t) => t.title.trim());

        try {
          const out = await App.api(`/api/children/${c.id}/materials/commit`, {
            method: "POST",
            body: {
              subject_id: subject.id,
              material_type: "exam_topic",
              title: document.getElementById("commit-title").value,
              image_paths: scanRes.image_paths,
              extracted_markdown: p.extracted_markdown || "",
              exam_id: examIdVal ? Number(examIdVal) : null,
              new_exam_title: document.getElementById("commit-title").value,
              new_exam_date: document.getElementById("commit-exam-date").value || null,
              topics,
            },
          });
          App.toast(`Lernstoff mit ${out.created_topics} Themen gespeichert!`, "success");
          App.go("subject_hub", { childId: c.id, subjectId: subject.id, tab: "learn" });
        } catch (err) {
          App.toast(err.message, "error");
        }
      };
    }
  },

  _renderSubjectPaperTab(c, subject, exams, worksheets) {
    const activeExams = exams.filter((e) => e.status === "active");
    const wsCards = worksheets.length
      ? worksheets
          .map(
            (w) => `
          <div class="card row-between">
            <div class="stack-sm" style="gap:4px;">
              <div class="row">
                <strong>${App.esc(w.title)}</strong>
                <span class="pill">${App.esc(w.code)}</span>
                <span class="small muted">${w.duration_minutes} Min. · ${App.formatDate(w.created_at)}</span>
              </div>
              <div class="small muted">
                ${
                  w.graded_at
                    ? `✅ Korrigiert am ${App.formatDate(w.graded_at)}: <strong>${w.score} / ${w.max_score} Punkte</strong>`
                    : "Noch nicht korrigiert – ausdrucken, auf Papier lösen & danach abfotografieren!"
                }
              </div>
            </div>
            <button class="btn btn-primary btn-sm"
                    onclick="App.go('worksheet', { worksheetId: ${w.id}, returnChildId: ${c.id}, returnSubjectId: ${subject.id} })">
              ${w.graded_at ? "Ergebnis & Druck ansehen" : "🖨️ Öffnen / Foto prüfen"}
            </button>
          </div>
        `
          )
          .join("")
      : `<p class="small muted">Noch keine Papier-Arbeitsblätter für ${App.esc(subject.name)} erstellt.</p>`;

    return `
      <div class="stack">
        <div class="card stack">
          <div>
            <h2>🖨️ Neues Papier-Arbeitsblatt / Probearbeit erstellen</h2>
            <p class="muted small">
              Mit ${subject.paper_style === "grid" ? "Rechenkästchen" : "Schreiblinien"}, Punktefeld und separatem Lösungsblatt.
              Nach dem Ausfüllen einfach abfotografieren und von Gemini korrigieren lassen!
            </p>
          </div>

          <form id="ws-gen-form" class="grid-2">
            <div class="field">
              <label for="ws-exam">Prüfung (optional)</label>
              <select id="ws-exam">
                <option value="">Alle aktiven Themen in ${App.esc(subject.name)}</option>
                ${activeExams.map((e) => `<option value="${e.id}">${App.esc(e.title)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="ws-focus">Schwerpunkt</label>
              <select id="ws-focus">
                <option value="weaknesses">🎯 Gezielt aktuelle Schwachstellen</option>
                <option value="mixed">⚖️ Gemischte Probearbeit</option>
                ${subject.subject_type === "language" ? `<option value="vocab">🃏 Schriftlicher Vokabeltest</option>` : ""}
              </select>
            </div>
            <div class="field">
              <label for="ws-duration">Umfang / Zeit</label>
              <select id="ws-duration">
                <option value="10">Kurz-Check (10 Min., ~4 Aufgaben)</option>
                <option value="20" selected>Übungsblatt (20 Min., ~6 Aufgaben)</option>
                <option value="35">Probearbeit (35 Min., ~8 Aufgaben)</option>
              </select>
            </div>
            <div class="field">
              <label for="ws-title">Eigener Titel (optional)</label>
              <input type="text" id="ws-title" placeholder="Wird automatisch benannt" />
            </div>
            <div style="grid-column:1/-1;" class="row">
              <button type="submit" id="ws-gen-btn" class="btn btn-primary btn-lg">✨ Arbeitsblatt erstellen</button>
              <span id="ws-gen-status" class="small muted"></span>
            </div>
          </form>
        </div>

        <div class="stack-sm">
          <h3>Gespeicherte Arbeitsblätter</h3>
          ${wsCards}
        </div>
      </div>
    `;
  },

  _bindPaperTabEvents(c, subject) {
    const form = document.getElementById("ws-gen-form");
    if (!form) return;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = document.getElementById("ws-gen-btn");
      const status = document.getElementById("ws-gen-status");
      btn.disabled = true;
      status.textContent = "Arbeitsblatt wird erstellt…";
      const duration = Number(document.getElementById("ws-duration").value);
      const qCount = duration <= 12 ? 4 : duration <= 25 ? 6 : 8;
      const examVal = document.getElementById("ws-exam").value;
      try {
        const res = await App.api(`/api/children/${c.id}/worksheets/generate`, {
          method: "POST",
          body: {
            subject_id: subject.id,
            exam_id: examVal ? Number(examVal) : null,
            title: document.getElementById("ws-title").value || null,
            duration_minutes: duration,
            focus_mode: document.getElementById("ws-focus").value,
            question_count: qCount,
          },
        });
        App.toast("Arbeitsblatt bereit zum Drucken!", "success");
        App.go("worksheet", { worksheetId: res.worksheet.id, returnChildId: c.id, returnSubjectId: subject.id });
      } catch (err) {
        status.textContent = "";
        btn.disabled = false;
        App.toast(err.message, "error");
      }
    };
  },

  // ============================================================
  // VOCAB TRAINER (Leitner 5-Box)
  // ============================================================
  async renderVocabTrainer(childId, subjectId) {
    const data = await this.loadChild(childId);
    const c = data.child;
    const subject = data.subjects.find((s) => s.id === subjectId);
    const vocabRes = await App.api(`/api/children/${c.id}/vocab?subject_id=${subject.id}`);

    const dueItems = vocabRes.items.filter((v) => v.is_due);
    const queue = (dueItems.length ? dueItems : vocabRes.items).slice(0, c.ui_mode === "junior" ? 8 : 12);

    this._vocabState = {
      child: c,
      subject,
      allItems: vocabRes.items,
      queue,
      index: 0,
      mode: c.ui_mode === "junior" ? "flashcard" : "typing",
      direction: "de_to_foreign",
      revealed: false,
      feedback: null,
      correctCount: 0,
      finished: false,
    };
    this._drawVocabView();
  },

  _drawVocabView() {
    const st = this._vocabState;
    const { child: c, subject } = st;
    const isFrench = subject.slug === "franzoesisch";

    if (!st.queue.length) {
      App.renderShell(
        `<div class="card stack"><h2>Keine Vokabeln vorhanden</h2>
         <button class="btn btn-primary" onclick="App.go('subject_hub', { childId:${c.id}, subjectId:${subject.id}, tab:'scan' })">Vokabeln scannen</button></div>`,
        { narrow: true }
      );
      return;
    }

    if (st.finished) {
      const pct = Math.round((st.correctCount / st.queue.length) * 100);
      App.renderShell(
        `
        <div class="card stack" style="text-align:center; padding: 36px 24px;">
          <div style="font-size:3.5rem;">🎉</div>
          <h1>Vokabel-Runde geschafft!</h1>
          <p class="muted">${st.correctCount} von ${st.queue.length} richtig (${pct}%)</p>
          <div class="row" style="justify-content:center; margin-top:8px;">
            <button class="btn btn-primary btn-lg" onclick="App.go('vocab_trainer', { childId:${c.id}, subjectId:${subject.id} })">Nächste Runde</button>
            <button class="btn btn-secondary btn-lg" onclick="App.go('subject_hub', { childId:${c.id}, subjectId:${subject.id}, tab:'learn' })">Zurück zu ${App.esc(subject.name)}</button>
          </div>
        </div>
        `,
        { narrow: true }
      );
      return;
    }

    const item = st.queue[st.index];
    const progressPct = Math.round((st.index / st.queue.length) * 100);
    const fullForeign = App.formatForeignWord(item.article, item.term_foreign);
    const questionText = st.direction === "de_to_foreign" ? item.term_german : fullForeign;
    const answerText = st.direction === "de_to_foreign" ? fullForeign : item.term_german;
    const speakTarget = fullForeign;

    let bodyHtml = "";
    if (st.mode === "flashcard") {
      bodyHtml = `
        <div class="flashcard" onclick="ChildViews.vocabToggleReveal()">
          <span class="pill">Fach ${item.box} · ${App.esc(item.unit_name)}</span>
          <div class="flashcard-word">${App.esc(questionText)}</div>
          ${
            st.revealed
              ? `
                <div class="flashcard-answer">${App.esc(answerText)}</div>
                ${item.hint ? `<p class="small muted">💡 ${App.esc(item.hint)}</p>` : ""}
                <button type="button" class="btn btn-secondary btn-sm"
                        onclick="event.stopPropagation(); App.speak(${App.jsArg(speakTarget)}, '${App.esc(subject.lang_code)}')">
                  🔊 Aussprache anhören
                </button>
              `
              : `<p class="muted small">Tippe auf die Karte zum Aufdecken</p>`
          }
        </div>
        ${
          st.revealed
            ? `
            <div class="grid-3">
              <button class="btn btn-danger btn-lg" onclick="ChildViews.vocabSubmitSelf('wrong')">😕 Nochmal (Fach 1)</button>
              <button class="btn btn-secondary btn-lg" onclick="ChildViews.vocabSubmitSelf('almost')">🤔 Fast</button>
              <button class="btn btn-success btn-lg" onclick="ChildViews.vocabSubmitSelf('correct')">✅ Gewusst!</button>
            </div>
          `
            : `<button class="btn btn-primary btn-lg btn-block" onclick="ChildViews.vocabToggleReveal()">Lösung zeigen</button>`
        }
      `;
    } else if (st.mode === "multiple_choice") {
      // Build 4 options deterministically for current card
      if (!item._mcOptions) {
        const pool = st.allItems
          .filter((x) => x.id !== item.id)
          .map((x) =>
            st.direction === "de_to_foreign"
              ? App.formatForeignWord(x.article, x.term_foreign)
              : x.term_german
          );
        const distractors = [...new Set(pool)].sort(() => Math.random() - 0.5).slice(0, 3);
        item._mcOptions = [answerText, ...distractors].sort(() => Math.random() - 0.5);
      }
      bodyHtml = `
        <div class="card-soft stack-sm" style="text-align:center; padding:22px;">
          <span class="pill" style="margin:0 auto;">Fach ${item.box} · ${App.esc(item.unit_name)}</span>
          <div class="flashcard-word">${App.esc(questionText)}</div>
          ${
            st.direction === "foreign_to_de"
              ? `<button class="btn btn-secondary btn-sm" style="margin:0 auto;" onclick="App.speak(${App.jsArg(speakTarget)}, '${App.esc(subject.lang_code)}')">🔊 Anhören</button>`
              : ""
          }
        </div>
        <div class="stack-sm">
          ${item._mcOptions
            .map((opt) => {
              let cls = "option-btn";
              if (st.feedback) {
                if (opt === answerText) cls += " correct";
                else if (opt === st.feedback.chosen) cls += " wrong";
              }
              return `<button class="${cls}" ${st.feedback ? "disabled" : ""}
                              onclick="ChildViews.vocabSubmitMC(${App.jsArg(opt)}, ${App.jsArg(answerText)})">${App.esc(opt)}</button>`;
            })
            .join("")}
        </div>
      `;
    } else {
      bodyHtml = `
        <div class="card-soft stack-sm" style="text-align:center; padding:22px;">
          <span class="pill" style="margin:0 auto;">Fach ${item.box} · ${App.esc(item.unit_name)}</span>
          <div class="flashcard-word">${App.esc(questionText)}</div>
          ${item.hint ? `<p class="small muted">💡 Hinweis: ${App.esc(item.hint)}</p>` : ""}
        </div>
        <form id="vocab-type-form" class="stack-sm">
          <input type="text" id="vocab-type-input" autocomplete="off" autocapitalize="off" spellcheck="false"
                 placeholder="${st.direction === "de_to_foreign" ? `Auf ${subject.name} eintippen…` : "Auf Deutsch eintippen…"}"
                 ${st.feedback ? "disabled" : ""} />
          ${isFrench && st.direction === "de_to_foreign" ? App.frenchAccentBarHtml("vocab-type-input") : ""}
          ${!st.feedback ? `<button type="submit" class="btn btn-primary btn-lg">Prüfen</button>` : ""}
        </form>
      `;
    }

    const feedbackHtml = st.feedback
      ? `
        <div class="banner ${st.feedback.outcome === "correct" ? "banner-success" : st.feedback.outcome === "almost" ? "banner-warn" : "banner-error"} stack-sm">
          <strong>${App.esc(st.feedback.feedback)}</strong>
          <div class="row">
            <button type="button" class="btn btn-secondary btn-sm"
                    onclick="App.speak(${App.jsArg(speakTarget)}, '${App.esc(subject.lang_code)}')">
              🔊 ${App.esc(fullForeign)} anhören
            </button>
            <button type="button" class="btn btn-primary btn-sm" onclick="ChildViews.vocabNext()">Weiter →</button>
          </div>
        </div>
      `
      : "";

    App.renderShell(
      `
      <div class="stack">
        <div class="row-between">
          <button class="btn btn-secondary btn-sm" onclick="App.go('subject_hub', { childId:${c.id}, subjectId:${subject.id}, tab:'learn' })">← Zurück</button>
          <span class="small muted">Karte ${st.index + 1} von ${st.queue.length}</span>
        </div>

        <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>

        <div class="row-between">
          <div class="tabs">
            <button class="tab ${st.mode === "flashcard" ? "active" : ""}" onclick="ChildViews.vocabSetMode('flashcard')">🃏 Karteikarten</button>
            <button class="tab ${st.mode === "multiple_choice" ? "active" : ""}" onclick="ChildViews.vocabSetMode('multiple_choice')">☑️ Auswahl</button>
            <button class="tab ${st.mode === "typing" ? "active" : ""}" onclick="ChildViews.vocabSetMode('typing')">⌨️ Eintippen</button>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="ChildViews.vocabToggleDirection()">
            ${st.direction === "de_to_foreign" ? `DE → ${App.esc(subject.name)}` : `${App.esc(subject.name)} → DE`}
          </button>
        </div>

        <div class="card stack">
          ${bodyHtml}
          ${feedbackHtml}
        </div>
      </div>
      `,
      { narrow: true }
    );

    const typeInput = document.getElementById("vocab-type-input");
    if (typeInput && !st.feedback) {
      typeInput.focus();
      document.getElementById("vocab-type-form").onsubmit = async (e) => {
        e.preventDefault();
        await this.vocabSubmitTyping(typeInput.value);
      };
    }
  },

  vocabSetMode(mode) {
    this._vocabState.mode = mode;
    this._vocabState.revealed = false;
    this._vocabState.feedback = null;
    this._drawVocabView();
  },

  vocabToggleDirection() {
    this._vocabState.direction = this._vocabState.direction === "de_to_foreign" ? "foreign_to_de" : "de_to_foreign";
    this._vocabState.queue.forEach((x) => delete x._mcOptions);
    this._vocabState.revealed = false;
    this._vocabState.feedback = null;
    this._drawVocabView();
  },

  vocabToggleReveal() {
    this._vocabState.revealed = !this._vocabState.revealed;
    this._drawVocabView();
  },

  async vocabSubmitSelf(rating) {
    const st = this._vocabState;
    const item = st.queue[st.index];
    const res = await App.api(`/api/children/${st.child.id}/vocab/review`, {
      method: "POST",
      body: { vocab_id: item.id, mode: "flashcard", self_rating: rating, direction: st.direction },
    });
    if (rating !== "wrong") st.correctCount++;
    if (res.progress) {
      App.state.currentChild.stars = res.progress.stars;
      App.state.currentChild.streak_days = res.progress.streak_days;
    }
    await this.vocabNext();
  },

  async vocabSubmitMC(chosen, expected) {
    const st = this._vocabState;
    const item = st.queue[st.index];
    const rating = chosen === expected ? "correct" : "wrong";
    const res = await App.api(`/api/children/${st.child.id}/vocab/review`, {
      method: "POST",
      body: { vocab_id: item.id, mode: "multiple_choice", self_rating: rating, direction: st.direction },
    });
    if (rating === "correct") st.correctCount++;
    st.feedback = { outcome: rating, feedback: rating === "correct" ? "Richtig!" : `Richtig ist: ${expected}`, chosen };
    this._drawVocabView();
  },

  async vocabSubmitTyping(userInput) {
    const st = this._vocabState;
    const item = st.queue[st.index];
    const res = await App.api(`/api/children/${st.child.id}/vocab/review`, {
      method: "POST",
      body: { vocab_id: item.id, mode: "typing", user_input: userInput, direction: st.direction },
    });
    if (res.outcome !== "wrong") st.correctCount++;
    st.feedback = { outcome: res.outcome, feedback: res.feedback };
    this._drawVocabView();
  },

  async vocabNext() {
    const st = this._vocabState;
    st.revealed = false;
    st.feedback = null;
    st.index++;
    if (st.index >= st.queue.length) {
      st.finished = true;
      try {
        await App.api(`/api/children/${st.child.id}/vocab/session-log`, {
          method: "POST",
          body: {
            subject_id: st.subject.id,
            mode: "vocab",
            score: st.correctCount,
            max_score: st.queue.length,
          },
        });
      } catch {}
    }
    this._drawVocabView();
  },

  // ============================================================
  // INTERACTIVE EXAM COACH
  // ============================================================
  async renderPracticeRunner(childId, subjectId, examId, style = "adaptive_mix") {
    const data = await this.loadChild(childId);
    const c = data.child;
    const subject = data.subjects.find((s) => s.id === subjectId);

    App.renderShell(
      `<div class="loading-screen"><div class="spinner"></div><h3>Deine persönlichen Übungsaufgaben werden zusammengestellt…</h3><p class="muted small">70% gezielt auf Schwachstellen · 30% Festigung</p></div>`,
      { narrow: true }
    );

    try {
      const qCount = c.settings?.session_length || (c.ui_mode === "junior" ? 6 : 8);
      const set = await App.api(`/api/children/${c.id}/practice/generate`, {
        method: "POST",
        body: { subject_id: subject.id, exam_id: examId, practice_style: style, question_count: qCount },
      });

      this._practiceState = {
        child: c,
        subject,
        examId,
        style,
        set,
        index: 0,
        hintsShown: 0,
        feedback: null,
        score: 0,
        maxScore: set.questions.reduce((acc, q) => acc + (q.points || 2), 0),
        topicResults: [],
        detectedWeaknesses: [],
        matchLeftSelected: null,
        matchPairsDone: {},
        finished: false,
        finishMeta: null,
      };
      this._drawPracticeView();
    } catch (err) {
      App.renderShell(
        `<div class="card stack"><h2>Übung konnte nicht erstellt werden</h2><p class="muted">${App.esc(err.message)}</p>
         <button class="btn btn-primary" onclick="App.go('subject_hub', { childId:${c.id}, subjectId:${subject.id}, tab:'learn' })">Zurück</button></div>`,
        { narrow: true }
      );
    }
  },

  _drawPracticeView() {
    const st = this._practiceState;
    const { child: c, subject } = st;

    if (st.finished) {
      const pct = Math.round((st.score / Math.max(1, st.maxScore)) * 100);
      App.renderShell(
        `
        <div class="card stack" style="text-align:center; padding: 36px 24px;">
          <div style="font-size:3.5rem;">${pct >= 75 ? "🏆" : "⭐"}</div>
          <h1>Super gemacht, ${App.esc(c.name)}!</h1>
          <p class="muted">${st.score} von ${st.maxScore} Punkten (${pct}%)</p>
          ${st.finishMeta ? `<div class="pill pill-amber" style="margin:0 auto;">+${st.finishMeta.stars_earned} Sterne verdient!</div>` : ""}
          ${
            st.detectedWeaknesses.length
              ? `<div class="banner banner-info" style="text-align:left;">
                   <strong>Gemerkte Übungspunkte fürs nächste Mal:</strong>
                   <ul style="margin:6px 0 0 18px;">
                     ${st.detectedWeaknesses.map((w) => `<li>${App.esc(w.summary)}</li>`).join("")}
                   </ul>
                 </div>`
              : ""
          }
          <div class="row" style="justify-content:center; margin-top:8px;">
            <button class="btn btn-primary btn-lg" onclick="App.go('subject_hub', { childId:${c.id}, subjectId:${subject.id}, tab:'learn' })">Zurück zu ${App.esc(subject.name)}</button>
            <button class="btn btn-secondary btn-lg" onclick="App.go('subject_hub', { childId:${c.id}, subjectId:${subject.id}, tab:'paper' })">🖨️ Papier-Blatt drucken</button>
          </div>
        </div>
        `,
        { narrow: true }
      );
      return;
    }

    const q = st.set.questions[st.index];
    const progressPct = Math.round((st.index / st.set.questions.length) * 100);
    const hints = q.hints || [];
    const shownHintsHtml = st.hintsShown
      ? `<div class="banner banner-info stack-sm">
           <strong>💡 Tipp${st.hintsShown > 1 ? "s" : ""}:</strong>
           ${hints.slice(0, st.hintsShown).map((h, i) => `<div>${i + 1}. ${App.esc(h)}</div>`).join("")}
         </div>`
      : "";

    let interactionHtml = "";
    if (q.question_type === "multiple_choice" && q.options?.length) {
      interactionHtml = `
        <div class="stack-sm">
          ${q.options
            .map((opt) => {
              let cls = "option-btn";
              if (st.feedback) {
                if (opt === q.expected_answer) cls += " correct";
                else if (opt === st.feedback.userAnswer) cls += " wrong";
              }
              return `<button class="${cls}" ${st.feedback ? "disabled" : ""}
                              onclick="ChildViews.practiceSubmitMC(${App.jsArg(opt)})">${App.esc(opt)}</button>`;
            })
            .join("")}
        </div>
      `;
    } else if (q.question_type === "matching" && q.match_pairs?.length) {
      if (!q._shuffledRight) {
        q._shuffledRight = q.match_pairs.map((p) => p.right).sort(() => Math.random() - 0.5);
      }
      const leftHtml = q.match_pairs
        .map((p) => {
          const paired = st.matchPairsDone[p.left];
          const cls = paired ? "match-item paired" : st.matchLeftSelected === p.left ? "match-item active" : "match-item";
          return `<button type="button" class="${cls}" ${paired || st.feedback ? "disabled" : ""}
                          onclick="ChildViews.matchSelectLeft(${App.jsArg(p.left)})">${App.esc(p.left)}</button>`;
        })
        .join("");
      const rightHtml = q._shuffledRight
        .map((r) => {
          const used = Object.values(st.matchPairsDone).includes(r);
          return `<button type="button" class="match-item ${used ? "paired" : ""}" ${used || st.feedback ? "disabled" : ""}
                          onclick="ChildViews.matchSelectRight(${App.jsArg(r)})">${App.esc(r)}</button>`;
        })
        .join("");

      interactionHtml = `
        <p class="small muted">Tippe zuerst links einen Begriff an und dann rechts das passende Gegenstück:</p>
        <div class="match-grid">
          <div class="stack-sm">${leftHtml}</div>
          <div class="stack-sm">${rightHtml}</div>
        </div>
      `;
    } else if (q.question_type === "dictation") {
      const speech = q.speech_text || q.expected_answer;
      interactionHtml = `
        <div class="card-soft stack-sm">
          <div class="row">
            <button type="button" class="btn btn-primary" onclick="App.speak(${App.jsArg(speech)}, 'de-DE', 0.92)">🔊 Normal vorlesen</button>
            <button type="button" class="btn btn-secondary" onclick="App.speak(${App.jsArg(speech)}, 'de-DE', 0.68)">🐢 Langsam vorlesen</button>
          </div>
          <p class="small muted">Höre genau zu und tippe den Satz ein (oder schreibe auf Papier und vergleiche danach).</p>
        </div>
        <form id="practice-answer-form" class="stack-sm">
          <textarea id="practice-text-input" placeholder="Schreibe den diktierten Satz hier auf…" ${st.feedback ? "disabled" : ""}></textarea>
          ${!st.feedback ? `<button type="submit" id="practice-submit-btn" class="btn btn-primary btn-lg">Antwort prüfen</button>` : ""}
        </form>
      `;
    } else {
      const isLong = q.question_type === "open";
      interactionHtml = `
        <form id="practice-answer-form" class="stack-sm">
          ${
            isLong
              ? `<textarea id="practice-text-input" placeholder="Erkläre es in deinen eigenen Worten…" ${st.feedback ? "disabled" : ""}></textarea>`
              : `<input type="text" id="practice-text-input" placeholder="Deine Antwort / dein Ergebnis…" ${st.feedback ? "disabled" : ""} />`
          }
          ${subject.slug === "franzoesisch" ? App.frenchAccentBarHtml("practice-text-input") : ""}
          ${!st.feedback ? `<button type="submit" id="practice-submit-btn" class="btn btn-primary btn-lg">Antwort prüfen</button>` : ""}
        </form>
      `;
    }

    const feedbackHtml = st.feedback
      ? `
        <div class="banner ${st.feedback.isCorrect ? "banner-success" : st.feedback.partial ? "banner-warn" : "banner-error"} stack-sm">
          <strong>${App.esc(st.feedback.message)}</strong>
          ${st.feedback.explanation ? `<p class="small">${App.esc(st.feedback.explanation)}</p>` : ""}
          <div>
            <button type="button" class="btn btn-primary" onclick="ChildViews.practiceNext()">
              ${st.index + 1 >= st.set.questions.length ? "Ergebnis ansehen →" : "Nächste Aufgabe →"}
            </button>
          </div>
        </div>
      `
      : "";

    App.renderShell(
      `
      <div class="stack">
        <div class="row-between">
          <button class="btn btn-secondary btn-sm" onclick="App.go('subject_hub', { childId:${c.id}, subjectId:${subject.id}, tab:'learn' })">← Abbrechen</button>
          <span class="small muted">Aufgabe ${st.index + 1} von ${st.set.questions.length} · ${q.points || 2} Pkt.</span>
        </div>

        <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>

        <div class="card stack">
          <div class="row-between">
            <div class="row">
              ${q.topic_title ? `<span class="pill">${App.esc(q.topic_title)}</span>` : ""}
              ${q.targets_weakness ? `<span class="pill pill-amber">🎯 Fokus-Übung</span>` : ""}
            </div>
            <button type="button" class="btn btn-ghost btn-sm"
                    onclick="App.speak(${App.jsArg(q.prompt)}, 'de-DE', 0.95)">
              🔊 Vorlesen
            </button>
          </div>

          <h2 style="white-space:pre-line;">${App.esc(q.prompt)}</h2>

          ${shownHintsHtml}

          ${
            !st.feedback && hints.length > st.hintsShown
              ? `<div><button type="button" class="btn btn-secondary btn-sm" onclick="ChildViews.practiceShowHint()">
                   💡 Tipp anzeigen (${st.hintsShown}/${hints.length})
                 </button></div>`
              : ""
          }

          ${interactionHtml}
          ${feedbackHtml}
        </div>
      </div>
      `,
      { narrow: true }
    );

    const form = document.getElementById("practice-answer-form");
    if (form && !st.feedback) {
      const inp = document.getElementById("practice-text-input");
      inp?.focus();
      form.onsubmit = async (e) => {
        e.preventDefault();
        await this.practiceSubmitText(inp.value);
      };
    }
  },

  practiceShowHint() {
    this._practiceState.hintsShown++;
    this._drawPracticeView();
  },

  practiceSubmitMC(chosen) {
    const st = this._practiceState;
    const q = st.set.questions[st.index];
    const isCorrect = chosen === q.expected_answer;
    const pts = q.points || 2;
    if (isCorrect) st.score += pts;
    if (q.topic_id) st.topicResults.push({ topic_id: q.topic_id, ratio: isCorrect ? 1 : 0 });
    if (!isCorrect && q.topic_title) {
      st.detectedWeaknesses.push({
        topic_id: q.topic_id || null,
        summary: `Unsicherheit bei: ${q.topic_title}`,
        example_mistake: `Gewählt: "${chosen}" statt "${q.expected_answer}"`,
        recommendation: "Thema in einer kurzen Runde gezielt wiederholen.",
        severity: 2,
      });
    }
    st.feedback = {
      isCorrect,
      partial: false,
      userAnswer: chosen,
      message: isCorrect ? "Klasse! Genau richtig." : `Nicht ganz – richtig ist: ${q.expected_answer}`,
      explanation: q.explanation,
    };
    this._drawPracticeView();
  },

  matchSelectLeft(leftVal) {
    this._practiceState.matchLeftSelected = leftVal;
    this._drawPracticeView();
  },

  matchSelectRight(rightVal) {
    const st = this._practiceState;
    if (!st.matchLeftSelected) return;
    const q = st.set.questions[st.index];
    const correctPair = q.match_pairs.find((p) => p.left === st.matchLeftSelected);
    if (correctPair && correctPair.right === rightVal) {
      st.matchPairsDone[st.matchLeftSelected] = rightVal;
      st.matchLeftSelected = null;
      if (Object.keys(st.matchPairsDone).length === q.match_pairs.length) {
        const pts = q.points || 2;
        st.score += pts;
        if (q.topic_id) st.topicResults.push({ topic_id: q.topic_id, ratio: 1 });
        st.feedback = { isCorrect: true, partial: false, message: "Alle Paare richtig zugeordnet!", explanation: q.explanation };
      }
      this._drawPracticeView();
    } else {
      App.toast("Das passt noch nicht zusammen – probier ein anderes Paar!", "error");
      if (q.topic_id) st.topicResults.push({ topic_id: q.topic_id, ratio: 0.4 });
    }
  },

  async practiceSubmitText(userAnswer) {
    const st = this._practiceState;
    const q = st.set.questions[st.index];
    const btn = document.getElementById("practice-submit-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Wird geprüft…";
    }
    try {
      const ev = await App.api(`/api/children/${st.child.id}/practice/evaluate`, {
        method: "POST",
        body: {
          subject_id: st.subject.id,
          exam_id: st.examId,
          topic_id: q.topic_id || null,
          question_type: q.question_type,
          prompt: q.question_type === "dictation" ? q.speech_text || q.prompt : q.prompt,
          expected_answer: q.expected_answer,
          user_answer: userAnswer,
        },
      });
      const pts = q.points || 2;
      st.score += Math.round(pts * ev.score_ratio);
      if (q.topic_id) st.topicResults.push({ topic_id: q.topic_id, ratio: ev.score_ratio });
      if (ev.weakness_summary) {
        st.detectedWeaknesses.push({
          topic_id: q.topic_id || null,
          summary: ev.weakness_summary,
          example_mistake: ev.weakness_example || userAnswer.slice(0, 120),
          recommendation: ev.weakness_recommendation || "",
          severity: ev.is_correct ? 1 : 2,
        });
      }
      st.feedback = {
        isCorrect: ev.is_correct,
        partial: ev.partial_credit,
        message: ev.feedback,
        explanation: ev.is_correct ? q.explanation : `Musterlösung: ${q.expected_answer}${q.explanation ? " — " + q.explanation : ""}`,
      };
      this._drawPracticeView();
    } catch (err) {
      App.toast(err.message, "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Antwort prüfen";
      }
    }
  },

  async practiceNext() {
    const st = this._practiceState;
    st.index++;
    st.hintsShown = 0;
    st.feedback = null;
    st.matchLeftSelected = null;
    st.matchPairsDone = {};

    if (st.index >= st.set.questions.length) {
      st.finished = true;
      try {
        const res = await App.api(`/api/children/${st.child.id}/practice/finish`, {
          method: "POST",
          body: {
            subject_id: st.subject.id,
            exam_id: st.examId,
            mode: st.style === "dictation" ? "dictation" : "exam_interactive",
            score: st.score,
            max_score: st.maxScore,
            topic_results: st.topicResults,
            detected_weaknesses: st.detectedWeaknesses,
          },
        });
        st.finishMeta = res;
        if (res.progress) {
          App.state.currentChild.stars = res.progress.stars;
          App.state.currentChild.streak_days = res.progress.streak_days;
        }
      } catch {}
    }
    this._drawPracticeView();
  },
};
