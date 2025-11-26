# Reddit Fashion Reps Search Engine

Un motore di ricerca avanzato per i subreddit di moda replica con funzionalità di machine learning e suggerimenti intelligenti.

## 🚀 Caratteristiche

### Frontend (React + TypeScript)
- **Interfaccia moderna e responsive** con design pulito
- **Ricerca multidimensionale** con suggerimenti intelligenti in tempo reale
- **Filtri avanzati** per subreddit, punteggio, data e tipo di contenuto
- **Modalità visualizzazione** con anteprima immagini e estrazione link
- **Navigazione da tastiera** completa per un'esperienza utente ottimale
- **Sistema di feedback** per migliorare la qualità dei risultati

### Backend (Node.js + Express)
- **API RESTful** per ricerca e gestione dati
- **Sistema di Machine Learning** che apprende dalle interazioni utente
- **Elaborazione intelligente del contenuto** con rimozione informazioni ridondanti
- **Caching avanzato** per prestazioni ottimali
- **Scoring semantico** con analisi di similarità e rilevanza
- **Tracking delle interazioni** per miglioramento continuo

### Sistema di Machine Learning
- **Apprendimento dai pattern di ricerca** degli utenti
- **Calcolo dinamico della rilevanza** basato su feedback e interazioni
- **Analisi del Click-Through Rate (CTR)** per ottimizzare i risultati
- **Sistema di feedback qualità** per subreddit, autori e post
- **Persistenza dei dati** con salvataggio automatico
- **Metriche di performance** e statistiche del sistema

## 📁 Struttura del Progetto

```
├── src/                    # Frontend React
│   ├── App.tsx            # Componente principale
│   ├── App.css            # Stili dell'applicazione
│   └── main.tsx           # Entry point
├── server/                # Backend Node.js
│   ├── index.js           # Server principale con API
│   ├── ml-system.js       # Sistema di Machine Learning
│   ├── package.json       # Dipendenze server
│   ├── vitest.config.js   # Configurazione test
│   └── tests/             # Test unitari
│       ├── ml-system.test.js
│       ├── api.test.js
│       └── content-processing.test.js
├── package.json           # Dipendenze frontend
└── README.md             # Documentazione
```

## 🛠️ Installazione e Avvio

### Prerequisiti
- Node.js (versione 16 o superiore)
- npm o yarn

### Installazione

1. **Clona il repository**
   ```bash
   git clone <repository-url>
   cd reddit-fashion-search
   ```

2. **Installa dipendenze frontend**
   ```bash
   npm install
   ```

3. **Installa dipendenze backend**
   ```bash
   cd server
   npm install
   ```

### Avvio in Sviluppo

1. **Avvia il backend** (porta 3001)
   ```bash
   cd server
   npm run dev
   ```

2. **Avvia il frontend** (porta 5173)
   ```bash
   npm run dev
   ```

3. **Apri il browser** su `http://localhost:5173`

## 🧪 Test

### Esecuzione Test Backend
```bash
cd server
npm test                    # Esegui tutti i test
npm run test:watch         # Modalità watch
npm run test:coverage      # Test con coverage
```

### Test Disponibili
- **ml-system.test.js**: Test del sistema di machine learning
- **api.test.js**: Test degli endpoint API
- **content-processing.test.js**: Test elaborazione contenuti

## 📊 API Endpoints

### Ricerca
- `GET /api/search?q={query}&subreddits={list}&sort={type}&limit={num}`
- `GET /api/best?q={query}` - Migliori risultati con ML

### Machine Learning
- `POST /api/interaction` - Registra interazione utente
- `POST /api/feedback` - Invia feedback qualità
- `GET /api/ml-stats` - Statistiche sistema ML

### Utilità
- `POST /api/extract-links` - Estrai link da URL
- `GET /api/subreddits` - Lista subreddit disponibili

## 🤖 Sistema di Machine Learning

### Funzionalità Principali

1. **Tracking Interazioni**
   - Registrazione di impression, click, bookmark, estrazione link
   - Analisi pattern di ricerca per query frequenti
   - Calcolo Click-Through Rate per risultati popolari

2. **Miglioramento Rilevanza**
   - Boost dinamico basato su pattern appresi
   - Bonus per contenuti con buone performance storiche
   - Penalizzazione per contenuti con feedback negativo

3. **Sistema di Feedback**
   - Valutazione qualità subreddit (1-5 stelle)
   - Rating autori affidabili
   - Feedback specifico su singoli post

4. **Persistenza e Cleanup**
   - Salvataggio automatico dati ogni 5 minuti
   - Cleanup automatico dati vecchi (>30 giorni)
   - Backup e recovery dei dati di apprendimento

### Metriche Monitorate

- **Interazioni Totali**: Numero totale di interazioni registrate
- **Query Uniche**: Diversità delle ricerche effettuate
- **CTR Medio**: Click-through rate medio del sistema
- **Tasso di Bookmark**: Percentuale di risultati salvati
- **Salute Sistema**: Stato generale e confidenza del ML

## 🎨 Interfaccia Utente

### Caratteristiche UX

1. **Ricerca Intelligente**
   - Suggerimenti in tempo reale durante la digitazione
   - Completamento automatico basato su ricerche popolari
   - Filtri avanzati con preview risultati

2. **Visualizzazione Risultati**
   - Layout a griglia responsive
   - Anteprima immagini con lazy loading
   - Indicatori di qualità e rilevanza

