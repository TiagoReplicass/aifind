import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { mlSystem } from './ml-system.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
// Cache per le richieste
const requestCache = new Map(); // Utilizziamo Map invece di NodeCache

// Cache persistente dei post per resilienza
const SUB_CACHE = new Map(); // key: subreddit, value: { posts: [], updatedAt: number }
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Rileva ambiente serverless (Netlify Functions)
const IS_SERVERLESS = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
console.log('[Startup] IS_SERVERLESS =', IS_SERVERLESS, 'PORT =', process.env.PORT || 3000);
// In serverless il filesystem del codice è read-only: usa directory temporanea
const CACHE_DIR = IS_SERVERLESS ? (process.env.TMPDIR || '/tmp') : __dirname;
const CACHE_FILE = path.join(CACHE_DIR, 'cache.json');
const REFRESH_INTERVAL_MS = parseInt(process.env.CACHE_REFRESH_MS || '300000', 10); // 5 min default
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || '86400000', 10); // 24h default

const loadCacheFromDisk = () => {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      const obj = JSON.parse(raw);
      Object.entries(obj || {}).forEach(([sub, val]) => {
        if (val && Array.isArray(val.posts)) SUB_CACHE.set(sub, { posts: val.posts, updatedAt: val.updatedAt || Date.now() });
      });
      console.log(`Loaded subreddit cache from disk (${SUB_CACHE.size} subs).`);
    }
  } catch (e) {
    console.warn('Failed to load cache from disk:', e.message);
  }
};

const saveCacheToDisk = () => {
  try {
    const obj = {};
    SUB_CACHE.forEach((v, k) => { obj[k] = { posts: v.posts, updatedAt: v.updatedAt }; });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.warn('Failed to save cache to disk:', e.message);
  }
};

// Config Reddit OAuth (server-side)
const USER_AGENT = 'TiagoSearchBot/1.3 (+https://localhost)';
const redditAuth = {
  clientId: process.env.REDDIT_CLIENT_ID,
  clientSecret: process.env.REDDIT_CLIENT_SECRET,
  username: process.env.REDDIT_USERNAME,
  password: process.env.REDDIT_PASSWORD,
};
let redditToken = null;
let redditTokenExpiresAt = 0;
const useOAuth = Boolean(redditAuth.clientId && redditAuth.clientSecret && redditAuth.username && redditAuth.password);

// Semaforo globale per limitare concorrenza delle chiamate a Reddit
const MAX_CONCURRENT_REDDIT = parseInt(process.env.MAX_CONCURRENT_REDDIT || '4', 10);
let currentRedditCalls = 0;
const redditQueue = [];

const acquireReddit = () => new Promise(resolve => {
  if (currentRedditCalls < MAX_CONCURRENT_REDDIT) {
    currentRedditCalls++;
    resolve();
  } else {
    redditQueue.push(resolve);
  }
});

const releaseReddit = () => {
  currentRedditCalls = Math.max(0, currentRedditCalls - 1);
  const next = redditQueue.shift();
  if (next) {
    currentRedditCalls++;
    next();
  }
};

const getRedditToken = async () => {
  if (!useOAuth) return null;
  const now = Date.now();
  if (redditToken && now < redditTokenExpiresAt - 60_000) return redditToken; // usa token finché valido (1min margine)
  const basic = Buffer.from(`${redditAuth.clientId}:${redditAuth.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'password',
    username: redditAuth.username,
    password: redditAuth.password,
  });
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: body.toString(),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Reddit OAuth failed ${r.status}: ${txt}`);
  }
  const j = await r.json();
  redditToken = j.access_token;
  redditTokenExpiresAt = Date.now() + (j.expires_in ? j.expires_in * 1000 : 3600_000);
  return redditToken;
};

const fetchReddit = async (path, headersExtra = {}, opts = {}) => {
  const baseHeaders = { 'User-Agent': USER_AGENT, ...headersExtra };
  // Prova con OAuth se configurato
  if (useOAuth) {
    try {
      const token = await getRedditToken();
      await acquireReddit();
      const r1 = await fetch(`https://oauth.reddit.com${path}`, {
        ...opts,
        headers: { ...baseHeaders, 'Authorization': `Bearer ${token}` },
      });
      releaseReddit();
      // Se token scaduto o invalido, riprova aggiornando token una volta
      if (r1.status === 401) {
        redditToken = null; redditTokenExpiresAt = 0;
        const token2 = await getRedditToken();
        await acquireReddit();
        const r2 = await fetch(`https://oauth.reddit.com${path}`, {
          ...opts,
          headers: { ...baseHeaders, 'Authorization': `Bearer ${token2}` },
        });
        releaseReddit();
        return r2;
      }
      return r1;
    } catch (e) {
      console.warn('OAuth fetch failed, falling back to public endpoints:', e.message);
      // Fall back a endpoint pubblico
      await acquireReddit();
      const rPub = await fetch(`https://www.reddit.com${path}`, { ...opts, headers: baseHeaders });
      releaseReddit();
      return rPub;
    }
  }
  // Nessun OAuth configurato: usa endpoint pubblico
  await acquireReddit();
  const rNo = await fetch(`https://www.reddit.com${path}`, { ...opts, headers: baseHeaders });
  releaseReddit();
  return rNo;
};

const refreshSubCache = async (sub) => {
  try {
    const altPath = `/r/${encodeURIComponent(sub)}/new.json?limit=100`;
    let r = await fetchReddit(altPath, { 'User-Agent': USER_AGENT });
    if (!r.ok && useOAuth) {
      try { r = await fetch(`https://www.reddit.com${altPath}`, { headers: { 'User-Agent': USER_AGENT } }); } catch {}
    }
    if (!r.ok) throw new Error(`Cache refresh failed ${r.status} for r/${sub}`);
    const j = await r.json();
    const children = (j?.data?.children || []).map(c => c?.data).filter(Boolean);
    SUB_CACHE.set(sub, { posts: children, updatedAt: Date.now() });
    saveCacheToDisk();
    console.log(`Refreshed cache for r/${sub}: ${children.length} posts`);
  } catch (e) {
    console.warn(`refreshSubCache error for r/${sub}:`, e.message);
  }
};

// Warm-up cache from disk & schedule refresh
loadCacheFromDisk();
// Evita scheduler in ambiente serverless (niente processi long-running)
if (!IS_SERVERLESS) {
  setTimeout(() => { DEFAULT_SUBS.forEach((s) => refreshSubCache(s)); }, 2000);
  setInterval(() => { DEFAULT_SUBS.forEach((s) => refreshSubCache(s)); }, REFRESH_INTERVAL_MS);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '1mb' })); // Limita dimensione richieste

// Rate limiting per IP (semplice, senza dipendenze)
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10); // 1 min
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '60', 10); // 60 req/min per IP
const ipRequests = new Map(); // ip -> array di timestamps

app.use((req, res, next) => {
  try {
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0] || req.ip || req.connection.remoteAddress || 'unknown').trim();
    const now = Date.now();
    const arr = ipRequests.get(ip) || [];
    const fresh = arr.filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
    fresh.push(now);
    ipRequests.set(ip, fresh);
    if (fresh.length > RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Rate limit exceeded', retry_after_ms: RATE_LIMIT_WINDOW_MS, limit: RATE_LIMIT_MAX });
    }
  } catch (e) {
    // Se qualcosa va storto, non bloccare
  }
  next();
});

// AI-powered semantic similarity function (local implementation) - OTTIMIZZATA
const getSemanticSimilarity = async (query, texts) => {
  try {
    // Cache check for performance optimization
    const cacheKey = `sim_${query}_${texts.length}`;
    const cachedResult = requestCache.get(cacheKey);
    if (cachedResult !== undefined) {
      return cachedResult;
    }
    
    // Preprocessing più rigoroso per evitare falsi positivi
    const normalizeForSemantic = (text) => {
      return text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(/\s+/)
        .filter(w => w.length > 2 && !isStopWord(w)); // Rimuovi stop words
    };
    
    // Lista di stop words per migliorare la precisione
    const isStopWord = (word) => {
      const stopWords = ['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use'];
      return stopWords.includes(word);
    };
    
    const queryWords = normalizeForSemantic(query);
    
    const results = texts.map(text => {
      if (!text || text.length < 3) return 0;
      
      const textWords = normalizeForSemantic(text);
      if (textWords.length === 0) return 0;
      
      let semanticScore = 0;
      
      // 1. Exact matches con peso maggiore
      let exactMatches = 0;
      queryWords.forEach(qw => {
        if (textWords.includes(qw)) {
          exactMatches++;
        }
      });
      
      // 2. Fuzzy matching più selettivo
      let fuzzyMatches = 0;
      queryWords.forEach(qw => {
        textWords.forEach(tw => {
          const similarity = levenshteinSimilarity(qw, tw);
          if (similarity > 0.85) { // Soglia più alta per maggiore precisione
            fuzzyMatches += similarity;
          }
        });
      });
      
      // 3. Controllo di rilevanza contestuale più rigoroso
      const fashionTerms = ['qc', 'quality', 'check', 'review', 'batch', 'seller', 'agent', 'shipping', 'size', 'fit', 'tts', 'w2c', 'find', 'link', 'store', 'buy', 'cop', 'price'];
      const brandTerms = ['nike', 'adidas', 'jordan', 'yeezy', 'supreme', 'balenciaga', 'gucci', 'louis', 'vuitton', 'dior', 'prada'];
      
      let contextRelevance = 0;
      const allWords = [...queryWords, ...textWords];
      
      // Bonus solo se ci sono termini rilevanti sia nella query che nel testo
      const queryHasFashion = queryWords.some(w => fashionTerms.includes(w) || brandTerms.includes(w));
      const textHasFashion = textWords.some(w => fashionTerms.includes(w) || brandTerms.includes(w));
      
      if (queryHasFashion && textHasFashion) {
        contextRelevance = 0.2;
      }
      
      // 4. Penalità per testi troppo generici o irrilevanti
      let penalty = 0;
      const genericWords = ['help', 'please', 'thanks', 'hello', 'good', 'bad', 'nice', 'cool', 'awesome', 'great'];
      const genericCount = textWords.filter(w => genericWords.includes(w)).length;
      if (genericCount > textWords.length * 0.3) {
        penalty = 0.3; // Penalità per testi troppo generici
      }
      
      // 5. Calcolo finale più conservativo
      const exactScore = (exactMatches / Math.max(queryWords.length, 1)) * 0.6; // Peso maggiore per exact matches
      const fuzzyScore = Math.min(0.3, fuzzyMatches / queryWords.length);
      
      semanticScore = exactScore + fuzzyScore + contextRelevance - penalty;
      
      // Soglia minima più alta per filtrare risultati irrilevanti
      return Math.min(1, Math.max(0, semanticScore));
    });
    
    // Cache the results for future requests
    requestCache.set(cacheKey, results);
    
    return results;
  } catch (error) {
    console.warn('Semantic similarity error:', error.message);
    return texts.map(() => 0); // Fallback più conservativo
  }
};

