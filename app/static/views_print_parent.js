window.PrintParentViews = {
  _gradeFiles: [],

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
  // PARENT DASHBOARD (PIN-protected)
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
    const summaries = data.children;
    const active = summaries.find((s) => s.child.id === selectedChildId) || summaries[0];
    const c = active.child;

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

    const childTabs = summaries
      .map(
        (s) => `
        <button class="tab ${s.child.id === c.id ? "active" : ""}" style="display:inline-flex; align-items:center; gap:8px;"
                onclick="App.go('parent', { selectedChildId: ${s.child.id} })">
          ${App.avatarHtml(s.child, "xs")} ${App.esc(s.child.name)} (${s.child.age} J.)
          ${s.open_weaknesses_count > 0 ? `· ${s.open_weaknesses_count} Fokus` : ""}
        </button>
      `
      )
      .join("");

    const examsHtml = active.exams.length
      ? active.exams
          .map((e) => {
            const r = e.readiness;
            return `
              <div class="card-soft stack-sm">
                <div class="row-between">
                  <div class="row">
                    <span>${App.esc(e.subject_icon)}</span>
                    <strong>${App.esc(e.title)}</strong>
                    <span class="pill">
                      <span class="light-dot light-${r.traffic_light}"></span>
                      ${App.esc(r.label)} (${r.avg_mastery}%)
                    </span>
                    <button type="button" class="pill pill-primary" style="border:none; cursor:pointer;"
                            onclick="PrintParentViews.editExam(${e.id}, ${c.id})">
                      📅 ${e.exam_date ? App.formatDate(e.exam_date) : "Datum setzen"} ✏️
                    </button>
                  </div>
                  <div class="row">
                    <button class="btn btn-secondary btn-sm"
                            onclick="PrintParentViews.editExam(${e.id}, ${c.id})">
                      📅 Datum
                    </button>
                    <button class="btn btn-secondary btn-sm"
                            onclick="PrintParentViews.createRemedialWorksheet(${c.id}, ${e.subject_id}, ${e.id})">
                      🖨️ Förderblatt
                    </button>
                    <button class="btn btn-danger btn-sm" onclick="PrintParentViews.deleteExam(${e.id}, ${c.id})">Löschen</button>
                  </div>
                </div>
                ${e.topics
                  .map(
                    (t) => `
                  <div class="row-between small">
                    <span>${App.esc(t.title)}</span>
                    <span class="muted">${t.mastery_score}% (${t.attempts_count}x geübt)</span>
                  </div>
                  <div class="progress-track">
                    <div class="progress-fill ${t.mastery_score >= 75 ? "green" : t.mastery_score >= 45 ? "amber" : "red"}"
                         style="width:${t.mastery_score}%"></div>
                  </div>
                `
                  )
                  .join("")}
              </div>
            `;
          })
          .join("")
      : `<p class="small muted">Noch keine Prüfungen eingetragen.</p>`;

    const weaknessesHtml = active.weaknesses.length
      ? active.weaknesses
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
      : `<p class="small muted">Aktuell sind keine Schwachstellen vermerkt – super!</p>`;

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

    App.renderShell(`
      <div class="stack">
        ${warnings.join("")}

        <div class="row-between">
          <div>
            <h1>👨‍👩‍👦‍👦 Eltern-Übersicht</h1>
            <p class="muted small">Fortschritt, Schwachstellen, Förderblätter & Profileinstellungen</p>
          </div>
          <button class="btn btn-primary" id="parent-ai-report-btn" onclick="PrintParentViews.loadAiReport(${c.id})">
            ✨ KI-Elternbericht für ${App.esc(c.name)} erstellen
          </button>
        </div>

        <div class="tabs">${childTabs}</div>

        <div id="parent-ai-report-box"></div>

        <div class="grid-3">
          <div class="card">
            <div class="small muted">Offene Schwachstellen</div>
            <h2 style="margin-top:4px;">${active.open_weaknesses_count}</h2>
          </div>
          <div class="card">
            <div class="small muted">Vokabeln (fällig / gesamt)</div>
            <h2 style="margin-top:4px;">${active.vocab.due} / ${active.vocab.total}</h2>
          </div>
          <div class="card">
            <div class="small muted">Aktivität</div>
            <h2 style="margin-top:4px;">⭐ ${c.stars} · 🔥 ${c.streak_days}d</h2>
          </div>
        </div>

        <div class="grid-2">
          <section class="card stack-sm">
            <h3>📅 Prüfungs-Bereitschaft</h3>
            ${examsHtml}
          </section>
          <section class="card stack-sm">
            <h3>🎯 Schwachstellen-Radar</h3>
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
            <h3>📈 Letzte Übungen & Papier-Prüfungen</h3>
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

        <div class="grid-2">
          <section class="card stack">
            <h3>⚙️ Profil & Fächer für ${App.esc(c.name)}</h3>
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
                <strong class="small">Aktive Fächer:</strong>
                <div class="grid-2">${subjectCheckboxes}</div>
              </div>

              <div>
                <button type="submit" class="btn btn-primary">Profil & Fächer speichern</button>
              </div>
            </form>
          </section>

          <section class="card stack">
            <h3>🤖 Gemini Smart-Routing Einstellungen</h3>
            <p class="small muted">Schnelles Modell für Alltag/Scanner/Quiz, stärkeres Modell für Handschrift-Korrektur & Elternberichte.</p>
            <form id="parent-ai-form" class="stack-sm">
              <div class="field">
                <label>Fast-Modell (Standard-Alltag)</label>
                <input type="text" id="ai-fast" value="${App.esc(data.ai_models.fast)}" />
              </div>
              <div class="field">
                <label>Smart-Modell (Handschrift-Korrektur & Berichte)</label>
                <input type="text" id="ai-smart" value="${App.esc(data.ai_models.smart)}" />
              </div>
              <div class="row">
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
      </div>
    `);

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
        this.renderParentDashboard(c.id);
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
    this.renderParentDashboard(childId);
  },

  async deleteWeakness(id, childId) {
    await App.api(`/api/parent/weaknesses/${id}`, { method: "DELETE" });
    this.renderParentDashboard(childId);
  },

  editExam(examId, childId) {
    const childSummary = (this._lastParentOverview?.children || []).find((s) => s.child.id === childId);
    const exam = (childSummary?.exams || []).find((e) => e.id === examId);
    if (!exam) return;
    App.openExamEditModal(exam, () => this.renderParentDashboard(childId));
  },

  async deleteExam(id, childId) {
    if (!confirm("Prüfung inkl. Unterthemen wirklich löschen?")) return;
    await App.api(`/api/exams/${id}`, { method: "DELETE" });
    this.renderParentDashboard(childId);
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
