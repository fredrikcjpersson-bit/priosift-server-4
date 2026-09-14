# PrioSift – server

Kliniskt beslutsstöd för akutmottagningar. Node.js/Express + PostgreSQL.

## Projektstruktur

```
priosift-server/
├── server.js                  # Express-app, session, route-mounting
├── package.json
├── railway.toml               # Railway deploy-config
├── Dockerfile                 # Alternativ: Docker-deploy
├── .env.example               # Kopiera till .env och fyll i
├── scripts/
│   └── prepare-frontend.sh   # Patchar artifact-HTML till server-mode
├── public/
│   └── index.html             # Genereras av prepare-frontend.sh
└── src/
    ├── db.js                  # PostgreSQL-pool, schema, seed, helpers
    ├── middleware.js           # requireAuth / requireOwner
    ├── scoring.js             # Poängberäkning (portad från frontend)
    ├── form.json              # Formulärkonfiguration (DEMO_FORM)
    └── routes/
        ├── auth.js            # login / logout / me / password
        ├── bootstrap.js       # /api/bootstrap (startdata)
        ├── departments.js     # CRUD avdelningar
        ├── patients.js        # CRUD patienter + triagering
        ├── waiting.js         # Anonym väntrumsvy
        ├── config.js          # Konfiguration + användarhantering
        ├── stats.js           # Admin-statistik, tier-analys
        └── cosmic.js          # HL7 FHIR / Cosmic-adapter (stub)
```

## Snabbstart (lokal utveckling)

### 1. Förutsättningar
- Node.js ≥ 20
- PostgreSQL (lokalt eller via Railway)

### 2. Klona och installera
```bash
git clone https://github.com/DITT-REPO/priosift-server.git
cd priosift-server
npm install
```

### 3. Miljövariabler
```bash
cp .env.example .env
# Redigera .env – sätt DATABASE_URL och SESSION_SECRET
```

### 4. Förbered frontend
Ladda ner artifact-HTML från Claude (`priosift-app.html`) och kör:
```bash
./scripts/prepare-frontend.sh ~/Downloads/priosift-app.html
```
Det skriver `public/index.html` redo för server-mode.

### 5. Starta
```bash
npm run dev   # node --watch (auto-reload)
# eller
npm start
```
Öppna http://localhost:3000 – logga in med `fredrik` / lösenordet från `.env`.

---

## Driftsättning på Railway

### 1. Skapa Railway-projekt
1. Logga in på [railway.app](https://railway.app)
2. **New Project → Deploy from GitHub repo** → välj ditt repo
3. Lägg till **PostgreSQL**-plugin (klicka "+ New" → Database → PostgreSQL)

### 2. Miljövariabler (Railway → Settings → Variables)
Kopiera in från `.env.example` och fyll i:
```
SESSION_SECRET=<lång slumpsträng>
OWNER_USERNAME=fredrik
OWNER_NAME=Fredrik Persson
OWNER_PASSWORD=<starkt lösenord>
NODE_ENV=production
```
`DATABASE_URL` sätts automatiskt av Railway-PostgreSQL-pluginen.

### 3. Anpassad domän
Railway → Settings → Domains → **Custom Domain** → ange `priosift.com`  
Uppdatera DNS hos din registrar:
```
CNAME  priosift.com  → <din-service>.up.railway.app
```
(eller A-record om CNAME på apex inte stöds – Railway visar IP)

### 4. Automatisk deploy
Varje `git push` till `main` triggar en ny deploy på Railway.

---

## Roller

| Roll    | Rättigheter |
|---------|-------------|
| `owner` | Allt – inklusive config, statistik och användarhantering |
| `staff` | Triagekö, patienter, väntrumsskärm |

Lägg till personal via admin-panelen (Inställningar → Användare).

---

## Cosmic / HL7 FHIR-integration

Adaptern i `src/routes/cosmic.js` är förberedd men inaktiv som standard.

Aktivera:
1. Skaffa API-uppgifter från TietoEvry (kräver regionavtal)
2. Sätt i Railway Variables:
   ```
   COSMIC_ENABLED=true
   COSMIC_BASE_URL=https://api.cosmic.tietoevry.com/fhir/r4
   COSMIC_TOKEN_URL=https://auth.cosmic.tietoevry.com/oauth2/token
   COSMIC_CLIENT_ID=...
   COSMIC_CLIENT_SECRET=...
   ```
3. Tillgängliga endpoints:
   - `GET  /api/cosmic/status`       – anslutningstest
   - `GET  /api/cosmic/patient/:pnr` – hämta patient från Cosmic
   - `POST /api/cosmic/push/:id`     – skicka triageresultat till Cosmic

---

## GDPR / Patientdatalagen

- Alla patientdata lagras i Railway-PostgreSQL **inom EU** (region: europe-west4)
- Välj EU-region vid skapande av Railway-projekt
- Personuppgiftsbiträdesavtal (PBA) tecknas med Railway via deras DPA-process
- PII (namn, personnummer) lagras krypterat i transit (TLS) och i vila (Railway Postgres)

---

## API-referens (snabböversikt)

```
POST   /api/login                  Logga in
POST   /api/logout                 Logga ut
GET    /api/me                     Inloggad användare
PUT    /api/password               Byt lösenord

GET    /api/bootstrap              Startdata (form, config, avdelningar)

GET    /api/departments            Lista avdelningar
POST   /api/departments            Skapa avdelning (owner)
PATCH  /api/departments/:id        Uppdatera (owner)
DELETE /api/departments/:id        Ta bort (owner, ?force=1)

GET    /api/patients?dept=         Patientlista
POST   /api/patients               Registrera patient (kör triagering)
GET    /api/patients/:id           Hämta patient
PATCH  /api/patients/:id           Uppdatera (labs triggar omberäkning)
DELETE /api/patients/:id           Ta bort

GET    /api/waiting?dept=          Anonym väntrumsvy

PUT    /api/config                 Uppdatera config (?recalculate) (owner)
GET    /api/users                  Lista användare (owner)
POST   /api/users                  Skapa användare (owner)
DELETE /api/users/:username        Ta bort användare (owner)

GET    /api/stats                  Statistik + tier-analys (owner)

GET    /api/cosmic/status          Cosmic anslutningstest
GET    /api/cosmic/patient/:pnr    Hämta patient från Cosmic
POST   /api/cosmic/push/:id        Skicka triageresultat till Cosmic
```