3. **Interazioni Avanzate**
   - Navigazione completa da tastiera (↑↓ per navigare, Enter per aprire)
   - Modalità focus per lettura dettagliata
   - Sistema di bookmark e condivisione

4. **Feedback Utente**
   - Rating rapido con stelle
   - Segnalazione contenuti inappropriati
   - Suggerimenti per miglioramenti

## 🔧 Configurazione Avanzata

### Variabili d'Ambiente
```bash
# Server
PORT=3001
ML_DATA_PATH=./ml-data.json
CLEANUP_INTERVAL=300000  # 5 minuti
MAX_INTERACTIONS_PER_SESSION=1000

# Frontend
VITE_API_BASE_URL=http://localhost:3001
VITE_ENABLE_ML_TRACKING=true
```

### Personalizzazione ML

Il sistema di ML può essere configurato modificando i parametri in `ml-system.js`:

```javascript
// Soglie di apprendimento
const LEARNING_THRESHOLDS = {
  MIN_INTERACTIONS: 10,
  MIN_QUERY_FREQUENCY: 3,
  MAX_BOOST_FACTOR: 2.0,
  QUALITY_WEIGHT: 0.3
};

// Intervalli di cleanup
const CLEANUP_INTERVALS = {
  DATA_RETENTION_DAYS: 30,
  MAX_RATINGS_PER_ITEM: 50,
  SAVE_INTERVAL_MS: 300000
};
```

## 🚀 Deployment

### Build di Produzione

1. **Build Frontend**
   ```bash
   npm run build
   ```

2. **Configurazione Server**
   ```bash
   cd server
   npm install --production
   ```

3. **Variabili d'Ambiente Produzione**
   ```bash
   NODE_ENV=production
   PORT=80
   ML_DATA_PATH=/data/ml-data.json
   ```

### Docker (Opzionale)

```dockerfile
# Dockerfile esempio
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3001
CMD ["node", "index.js"]
```

## 🤝 Contribuire

1. Fork del repository
2. Crea branch feature (`git checkout -b feature/nuova-funzionalita`)
3. Commit modifiche (`git commit -am 'Aggiungi nuova funzionalità'`)
4. Push al branch (`git push origin feature/nuova-funzionalita`)
5. Crea Pull Request

### Linee Guida

- Scrivi test per nuove funzionalità
- Mantieni copertura test >80%
- Segui convenzioni di codice esistenti
- Documenta API e funzioni pubbliche

## 📈 Roadmap

### Prossime Funzionalità

- [ ] **Ricerca vocale** con riconoscimento speech-to-text
- [ ] **Filtri AI avanzati** per qualità e autenticità
- [ ] **Sistema di raccomandazioni** personalizzate
- [ ] **Integrazione social** per condivisione risultati
- [ ] **App mobile** React Native
- [ ] **Dashboard analytics** per amministratori

### Miglioramenti Tecnici

- [ ] **Caching Redis** per prestazioni superiori
- [ ] **Database PostgreSQL** per persistenza avanzata
- [ ] **Microservizi** per scalabilità
- [ ] **CI/CD Pipeline** automatizzata
- [ ] **Monitoring** con Prometheus/Grafana

## 📄 Licenza

Questo progetto è rilasciato sotto licenza MIT. Vedi il file `LICENSE` per dettagli.

## 🙏 Ringraziamenti

- Community Reddit per i dati e feedback
- Contributori open source per librerie utilizzate
- Beta tester per suggerimenti e bug report

---

**Sviluppato con ❤️ per la community fashion reps**
# TIAGOXSEARCH

## Config Reddit per sito pubblico

Per evitare blocchi (403/429) da Reddit e rendere il sito affidabile in produzione, configura OAuth lato server:

1. Crea un'app Reddit (https://www.reddit.com/prefs/apps) di tipo "script" per uso server.
2. Prendi `client_id`, `client_secret`, e usa le credenziali di un account dedicato (username/password).
3. Imposta le variabili d'ambiente nel tuo ambiente di deploy:

   - `REDDIT_CLIENT_ID`
   - `REDDIT_CLIENT_SECRET`
   - `REDDIT_USERNAME`
   - `REDDIT_PASSWORD`

Con queste variabili, il backend userà `https://oauth.reddit.com` con `Authorization: Bearer <token>` e gestirà il refresh automatico del token. In caso di errore, c'è fallback agli endpoint pubblici.

### Note operative

- Il backend include cache in memoria per alcune operazioni e gestisce fallimenti parziali per i diversi subreddit.
- In assenza di credenziali OAuth, il sistema funziona comunque usando gli endpoint pubblici, ma può essere limitato da Reddit.
- Puoi aggiungere un layer di cache persistente (es. Redis/DB) e batching per migliorare affidabilità e ridurre rate limit.

## Avvio in sviluppo

```bash
npm run dev
```

Backend: `http://localhost:3000/` — Frontend: `http://localhost:5173/`

## Variabili d’ambiente

Puoi esportarle prima di avviare il server (Windows PowerShell):

```powershell
$env:REDDIT_CLIENT_ID = "<id>"
$env:REDDIT_CLIENT_SECRET = "<secret>"
$env:REDDIT_USERNAME = "<username>"
$env:REDDIT_PASSWORD = "<password>"
npm run dev
```
