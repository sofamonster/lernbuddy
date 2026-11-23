![Vibe Coded with Gemini](https://img.shields.io/badge/any_text-With_Gemini-%239D00FF?label=Vibe%20Coded
)

# 📚 LernBuddy – Familien-Lern-Web-App

Lokale Web-App für zwei Kinder (Standardprofile: 8 & 11 Jahre, frei anpassbar) zum gemeinsamen und selbstständigen Lernen auf **Handy, Tablet und Laptop** – unterstützt durch die **Google Gemini API**.

## Features im Überblick

- **6 Fächer-Vorlagen:** Mathe, Deutsch, Englisch, Französisch, Sachunterricht, Biologie (pro Kind im Elternbereich aktivierbar)
- **Altersgerechte Oberfläche:** Junior-Modus (große Buttons & Schrift, Vorlesehilfe) und Standard-Modus
- **Foto-Scanner (Handy-Kamera):** Buchseiten, Arbeitsblätter oder Vokabellisten abfotografieren → Gemini extrahiert Lernstoff mit Vorschau-Editor
- **Vokabeltrainer (Englisch & Französisch):** 5-Fächer-Leitner-System, Karteikarten / Multiple Choice / Eintippen, Französisch-Sonderzeichen-Leiste (`é è ê ç œ …`), einstellbare Tippfehler- & Akzent-Toleranz, Aussprache per Web Speech API
- **Interaktiver Prüfungs-Coach (70/30 adaptiv):**
  - Mathe mit schrittweisen Sokrates-Tipps
  - Deutsch-Diktat-Modus mit Vorlesen (normal & langsam)
  - Lückentexte & Zuordnungen (Sachunterricht, Biologie, Grammatik)
  - Offene Verständnisfragen („Erkläre in eigenen Worten“)
- **Papier-Prüfungen & Foto-Korrektur:** Saubere A4-Druckansicht (`@media print`) mit Rechenkästchen (Mathe) oder Schreiblinien + umschaltbarem Lösungsblatt. Ausgefülltes Blatt abfotografieren → Gemini korrigiert Handschrift & Rechenweg und aktualisiert automatisch das Schwachstellen-Profil!
- **PIN-geschütztes Eltern-Dashboard:** Prüfungs-Readiness (Ampel), Schwachstellen-Radar, Vokabel-Status, 1-Klick-Förderblatt, KI-Elternbericht und Profileinstellungen
- **Zugriffsschutz:** Familien-Login (`HttpOnly`-Session-Cookie) + 4-stellige Eltern-PIN

---

## Schnellstart (Lokal auf Linux)

1. Konfigurationsdatei anlegen und deinen Google Gemini API-Key eintragen:
   ```bash
   cp .env.example .env
   nano .env
   ```
   Trage dort `GEMINI_API_KEY`, ein eigenes `FAMILY_PASSWORD` und deine `PARENT_PIN` ein.

2. Starten:
   ```bash
   ./start.sh
   ```
   Im Terminal werden dir sofort die URLs für **Laptop** (`http://localhost:8000`) und **Handy/Tablet im selben WLAN** (`http://<deine-ip>:8000`) angezeigt.

---

## Start mit Docker & späteres Hosting von überall

```bash
cp .env.example .env
# .env bearbeiten (insbesondere GEMINI_API_KEY, FAMILY_PASSWORD, PARENT_PIN)
docker compose up -d --build
```

Alle Nutzdaten (SQLite-Datenbank + komprimierte Fotos) liegen gesammelt im Ordner `./data/`. Ein Backup besteht einfach aus dem Kopieren dieses Ordners.

### Sicher von unterwegs erreichbar machen
1. **Privat & ohne offene Router-Ports (Empfehlung):** Docker-Container zu Hause laufen lassen und per **Tailscale** (`tailscale serve https / http://localhost:8000`) oder **Cloudflare Tunnel** mit HTTPS verbinden (`COOKIE_SECURE=true` in `.env` setzen).
2. **Eigener Server / VPS:** Per `docker compose up -d` hinter einem HTTPS Reverse Proxy (z. B. Caddy, Traefik oder Coolify) mit `COOKIE_SECURE=true` betreiben.
