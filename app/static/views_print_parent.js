window.PrintParentViews = {
  _gradeFiles: [],
  _lastParentOverview: null,
  _selectedChildId: null,
  _parentUi: {
    tab: "overview", // 'overview' | 'exams' | 'settings'
    examFilter: "active", // 'active' | 'archived' | 'all'
    examSubjectId: "",
    examSearch: "",
    examPage: 1,
    pageSize: 10,
    expandedExams: {},
    showArchivedTopics: {},
    weakSubjectId: "",
    hideResolvedWeak: true,
  },

  async renderWorksheetView(worksheetId, returnChildId = null, returnSubjectId = null) {
    const res = await App.api(`/api/worksheets/${worksheetId}`);
    const ws = res.worksheet;
    this._gradeFiles = [];

    const backAction =
      returnChildId && returnSubjectId
        ? `App.go('subject_hub', { childId:${returnChildId}, subjectId:${returnSubjectId}, tab:'paper' })`
        : returnChildId
        ? `App.go('child_home', { childId:${returnChildId} })`
        : `App.go('parent')`;

    const questionsHtml = (ws.questions || [])
      .map((q) => {
        const lines = Math.max(2, Math.min(10, Number(q.answer_space_lines || 4)));
        const spaceHtml =
          ws.paper_style === "grid"
            ? `<div class="paper-grid" style="height:${lines * 28}px;"></div>`
            : `<div class="paper-lines">${Array.from({ length: lines })
                .map(() => `<div class="paper-line"></div>`)
                .join("")}</div>`;

        const subsHtml = q.sub_items?.length
          ? `<ul class="ws-sublist">${q.sub_items.map((s) => `<li>${App.esc(s)}</li>`).join("")}</ul>`
          : "";

        return `
          <div class="ws-question">
            <div class="ws-q-head">
              <span>Aufgabe ${q.number}${q.topic_title ? ` (${App.esc(q.topic_title)})` : ""}</span>
              <span>___ / ${q.points || 2} Pkt.</span>
            </div>
            <div style="white-space:pre-line;">${App.esc(q.prompt)}</div>
            ${subsHtml}
            ${spaceHtml}
          </div>
        `;
      })
      .join("");

    const answerKeyHtml = (ws.answer_key || [])
      .map(
        (a) => `
        <div class="ws-question" style="margin-bottom:14px;">
          <strong>Aufgabe ${a.number}:</strong>
          <div style="white-space:pre-line; margin-top:2px;">${App.esc(a.model_solution)}</div>
          ${a.grading_notes ? `<div class="small muted">Korrekturhinweis: ${App.esc(a.grading_notes)}</div>` : ""}
        </div>
      `
      )
      .join("");

    const gradingHtml = ws.grading_result ? this._renderGradingResult(ws.grading_result, ws.submission_images) : "";

    App.renderShell(`
      <div class="stack">
        <div class="card row-between no-print">
          <div class="row">
            <button class="btn btn-secondary btn-sm" onclick="${backAction}">← Zurück</button>
            <span class="pill">${App.esc(ws.code)}</span>
            <strong>${App.esc(ws.title)}</strong>
          </div>
          <div class="row">
            <label class="row small" style="cursor:pointer;">
              <input type="checkbox" id="toggle-answer-key" checked style="width:auto; min-height:auto;" />
              <span>Lösungsblatt mitdrucken</span>
            </label>
            <button class="btn btn-primary" onclick="window.print()">🖨️ Drucken / Als PDF</button>
          </div>
        </div>

        <div class="card stack no-print" style="border: 2px solid var(--primary-soft);">
          <div class="row-between">
            <div>
              <h3>📷 Ausgefülltes Blatt abfotografieren & korrigieren</h3>
              <p class="muted small">
                Löse das Blatt erst in Ruhe auf Papier. Fotografiere es danach ab – Gemini liest deine Handschrift,
                prüft Rechenwege und merkt sich Schwachstellen für die nächsten Übungen!
              </p>
            </div>
          </div>

          <label class="upload-zone stack-sm" for="grade-file-input" style="padding:16px;">
            <strong>📸 Fotos vom ausgefüllten Arbeitsblatt hinzufügen</strong>
            <span class="small muted">Eine oder mehrere Seiten aufnehmen / auswählen</span>
            <input type="file" id="grade-file-input" accept="image/*" capture="environment" multiple style="display:none;" />
          </label>
          <div id="grade-thumbs" class="thumb-grid"></div>
          <div class="row">
            <button id="grade-run-btn" class="btn btn-success" disabled>✨ Handschrift korrigieren (Gemini Smart)</button>
            <span id="grade-status" class="small muted"></span>
          </div>

          <div id="grading-result-box">${gradingHtml}</div>
        </div>

        <div id="worksheet-paper-root" class="worksheet-paper">
          <div class="ws-header">
            <div>
              <div class="small muted">${App.esc(ws.subject_icon)} ${App.esc(ws.subject_name)} · ${App.esc(ws.child_grade)}</div>
              <h1 style="margin-top:4px;">${App.esc(ws.title)}</h1>
            </div>
            <div style="text-align:right;">
              <div style="font-weight:800; font-size:1.1rem;">${App.esc(ws.code)}</div>
              <div class="small muted">Zeit: ca. ${ws.duration_minutes} Min.</div>
            </div>
          </div>

          <div class="ws-meta-grid">
            <div class="ws-meta-box"><strong>Name:</strong> ${App.esc(ws.child_name)}</div>
            <div class="ws-meta-box"><strong>Datum:</strong> _______________</div>
            <div class="ws-meta-box"><strong>Punkte:</strong> ____ / ${ws.max_score || 0}</div>
          </div>

          ${questionsHtml}

          <div class="answer-key-page">
            <h2>Lösungsblatt – ${App.esc(ws.title)} (${App.esc(ws.code)})</h2>
            <p class="small muted" style="margin-bottom:16px;">Für Eltern oder zur Selbstkontrolle nach dem Ausfüllen.</p>
            ${answerKeyHtml}
          </div>
        </div>
      </div>
    `);

    const toggleKey = document.getElementById("toggle-answer-key");
    const paperRoot = document.getElementById("worksheet-paper-root");
    toggleKey.onchange = () => {
      paperRoot.classList.toggle("hide-answer-key", !toggleKey.checked);
    };

    const fileInput = document.getElementById("grade-file-input");
    const thumbs = document.getElementById("grade-thumbs");
    const runBtn = document.getElementById("grade-run-btn");
    const statusEl = document.getElementById("grade-status");

    const renderThumbs = () => {
      thumbs.innerHTML = this._gradeFiles
        .map(
          (it, idx) => `
          <div class="thumb-item">
            <img src="${it.url}" alt="Blatt ${idx + 1}" />
            <button type="button" class="thumb-remove" onclick="PrintParentViews.removeGradeFile(${idx})">✕</button>
          </div>
        `
        )
        .join("");
      runBtn.disabled = this._gradeFiles.length === 0;
    };

    this.removeGradeFile = (idx) => {
      const rem = this._gradeFiles.splice(idx, 1);
      if (rem[0]?.url) URL.revokeObjectURL(rem[0].url);
      renderThumbs();
    };

    fileInput.onchange = async () => {
      statusEl.textContent = "Bilder werden optimiert…";
      for (const f of Array.from(fileInput.files || [])) {
        const c = await App.compressImageFile(f);
        this._gradeFiles.push({ file: c, url: URL.createObjectURL(c) });
      }
      fileInput.value = "";
      statusEl.textContent = `${this._gradeFiles.length} Seite(n) bereit.`;
      renderThumbs();
    };

    runBtn.onclick = async () => {
      if (!this._gradeFiles.length) return;
      runBtn.disabled = true;
      statusEl.textContent = "Gemini liest deine Handschrift und korrigiert… (ca. 10–20 Sek.)";
      try {
        const fd = new FormData();
        for (const it of this._gradeFiles) fd.append("files", it.file);
        const out = await App.api(`/api/worksheets/${ws.id}/grade`, { method: "POST", body: fd });
        statusEl.textContent = `Korrektur fertig! +${out.stars_earned} Sterne verdient.`;
        document.getElementById("grading-result-box").innerHTML = this._renderGradingResult(
          out.grading_result,
          out.submission_images
        );
        App.toast("Arbeitsblatt korrigiert & Schwachstellen aktualisiert!", "success");
      } catch (err) {
        statusEl.textContent = "";
        runBtn.disabled = false;
        App.toast(err.message, "error");
      }
    };
  },

  _renderGradingResult(gr, images = []) {
    const pct = Math.round((gr.total_points / Math.max(1, gr.max_points)) * 100);
    const statusLabel = {
      correct: { text: "Richtig", cls: "pill-green" },
      partial: { text: "Teilweise", cls: "pill-amber" },
      wrong: { text: "Üben", cls: "pill-red" },
      missing: { text: "Leer", cls: "pill" },
    };

    return `
      <div class="stack" style="margin-top:12px;">
        <div class="banner ${pct >= 75 ? "banner-success" : pct >= 45 ? "banner-warn" : "banner-info"} stack-sm">
          <div class="row-between">
            <strong>Ergebnis: ${gr.total_points} / ${gr.max_points} Punkte (${pct}%)</strong>
          </div>
          <p>${App.esc(gr.praise)}</p>
          <p class="small">${App.esc(gr.overall_feedback)}</p>
        </div>

        ${
          images?.length
            ? `<div class="thumb-grid">${images
                .map((p) => `<a href="/api/uploads/${App.esc(p)}" target="_blank" class="thumb-item"><img src="/api/uploads/${App.esc(p)}" alt="Abgabe" /></a>`)
                .join("")}</div>`
            : ""
        }

        <div class="stack-sm">
          ${(gr.items || [])
            .map((it) => {
              const st = statusLabel[it.status] || statusLabel.partial;
              return `
                <div class="card-soft stack-sm" style="gap:4px;">
                  <div class="row-between">
                    <strong>Aufgabe ${it.number}</strong>
                    <div class="row">
                      <span class="pill ${st.cls}">${st.text}</span>
                      <span class="small muted">${it.points_awarded}/${it.max_points} Pkt.</span>
                    </div>
                  </div>
                  <div class="small muted"><em>Erkannte Handschrift:</em> ${App.esc(it.transcribed_answer || "–")}</div>
                  <div class="small">${App.esc(it.feedback)}</div>
                  ${
                    it.detected_weakness
                      ? `<div class="small" style="color:var(--amber);">🎯 Gemerkte Schwachstelle: <strong>${App.esc(it.detected_weakness)}</strong></div>`
                      : ""
                  }
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    `;
  },

  // ============================================================
  // PARENT DASHBOARD (PIN-protected, scalable tabs & archiving)
  // ============================================================
  async renderParentDashboard(selectedChildId = null) {
    let data;
    try {
      data = await App.api("/api/parent/overview");
    } catch (err) {
      if (err.status === 403) {
        App.state.auth.parent_unlocked = false;
        App.openParentPinModal(() => this.renderParentDashboard(selectedChildId));
        return;
      }
      App.toast(err.message, "error");
      return;
    }

    this._lastParentOverview = data;
    if (selectedChildId) this._selectedChildId = selectedChildId;
    this._drawParentDashboard();
  },

  _getActiveParentSummary() {
    const data = this._lastParentOverview;
    if (!data?.children?.length) return null;
    const found = data.children.find((s) => s.child.id === this._selectedChildId);
    const active = found || data.children[0];
    this._selectedChildId = active.child.id;
    return active;
  },

  setParentChild(childId) {
    this._selectedChildId = childId;
    this._parentUi.examPage = 1;
    this._drawParentDashboard();
  },

  setParentTab(tab) {
    this._parentUi.tab = tab;
    this._drawParentDashboard();
  },

  _drawParentDashboard() {
    const data = this._lastParentOverview;
    const active = this._getActiveParentSummary();
    if (!data || !active) return;

    const c = active.child;
    const ui = this._parentUi;

    const warnings = [];
    if (!data.has_gemini_key) {
      warnings.push(
        `<div class="banner banner-warn"><strong>Gemini API-Key fehlt:</strong> Bitte <code>GEMINI_API_KEY</code> in <code>.env</code> setzen und Server neu starten.</div>`
      );
    }
    if (data.using_default_credentials) {
      warnings.push(
        `<div class="banner banner-info"><strong>Sicherheitshinweis vor Online-Hosting:</strong> Aktuell sind noch Standard-Passwort oder Standard-PIN aktiv. Ändere <code>FAMILY_PASSWORD</code> und <code>PARENT_PIN</code> in <code>.env</code>, bevor du die App von außen erreichbar machst.</div>`
      );
    }

    const childTabs = data.children
      .map(
        (s) => `
        <button class="tab ${s.child.id === c.id ? "active" : ""}" style="display:inline-flex; align-items:center; gap:8px;"
                onclick="PrintParentViews.setParentChild(${s.child.id})">
          ${App.avatarHtml(s.child, "xs")} ${App.esc(s.child.name)} (${s.child.age} J.)
          ${s.open_weaknesses_count > 0 ? `· ${s.open_weaknesses_count} Fokus` : ""}
        </button>
      `
      )
      .join("");

    const totalExams = active.exams.length;
    const activeExamsTotal = active.exams.filter((e) => !e.archived).length;
    const archivedExamsTotal = totalExams - activeExamsTotal;

    const subTabs = `
      <div class="tabs" style="border-bottom:1px solid var(--border); padding-bottom:10px;">
        <button class="tab ${ui.tab === "overview" ? "active" : ""}" onclick="PrintParentViews.setParentTab('overview')">
          📊 Übersicht
        </button>
        <button class="tab ${ui.tab === "exams" ? "active" : ""}" onclick="PrintParentViews.setParentTab('exams')">
          📚 Prüfungen & Themen (${activeExamsTotal}${archivedExamsTotal ? ` · ${archivedExamsTotal} Archiv` : ""})
        </button>
        <button class="tab ${ui.tab === "settings" ? "active" : ""}" onclick="PrintParentViews.setParentTab('settings')">
          ⚙️ Profile, Fächer & KI
        </button>
      </div>
    `;

    let tabContent = "";
    if (ui.tab === "overview") {
      tabContent = this._renderParentOverviewTab(data, active);
    } else if (ui.tab === "exams") {
      tabContent = this._renderParentExamsTab(data, active);
    } else {
      tabContent = this._renderParentSettingsTab(data, active);
    }

    App.renderShell(`
      <div class="stack">
        ${warnings.join("")}

        <div class="row-between">
          <div>
            <h1>👨‍👩‍👦‍👦 Eltern-Übersicht</h1>
            <p class="muted small">Fortschritt, Schwachstellen, Prüfungs-Archiv, Fächer & Einstellungen</p>
          </div>
          <button class="btn btn-primary" id="parent-ai-report-btn" onclick="PrintParentViews.loadAiReport(${c.id})">
            ✨ KI-Elternbericht für ${App.esc(c.name)}
          </button>
        </div>

        <div class="tabs">${childTabs}</div>
        ${subTabs}

        <div id="parent-ai-report-box"></div>

        ${tabContent}
      </div>
    `);

    if (ui.tab === "overview") this._bindParentOverviewEvents();
    if (ui.tab === "exams") this._bindParentExamsEvents();
    if (ui.tab === "settings") this._bindParentSettingsEvents(data, active);
  },

  _renderParentOverviewTab(data, active) {
    const c = active.child;
    const ui = this._parentUi;
    const activeExams = active.exams.filter((e) => !e.archived);
    const archivedCount = active.exams.length - activeExams.length;

    const compactExamsHtml = activeExams.length
      ? activeExams
          .slice(0, 5)
          .map((e) => {
            const r = e.readiness;
            return `
              <div class="card-soft row-between">
                <div class="stack-sm" style="gap:3px;">
                  <div class="row">
                    <span>${App.esc(e.subject_icon)}</span>
                    <strong>${App.esc(e.title)}</strong>
                    <span class="pill">
                      <span class="light-dot light-${r.traffic_light}"></span>
                      ${App.esc(r.label)} (${r.avg_mastery}%)
                    </span>
                  </div>
                  <div class="small muted">
                    ${e.exam_date ? `📅 ${App.formatDate(e.exam_date)} · ` : ""}${e.active_topics_count} aktive Themen${
              e.archived_topics_count ? ` (${e.archived_topics_count} archiviert)` : ""
            }
                  </div>
                </div>
                <div class="row">
                  <button class="btn btn-secondary btn-sm"
                          onclick="PrintParentViews.createRemedialWorksheet(${c.id}, ${e.subject_id}, ${e.id})">
                    🖨️ Förderblatt
                  </button>
                  <button class="btn btn-secondary btn-sm"
                          onclick="PrintParentViews.jumpToExam(${e.id})">
                    Verwalten
                  </button>
                </div>
              </div>
            `;
          })
          .join("")
      : `<p class="small muted">Keine aktiven Prüfungen. ${archivedCount ? `(${archivedCount} im Archiv)` : ""}</p>`;

    const filteredWeaknesses = active.weaknesses.filter((w) => {
      if (ui.hideResolvedWeak && w.resolved) return false;
      if (ui.weakSubjectId && String(w.subject_id) !== String(ui.weakSubjectId)) return false;
      return true;
    });

    const weaknessesHtml = filteredWeaknesses.length
      ? filteredWeaknesses
          .slice(0, 12)
          .map(
            (w) => `
          <div class="card-soft stack-sm" style="${w.resolved ? "opacity:0.6;" : ""}">
            <div class="row-between">
              <div class="row">
                <span>${App.esc(w.subject_icon)}</span>
                <strong>${App.esc(w.summary)}</strong>
                <span class="pill ${w.resolved ? "pill-green" : w.severity === 3 ? "pill-red" : "pill-amber"}">
                  ${w.resolved ? "Behoben" : w.severity === 3 ? "Wichtig" : "Üben"} · ${w.occurrences}x
                </span>
              </div>
              <div class="row">
                ${
                  !w.resolved
                    ? `<button class="btn btn-secondary btn-sm" onclick="PrintParentViews.createRemedialWorksheet(${c.id}, ${w.subject_id}, null)">🖨️ Förderblatt</button>`
                    : ""
                }
                <button class="btn btn-secondary btn-sm"
                        onclick="PrintParentViews.toggleWeakness(${w.id}, ${w.resolved ? "false" : "true"}, ${c.id})">
                  ${w.resolved ? "Wieder öffnen" : "✓ Behoben"}
                </button>
                <button class="btn btn-danger btn-sm" onclick="PrintParentViews.deleteWeakness(${w.id}, ${c.id})">✕</button>
              </div>
            </div>
            ${w.example_mistake ? `<div class="small muted">Beispiel: ${App.esc(w.example_mistake)}</div>` : ""}
            ${w.recommendation ? `<div class="small">💡 Tipp: ${App.esc(w.recommendation)}</div>` : ""}
          </div>
        `
          )
          .join("")
      : `<p class="small muted">Keine passenden Schwachstellen in dieser Auswahl – super!</p>`;

    const problemWordsHtml = active.vocab.problem_words.length
      ? active.vocab.problem_words
          .map(
            (v) => `
          <div class="row-between small" style="padding:6px 0; border-bottom:1px solid var(--border);">
            <span>${App.esc(v.subject_icon)} <strong>${App.esc(App.formatForeignWord(v.article, v.term_foreign))}</strong> = ${App.esc(v.term_german)}</span>
            <span class="muted">${v.wrong_count}x falsch · Fach ${v.box} ${v.error_tags?.length ? `(${v.error_tags.join(", ")})` : ""}</span>
          </div>
        `
          )
          .join("")
      : `<p class="small muted">Noch keine Problem-Vokabeln erkannt.</p>`;

    const sessionsHtml = active.recent_sessions.length
      ? active.recent_sessions
          .slice(0, 8)
          .map(
            (s) => `
          <div class="row-between small" style="padding:6px 0; border-bottom:1px solid var(--border);">
            <span>${App.esc(s.subject_icon)} ${App.esc(s.subject_name)} (${App.esc(s.mode)})</span>
            <span><strong>${s.score}/${s.max_score}</strong> · ⭐ +${s.stars_earned} · <span class="muted">${App.formatDate(s.created_at)}</span></span>
          </div>
        `
          )
          .join("")
      : `<p class="small muted">Noch keine abgeschlossenen Übungsrunden.</p>`;

    return `
      <div class="stack">
        <div class="grid-3">
          <div class="card">
            <div class="small muted">Aktive Prüfungen</div>
            <h2 style="margin-top:4px;">${activeExams.length} <span class="small muted" style="font-weight:500;">${archivedCount ? `(+${archivedCount} archiviert)` : ""}</span></h2>
          </div>
          <div class="card">
            <div class="small muted">Offene Schwachstellen (aktiv)</div>
            <h2 style="margin-top:4px;">${active.open_weaknesses_count}</h2>
          </div>
          <div class="card">
            <div class="small muted">Vokabeln (fällig / gesamt) · Aktivität</div>
            <h2 style="margin-top:4px;">${active.vocab.due}/${active.vocab.total} · ⭐ ${c.stars}</h2>
          </div>
        </div>

        <div class="grid-2">
          <section class="card stack-sm">
            <div class="row-between">
              <h3>📅 Aktuelle Prüfungen</h3>
              <button class="btn btn-secondary btn-sm" onclick="PrintParentViews.setParentTab('exams')">
                Alle verwalten (${active.exams.length}) →
              </button>
            </div>
            ${compactExamsHtml}
            ${
              activeExams.length > 5
                ? `<div class="small muted">… und ${activeExams.length - 5} weitere aktive Prüfungen im Tab „Prüfungen & Themen“.</div>`
                : ""
            }
          </section>

          <section class="card stack-sm">
            <div class="row-between">
              <h3>🎯 Schwachstellen-Radar</h3>
              <div class="row" style="gap:6px;">
                <select id="weak-subject-filter" style="min-height:34px; padding:4px 8px; width:auto; font-size:0.85rem;">
                  <option value="">Alle Fächer</option>
                  ${data.all_subjects
                    .map(
                      (s) =>
                        `<option value="${s.id}" ${String(ui.weakSubjectId) === String(s.id) ? "selected" : ""}>${App.esc(s.icon)} ${App.esc(s.name)}</option>`
                    )
                    .join("")}
                </select>
                <label class="row small" style="cursor:pointer; gap:4px;">
                  <input type="checkbox" id="weak-hide-resolved" ${ui.hideResolvedWeak ? "checked" : ""} style="width:auto; min-height:auto;" />
                  <span>Nur offene</span>
                </label>
              </div>
            </div>
            ${weaknessesHtml}
          </section>
        </div>

        <div class="grid-2">
          <section class="card stack-sm">
            <h3>🃏 Vokabel-Kasten (Leitner)</h3>
            <div class="leitner-boxes">
              ${[1, 2, 3, 4, 5]
                .map(
                  (b) => `
                <div class="leitner-box">
                  <span class="small muted">Fach ${b}</span>
                  <strong>${active.vocab.boxes[String(b)] || 0}</strong>
                </div>
              `
                )
                .join("")}
            </div>
            <h4 style="margin-top:8px;">Häufigste Problemwörter</h4>
            ${problemWordsHtml}
          </section>

          <section class="card stack-sm">
            <h3>📈 Letzte Übungen & Arbeitsblätter</h3>
            ${sessionsHtml}
            ${
              active.recent_worksheets.length
                ? `<div class="stack-sm" style="margin-top:8px;">
                     <h4>Arbeitsblätter</h4>
                     ${active.recent_worksheets
                       .slice(0, 5)
                       .map(
                         (w) => `
                       <div class="row-between small">
                         <a href="#" onclick="event.preventDefault(); App.go('worksheet', { worksheetId:${w.id} })">
                           ${App.esc(w.subject_icon)} ${App.esc(w.code)} – ${App.esc(w.title)}
                         </a>
                         <span class="muted">${w.graded_at ? `${w.score}/${w.max_score} Pkt.` : "offen"}</span>
                       </div>
                     `
                       )
                       .join("")}
                   </div>`
                : ""
            }
          </section>
        </div>
      </div>
    `;
  },

  _bindParentOverviewEvents() {
    const sel = document.getElementById("weak-subject-filter");
    if (sel) {
      sel.onchange = () => {
        this._parentUi.weakSubjectId = sel.value;
        this._drawParentDashboard();
      };
    }
    const cb = document.getElementById("weak-hide-resolved");
    if (cb) {
      cb.onchange = () => {
        this._parentUi.hideResolvedWeak = cb.checked;
        this._drawParentDashboard();
      };
    }
  },

  jumpToExam(examId) {
    this._parentUi.tab = "exams";
    this._parentUi.examFilter = "all";
    this._parentUi.examSearch = "";
    this._parentUi.examSubjectId = "";
    this._parentUi.expandedExams[examId] = true;
    this._drawParentDashboard();
  },

  // ============================================================
  // TAB 2: SCALABLE EXAMS & TOPICS MANAGER (Search, Filter, Archive, Pagination)
  // ============================================================
  _renderParentExamsTab(data, active) {
    const c = active.child;
    const ui = this._parentUi;
    const allExams = active.exams || [];

    const activeCount = allExams.filter((e) => !e.archived).length;
    const archivedCount = allExams.length - activeCount;
    const q = (ui.examSearch || "").trim().toLowerCase();

    const filtered = allExams.filter((e) => {
      if (ui.examFilter === "active" && e.archived) return false;
      if (ui.examFilter === "archived" && !e.archived) return false;
      if (ui.examSubjectId && String(e.subject_id) !== String(ui.examSubjectId)) return false;
      if (q) {
        const inExam =
          (e.title || "").toLowerCase().includes(q) ||
          (e.subject_name || "").toLowerCase().includes(q) ||
          (e.notes || "").toLowerCase().includes(q);
        const inTopics = (e.topics || []).some(
          (t) => (t.title || "").toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q)
        );
        if (!inExam && !inTopics) return false;
      }
      return true;
    });

    const totalPages = Math.max(1, Math.ceil(filtered.length / ui.pageSize));
    if (ui.examPage > totalPages) ui.examPage = totalPages;
    const startIdx = (ui.examPage - 1) * ui.pageSize;
    const pageItems = filtered.slice(startIdx, startIdx + ui.pageSize);

    const listHtml = pageItems.length
      ? pageItems
          .map((e) => {
            const r = e.readiness;
            const isOpen = Boolean(ui.expandedExams[e.id]) || Boolean(q);
            const showArchTopics = Boolean(ui.showArchivedTopics[e.id]) || e.archived || Boolean(q);
            const visibleTopics = (e.topics || []).filter((t) => {
              if (!showArchTopics && t.archived) return false;
              if (q && !(e.title || "").toLowerCase().includes(q)) {
                return (
                  (t.title || "").toLowerCase().includes(q) || (t.description || "").toLowerCase().includes(q)
                );
              }
              return true;
            });

            const topicsBody = visibleTopics.length
              ? visibleTopics
                  .map(
                    (t) => `
                  <div class="topic-row ${t.archived ? "is-archived" : ""}">
                    <div class="row-between">
                      <div class="stack-sm" style="gap:2px;">
                        <div class="row" style="gap:8px;">
                          <strong>${App.esc(t.title)}</strong>
                          ${
                            t.archived
                              ? `<span class="pill">📦 Archiviert (für Kind unsichtbar)</span>`
                              : `<span class="small muted">${t.mastery_score}% · ${t.attempts_count}x geübt</span>`
                          }
                        </div>
                        ${t.description ? `<div class="small muted">${App.esc(t.description)}</div>` : ""}
                      </div>
                      <div class="row" style="gap:6px;">
                        <button type="button" class="btn btn-secondary btn-sm"
                                onclick="PrintParentViews.openTopicModal(${e.id}, ${t.id}, ${c.id})">✏️ Bearbeiten</button>
                        <button type="button" class="btn btn-secondary btn-sm"
                                onclick="PrintParentViews.toggleTopicArchive(${t.id}, ${t.archived ? "false" : "true"}, ${c.id})">
                          ${t.archived ? "♻️ Aktivieren" : "📦 Archivieren"}
                        </button>
                        <button type="button" class="btn btn-danger btn-sm"
                                onclick="PrintParentViews.deleteTopic(${t.id}, ${c.id})">✕</button>
                      </div>
                    </div>
                    ${
                      !t.archived
                        ? `<div class="progress-track">
                             <div class="progress-fill ${t.mastery_score >= 75 ? "green" : t.mastery_score >= 45 ? "amber" : "red"}"
                                  style="width:${t.mastery_score}%"></div>
                           </div>`
                        : ""
                    }
                  </div>
                `
                  )
                  .join("")
              : `<div class="small muted">Keine Themen in dieser Ansicht. Füge unten ein neues Thema hinzu oder blende archivierte Themen ein.</div>`;

            return `
              <div class="exam-acc ${e.archived ? "is-archived" : ""}">
                <div class="exam-acc-head" onclick="PrintParentViews.toggleExamExpand(${e.id})">
                  <div class="row" style="gap:8px;">
                    <span class="exam-acc-chevron">${isOpen ? "▾" : "▸"}</span>
                    <span>${App.esc(e.subject_icon)}</span>
                    <strong>${App.esc(e.title)}</strong>
                    ${
                      e.archived
                        ? `<span class="pill">📦 Archiviert</span>`
                        : `<span class="pill"><span class="light-dot light-${r.traffic_light}"></span> ${App.esc(r.label)} (${r.avg_mastery}%)</span>`
                    }
                    ${e.status === "completed" && !e.archived ? `<span class="pill pill-green">✓ Erledigt</span>` : ""}
                    ${e.exam_date ? `<span class="small muted">📅 ${App.formatDate(e.exam_date)}</span>` : ""}
                    <span class="small muted">· ${e.active_topics_count} aktiv${e.archived_topics_count ? ` / ${e.archived_topics_count} archiv.` : ""}</span>
                  </div>
                  <div class="row" style="gap:6px;" onclick="event.stopPropagation();">
                    <button type="button" class="btn btn-secondary btn-sm"
                            onclick="PrintParentViews.openParentExamModal(${e.id}, ${c.id})">✏️ Bearbeiten</button>
                    <button type="button" class="btn btn-secondary btn-sm"
                            onclick="PrintParentViews.toggleExamArchive(${e.id}, ${e.archived ? "false" : "true"}, ${c.id})">
                      ${e.archived ? "♻️ Aktivieren" : "📦 Archivieren"}
                    </button>
                    ${
                      !e.archived
                        ? `<button type="button" class="btn btn-secondary btn-sm"
                                   onclick="PrintParentViews.createRemedialWorksheet(${c.id}, ${e.subject_id}, ${e.id})">🖨️ Förderblatt</button>`
                        : ""
                    }
                    <button type="button" class="btn btn-danger btn-sm"
                            onclick="PrintParentViews.deleteExam(${e.id}, ${c.id})">🗑️</button>
                  </div>
                </div>
                ${
                  isOpen
                    ? `
                  <div class="exam-acc-body">
                    ${e.notes ? `<div class="small muted">📝 Notiz: ${App.esc(e.notes)}</div>` : ""}
                    <div class="row-between">
                      <div class="row" style="gap:10px;">
                        <strong class="small">Unterthemen (${e.topics.length})</strong>
                        ${
                          e.archived_topics_count > 0 && !e.archived
                            ? `<label class="row small muted" style="cursor:pointer; gap:5px;">
                                 <input type="checkbox" ${showArchTopics ? "checked" : ""} style="width:auto; min-height:auto;"
                                        onchange="PrintParentViews.toggleShowArchivedTopics(${e.id}, this.checked)" />
                                 <span>Archivierte Themen anzeigen (${e.archived_topics_count})</span>
                               </label>`
                            : ""
                        }
                      </div>
                      <button type="button" class="btn btn-primary btn-sm"
                              onclick="PrintParentViews.openTopicModal(${e.id}, null, ${c.id})">
                        + Thema hinzufügen
                      </button>
                    </div>
                    ${topicsBody}
                  </div>
                `
                    : ""
                }
              </div>
            `;
          })
          .join("")
      : `<div class="card-soft muted small">Keine Prüfungen für diese Filterauswahl gefunden.</div>`;

    const pagerHtml =
      filtered.length > ui.pageSize
        ? `
        <div class="row-between small" style="margin-top:8px;">
          <span class="muted">Zeige ${startIdx + 1}–${Math.min(startIdx + ui.pageSize, filtered.length)} von ${filtered.length} Prüfungen</span>
          <div class="row">
            <button type="button" class="btn btn-secondary btn-sm" ${ui.examPage <= 1 ? "disabled" : ""}
                    onclick="PrintParentViews.setExamPage(${ui.examPage - 1})">← Zurück</button>
            <span>Seite ${ui.examPage} / ${totalPages}</span>
            <button type="button" class="btn btn-secondary btn-sm" ${ui.examPage >= totalPages ? "disabled" : ""}
                    onclick="PrintParentViews.setExamPage(${ui.examPage + 1})">Weiter →</button>
          </div>
        </div>
      `
        : filtered.length > 0
        ? `<div class="small muted">${filtered.length} Prüfung${filtered.length === 1 ? "" : "en"} angezeigt</div>`
        : "";

    return `
      <div class="card stack">
        <div class="row-between">
          <div>
            <h2>📚 Prüfungen & Themen verwalten (${App.esc(c.name)})</h2>
            <p class="small muted">
              Archivierte Prüfungen und Themen sind für das Kind unsichtbar und fließen nicht in Statistiken ein – jederzeit wieder aktivierbar.
            </p>
          </div>
          <button type="button" class="btn btn-primary" onclick="PrintParentViews.openNewExamModal(${c.id})">
            + Neue Prüfung
          </button>
        </div>

        <div class="filter-bar">
          <input type="text" id="parent-exam-search" class="search-input"
                 placeholder="🔍 Nach Prüfung oder Thema suchen…" value="${App.esc(ui.examSearch)}" />
          <select id="parent-exam-subject" class="filter-select">
            <option value="">Alle Fächer</option>
            ${data.all_subjects
              .map(
                (s) =>
                  `<option value="${s.id}" ${String(ui.examSubjectId) === String(s.id) ? "selected" : ""}>${App.esc(s.icon)} ${App.esc(s.name)}</option>`
              )
              .join("")}
          </select>
        </div>

        <div class="row-between">
          <div class="tabs">
            <button type="button" class="tab ${ui.examFilter === "active" ? "active" : ""}"
                    onclick="PrintParentViews.setExamFilter('active')">Aktiv (${activeCount})</button>
            <button type="button" class="tab ${ui.examFilter === "archived" ? "active" : ""}"
                    onclick="PrintParentViews.setExamFilter('archived')">📦 Archiviert (${archivedCount})</button>
            <button type="button" class="tab ${ui.examFilter === "all" ? "active" : ""}"
                    onclick="PrintParentViews.setExamFilter('all')">Alle (${allExams.length})</button>
          </div>
          <div class="row" style="gap:6px;">
            <button type="button" class="btn btn-ghost btn-sm" onclick="PrintParentViews.expandAllVisible(true)">Alle aufklappen</button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="PrintParentViews.expandAllVisible(false)">Alle zuklappen</button>
          </div>
        </div>

        <div class="stack-sm">${listHtml}</div>
        ${pagerHtml}
      </div>
    `;
  },

  _bindParentExamsEvents() {
    const searchEl = document.getElementById("parent-exam-search");
    if (searchEl) {
      searchEl.oninput = () => {
        const pos = searchEl.selectionStart;
        this._parentUi.examSearch = searchEl.value;
        this._parentUi.examPage = 1;
        this._drawParentDashboard();
        const refreshed = document.getElementById("parent-exam-search");
        if (refreshed) {
          refreshed.focus();
          refreshed.setSelectionRange(pos, pos);
        }
      };
    }
    const subjEl = document.getElementById("parent-exam-subject");
    if (subjEl) {
      subjEl.onchange = () => {
        this._parentUi.examSubjectId = subjEl.value;
        this._parentUi.examPage = 1;
        this._drawParentDashboard();
      };
    }
  },

  setExamFilter(filter) {
    this._parentUi.examFilter = filter;
    this._parentUi.examPage = 1;
    this._drawParentDashboard();
  },

  setExamPage(page) {
    this._parentUi.examPage = Math.max(1, page);
    this._drawParentDashboard();
  },

  toggleExamExpand(examId) {
    this._parentUi.expandedExams[examId] = !this._parentUi.expandedExams[examId];
    this._drawParentDashboard();
  },

  toggleShowArchivedTopics(examId, checked) {
    this._parentUi.showArchivedTopics[examId] = checked;
    this._drawParentDashboard();
  },

  expandAllVisible(expand) {
    const active = this._getActiveParentSummary();
    if (!active) return;
    if (!expand) {
      this._parentUi.expandedExams = {};
    } else {
      for (const e of active.exams) {
        this._parentUi.expandedExams[e.id] = true;
      }
    }
    this._drawParentDashboard();
  },

  // ============================================================
  // TAB 3: PROFILE, SUBJECTS (ADD NEW!) & GEMINI AI SETTINGS
  // ============================================================
  _renderParentSettingsTab(data, active) {
    const c = active.child;
    const enabledIds = new Set(active.subjects.filter((s) => s.enabled).map((s) => s.id));
    const subjectCheckboxes = data.all_subjects
      .map(
        (s) => `
        <label class="row small card-soft" style="padding:8px 12px; cursor:pointer;">
          <input type="checkbox" class="sub-toggle-cb" value="${s.id}" ${enabledIds.has(s.id) ? "checked" : ""}
                 style="width:auto; min-height:auto;" />
          <span>${App.esc(s.icon)} ${App.esc(s.name)}</span>
        </label>
      `
      )
      .join("");

    const childEnableBoxes = data.children
      .map(
        (s) => `
        <label class="row small card-soft" style="padding:6px 10px; cursor:pointer;">
          <input type="checkbox" class="new-sub-child-cb" value="${s.child.id}" ${s.child.id === c.id ? "checked" : ""}
                 style="width:auto; min-height:auto;" />
          <span>${App.esc(s.child.name)} (${s.child.age} J.)</span>
        </label>
      `
      )
      .join("");

    const subjectIcons = ["📘", "🏛️", "⚡", "🧪", "🎵", "🎨", "💻", "🗺️", "🇪🇸", "🇮🇹", "🏺", "⚽", "⛪", "🌱"];
    const subjectColors = ["#4338ca", "#2563eb", "#059669", "#16a34a", "#d97706", "#ea580c", "#dc2626", "#7c3aed", "#db2777", "#0891b2"];

    const allSubjectsList = data.all_subjects
      .map(
        (s) => `
        <div class="row-between small" style="padding:6px 0; border-bottom:1px solid var(--border);">
          <div class="row" style="gap:8px;">
            <span style="width:12px; height:12px; border-radius:50%; background:${App.esc(s.color)}; display:inline-block;"></span>
            <span>${App.esc(s.icon)} <strong>${App.esc(s.name)}</strong></span>
            <span class="muted">${s.subject_type === "language" ? `Sprache (${App.esc(s.lang_code)})` : "Schulfach"} · ${s.paper_style === "grid" ? "Kästchen" : "Linien"}</span>
          </div>
          <button type="button" class="btn btn-danger btn-sm" onclick="PrintParentViews.deleteSubject(${s.id}, ${App.jsArg(s.name)})">Löschen</button>
        </div>
      `
      )
      .join("");

    return `
      <div class="stack">
        <div class="grid-2">
          <section class="card stack">
            <h3>⚙️ Profil & aktive Fächer für ${App.esc(c.name)}</h3>
            <form id="parent-child-form" class="stack-sm">
              <div class="grid-2">
                <div class="field">
                  <label>Name</label>
                  <input type="text" id="pc-name" value="${App.esc(c.name)}" required />
                </div>
                <div class="field">
                  <label>Avatar (Emoji)</label>
                  <input type="text" id="pc-avatar" value="${App.esc(c.avatar)}" />
                </div>
                <div class="field">
                  <label>Alter</label>
                  <input type="number" id="pc-age" value="${c.age}" min="5" max="18" />
                </div>
                <div class="field">
                  <label>Klasse</label>
                  <input type="text" id="pc-grade" value="${App.esc(c.grade)}" />
                </div>
                <div class="field">
                  <label>Oberflächen-Modus</label>
                  <select id="pc-uimode">
                    <option value="junior" ${c.ui_mode === "junior" ? "selected" : ""}>Junior (große Schrift & Buttons)</option>
                    <option value="standard" ${c.ui_mode === "standard" ? "selected" : ""}>Standard (kompakt)</option>
                  </select>
                </div>
                <div class="field">
                  <label>Vokabel-Tippfehler-Toleranz</label>
                  <select id="pc-typo">
                    <option value="relaxed" ${c.settings?.typo_tolerance === "relaxed" ? "selected" : ""}>Sanft (ideal für 8 J.)</option>
                    <option value="moderate" ${(c.settings?.typo_tolerance || "moderate") === "moderate" ? "selected" : ""}>Mittel (1 Tippfehler ok)</option>
                    <option value="strict" ${c.settings?.typo_tolerance === "strict" ? "selected" : ""}>Streng (Prüfungsmodus)</option>
                  </select>
                </div>
              </div>
              <label class="row small" style="cursor:pointer;">
                <input type="checkbox" id="pc-accent" ${c.settings?.accent_strict ? "checked" : ""} style="width:auto; min-height:auto;" />
                <span>Französische Akzente streng werten (sonst sanfter Hinweis)</span>
              </label>

              <div class="stack-sm">
                <strong class="small">Aktive Fächer für ${App.esc(c.name)}:</strong>
                <div class="grid-2">${subjectCheckboxes}</div>
              </div>

              <div>
                <button type="submit" class="btn btn-primary">Profil & Fächer speichern</button>
              </div>
            </form>
          </section>

          <section class="card stack">
            <h3>➕ Neues Schulfach / neue Sprache anlegen</h3>
            <p class="small muted">Ergänze beliebige weitere Fächer (z. B. Geschichte, Physik, Spanisch, Latein, Erdkunde, Musik).</p>
            <form id="parent-new-subject-form" class="stack-sm">
              <div class="grid-2">
                <div class="field">
                  <label for="ns-name">Fachname</label>
                  <input type="text" id="ns-name" placeholder="z. B. Geschichte oder Spanisch" maxlength="40" required />
                </div>
                <div class="field">
                  <label for="ns-icon">Symbol (Emoji)</label>
                  <input type="text" id="ns-icon" value="🏛️" maxlength="16" required />
                </div>
              </div>
              <div class="row" style="gap:6px;">
                ${subjectIcons
                  .map(
                    (ic) =>
                      `<button type="button" class="accent-key" onclick="document.getElementById('ns-icon').value=${App.jsArg(ic)}">${ic}</button>`
                  )
                  .join("")}
              </div>

              <div class="grid-2">
                <div class="field">
                  <label for="ns-type">Fach-Typ</label>
                  <select id="ns-type">
                    <option value="subject">Schulfach (Prüfungen & Themen)</option>
                    <option value="language">Sprache (inkl. Vokabeltrainer)</option>
                  </select>
                </div>
                <div class="field">
                  <label for="ns-paper">Papier-Drucklayout</label>
                  <select id="ns-paper">
                    <option value="lines">Schreiblinien</option>
                    <option value="grid">Rechenkästchen (Mathe/Physik)</option>
                  </select>
                </div>
              </div>

              <div class="field" id="ns-lang-wrap" style="display:none;">
                <label for="ns-lang">Vorlese-Sprache (Aussprache)</label>
                <select id="ns-lang">
                  <option value="es-ES">Spanisch (es-ES)</option>
                  <option value="it-IT">Italienisch (it-IT)</option>
                  <option value="en-GB">Englisch (en-GB)</option>
                  <option value="fr-FR">Französisch (fr-FR)</option>
                  <option value="de-DE">Latein / Deutsch (de-DE)</option>
                </select>
              </div>

              <div class="field">
                <label>Farbe</label>
                <input type="hidden" id="ns-color" value="#4338ca" />
                <div class="color-swatches" id="ns-swatches">
                  ${subjectColors
                    .map(
                      (col, i) =>
                        `<button type="button" class="color-swatch ${i === 0 ? "active" : ""}" style="background:${col}" data-color="${col}"></button>`
                    )
                    .join("")}
                </div>
              </div>

              <div class="stack-sm">
                <strong class="small">Sofort aktivieren für:</strong>
                <div class="row">${childEnableBoxes}</div>
              </div>

              <div>
                <button type="submit" class="btn btn-primary">➕ Fach anlegen</button>
              </div>
            </form>

            <div class="stack-sm" style="margin-top:8px;">
              <strong class="small">Alle vorhandenen Fächer (${data.all_subjects.length}):</strong>
              ${allSubjectsList}
            </div>
          </section>
        </div>

        <section class="card stack">
          <h3>🤖 Gemini Smart-Routing Einstellungen</h3>
          <p class="small muted">Schnelles Modell für Alltag/Scanner/Quiz, stärkeres Modell für Handschrift-Korrektur & Elternberichte.</p>
          <form id="parent-ai-form" class="grid-2">
            <div class="field">
              <label>Fast-Modell (Standard-Alltag)</label>
              <input type="text" id="ai-fast" value="${App.esc(data.ai_models.fast)}" />
            </div>
            <div class="field">
              <label>Smart-Modell (Handschrift-Korrektur & Berichte)</label>
              <input type="text" id="ai-smart" value="${App.esc(data.ai_models.smart)}" />
            </div>
            <div style="grid-column:1/-1;" class="row">
              <button type="submit" class="btn btn-primary btn-sm">Modelle speichern</button>
              <button type="button" class="btn btn-secondary btn-sm" id="load-models-btn"
                      onclick="PrintParentViews.loadAvailableModels()">
                🔍 Verfügbare Modelle meines API-Keys laden
              </button>
            </div>
          </form>
          <div id="available-models-box"></div>
        </section>
      </div>
    `;
  },

  _bindParentSettingsEvents(data, active) {
    const c = active.child;

    document.getElementById("parent-child-form").onsubmit = async (e) => {
      e.preventDefault();
      const enabledIdsList = Array.from(document.querySelectorAll(".sub-toggle-cb:checked")).map((cb) => Number(cb.value));
      try {
        await App.api(`/api/children/${c.id}`, {
          method: "PATCH",
          body: {
            name: document.getElementById("pc-name").value,
            avatar: document.getElementById("pc-avatar").value,
            age: Number(document.getElementById("pc-age").value),
            grade: document.getElementById("pc-grade").value,
            ui_mode: document.getElementById("pc-uimode").value,
            settings: {
              typo_tolerance: document.getElementById("pc-typo").value,
              accent_strict: document.getElementById("pc-accent").checked,
            },
          },
        });
        await App.api(`/api/children/${c.id}/subjects`, {
          method: "PUT",
          body: { enabled_subject_ids: enabledIdsList },
        });
        App.toast("Profil & Fächer aktualisiert!", "success");
        await this.renderParentDashboard(c.id);
      } catch (err) {
        App.toast(err.message, "error");
      }
    };

    const nsType = document.getElementById("ns-type");
    const nsLangWrap = document.getElementById("ns-lang-wrap");
    nsType.onchange = () => {
      nsLangWrap.style.display = nsType.value === "language" ? "flex" : "none";
    };

    const swatches = Array.from(document.querySelectorAll("#ns-swatches .color-swatch"));
    swatches.forEach((btn) => {
      btn.onclick = () => {
        swatches.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("ns-color").value = btn.dataset.color;
      };
    });

    document.getElementById("parent-new-subject-form").onsubmit = async (e) => {
      e.preventDefault();
      const enableChildIds = Array.from(document.querySelectorAll(".new-sub-child-cb:checked")).map((cb) => Number(cb.value));
      const subjectType = nsType.value;
      try {
        await App.api("/api/parent/subjects", {
          method: "POST",
          body: {
            name: document.getElementById("ns-name").value.trim(),
            icon: document.getElementById("ns-icon").value.trim() || "📘",
            color: document.getElementById("ns-color").value,
            subject_type: subjectType,
            lang_code: subjectType === "language" ? document.getElementById("ns-lang").value : "de-DE",
            paper_style: document.getElementById("ns-paper").value,
            enable_for_child_ids: enableChildIds,
          },
        });
        App.toast("Neues Fach angelegt!", "success");
        await this.renderParentDashboard(c.id);
      } catch (err) {
        App.toast(err.message, "error");
      }
    };

    document.getElementById("parent-ai-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await App.api("/api/parent/settings/ai", {
          method: "PATCH",
          body: {
            gemini_model_fast: document.getElementById("ai-fast").value,
            gemini_model_smart: document.getElementById("ai-smart").value,
          },
        });
        App.toast("Gemini-Modelle gespeichert!", "success");
      } catch (err) {
        App.toast(err.message, "error");
      }
    };
  },

  // ============================================================
  // PARENT MODALS & ACTIONS (Exam, Topic, Subject, Archive)
  // ============================================================
  openNewExamModal(childId) {
    const subjects = this._lastParentOverview?.all_subjects || [];
    const root = document.getElementById("modal-root");
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this) App.closeModal()">
        <div class="modal-box stack" style="max-width:480px;">
          <div class="row-between">
            <h3>➕ Neue Prüfung anlegen</h3>
            <button type="button" class="btn btn-ghost btn-sm" onclick="App.closeModal()">✕</button>
          </div>
          <form id="p-new-exam-form" class="stack-sm">
            <div class="field">
              <label>Fach</label>
              <select id="pne-subject">
                ${subjects.map((s) => `<option value="${s.id}">${App.esc(s.icon)} ${App.esc(s.name)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Titel der Prüfung</label>
              <input type="text" id="pne-title" required placeholder="z. B. Klassenarbeit Bruchrechnung" />
            </div>
            <div class="field">
              <label>Prüfungsdatum (optional)</label>
              <input type="date" id="pne-date" />
            </div>
            <div class="field">
              <label>Unterthemen (eins pro Zeile, optional)</label>
              <textarea id="pne-topics" placeholder="Erweitern und Kürzen&#10;Textaufgaben"></textarea>
            </div>
            <div class="row" style="justify-content:flex-end;">
              <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Abbrechen</button>
              <button type="submit" class="btn btn-primary">💾 Anlegen</button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.getElementById("p-new-exam-form").onsubmit = async (e) => {
      e.preventDefault();
      const topics = document.getElementById("pne-topics").value
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((title) => ({ title, description: "", key_concepts: [] }));
      try {
        const res = await App.api(`/api/children/${childId}/exams`, {
          method: "POST",
          body: {
            subject_id: Number(document.getElementById("pne-subject").value),
            title: document.getElementById("pne-title").value.trim(),
            exam_date: document.getElementById("pne-date").value || null,
            topics,
          },
        });
        App.closeModal();
        this._parentUi.expandedExams[res.exam_id] = true;
        App.toast("Prüfung angelegt!", "success");
        await this.renderParentDashboard(childId);
      } catch (err) {
        App.toast(err.message, "error");
      }
    };
  },

  openParentExamModal(examId, childId) {
    const childSummary = (this._lastParentOverview?.children || []).find((s) => s.child.id === childId);
    const exam = (childSummary?.exams || []).find((e) => e.id === examId);
    const subjects = this._lastParentOverview?.all_subjects || [];
    if (!exam) return;

    const dateVal = exam.exam_date ? String(exam.exam_date).slice(0, 10) : "";
    const root = document.getElementById("modal-root");
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this) App.closeModal()">
        <div class="modal-box stack" style="max-width:480px;">
          <div class="row-between">
            <h3>✏️ Prüfung bearbeiten</h3>
            <button type="button" class="btn btn-ghost btn-sm" onclick="App.closeModal()">✕</button>
          </div>
          <form id="p-edit-exam-form" class="stack-sm">
            <div class="field">
              <label>Titel</label>
              <input type="text" id="pee-title" value="${App.esc(exam.title)}" required />
            </div>
            <div class="grid-2">
              <div class="field">
                <label>Fach</label>
                <select id="pee-subject">
                  ${subjects
                    .map(
                      (s) =>
                        `<option value="${s.id}" ${s.id === exam.subject_id ? "selected" : ""}>${App.esc(s.icon)} ${App.esc(s.name)}</option>`
                    )
                    .join("")}
                </select>
              </div>
              <div class="field">
                <label>Status</label>
                <select id="pee-status">
                  <option value="active" ${exam.status === "active" ? "selected" : ""}>Aktiv</option>
                  <option value="completed" ${exam.status === "completed" ? "selected" : ""}>Abgeschlossen</option>
                </select>
              </div>
            </div>
            <div class="field">
              <label>Prüfungsdatum</label>
              <div class="row">
                <input type="date" id="pee-date" value="${App.esc(dateVal)}" style="flex:1;" />
                <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('pee-date').value=''">Entfernen</button>
              </div>
            </div>
            <div class="field">
              <label>Notizen (optional)</label>
              <textarea id="pee-notes" style="min-height:68px;">${App.esc(exam.notes || "")}</textarea>
            </div>
            <label class="row small" style="cursor:pointer;">
              <input type="checkbox" id="pee-archived" ${exam.archived ? "checked" : ""} style="width:auto; min-height:auto;" />
              <span>📦 Prüfung archivieren (für Kind unsichtbar & aus Statistiken ausblenden)</span>
            </label>
            <div class="row" style="justify-content:flex-end;">
              <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Abbrechen</button>
              <button type="submit" class="btn btn-primary">💾 Speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.getElementById("p-edit-exam-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await App.api(`/api/exams/${exam.id}`, {
          method: "PATCH",
          body: {
            title: document.getElementById("pee-title").value.trim(),
            subject_id: Number(document.getElementById("pee-subject").value),
            status: document.getElementById("pee-status").value,
            exam_date: document.getElementById("pee-date").value || "",
            notes: document.getElementById("pee-notes").value,
            archived: document.getElementById("pee-archived").checked,
          },
        });
        App.closeModal();
        App.toast("Prüfung gespeichert!", "success");
        await this.renderParentDashboard(childId);
      } catch (err) {
        App.toast(err.message, "error");
      }
    };
  },

  openTopicModal(examId, topicId, childId) {
    const childSummary = (this._lastParentOverview?.children || []).find((s) => s.child.id === childId);
    const exam = (childSummary?.exams || []).find((e) => e.id === examId);
    const topic = topicId ? (exam?.topics || []).find((t) => t.id === topicId) : null;
    const isEdit = Boolean(topic);

    const root = document.getElementById("modal-root");
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this) App.closeModal()">
        <div class="modal-box stack" style="max-width:480px;">
          <div class="row-between">
            <h3>${isEdit ? "✏️ Thema bearbeiten" : "➕ Neues Thema hinzufügen"}</h3>
            <button type="button" class="btn btn-ghost btn-sm" onclick="App.closeModal()">✕</button>
          </div>
          <form id="p-topic-form" class="stack-sm">
            <div class="field">
              <label>Titel des Themas</label>
              <input type="text" id="pt-title" value="${App.esc(topic?.title || "")}" required maxlength="120" placeholder="z. B. Schriftliche Division" />
            </div>
            <div class="field">
              <label>Beschreibung / Lernziel (optional)</label>
              <textarea id="pt-desc" style="min-height:70px;" placeholder="Was soll das Kind hier sicher können?">${App.esc(topic?.description || "")}</textarea>
            </div>
            <div class="field">
              <label>Schlüsselbegriffe (kommagetrennt, optional)</label>
              <input type="text" id="pt-concepts" value="${App.esc((topic?.key_concepts || []).join(", "))}" placeholder="z. B. Zähler, Nenner, Kürzen" />
            </div>
            ${
              isEdit
                ? `
              <div class="field">
                <label>Aktueller Mastery-Stand (0–100 %)</label>
                <input type="number" id="pt-mastery" min="0" max="100" value="${topic.mastery_score}" />
              </div>
              <label class="row small" style="cursor:pointer;">
                <input type="checkbox" id="pt-archived" ${topic.archived ? "checked" : ""} style="width:auto; min-height:auto;" />
                <span>📦 Thema archivieren (für Kind unsichtbar & nicht in Auswertungen)</span>
              </label>
            `
                : ""
            }
            <div class="row" style="justify-content:flex-end;">
              <button type="button" class="btn btn-secondary" onclick="App.closeModal()">Abbrechen</button>
              <button type="submit" class="btn btn-primary">💾 Speichern</button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.getElementById("p-topic-form").onsubmit = async (e) => {
      e.preventDefault();
      const concepts = document.getElementById("pt-concepts").value
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      try {
        if (isEdit) {
          await App.api(`/api/parent/topics/${topic.id}`, {
            method: "PATCH",
            body: {
              title: document.getElementById("pt-title").value.trim(),
              description: document.getElementById("pt-desc").value.trim(),
              key_concepts: concepts,
              mastery_score: Number(document.getElementById("pt-mastery").value),
              archived: document.getElementById("pt-archived").checked,
            },
          });
          App.toast("Thema aktualisiert!", "success");
        } else {
          await App.api(`/api/parent/exams/${examId}/topics`, {
            method: "POST",
            body: {
              title: document.getElementById("pt-title").value.trim(),
              description: document.getElementById("pt-desc").value.trim(),
              key_concepts: concepts,
            },
          });
          this._parentUi.expandedExams[examId] = true;
          App.toast("Thema hinzugefügt!", "success");
        }
        App.closeModal();
        await this.renderParentDashboard(childId);
      } catch (err) {
        App.toast(err.message, "error");
      }
    };
  },

  async toggleExamArchive(examId, archived, childId) {
    try {
      await App.api(`/api/exams/${examId}`, { method: "PATCH", body: { archived } });
      App.toast(archived ? "Prüfung archiviert (für Kind & Statistiken ausgeblendet)." : "Prüfung wieder aktiviert!", "success");
      await this.renderParentDashboard(childId);
    } catch (err) {
      App.toast(err.message, "error");
    }
  },

  async toggleTopicArchive(topicId, archived, childId) {
    try {
      await App.api(`/api/parent/topics/${topicId}`, { method: "PATCH", body: { archived } });
      App.toast(archived ? "Thema archiviert." : "Thema wieder aktiviert!", "success");
      await this.renderParentDashboard(childId);
    } catch (err) {
      App.toast(err.message, "error");
    }
  },

  async deleteTopic(topicId, childId) {
    if (!confirm("Dieses Thema wirklich dauerhaft löschen? (Alternativ kannst du es archivieren.)")) return;
    await App.api(`/api/parent/topics/${topicId}`, { method: "DELETE" });
    App.toast("Thema gelöscht.");
    await this.renderParentDashboard(childId);
  },

  async deleteSubject(subjectId, name) {
    if (!confirm(`Das Fach „${name}“ wirklich dauerhaft löschen? Alle zugehörigen Prüfungen und Vokabeln dieses Fachs werden mitgelöscht.`)) return;
    try {
      await App.api(`/api/parent/subjects/${subjectId}`, { method: "DELETE" });
      App.toast(`Fach „${name}“ gelöscht.`);
      await this.renderParentDashboard(this._selectedChildId);
    } catch (err) {
      App.toast(err.message, "error");
    }
  },

  async loadAiReport(childId) {
    const btn = document.getElementById("parent-ai-report-btn");
    const box = document.getElementById("parent-ai-report-box");
    btn.disabled = true;
    box.innerHTML = `<div class="card row"><div class="spinner"></div><span>KI-Elternbericht wird erstellt…</span></div>`;
    try {
      const res = await App.api(`/api/parent/children/${childId}/report`, { method: "POST" });
      const r = res.report;
      box.innerHTML = `
        <div class="card stack" style="border: 2px solid var(--primary);">
          <div class="row-between">
            <h2>✨ ${App.esc(r.headline)}</h2>
            <button class="btn btn-ghost btn-sm" onclick="document.getElementById('parent-ai-report-box').innerHTML=''">Schließen</button>
          </div>
          <p>${App.esc(r.overall_summary)}</p>
          <div class="grid-3">
            <div class="card-soft stack-sm">
              <strong>💪 Stärken</strong>
              <ul class="small" style="margin:0 0 0 18px;">${r.strengths.map((x) => `<li>${App.esc(x)}</li>`).join("")}</ul>
            </div>
            <div class="card-soft stack-sm">
              <strong>🎯 Top-Schwachstellen</strong>
              <ul class="small" style="margin:0 0 0 18px;">${r.top_weaknesses.map((x) => `<li>${App.esc(x)}</li>`).join("")}</ul>
            </div>
            <div class="card-soft stack-sm">
              <strong>🧭 Nächste Schritte</strong>
              <ul class="small" style="margin:0 0 0 18px;">${r.concrete_next_steps.map((x) => `<li>${App.esc(x)}</li>`).join("")}</ul>
            </div>
          </div>
          <div class="banner banner-success small"><strong>Motivations-Tipp:</strong> ${App.esc(r.motivation_tip)}</div>
        </div>
      `;
    } catch (err) {
      box.innerHTML = "";
      App.toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  },

  async createRemedialWorksheet(childId, subjectId, examId) {
    App.toast("Förder-Arbeitsblatt zu den Schwachstellen wird erstellt…");
    try {
      const res = await App.api(`/api/children/${childId}/worksheets/generate`, {
        method: "POST",
        body: {
          subject_id: subjectId,
          exam_id: examId,
          duration_minutes: 15,
          focus_mode: "weaknesses",
          question_count: 5,
        },
      });
      App.go("worksheet", { worksheetId: res.worksheet.id });
    } catch (err) {
      App.toast(err.message, "error");
    }
  },

  async toggleWeakness(id, resolved, childId) {
    await App.api(`/api/parent/weaknesses/${id}`, { method: "PATCH", body: { resolved } });
    await this.renderParentDashboard(childId);
  },

  async deleteWeakness(id, childId) {
    await App.api(`/api/parent/weaknesses/${id}`, { method: "DELETE" });
    await this.renderParentDashboard(childId);
  },

  async deleteExam(id, childId) {
    if (!confirm("Prüfung inkl. Unterthemen wirklich dauerhaft löschen? (Tipp: Mit 'Archivieren' kannst du sie stattdessen einfach ausblenden.)")) return;
    await App.api(`/api/exams/${id}`, { method: "DELETE" });
    await this.renderParentDashboard(childId);
  },

  async loadAvailableModels() {
    const btn = document.getElementById("load-models-btn");
    const box = document.getElementById("available-models-box");
    btn.disabled = true;
    box.innerHTML = `<div class="small muted">Lade verfügbare Gemini-Modelle…</div>`;
    try {
      const res = await App.api("/api/parent/settings/ai/models");
      const models = res.models || [];
      if (!models.length) {
        box.innerHTML = `<div class="small muted">Keine kompatiblen Modelle gefunden.</div>`;
        return;
      }
      box.innerHTML = `
        <div class="card-soft stack-sm" style="max-height:240px; overflow-y:auto;">
          <strong class="small">Freigeschaltete Modelle (${models.length}):</strong>
          ${models
            .map(
              (m) => `
            <div class="row-between small" style="padding:4px 0; border-bottom:1px solid var(--border);">
              <div><code>${App.esc(m.id)}</code> <span class="muted">${m.display_name !== m.id ? `(${App.esc(m.display_name)})` : ""}</span></div>
              <div class="row" style="gap:4px;">
                <button type="button" class="btn btn-secondary btn-sm"
                        onclick="document.getElementById('ai-fast').value=${App.jsArg(m.id)}; App.toast('Als Fast eingetragen – noch speichern!')">Fast</button>
                <button type="button" class="btn btn-secondary btn-sm"
                        onclick="document.getElementById('ai-smart').value=${App.jsArg(m.id)}; App.toast('Als Smart eingetragen – noch speichern!')">Smart</button>
              </div>
            </div>
          `
            )
            .join("")}
        </div>
      `;
    } catch (err) {
      box.innerHTML = `<div class="small" style="color:var(--red);">${App.esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  },
};