// Enhanced Levenshtein similarity with optimizations
const levenshteinSimilarity = (str1, str2) => {
  if (str1 === str2) return 1;
  
  const len1 = str1.length;
  const len2 = str2.length;
  
  if (len1 === 0) return len2 === 0 ? 1 : 0;
  if (len2 === 0) return 0;
  
  // Optimization: if strings are too different in length, return early
  if (Math.abs(len1 - len2) > Math.max(len1, len2) * 0.7) return 0;
  
  const matrix = Array(len1 + 1).fill().map(() => Array(len2 + 1).fill(0));
  
  for (let i = 0; i <= len1; i++) matrix[i][0] = i;
  for (let j = 0; j <= len2; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  
  const maxLen = Math.max(len1, len2);
  return 1 - matrix[len1][len2] / maxLen;
};

// Advanced text preprocessing with NLP-inspired techniques
const preprocessTextForAI = (title, selftext = '') => {
  const combined = `${title || ''} ${selftext || ''}`;
  
  // Advanced normalization
  return combined
    .toLowerCase()
    .replace(/[^\w\s\-.,!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(.)\1{2,}/g, '$1$1') // Reduce repeated characters (e.g., "sooo" -> "soo")
    .trim()
    .substring(0, 800); // Increased limit for better context
};

// Machine Learning inspired feature extraction
const extractFeatures = (text, query) => {
  const features = {};
  
  // Basic text statistics
  features.textLength = text.length;
  features.wordCount = text.split(/\s+/).length;
  features.avgWordLength = features.wordCount > 0 ? features.textLength / features.wordCount : 0;
  
  // Query relevance features
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const textWords = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  
  features.queryWordDensity = queryWords.length > 0 ? 
    queryWords.filter(qw => textWords.includes(qw)).length / queryWords.length : 0;
  
  features.uniqueWordRatio = textWords.length > 0 ? 
    new Set(textWords).size / textWords.length : 0;
  
  // Readability features
  features.sentenceCount = (text.match(/[.!?]+/g) || []).length;
  features.avgSentenceLength = features.sentenceCount > 0 ? 
    features.wordCount / features.sentenceCount : features.wordCount;
  
  // Domain-specific features
  const fashionKeywords = ['qc', 'quality', 'review', 'batch', 'seller', 'w2c', 'find'];
  features.fashionKeywordCount = fashionKeywords.filter(kw => 
    text.toLowerCase().includes(kw)).length;
  
  return features;
};

// Default subreddits for product search. Accept names without the "r/" prefix.
const DEFAULT_SUBS = ['weidianwarriors','1688Reps','RepsneakersDogs','DesignerReps','QualityReps'];

// Root info route to avoid "Cannot GET /"
app.get('/', (req, res) => {
  res.type('html').send(`
    <html>
      <head><title>API Server</title></head>
      <body style="font-family: system-ui; padding: 20px;">
        <h2>Backend API</h2>
        <p>Server attivo su <code>http://localhost:${PORT}</code>.</p>
        <ul>
          <li><a href="/api/health">/api/health</a></li>
          <li><code>/api/search?q=scarpe</code></li>
          <li><code>/api/best?q=scarpe</code></li>
          <li><code>/api/extract?permalink=https://www.reddit.com/r/FashionReps/comments/xxxxx/</code></li>
        </ul>
        <p>Apri il frontend su <a href="http://localhost:5173/">http://localhost:5173/</a>.</p>
      </body>
    </html>
  `);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Stato sistema (OAuth + Cache)
app.get('/api/status', (req, res) => {
  try {
    const cache = {};
    DEFAULT_SUBS.forEach((sub) => {
      const entry = SUB_CACHE.get(sub);
      cache[sub] = {
        count: entry?.posts?.length || 0,
        updatedAt: entry?.updatedAt || 0,
        ageMinutes: entry?.updatedAt ? Math.round((Date.now() - entry.updatedAt) / 60000) : null
      };
    });
    res.json({
      useOAuth,
      hasToken: Boolean(redditToken),
      tokenExpiresAt: redditTokenExpiresAt || null,
      userAgent: USER_AGENT,
      cache
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get status', details: e.message });
  }
});

// Utility: sistema avanzato di estrazione e validazione URL
// Regex ottimizzata per URL standard con validazione più rigorosa
const URL_REGEX = /https?:\/\/(?:[-\w.])+(?:\:[0-9]+)?(?:\/(?:[\w\/_.])*(?:\?(?:[\w&=%.])*)?(?:\#(?:[\w.])*)?)?/gi;

// Regex per URL in formato markdown
const MARKDOWN_URL_REGEX = /\[([^\]]+)\]\(([^)]+)\)/gi;

// Regex per URL in formato HTML
const HTML_URL_REGEX = /<a\s+(?:[^>]*?\s+)?href="([^"]*)"[^>]*>/gi;

// Regex migliorata per URL in formato testo semplice con validazione più rigorosa
const TEXT_URL_REGEX = /(?:^|\s)((?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}(?:\/[\S]*)?)/gi;

// Elenco unificato dei domini shopping
const SHOPPING_SITES = [
  'weidian.com',
  'item.taobao.com',
  'taobao.com',
  'm.tb.cn',
  '1688.com',
  'acbuy.com',
  'mulebuy.com',
  'allchinabuy.com',
  'itaobuy.com',
  'tmall.com',
  'alibaba.com',
  'pandabuy.com',
  'wegobuy.com',
  'superbuy.com',
  'cssbuy.com',
  'ytaopal.com',
  'basetao.com',
  'sugargoo.com',
  'cnfans.com',
  'hoobuy.com',
  'hagobuy.com',
  'kameymall.com',
  'joyabuy.com',
  'yupoo.com'
];

// Validatori specifici per domini shopping per ridurre falsi positivi
const SHOPPING_VALIDATORS = {
  'weidian.com': (u) => {
    try {
      const a = new URL(u);
      if (!a.hostname.endsWith('weidian.com')) return false;
      const p = a.pathname.toLowerCase();
      const id = a.searchParams.get('itemID') || a.searchParams.get('itemid');
      return p.includes('item.html') && (!!id || /item\.html$/.test(p));
    } catch { return false; }
  },
  'item.taobao.com': (u) => {
    try {
      const a = new URL(u);
      return a.hostname === 'item.taobao.com' && a.pathname.toLowerCase().includes('item.htm') && !!a.searchParams.get('id');
    } catch { return false; }
  },
  'taobao.com': (u) => {
    try {
      const a = new URL(u);
      return a.hostname.endsWith('taobao.com') && a.pathname.toLowerCase().includes('item.htm') && !!a.searchParams.get('id');
    } catch { return false; }
  },
  'tmall.com': (u) => {
    try {
      const a = new URL(u);
      return a.hostname.endsWith('tmall.com') && a.pathname.toLowerCase().includes('item.htm') && !!a.searchParams.get('id');
    } catch { return false; }
  },
  '1688.com': (u) => {
    try {
      const a = new URL(u);
      const p = a.pathname.toLowerCase();
      return a.hostname.endsWith('1688.com') && (p.includes('/offer/') || !!a.searchParams.get('id'));
    } catch { return false; }
  },
  'alibaba.com': (u) => {
    try {
      const a = new URL(u);
      const p = a.pathname.toLowerCase();
      return a.hostname.endsWith('alibaba.com') && (p.includes('/product-detail') || p.includes('/offer/') || !!a.searchParams.get('id'));
    } catch { return false; }
  },
  'm.tb.cn': (_) => true, // shortener Taobao, accetta
  'pandabuy.com': (_) => true,
  'wegobuy.com': (_) => true,
  'superbuy.com': (_) => true,
  'cssbuy.com': (_) => true,
  'ytaopal.com': (_) => true,
  'basetao.com': (_) => true,
  'sugargoo.com': (_) => true,
  'cnfans.com': (_) => true,
  'hoobuy.com': (_) => true,
  'hagobuy.com': (_) => true,
  'kameymall.com': (_) => true,
  'joyabuy.com': (_) => true,
  'yupoo.com': (_) => true,
};

// Pesi di qualità per domini shopping e blacklist parziale
const DOMAIN_WEIGHTS = {
  'weidian.com': 1.0,
  '1688.com': 0.95,
  'item.taobao.com': 0.9,
  'taobao.com': 0.85,
  'tmall.com': 0.8,
  'alibaba.com': 0.75,
  'yupoo.com': 0.7,
  'pandabuy.com': 0.6,
  'wegobuy.com': 0.6,
  'superbuy.com': 0.6,
  'discord.gg': 0.2,
  'linktr.ee': 0.3,
  'instagram.com': 0.3,
};

const BLACKLIST_TITLE = [
  'giveaway', 'discount event', 'free gifts', 'mod post', 'weekly thread', 'daily thread', 'bst thread', 'nsfw'
];

const canonicalShoppingId = (rawUrl = '') => {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.replace(/^www\./,'').toLowerCase();
    if (host.endsWith('weidian.com')) {
      const id = u.searchParams.get('itemID') || u.searchParams.get('itemid');
      if (id) return `weidian:${id}`;
    }
    if (host.endsWith('1688.com')) {
      const m = u.pathname.match(/\/offer\/(\d+)\.html/i);
      if (m) return `1688:${m[1]}`;
    }
    if (host.endsWith('taobao.com') || host.endsWith('item.taobao.com')) {
      const id = u.searchParams.get('id');
      if (id) return `taobao:${id}`;
    }
    return `${host}:${u.pathname}`;
  } catch {
    return rawUrl;
  }
};

// TLD ammessi per ridurre falsi positivi in URL di testo semplice
const VALID_TLDS = new Set([
  'com','net','org','cn','co','io','me','app','shop','vip','xyz','cc','top','tv','us','uk','de','fr','it','es','nl','be','pl','se','no','dk','fi','ru','jp','kr','hk','tw'
]);

// Funzione migliorata per normalizzare gli URL
const normalizeUrl = (rawUrl) => {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  let url = rawUrl.trim()
    // Rimuovi caratteri di controllo e invisibili
    .replace(/[\r\n\t]/g, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    // Decodifica entità comuni
    .replace(/&amp;/gi, '&');

  // Normalizza varianti di punteggiatura e dot obfuscati
  url = url
    .replace(/^hxxp(s?):\/\//i, 'http$1://')
    .replace(/\b(https?)\s*:\s*\/\s*\/\s*/gi, (_, sch) => sch.toLowerCase() + '://')
    .replace(/\s*\[dot\]\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\s*\(dot\)\s*/gi, '.')
    .replace(/[\uFF0E\u00B7\u2022]/g, '.')
    .replace(/([a-z0-9])\s*\.\s*([a-z0-9])/gi, '$1.$2')
    .replace(/([a-z0-9])\s*\/\s*([a-z0-9])/gi, '$1/$2');

  // Rimuovi wrapper comuni all'inizio/fine (backtick, virgolette, parentesi, simboli)
  url = url.replace(/^[`'"<\(\[\{]+/, '').replace(/[`'">\)\]\}]+$/, '');

  // Rimuovi caratteri di punteggiatura finali che spesso seguono gli URL
  url = url.replace(/[)>\]}.,;:!?…]+$/g, '');

  // Aggiungi http:// se manca il protocollo ma inizia con www
  if (/^www\./i.test(url)) {
    url = 'http://' + url;
  }

  // Aggiungi protocollo per domini validi (TLD in allowlist)
  if (!/^https?:\/\//i.test(url) && url.includes('.')) {
    const hostCandidate = url.split(/[\/\?\#]/)[0];
    const parts = hostCandidate.split('.');
    const tld = parts[parts.length - 1].split('/')[0].toLowerCase();
    if (tld.length >= 2 && /^[a-zA-Z]+$/.test(tld) && VALID_TLDS.has(tld)) {
      url = 'http://' + url;
    }
  }

  // Rimuovi parametri di tracciamento comuni mantenendo gli ID necessari (es: itemID)
  try {
    const parsed = new URL(url);
    const trackParams = [/^utm_/i, /^spm$/i, /^spider_token$/i, /^from$/i, /^ref$/i, /^referrer$/i, /^campaign$/i, /^camp$/i, /^fbclid$/i, /^gclid$/i];
    const params = parsed.searchParams;
    let modified = false;
    for (const key of Array.from(params.keys())) {
      if (trackParams.some(re => re.test(key))) {
        params.delete(key);
        modified = true;
      }
    }
    if (modified) {
      parsed.search = params.toString();
      url = parsed.toString();
    }
  } catch (_) {
    // Ignora se non parsabile
  }

  return url;
};

// Funzione migliorata per validare un URL
const isValidUrl = (url) => {
  try {
    if (!url || typeof url !== 'string' || url.length < 10) {
      return false;
    }
    
    // Verifica che l'URL sia ben formato
    const parsedUrl = new URL(url);
    
    // Verifica che l'URL abbia un dominio valido
    if (!parsedUrl.hostname || !parsedUrl.hostname.includes('.')) {
      return false;
    }
    
    // Verifica che l'URL abbia un protocollo supportato
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return false;
    }
    
    // Verifica che il dominio non sia troppo corto o troppo lungo
    const hostname = parsedUrl.hostname;
    if (hostname.length < 4 || hostname.length > 253) {
      return false;
    }
    
    // Verifica che il dominio abbia un TLD valido
    const parts = hostname.split('.');
    if (parts.length < 2) {
      return false;
    }
    
    const tld = parts[parts.length - 1].toLowerCase();
    if (tld.length < 2 || !/^[a-zA-Z]+$/.test(tld)) {
      return false;
    }
    // TLD deve essere nella allowlist per evitare domini inventati
    if (!VALID_TLDS.has(tld)) {
      return false;
    }
    
    // Verifica che non sia un indirizzo IP locale o riservato
    if (/^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname)) {
      return false;
    }
    
    // Verifica che non contenga caratteri non validi
    if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) {
      return false;
    }
    
    return true;
  } catch (e) {
    // URL non valido
    return false;
  }
};

// Sistema di logging per errori di estrazione
const extractionLogger = {
  errors: [],
  maxErrors: 100,
  
  // Registra un errore di estrazione
  logError(type, url, error) {
    // Limita il numero di errori memorizzati
    if (this.errors.length >= this.maxErrors) {
      this.errors.shift(); // Rimuovi l'errore più vecchio
    }
    
    this.errors.push({
      timestamp: new Date().toISOString(),
      type,
      url,
      error: error.message || String(error),
      stack: error.stack
    });
    
    // Log su console per debug
    console.error(`URL Extraction Error [${type}]: ${error.message || String(error)}`);
  },
  
  // Ottieni statistiche sugli errori
  getStats() {
    const typeCounts = {};
    this.errors.forEach(err => {
      typeCounts[err.type] = (typeCounts[err.type] || 0) + 1;
    });
    
    return {
      totalErrors: this.errors.length,
      byType: typeCounts,
      recentErrors: this.errors.slice(-5) // Ultimi 5 errori
    };
  },
  
  // Resetta gli errori
  reset() {
    this.errors = [];
  }
};

// Funzione ottimizzata per estrarre URL da testo con validazione rigorosa
const extractUrls = (text = '') => {
  if (!text || typeof text !== 'string') return [];
  
  const urls = new Set();
  let match;
  let extractionStats = {
    attempted: 0,
    successful: 0,
    failed: 0,
    byType: { standard: 0, markdown: 0, html: 0, text: 0 }
  };
  
  try {
    // Pre-normalizza il testo per gestire formati obfuscati e entità HTML
    const textNorm = String(text)
      .replace(/&amp;/gi, '&')
      .replace(/\s*\(dot\)\s*/gi, '.')
      .replace(/([a-zA-Z0-9])\s*\.\s*([a-zA-Z0-9])/g, '$1.$2');
    // Estrai URL standard (solo con protocollo esplicito)
    URL_REGEX.lastIndex = 0;
    while ((match = URL_REGEX.exec(textNorm)) !== null) {
      extractionStats.attempted++;
      extractionStats.byType.standard++;
      
      try {
        const url = normalizeUrl(match[0]);
        if (isValidUrl(url)) {
          urls.add(url);
          extractionStats.successful++;
        } else {
          extractionStats.failed++;
        }
      } catch (e) {
        extractionStats.failed++;
      }
    }
    
    // Estrai URL in formato markdown
    MARKDOWN_URL_REGEX.lastIndex = 0;
    while ((match = MARKDOWN_URL_REGEX.exec(textNorm)) !== null) {
      extractionStats.attempted++;
      extractionStats.byType.markdown++;
      
      try {
        const url = normalizeUrl(match[2]);
        if (isValidUrl(url)) {
          urls.add(url);
          extractionStats.successful++;
        } else {
          extractionStats.failed++;
        }
      } catch (e) {
        extractionStats.failed++;
      }
    }
    
    // Estrai URL in formato HTML
    HTML_URL_REGEX.lastIndex = 0;
    while ((match = HTML_URL_REGEX.exec(textNorm)) !== null) {
      extractionStats.attempted++;
      extractionStats.byType.html++;
      
      try {
        const url = normalizeUrl(match[1]);
        if (isValidUrl(url)) {
          urls.add(url);
          extractionStats.successful++;
        } else {
          extractionStats.failed++;
        }
      } catch (e) {
        extractionStats.failed++;
      }
    }
    
    // Estrai URL in formato testo semplice (con validazione più rigorosa)
    TEXT_URL_REGEX.lastIndex = 0;
    while ((match = TEXT_URL_REGEX.exec(textNorm)) !== null) {
      extractionStats.attempted++;
      extractionStats.byType.text++;
      
      try {
        const fullUrl = normalizeUrl(match[1].trim());
        // Validazione extra per URL di testo semplice
        if (isValidUrl(fullUrl) && fullUrl.includes('.') && fullUrl.length > 10) {
          // Verifica che non sia solo un numero o una parola generica
          const hostname = new URL(fullUrl).hostname;
          if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && hostname.split('.').length >= 2) {
            urls.add(fullUrl);
            extractionStats.successful++;
          } else {
            extractionStats.failed++;
          }
        } else {
          extractionStats.failed++;
        }
      } catch (e) {
        extractionStats.failed++;
      }
    }
  } catch (e) {
    // Errore generale nell'estrazione
    console.error('URL extraction error:', e.message);
  }
  
  // Log delle statistiche solo se ci sono stati tentativi significativi
  if (extractionStats.attempted > 0 && extractionStats.successful > 0) {
    const successRate = (extractionStats.successful / extractionStats.attempted * 100).toFixed(1);
    console.log(`URL Extraction: ${extractionStats.successful}/${extractionStats.attempted} URLs (${successRate}% success)`);
  }
  
  return Array.from(urls);
};

// Estrazione URL con contesto dal selftext
const extractUrlsWithContext = (text = '') => {
  const textNorm = String(text || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[`]+/g, '')
    .replace(/\s*\(dot\)\s*/gi, '.')
    .replace(/\s*\[dot\]\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/[\uFF0E\u00B7\u2022]/g, '.')
    .replace(/\bhxxps?:\/\//gi, (m) => m.replace(/hxxp/i, 'http'))
    .replace(/\b(https?)\s*:\s*\/\s*\/\s*/gi, (_, sch) => sch.toLowerCase() + '://')
    .replace(/([a-zA-Z0-9])\s*\.\s*([a-zA-Z0-9])/g, '$1.$2')
    .replace(/([a-zA-Z0-9])\s*\/\s*([a-zA-Z0-9])/g, '$1/$2');
  const urls = [];
  let match;
  // Usa solo regex standard/markdown/testo (evita HTML src)
  URL_REGEX.lastIndex = 0;
  while ((match = URL_REGEX.exec(textNorm)) !== null) {
    const raw = normalizeUrl(match[0]);
    if (isValidUrl(raw)) {
      const start = Math.max(0, match.index - 150);
      const end = Math.min(textNorm.length, match.index + match[0].length + 150);
      const context = textNorm.substring(start, end);
      urls.push({ url: raw, context });
    }
  }
  MARKDOWN_URL_REGEX.lastIndex = 0;
  while ((match = MARKDOWN_URL_REGEX.exec(textNorm)) !== null) {
    const raw = normalizeUrl(match[2]);
    if (isValidUrl(raw)) {
      const start = Math.max(0, match.index - 150);
      const end = Math.min(textNorm.length, match.index + match[0].length + 150);
      const context = textNorm.substring(start, end);
      urls.push({ url: raw, context });
    }
  }
  TEXT_URL_REGEX.lastIndex = 0;
  while ((match = TEXT_URL_REGEX.exec(textNorm)) !== null) {
    const raw = normalizeUrl(match[1].trim());
    if (isValidUrl(raw) && raw.includes('.') && raw.length > 10) {
      const hostname = new URL(raw).hostname;
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && hostname.split('.').length >= 2) {
        const start = Math.max(0, match.index - 150);
        const end = Math.min(textNorm.length, match.index + match[0].length + 150);
        const context = textNorm.substring(start, end);
        urls.push({ url: raw, context });
      }
    }
  }
  const seen = new Set();
  return urls.filter(u => { if (seen.has(u.url)) return false; seen.add(u.url); return true; });
};

// Verifica pertinenza del contesto rispetto alla query
const contextMatchesQuery = (context = '', q = '') => {
  const queryLower = String(q || '').toLowerCase().trim();
  if (!queryLower) return true;
  const words = queryLower.split(/\s+/).filter(w => w.length >= 3);
  if (words.length === 0) return true;
  const c = String(context || '').toLowerCase();
  return words.every(w => c.includes(w));
};
const domainFrom = (u = '') => {
  try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ''; }
};
const hasKeyword = (u = '', keywords = []) => {
  const t = u.toLowerCase();
  return keywords.filter(k => t.includes(k.toLowerCase()));
};

// Verifica se un singolo URL è un link shopping valido (con validazione dominio-specifica)
const isShoppingLink = (u = '') => {
  try {
    const host = new URL(u).hostname.replace(/^www\./,'').toLowerCase();
    for (const site of SHOPPING_SITES) {
      if (host.endsWith(site)) {
        const validator = SHOPPING_VALIDATORS[site];
        return typeof validator === 'function' ? validator(u) : true;
      }
    }
    return false;
  } catch { return false; }
};

// Function to check if URLs contain shopping links
const hasShoppingLinks = (urls) => {
  if (!urls || urls.length === 0) return false;
  return urls.some(u => isShoppingLink(u));
};

// Function to extract shopping links from URLs
const extractShoppingLinks = (urls) => {
  if (!urls || urls.length === 0) return [];
  return urls.filter(u => isShoppingLink(u));
};

// --- Smart Link Converter → Mulebuy + QC ---
const getPlatformFromLink = (raw) => {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const params = url.searchParams;
    if (host.includes('weidian.com')) {
      const id = params.get('itemID') || params.get('itemid');
      if (id) return { platform: 'weidian', id };
    }
    if (host.includes('taobao.com') || host.includes('tmall.com')) {
      const id = params.get('id');
      if (id) return { platform: 'taobao', id };
    }
    if (host.includes('1688.com')) {
      const m = url.pathname.match(/offer\/(\d+)/i);
      if (m && m[1]) return { platform: '1688', id: m[1] };
    }
    if (host.includes('mulebuy.com')) {
      const id = params.get('id');
      const type = params.get('shop_type');
      if (id) return { platform: 'mulebuy', id, type };
    }
    return null;
  } catch {
    return null;
  }
};

const makeMulebuyLink = (platform, id) => {
  if (!platform || !id) return null;
  const p = String(platform).toLowerCase();
  return `https://mulebuy.com/product/?shop_type=${encodeURIComponent(p)}&id=${encodeURIComponent(id)}&ref=200647145`;
};

// QC links rimossi su richiesta: manteniamo solo Mulebuy

// Dato un URL, restituisce oggetto con link convertiti
const convertLink = (raw) => {
  const info = getPlatformFromLink(raw);
  if (!info || !info.id) return { source_url: raw };
  let mulebuy_link = null;
  if (info.platform === 'mulebuy') {
    mulebuy_link = raw;
  } else {
    mulebuy_link = makeMulebuyLink(info.platform, info.id);
  }
  return { source_url: raw, platform: info.platform, id: info.id, mulebuy_link };
};

// Reddit search endpoint con ranking e quality filter
app.get('/api/search', async (req, res) => {
  const startTime = performance.now();
  const q = (req.query.q || '').toString().trim();
  if (!q) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  // Verifica cache
  const cacheKey = `search_${q}_${req.query.subreddits || ''}_${req.query.sort || ''}_${req.query.limit || ''}_${req.query.type || ''}`;
  const cachedResults = requestCache.get(cacheKey);
  if (cachedResults) {
    console.log(`Cache hit for query: ${q}`);
    return res.json(cachedResults);
  }

  // Subreddit: usa override da query se fornito, altrimenti default
  const subreddits = (req.query.subreddits ? String(req.query.subreddits).split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_SUBS);
  const sort = (req.query.sort || 'relevance').toString(); // relevance | top | new | comments
  const t = (req.query.t || 'all').toString(); // hour | day | week | month | year | all
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 100);
  const contentType = (req.query.type || 'all').toString(); // all | image | link | text
  const minScore = parseInt(req.query.min_score || '0', 10) || 0;
  const qThreshold = Math.min(Math.max(parseFloat(req.query.quality_threshold || '0.45'), 0), 1);

  try {
    const headers = { 'User-Agent': USER_AGENT };

    const fetchSub = async (sub) => {
      const searchPath = `/r/${encodeURIComponent(sub)}/search.json?q=${encodeURIComponent(q)}&restrict_sr=1&limit=${limit}&sort=${encodeURIComponent(sort)}&t=${encodeURIComponent(t)}`;
      let r = await fetchReddit(searchPath, headers);
      if (!r.ok) {
        // Fallback su listing pubblico se Reddit blocca la search
        const status = r.status;
        if (status === 403 || status === 429) {
          const altPath = `/r/${encodeURIComponent(sub)}/new.json?limit=${limit}`;
          r = await fetchReddit(altPath, headers);
          if (!r.ok) {
            // Ulteriore fallback: prova endpoint pubblico senza OAuth se disponibile
            if (useOAuth) {
              try {
                r = await fetch(`https://www.reddit.com${altPath}`, { headers });
              } catch {}
            }
          }
          if (!r.ok) {
            const err = new Error(`Reddit fallback error ${r.status} for r/${sub}`);
            err.status = r.status;
            err.subreddit = sub;
            throw err;
          }
          const j2 = await r.json();
          const children = (j2?.data?.children || []).map(c => c?.data).filter(Boolean);
          // Non filtriamo per query qui: lasciamo che ranking/quality lo facciano
          return children.map(p => ({ ...p, _sub: sub }));
        } else {
          const err = new Error(`Reddit API error ${status} for r/${sub}`);
          err.status = status;
          err.subreddit = sub;
          throw err;
        }
      }
      const j = await r.json();
      return (j?.data?.children || []).map(c => c?.data).filter(Boolean).map(p => ({ ...p, _sub: sub }));
    };

    // Esegui le chiamate a Reddit in parallelo, gestendo fallimenti parziali
    const settled = await Promise.allSettled(subreddits.map(fetchSub));
    const posts = [];
    const failed = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') posts.push(...s.value);
      else failed.push(s.reason);
    }

    // Se tutte le richieste sono fallite, prova a propagare uno status significativo
    let responseSource = 'live';
    if (posts.length === 0 && failed.length > 0) {
      const has429 = failed.some(e => (e && e.status) === 429);
      const has403 = failed.some(e => (e && e.status) === 403);
      const first = failed.find(e => e && e.status) || failed[0];
      const warning = has429
        ? 'Limite di richieste Reddit raggiunto. Riprova più tardi.'
        : (has403
          ? 'Accesso Reddit limitato per i subreddit richiesti.'
          : 'Impossibile recuperare risultati da Reddit al momento.');
      // Fallback alla cache locale, se disponibile
      const cached = [];
      for (const sub of subreddits) {
        const entry = SUB_CACHE.get(sub);
        if (entry && Array.isArray(entry.posts) && entry.posts.length > 0) {
          // Scarta cache troppo vecchia
          if (Date.now() - (entry.updatedAt || 0) < CACHE_TTL_MS) {
            cached.push(...entry.posts.map(p => ({ ...p, _sub: sub })));
          }
        }
      }
      if (cached.length > 0) {
        posts.push(...cached);
        responseSource = 'cache';
      } else {
        // Rispondi con 200 e nessun risultato per evitare errori lato frontend
        return res.json({ query: q, subreddits, sort, t, count: 0, quality_threshold: qThreshold, best_limit: Math.min(parseInt(req.query.best_limit || '12', 10) || 12, 50), results: [], best: [], warning, details: first?.message || 'No details', source: 'empty' });
      }
    }

    const isImage = (p) => {
      if (p.post_hint === 'image') return true;
      if (p.is_gallery && p.media_metadata) return true;
      const u = (p.url_overridden_by_dest || p.url || '').toLowerCase();
      return /(\.jpg|\.jpeg|\.png|\.gif|\.webp)(\?.*)?$/.test(u);
    };
    const isText = (p) => !!p.is_self;
    const isLink = (p) => !isText(p);

    const firstPreview = (p) => {
      try {
        if (p.preview?.images?.[0]?.source?.url) return p.preview.images[0].source.url.replace(/&amp;/g, '&');
        if (p.is_gallery && p.gallery_data?.items?.length && p.media_metadata) {
          const mediaId = p.gallery_data.items[0]?.media_id;
          const meta = p.media_metadata[mediaId];
          const url = meta?.s?.u || meta?.p?.[0]?.u;
          if (url) return url.replace(/&amp;/g, '&');
        }
        const u = (p.url_overridden_by_dest || p.url || '');
        if (/(\.jpg|\.jpeg|\.png|\.gif|\.webp)(\?.*)?$/.test(u)) return u;
        if (p.thumbnail && p.thumbnail.startsWith('http')) return p.thumbnail;
      } catch {}
      return null;
    };

    // Heuristica di qualità migliorata: boost keyword positive, penalizza negative, considera engagement e recency
    const POS = ['qc','review','guide','best','koala','batch','gx','ts','help','legit','comparison','w2c','find','quality','authentic','real','good','recommend','trusted','seller','store','link','buy'];
    const NEG = ['scam','avoid','low quality','broken','ban','nsfw','offtopic','issue','problem','fake','bad','terrible','worst','shit','garbage','trash'];
    const BRAND_KEYWORDS = ['nike','adidas','jordan','yeezy','supreme','off-white','balenciaga','gucci','louis vuitton','dior','prada','versace','stone island','moncler','canada goose'];
    
    const now = Math.floor(Date.now() / 1000);
    const ageHours = (r) => Math.max(1, (now - (r.created_utc || now)) / 3600);
    
    // Funzione per pulire e filtrare il contenuto dei post
    const cleanPostContent = (selftext) => {
      if (!selftext) return '';
      
      // Rimuovi contenuti ridondanti e non rilevanti
      let cleaned = selftext
        // Rimuovi link già estratti separatamente
        .replace(/https?:\/\/[^\s]+/gi, '')
        // Rimuovi menzioni utente eccessive
        .replace(/u\/\w+/gi, '')
        // Rimuovi subreddit mentions ridondanti
        .replace(/r\/\w+/gi, '')
        // Rimuovi emoji e caratteri speciali eccessivi
        .replace(/[🔥💯👌🙏❤️😍🤩⭐️✨💪🎯🚀💎]/g, '')
        // Rimuovi testo ripetitivo comune
        .replace(/\b(upvote|karma|thanks|please|help|guys|bro|fam)\b/gi, '')
        // Rimuovi frasi di cortesia ridondanti
        .replace(/\b(any help would be appreciated|thanks in advance|please help|much appreciated)\b/gi, '')
        // Rimuovi spazi multipli
        .replace(/\s+/g, ' ')
        .trim();
      
      // Se il contenuto è troppo corto o generico, rimuovilo
      if (cleaned.length < 20 || 
          /^(help|please|thanks|wow|nice|good|bad|ok|yes|no)$/i.test(cleaned)) {
        return '';
      }
      
      // Mantieni solo i primi 200 caratteri se troppo lungo
      return cleaned.length > 200 ? cleaned.substring(0, 200) + '...' : cleaned;
    };

    // Funzione migliorata per il punteggio del testo con AI
    const textScore = (title, selftext='', query='') => {
      // Pulisci il contenuto prima dell'analisi
      const cleanedSelftext = cleanPostContent(selftext);
      const t = `${title || ''} ${cleanedSelftext}`.toLowerCase();
      const queryLower = query.toLowerCase();
      
      // Punteggio base per parole chiave positive/negative
      const pos = POS.reduce((a,k)=> a + (t.includes(k) ? 1 : 0), 0);
      const neg = NEG.reduce((a,k)=> a + (t.includes(k) ? 1 : 0), 0);
      
      // Bonus per corrispondenza esatta della query nel titolo
      const titleMatch = (title || '').toLowerCase().includes(queryLower) ? 2 : 0;
      
      // Bonus per brand famosi
      const brandBonus = BRAND_KEYWORDS.reduce((a,brand)=> a + (t.includes(brand) ? 0.5 : 0), 0);
      
      // Bonus per lunghezza del contenuto pulito (post più dettagliati)
      const lengthBonus = Math.min(1, cleanedSelftext.length / 150);
      
      // Calcolo semplificato di similarità semantica
      let semanticBonus = 0;
      const words = queryLower.split(/\s+/).filter(w => w.length > 2);
      if (words.length > 0) {
        const matches = words.filter(w => t.includes(w));
        semanticBonus = matches.length / words.length * 1.5;
      }
      
      return Math.max(0, pos + titleMatch + brandBonus + lengthBonus + semanticBonus - 0.8*neg);
    };

    let results = posts.map((p) => ({
      id: p.id,
      title: p.title,
      subreddit: p._sub || p.subreddit,
      url: `https://www.reddit.com${p.permalink}`,
      score: p.score,
      num_comments: p.num_comments,
      created_utc: p.created_utc,
      author: p.author,
      content_url: p.url_overridden_by_dest || p.url,
      image_preview: firstPreview(p),
      is_image: isImage(p),
      is_text: isText(p),
      is_link: isLink(p),
      _selftext: p.selftext || ''
    }));

    // Utility: verifica se il contesto contiene la query (parole di almeno 3 lettere)
    const contextMatchesQuery = (context = '', q = '') => {
      const queryLower = String(q || '').toLowerCase().trim();
      if (!queryLower) return true; // se non c'è query, non filtra
      const words = queryLower.split(/\s+/).filter(w => w.length >= 3);
      if (words.length === 0) return true;
      const c = String(context || '').toLowerCase();
      return words.every(w => c.includes(w));
    };

    // Estrazione con contesto dal selftext
    const extractUrlsWithContext = (text = '') => {
      const textNorm = String(text || '')
        .replace(/&amp;/gi, '&')
        .replace(/\s*\(dot\)\s*/gi, '.')
        .replace(/([a-zA-Z0-9])\s*\.\s*([a-zA-Z0-9])/g, '$1.$2');
      const urls = [];
      let match;
      // Usa solo regex standard/markdown/testo (evita HTML src)
      URL_REGEX.lastIndex = 0;
      while ((match = URL_REGEX.exec(textNorm)) !== null) {
        const raw = normalizeUrl(match[0]);
        if (isValidUrl(raw)) {
          const start = Math.max(0, match.index - 150);
          const end = Math.min(textNorm.length, match.index + match[0].length + 150);
          const context = textNorm.substring(start, end);
          urls.push({ url: raw, context });
        }
      }
      MARKDOWN_URL_REGEX.lastIndex = 0;
      while ((match = MARKDOWN_URL_REGEX.exec(textNorm)) !== null) {
        const raw = normalizeUrl(match[2]);
        if (isValidUrl(raw)) {
          const start = Math.max(0, match.index - 150);
          const end = Math.min(textNorm.length, match.index + match[0].length + 150);
          const context = textNorm.substring(start, end);
          urls.push({ url: raw, context });
        }
      }
      TEXT_URL_REGEX.lastIndex = 0;
      while ((match = TEXT_URL_REGEX.exec(textNorm)) !== null) {
        const raw = normalizeUrl(match[1].trim());
        if (isValidUrl(raw) && raw.includes('.') && raw.length > 10) {
          const hostname = new URL(raw).hostname;
          if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && hostname.split('.').length >= 2) {
            const start = Math.max(0, match.index - 150);
            const end = Math.min(textNorm.length, match.index + match[0].length + 150);
            const context = textNorm.substring(start, end);
            urls.push({ url: raw, context });
          }
        }
      }
      // Deduplica per URL
      const seen = new Set();
      return urls.filter(u => { if (seen.has(u.url)) return false; seen.add(u.url); return true; });
    };

    // Function to check if post contains shopping links only in selftext (descrizione) e rilevanti alla query
    const hasShoppingLinksInContent = (post, query) => {
      const selftext = post._selftext || '';
      const pairs = extractUrlsWithContext(selftext);
      const urls = pairs.map(p => p.url);
      const shoppingUrls = extractShoppingLinks(urls);
      // Applica filtro di pertinenza alla query basato sul contesto
      const relevantShopping = pairs.filter(p => shoppingUrls.includes(p.url) && contextMatchesQuery(p.context, query));

      post.extracted_links = urls;
      post.shopping_links = relevantShopping.map(p => p.url);

      return relevantShopping.length > 0;
    };

    // Apply base filters
    results = results.filter(r => r.score >= minScore);

    // Filtro spam nel titolo
    results = results.filter(r => {
      const t = (r.title || '').toLowerCase();
      return !BLACKLIST_TITLE.some(b => t.includes(b));
    });

    // Mantieni solo i post che hanno link shopping nel contenuto (titolo/selftext o URL del post)
    results.forEach(r => {
      const hasShop = hasShoppingLinksInContent(r, q);
      r.has_shopping = Boolean(hasShop);
    });
    results = results.filter(r => r.has_shopping);
    
    if (contentType === 'image') results = results.filter(r => r.is_image);
    else if (contentType === 'text') results = results.filter(r => r.is_text);
    else if (contentType === 'link') results = results.filter(r => r.is_link);

    // Ranking e qualità migliorati con AI locale
    results = results.map((r) => {
      const scoreNorm = Math.log10(1 + (r.score || 0));
      const commentsNorm = Math.log10(1 + (r.num_comments || 0));
      const recency = 1 / Math.log10(2 + ageHours(r));
      const imageBonus = r.is_image ? 0.3 : 0;
      
      // Calcolo del punteggio di rilevanza con AI locale e ML
      const baseKwScore = textScore(r.title, r._selftext, q);
      const kw = mlSystem.calculateEnhancedRelevance(r, q, baseKwScore);
      
      // Bonus per post con molti link nel contenuto (testo/titolo)
      const linksAll = extractUrls(`${r.title} ${r._selftext}`);
      const linkCount = linksAll.length;
      const linkBonus = Math.min(0.4, linkCount * 0.08);
      // Pesi dominio per i link shopping
      const domainWeights = (r.shopping_links || []).map(u => {
        try { const host = new URL(u).hostname.replace(/^www\./,'').toLowerCase(); return DOMAIN_WEIGHTS[host] || 0.5; } catch { return 0.5; }
      });
      const shopWeight = domainWeights.length ? (domainWeights.reduce((a,b)=>a+b,0) / domainWeights.length) : 0;
      const domainBonus = Math.min(0.6, shopWeight);
      // Bonus specifico se abbiamo rilevato veri link shopping (es. Weidian, Taobao, 1688)
      const shoppingBonus = Math.min(0.6, (r.shopping_links?.length || 0) * 0.15 + (r.has_shopping ? 0.15 : 0));
      
      // Penalità per post troppo vecchi (oltre 6 mesi)
      const agePenalty = ageHours(r) > (6 * 30 * 24) ? -0.2 : 0;
      
      // Calcolo similarità semantica avanzata con comprensione del linguaggio
      const t = `${r.title || ''} ${r._selftext || ''}`.toLowerCase();
      
      // Preprocessing avanzato per gestire linguaggio colloquiale e tecnico
      const normalizeText = (text) => {
        // Rimuovi caratteri speciali e normalizza spazi
        let normalized = text.replace(/[^\w\s]/gi, ' ').replace(/\s+/g, ' ').trim();
        
        // Espandi abbreviazioni comuni
        const abbreviations = {
          'w2c': 'where to cop',
          'qc': 'quality check',
          'lc': 'legit check',
          'gl': 'green light',
          'rl': 'red light',
          'wtb': 'want to buy',
          'wts': 'want to sell',
          'wtc': 'where to cop',
          'fs': 'for sale'
        };
        
        Object.entries(abbreviations).forEach(([abbr, full]) => {
          const regex = new RegExp(`\\b${abbr}\\b`, 'gi');
          normalized = normalized.replace(regex, full);
        });
        
        return normalized;
      };
      
      const normalizedQuery = normalizeText(q);
      const normalizedText = normalizeText(t);
      
      // Estrazione di parole chiave con pesi semantici
      const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 2);
      const textWords = normalizedText.split(/\s+/).filter(w => w.length > 2);
      
      // Gestione del contesto e sinonimi per evitare fraintendimenti
      const synonymGroups = [
        ['quality', 'qc', 'check', 'legit', 'authentic', 'real'],
        ['buy', 'cop', 'purchase', 'order'],
        ['sell', 'sale', 'selling', 'sold'],
        ['price', 'cost', 'cheap', 'expensive'],
        ['shipping', 'delivery', 'shipped'],
        ['size', 'sizing', 'fit', 'tts', 'measurement']
      ];
      
      // Funzione per trovare sinonimi
      const findSynonyms = (word) => {
        for (const group of synonymGroups) {
          if (group.some(g => word.includes(g) || g.includes(word))) {
            return group;
          }
        }
        return [word];
      };
      
      let aiSimilarity = 0.5; // valore predefinito
      
      if (queryWords.length > 0 && textWords.length > 0) {
        // Calcolo similarità con comprensione semantica avanzata
        let semanticMatches = 0;
        let exactMatches = 0;
        let partialMatches = 0;
        
        // Analisi semantica avanzata
        for (const qWord of queryWords) {
          const synonyms = findSynonyms(qWord);
          
          // Verifica corrispondenze esatte
          if (textWords.some(tw => synonyms.includes(tw) || tw === qWord)) {
            exactMatches++;
          }
          // Verifica corrispondenze parziali
          else if (textWords.some(tw => 
            synonyms.some(s => tw.includes(s) || s.includes(tw)) || 
            tw.includes(qWord) || qWord.includes(tw)
          )) {
            partialMatches++;
          }
          
          // Verifica corrispondenze semantiche
          if (textWords.some(tw => 
            synonyms.some(s => tw.includes(s) || s.includes(tw))
          )) {
            semanticMatches++;
          }
        }
        
        // Calcolo punteggi avanzati
        const exactScore = exactMatches / queryWords.length;
        const partialScore = partialMatches / queryWords.length;
        const semanticScore = semanticMatches / queryWords.length;
        
        // Bonus per posizione (titolo e inizio testo)
        const titleWords = normalizeText(r.title || '').split(/\s+/).filter(w => w.length > 2);
        const positionBonus = titleWords.some(w => 
          queryWords.some(qw => w.includes(qw) || qw.includes(w))
        ) ? 0.25 : 0;
        
        // Bonus per contenuto dettagliato
        const contentLengthBonus = Math.min(0.2, textWords.length / 200);
        
        // Calcolo similarità finale con pesi ottimizzati
        aiSimilarity = Math.min(1, Math.max(0.2, 
          exactScore * 0.4 + 
          partialScore * 0.2 + 
          semanticScore * 0.3 + 
          positionBonus + 
          contentLengthBonus
        ));
      }
      
      // Enhanced ranking with AI component
      const rank = (0.25 * scoreNorm) + (0.18 * commentsNorm) + (0.25 * recency) + 
                   imageBonus + (0.45 * kw) + linkBonus + shoppingBonus + domainBonus + agePenalty;
      
      // Qualità normalizzata 0..1 con fattori migliorati incluso AI
      const quality = Math.max(0, Math.min(1, 
        0.18*scoreNorm + 
        0.14*commentsNorm + 
        0.18*recency + 
        0.28*(kw>0?1:0) + 
        0.08*linkBonus + 
        0.12*shoppingBonus + 
        0.12*domainBonus +
        0.08*(r.is_image?1:0) +
        0.06*aiSimilarity
      ));
      
      // Pulisci il contenuto del post prima di restituirlo
      const cleanedSelftext = cleanPostContent(r.selftext);
      
      // Assicuriamoci che i link estratti siano inclusi nei risultati
      return { 
        ...r, 
        selftext: cleanedSelftext, // Sostituisci con contenuto pulito
        rank_score: Number(rank.toFixed(4)), 
        quality_score: Number(quality.toFixed(4)),
        ai_similarity: Number(aiSimilarity.toFixed(4)),
        extracted_links: r.extracted_links || [],
        shopping_links: r.shopping_links || []
      };
    });

    // Filtro qualità intelligente (più permissivo quando si usa cache)
    const effectiveThreshold = responseSource === 'cache' ? Math.max(0.3, qThreshold - 0.1) : qThreshold;
    results = results.filter(r => (r.quality_score || 0) >= effectiveThreshold);

    // Sort locale opzionale
    if (sort === 'top') results.sort((a, b) => (b.score || 0) - (a.score || 0));
    else if (sort === 'new') results.sort((a, b) => (b.created_utc || 0) - (a.created_utc || 0));
    else if (sort === 'comments') results.sort((a, b) => (b.num_comments || 0) - (a.num_comments || 0));

    // Deduplica risultati per ID link shopping canonico
    const seenKeys = new Set();
    results = results.filter(r => {
      const first = (r.shopping_links || [])[0] || '';
      const key = canonicalShoppingId(first);
      if (!key) return true;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    const bestLimit = Math.min(parseInt(req.query.best_limit || '12', 10) || 12, 50);
    const best = [...results].sort((a, b) => (b.rank_score || 0) - (a.rank_score || 0)).slice(0, bestLimit);

    // Conversione Mulebuy+QC (non bloccante): stampa in console per test
    try {
      setTimeout(() => {
        results.forEach((r) => {
          const uniq = [...new Set((r.shopping_links || []).map(u => u))];
          if (uniq.length === 0) return;
          const convs = uniq.map(convertLink);
          convs.forEach(c => {
            if (c.platform && c.id) {
              console.log(`[Converter] (search) ${c.platform}:${c.id}\n  source: ${c.source_url}\n  mulebuy: ${c.mulebuy_link}`);
            }
          });
        });
      }, 0);
    } catch {}

    res.json({
      query: q,
      subreddits,
      sort,
      t,
      count: results.length,
      quality_threshold: qThreshold,
      best_limit: bestLimit,
      results,
      best,
      source: responseSource
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch from Reddit', details: err.message });
  }
});

// Endpoint per registrare interazioni utente (per ML)
app.post('/api/interaction', express.json(), (req, res) => {
  try {
    const { sessionId, query, resultId, action, metadata } = req.body;
    
    if (!sessionId || !query || !resultId || !action) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    mlSystem.recordInteraction(sessionId, query, resultId, action, metadata);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record interaction', details: err.message });
  }
});

// Endpoint per feedback sulla qualità (per ML)
app.post('/api/feedback', express.json(), (req, res) => {
  try {
    const { type, identifier, rating } = req.body;
    
    if (!type || !identifier || rating === undefined) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (rating < 0 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 0 and 5' });
    }
    
    mlSystem.recordQualityFeedback(type, identifier, rating);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to record feedback', details: err.message });
  }
});

// Endpoint per statistiche ML
app.get('/api/ml-stats', (req, res) => {
  try {
    const stats = mlSystem.getMLStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get ML stats', details: err.message });
  }
});

// Endpoint dedicato per i migliori risultati
app.get('/api/best', async (req, res) => {
  req.query.best_limit = req.query.best_limit || '12';
  req.query.quality_threshold = req.query.quality_threshold || '0.45';
  const q = (req.query.q || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  try {
    const url = new URL(`http://localhost:${PORT}/api/search`);
    Object.entries(req.query).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const r = await fetch(url.href);
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json(j);
    return res.json({ 
      query: j.query, 
      subreddits: j.subreddits, 
      best_limit: j.best_limit, 
      quality_threshold: j.quality_threshold, 
      best: j.best,
      warning: j.warning || null,
      source: j.source || 'live'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute best', details: err.message });
  }
});

// Estrazione link da un post Reddit (solo descrizione/selftext) - Endpoint migliorato
app.get('/api/extract', async (req, res) => {
  const permalink = (req.query.permalink || '').toString();
  const id = (req.query.id || '').toString();
  const url = (req.query.url || '').toString(); // Aggiunto supporto per parametro 'url'
  const qparam = (req.query.q || '').toString().trim(); // Query opzionale per pertinenza
  
  // Accetta permalink, id, o url
  if (!permalink && !id && !url) {
    return res.status(400).json({ 
      error: 'Missing required parameter: permalink, id, or url',
      usage: 'Use ?permalink=... or ?id=... or ?url=...'
    });
  }
  
  try {
    const headers = { 'User-Agent': USER_AGENT };
    let redditPath;
    
    if (permalink) {
      const perma = permalink.replace(/^https?:\/\/www\.reddit\.com/i, '').replace(/\/$/, '');
      redditPath = perma.endsWith('.json') ? perma : `${perma}.json`;
    } else if (id) {
      redditPath = `/comments/${encodeURIComponent(id)}.json`;
    } else if (url) {
      if (url.includes('reddit.com')) {
        const perma = url.replace(/^https?:\/\/www\.reddit\.com/i, '').replace(/\/$/, '');
        redditPath = perma.endsWith('.json') ? perma : `${perma}.json`;
      } else {
        return res.status(400).json({ 
          error: 'URL must be a Reddit post URL',
          provided: url
        });
      }
    }

    let r = await fetchReddit(redditPath, headers);
    if (!r.ok && useOAuth) {
      try { r = await fetch(`https://www.reddit.com${redditPath}`, { headers }); } catch {}
    }
    if (!r.ok) {
      if (r.status === 404) {
        return res.status(404).json({ error: 'Reddit post not found or removed' });
      } else if (r.status === 429) {
        return res.status(429).json({ error: 'Rate limited by Reddit API' });
      } else {
        // Fallback alla cache: prova a costruire un risultato minimo dal SUB_CACHE
        let cachedPost = null;
        const postId = (id || '') || (permalink.match(/\/comments\/([a-z0-9]+)/i)?.[1] || url.match(/\/comments\/([a-z0-9]+)/i)?.[1] || '');
        if (postId) {
          for (const [sub, entry] of SUB_CACHE.entries()) {
            const found = (entry.posts || []).find(p => p.id === postId);
            if (found) { cachedPost = { post: found, comments: [] }; break; }
          }
        }
        if (cachedPost) {
          const post = cachedPost.post;
          const comments = [];
          // Prosegui con estrazione link da post (senza commenti)
          const KEYWORDS = [
            'weidian','weidian.com','weidian.shop','taobao','tmall','1688','alibaba',
            'dhgate','aliexpress','pandabuy','wegobuy','superbuy','cssbuy','ytaopal'
          ];
          const links = [];
          // Solo link presenti nella descrizione del post (selftext)
          const postLinks = new Set([
            ...(extractUrls(post.selftext || ''))
          ]);
          [...postLinks].forEach(u => {
            if (u && u.length > 10) {
              links.push({ url: u, source: 'post', author: post.author, score: post.score || 0, keywords: hasKeyword(u, KEYWORDS), domain: domainFrom(u), title: post.title || '', created: post.created_utc || 0 });
            }
          });
          const seen = new Set();
          const organized = links.filter(l => { if (!l.url || seen.has(l.url)) return false; seen.add(l.url); return true; })
            .filter(l => isValidUrl(l.url))
            .sort((a,b) => (b.keywords.length - a.keywords.length) || (b.score - a.score));
          const stats = {
            totalLinks: organized.length,
            fromPost: organized.filter(l => l.source === 'post').length,
            fromComments: 0,
            withKeywords: organized.filter(l => l.keywords.length > 0).length,
            domains: [...new Set(organized.map(l => l.domain))].length
          };
          return res.json({ links: organized, stats, post: { title: post?.title || '', author: post?.author || '', score: post?.score || 0, created: post?.created_utc || 0, subreddit: post?._sub || post?.subreddit || '' }, source: 'cache' });
        }
        throw new Error(`Reddit JSON error ${r.status}`);
      }
    }
    
    const data = await r.json();

    const post = data?.[0]?.data?.children?.[0]?.data;
    const comments = (data?.[1]?.data?.children || []).map(c => c?.data).filter(Boolean);

    // Keywords espansi per migliore rilevamento
    const KEYWORDS = [
      'weidan', 'weidian', 'weidan.com', 'weidian.com', 'weidian.shop',
      'taobao', 'tmall', '1688', 'alibaba', 'dhgate', 'aliexpress',
      'pandabuy', 'wegobuy', 'superbuy', 'cssbuy', 'ytaopal'
    ];

    const links = [];
    
    // Dal corpo del post con validazione migliorata
    if (post) {
      // Fallback: se selftext è vuoto, prova a decodificare selftext_html in testo
      const htmlToText = (html = '') => String(html || '')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/<br\s*\/>/gi, '\n')
        .replace(/<br\s*>/gi, '\n')
        .replace(/<[^>]+>/g, '');
      const bodyText = (post.selftext && post.selftext.trim().length > 0)
        ? post.selftext
        : htmlToText(post.selftext_html || '');

      // Estrai solo dal testo della descrizione e cattura contesto
      let pairs = extractUrlsWithContext(bodyText || '')
        .filter(p => SHOPPING_SITES.some(site => String(p.url).toLowerCase().includes(site)));
      // Se è fornita una query, mantieni solo i link con contesto pertinente
      if (qparam) {
        pairs = pairs.filter(p => contextMatchesQuery(p.context, qparam));
      }

      for (const p of pairs) {
        if (p.url && p.url.length > 10) {
          links.push({
            url: p.url,
            source: 'post',
            author: post.author,
            score: post.score || 0,
            keywords: hasKeyword(p.url, KEYWORDS),
            domain: domainFrom(p.url),
            title: post.title || '',
            created: post.created_utc || 0,
            context: p.context
          });
        }
      }
    }

    // Escludi completamente i commenti: cerchiamo link solo nella descrizione del post

    // Normalizza, rimuovi duplicati e ordina con algoritmo migliorato
    const canonical = (raw) => {
      try {
        const u = new URL(raw);
        const params = new URLSearchParams(u.search);
        ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','spm','src'].forEach(k => params.delete(k));
        u.search = params.toString() ? `?${params.toString()}` : '';
        return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
      } catch { return raw; }
    };

    const seen = new Set();
    const organized = links
      .map(l => ({ ...l, url: canonical(l.url) }))
      .filter(l => {
        if (!l.url || seen.has(l.url)) return false;
        seen.add(l.url);
        return true;
      })
      // Solo link shopping nei risultati finali
      .filter(l => SHOPPING_SITES.some(site => String(l.url).toLowerCase().includes(site)))
      .sort((a, b) => {
        // Priorità: 1) Keywords match, 2) Score, 3) Source (post > comment)
        const aKeywords = a.keywords.length;
        const bKeywords = b.keywords.length;
        
        if (aKeywords !== bKeywords) return bKeywords - aKeywords;
        if (a.score !== b.score) return b.score - a.score;
        if (a.source !== b.source) return a.source === 'post' ? -1 : 1;
        
        return 0;
      });

    // Statistiche per debugging
    const stats = {
      totalLinks: organized.length,
      fromPost: organized.filter(l => l.source === 'post').length,
      fromComments: organized.filter(l => l.source === 'comment').length,
      withKeywords: organized.filter(l => l.keywords.length > 0).length,
      domains: [...new Set(organized.map(l => l.domain))].length
    };

    // Avvia conversione Mulebuy+QC per il prodotto estratto (test: log in console)
    let converted = [];
    try {
      const uniqExtract = [...new Set(organized.map(l => canonical(l.url)))];
      converted = uniqExtract.map(convertLink);
      setTimeout(() => {
        converted.forEach(c => {
          if (c.platform && c.id) {
            console.log(`[Converter] (extract) ${c.platform}:${c.id}\n  source: ${c.source_url}\n  mulebuy: ${c.mulebuy_link}`);
          }
        });
      }, 0);
    } catch {}

    res.json({
      links: organized,
      stats,
      converted_links: converted,
      post: {
        title: post?.title || '',
        author: post?.author || '',
        score: post?.score || 0,
        created: post?.created_utc || 0,
        subreddit: post?.subreddit || ''
      },
      source: 'live'
    });

  } catch (err) {
    console.error('Extract API error:', err);
    res.status(500).json({ 
      error: 'Internal server error during extraction',
      message: err.message 
    });
  }
});

// Avvio condizionale: in ambiente serverless (Netlify) esportiamo l'app invece di ascoltare
if (!IS_SERVERLESS) {
  console.log('[Startup] Starting Express listener on port', PORT);
  app.listen(PORT, () => {
    console.log(`Backend API running on http://localhost:${PORT}`);
  });
} else {
  console.log('[Startup] Serverless mode: exporting app for function runtime');
}

export default app;
// Path per manual-cards.json
const manualCardsPath = path.join(__dirname, '..', 'public', 'manual-cards.json');
const loadManualCardsFile = () => {
  try {
    const raw = fs.readFileSync(manualCardsPath, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.rules)) {
      return { rules: [] };
    }
    return data;
  } catch (e) {
    return { rules: [] };
  }
};
const saveManualCardsFile = (data) => {
  fs.writeFileSync(manualCardsPath, JSON.stringify(data, null, 2), 'utf-8');
};

// API per gestione manual-cards
app.get('/api/manual-cards', (req, res) => {
  const data = loadManualCardsFile();
  res.json(data);
});
app.post('/api/manual-cards', (req, res) => {
  try {
    const { keywords, card } = req.body || {};
    const kw = Array.isArray(keywords) ? keywords.filter(k => typeof k === 'string' && k.trim().length) : [];
    if (!card || typeof card !== 'object') {
      return res.status(400).json({ error: 'Card non valida' });
    }
    const { title, image, images, mulebuy } = card;
    if (!title || !mulebuy) {
      return res.status(400).json({ error: 'title e mulebuy sono obbligatori' });
    }
    const normalizedImages = Array.isArray(images)
      ? images.filter(x => typeof x === 'string' && x.trim().length)
      : [];
    const normalizedCard = {
      title: String(title),
      // manteniamo compatibilità: se arriva una sola immagine in "image" la salviamo;
      image: image ? String(image) : undefined,
      // se arriva un array di immagini valido, lo salviamo
      ...(normalizedImages.length > 0 ? { images: normalizedImages } : {}),
      mulebuy: Array.isArray(mulebuy) ? mulebuy : String(mulebuy)
    };
    const data = loadManualCardsFile();
    // Trova una regola con le stesse keywords (case-insensitive)
    const matchIdx = data.rules.findIndex(r => {
      const rk = Array.isArray(r.keywords) ? r.keywords.map(x => String(x).toLowerCase()) : [];
      const ck = kw.map(x => String(x).toLowerCase());
      return rk.length === ck.length && rk.every((x, i) => x === ck[i]);
    });
    if (matchIdx >= 0) {
      const rule = data.rules[matchIdx];
      rule.cards = Array.isArray(rule.cards) ? rule.cards : [];
      rule.cards.push(normalizedCard);
    } else {
      data.rules.push({ keywords: kw, cards: [normalizedCard] });
    }
    saveManualCardsFile(data);
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ error: 'Errore nel salvataggio', details: String(e && e.message || e) });
  }
});
app.delete('/api/manual-cards', (req, res) => {
  try {
    const { ruleIndex, cardIndex, deleteRule } = req.body || {};
    const data = loadManualCardsFile();
    if (!Array.isArray(data.rules)) data.rules = [];
    const rIdx = Number.isInteger(ruleIndex) ? ruleIndex : -1;
    if (rIdx < 0 || rIdx >= data.rules.length) {
      return res.status(400).json({ error: 'ruleIndex non valido' });
    }
    const rule = data.rules[rIdx];
    if (deleteRule) {
      data.rules.splice(rIdx, 1);
      saveManualCardsFile(data);
      return res.json({ ok: true, data });
    }
    const cIdx = Number.isInteger(cardIndex) ? cardIndex : -1;
    if (!Array.isArray(rule.cards)) rule.cards = [];
    if (cIdx < 0 || cIdx >= rule.cards.length) {
      return res.status(400).json({ error: 'cardIndex non valido' });
    }
    rule.cards.splice(cIdx, 1);
    // Se la regola rimane senza cards, manteniamo la regola (keywords utili) — opzionale: si potrebbe rimuovere
    saveManualCardsFile(data);
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ error: 'Errore nella cancellazione', details: String(e && e.message || e) });
  }
});

// Aggiornamento card esistente
app.put('/api/manual-cards', (req, res) => {
  try {
    const { ruleIndex, cardIndex, card } = req.body || {};
    const rIdx = Number.isInteger(ruleIndex) ? ruleIndex : -1;
    const cIdx = Number.isInteger(cardIndex) ? cardIndex : -1;
    if (rIdx < 0 || cIdx < 0) {
      return res.status(400).json({ error: 'ruleIndex o cardIndex non validi' });
    }
    const data = loadManualCardsFile();
    if (!Array.isArray(data.rules) || rIdx >= data.rules.length) {
      return res.status(400).json({ error: 'Regola non trovata' });
    }
    const rule = data.rules[rIdx];
    if (!Array.isArray(rule.cards) || cIdx >= rule.cards.length) {
      return res.status(400).json({ error: 'Card non trovata' });
    }
    if (!card || typeof card !== 'object') {
      return res.status(400).json({ error: 'Card aggiornata non valida' });
    }
    const { title, image, images, mulebuy } = card;
    const normalizedImages = Array.isArray(images)
      ? images.filter(x => typeof x === 'string' && x.trim().length)
      : [];
    const normalizedCard = {
      ...(title ? { title: String(title) } : {}),
      ...(normalizedImages.length > 0
        ? { images: normalizedImages, image: undefined }
        : (image ? { image: String(image) } : {})),
      ...(typeof mulebuy !== 'undefined' ? { mulebuy: Array.isArray(mulebuy) ? mulebuy : String(mulebuy) } : {})
    };
    // Applica aggiornamento
    rule.cards[cIdx] = { ...rule.cards[cIdx], ...normalizedCard };
    // Rimuove eventuale chiave image: undefined
    if (rule.cards[cIdx] && typeof rule.cards[cIdx] === 'object' && typeof rule.cards[cIdx].image === 'undefined') {
      delete rule.cards[cIdx].image;
    }
    saveManualCardsFile(data);
    return res.json({ ok: true, data });
  } catch (e) {
    return res.status(500).json({ error: 'Errore nell\'aggiornamento', details: String(e && e.message || e) });
  }
});