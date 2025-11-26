import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

// Utility function to format time ago
const timeAgo = (timestamp: number): string => {
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  
  if (diff < 60) return 'ora';
  if (diff < 3600) return `${Math.floor(diff / 60)}m fa`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h fa`;
  if (diff < 2592000) return `${Math.floor(diff / 86400)}g fa`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}mesi fa`;
  return `${Math.floor(diff / 31536000)}a fa`;
};

export type Post = {
  id: string;
  title: string;
  subreddit: string;
  url: string;
  score: number;
  num_comments: number;
  created_utc: number;
  author: string;
  content_url?: string;
  image_preview?: string | null;
  images?: string[];
  is_image?: boolean;
  is_text?: boolean;
  is_link?: boolean;
  rank_score?: number;
  quality_score?: number;
  extracted_links?: any[];
  shopping_links?: any[];
  is_manual?: boolean;
  selftext?: string;
};



  // Galleria immagini per il modal con frecce (solo nel popup)
  function ModalImageCarousel({ images, title, onZoom }: { images: string[]; title: string; onZoom: (src: string) => void }) {
    const [idx, setIdx] = useState(0);
    const total = images.length;
    const current = images[Math.max(0, Math.min(idx, total - 1))];
    const goPrev = (e?: React.MouseEvent | React.KeyboardEvent) => { if (e) e.stopPropagation(); setIdx((i) => (i - 1 + total) % total); };
    const goNext = (e?: React.MouseEvent | React.KeyboardEvent) => { if (e) e.stopPropagation(); setIdx((i) => (i + 1) % total); };
    return (
      <div 
        className="pm-gallery-compact"
        style={{ position:'relative' }}
        onKeyDown={(e) => { if (e.key === 'ArrowLeft') goPrev(e); if (e.key === 'ArrowRight') goNext(e); }}
        aria-label={`Galleria immagini (${idx + 1}/${total}) per ${title}`}
      >
        <img
          src={current}
          alt={`Immagine ${idx + 1} di ${total} per ${title}`}
          style={{ maxHeight: '70vh', borderRadius: 12, cursor:'zoom-in', objectFit:'contain', width:'auto', maxWidth: '98%', display:'block', margin: '0 auto' }}
          onClick={() => onZoom(current)}
        />
        {total > 1 && (
          <>
            <button type="button" className="carousel-arrow left" onClick={goPrev} aria-label="Immagine precedente" title="Immagine precedente">‹</button>
            <button type="button" className="carousel-arrow right" onClick={goNext} aria-label="Immagine successiva" title="Immagine successiva">›</button>
            <div className="carousel-indicator" aria-label={`Immagine ${idx + 1} di ${total}`}>{idx + 1}/{total}</div>
          </>
        )}
      </div>
    );
  }

export default function App() {
  const [query, setQuery] = useState('');
  const [best, setBest] = useState<Post[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [didSearch, setDidSearch] = useState(false);
  const [modalPost, setModalPost] = useState<Post | null>(null);
  const [modalConverted, setModalConverted] = useState<any[]>([]);
  const [modalExtracting, setModalExtracting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [searchProgress, setSearchProgress] = useState<string>('');
  const [retryCount, setRetryCount] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [focusedCardIndex, setFocusedCardIndex] = useState<number>(-1);
  // Manual cards rules loaded from JSON
  const [manualRules, setManualRules] = useState<any[]>([]);
  // Admin UI spostata su /admin
  
  // ML System integration
  const [sessionId] = useState(() => `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`);
  const [currentQuery, setCurrentQuery] = useState<string>('');

  const [searchSuggestions, setSearchSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('searchHistory') || '[]');
    } catch {
      return [];
    }
  });
  
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);

  // Monitor online status
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Load manual cards rules from API with fallback to public JSON
  useEffect(() => {
    const loadManual = async () => {
      try {
        let data: any = null;
        try {
          const resApi = await fetch('/api/manual-cards');
          if (resApi.ok) data = await resApi.json();
        } catch {}
        if (!data) {
          const res = await fetch('/manual-cards.json');
          if (!res.ok) return;
          data = await res.json();
        }
        if (data && Array.isArray(data.rules)) setManualRules(data.rules);
      } catch (e) {
        // ignore load error
      }
    };
    loadManual();
  }, []);

  // Risultati ordinati per rilevanza (predefinito)
  const sortedAndFilteredResults = useMemo(() => {
    const sorted = [...best].sort((a, b) => (b.rank_score || 0) - (a.rank_score || 0));
    
    return sorted.map(p => ({
      ...p,
      extracted_links_count: Array.isArray(p.extracted_links) ? p.extracted_links.length : 0,
      shopping_links_count: Array.isArray(p.shopping_links) ? p.shopping_links.length : 0,
    }));
  }, [best]);

  // Search suggestions based on common fashion terms and brands
  const fashionTerms = [
    'Jordan', 'Nike', 'Adidas', 'Yeezy', 'Supreme', 'Off-White', 'Balenciaga', 'Gucci', 'Louis Vuitton',
    'Dior', 'Travis Scott', 'Fragment', 'Stone Island', 'Moncler', 'Canada Goose', 'Palm Angels',
    'Fear of God', 'Essentials', 'Chrome Hearts', 'Amiri', 'Rhude', 'Gallery Dept', 'Human Made',
    'Bape', 'Kaws', 'Stussy', 'Carhartt', 'Dickies', 'Vans', 'Converse', 'New Balance', 'Asics',
    'sneakers', 'hoodie', 't-shirt', 'jeans', 'jacket', 'pants', 'shoes', 'bag', 'backpack', 'cap',
    'hat', 'watch', 'belt', 'wallet', 'sunglasses', 'jewelry', 'necklace', 'ring', 'bracelet'
  ];

  // Generate search suggestions
  const generateSuggestions = (input: string) => {
    if (!input.trim()) return [];
    
    const inputLower = input.toLowerCase();
    const suggestions = new Set<string>();
    
    // Add matching fashion terms
    fashionTerms.forEach(term => {
      if (term.toLowerCase().includes(inputLower)) {
        suggestions.add(term);
      }
    });
    
    // Add matching search history
    searchHistory.forEach(term => {
      if (term.toLowerCase().includes(inputLower) && term !== input) {
        suggestions.add(term);
      }
    });
    
    // Add brand + product combinations
    const brands = ['Nike', 'Adidas', 'Jordan', 'Yeezy', 'Supreme'];
    const products = ['hoodie', 'sneakers', 't-shirt', 'jacket'];
    
    brands.forEach(brand => {
      if (brand.toLowerCase().includes(inputLower)) {
        products.forEach(product => {
          suggestions.add(`${brand} ${product}`);
        });
      }
    });
    
    return Array.from(suggestions).slice(0, 8);
  };

  // Handle input change with suggestions
  const handleInputChange = (value: string) => {
    setQuery(value);
    const suggestions = generateSuggestions(value);
    setSearchSuggestions(suggestions);
    setShowSuggestions(suggestions.length > 0 && value.trim().length > 0);
  };

  // Add to search history
  const addToSearchHistory = (searchTerm: string) => {
    if (!searchTerm.trim()) return;
    
    const newHistory = [searchTerm, ...searchHistory.filter(term => term !== searchTerm)].slice(0, 10);
    setSearchHistory(newHistory);
    localStorage.setItem('searchHistory', JSON.stringify(newHistory));
  };

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Enhanced keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Modal navigation
      if (modalPost) {
        if (e.key === 'Escape') {
          closeModal();
          return;
        }
        return;
      }

      // Search results navigation
      if (best.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          const nextIndex = Math.min(focusedCardIndex + 1, best.length - 1);
          setFocusedCardIndex(nextIndex);
          cardRefs.current[nextIndex]?.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prevIndex = Math.max(focusedCardIndex - 1, -1);
          setFocusedCardIndex(prevIndex);
          if (prevIndex === -1) {
            inputRef.current?.focus();
          } else {
            cardRefs.current[prevIndex]?.focus();
          }
        } else if (e.key === 'Enter' && focusedCardIndex >= 0) {
          e.preventDefault();
          openModal(best[focusedCardIndex]);
        }
      }

      // Global shortcuts
      if (e.key === '/' && !modalPost) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [modalPost, best, focusedCardIndex]);

  // Mobile touch optimizations
  useEffect(() => {
    // Prevent zoom on double tap for mobile
    let lastTouchEnd = 0;
    const handleTouchEnd = (e: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) {
        e.preventDefault();
      }
      lastTouchEnd = now;
    };

    // Optimize touch scrolling
    const handleTouchMove = (e: TouchEvent) => {
      if (modalPost) {
        e.preventDefault();
      }
    };

    // Optimizzazioni per dispositivi mobili
    const optimizeForMobile = () => {
      // Previene il bounce su iOS
      document.body.style.overscrollBehavior = 'contain';
      
      // Migliora le performance su dispositivi meno potenti
      if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2) {
        document.documentElement.classList.add('low-performance');
      }
      
      // Rileva se è un dispositivo touch
      if ('ontouchstart' in window) {
        document.documentElement.classList.add('touch-device');
      }
    };

    document.addEventListener('touchend', handleTouchEnd, { passive: false });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    
    optimizeForMobile();

    return () => {
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchmove', handleTouchMove);
    };
  }, [modalPost]);
  
  // Lock scroll e chiusura con ESC quando la modale è aperta
  useEffect(() => {
    if (!modalPost) return;
    
    document.body.style.overflow = 'hidden';
    
    // Focus management for modal
    const focusableElements = modalRef.current?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstFocusable = focusableElements?.[0] as HTMLElement;
    const lastFocusable = focusableElements?.[focusableElements.length - 1] as HTMLElement;

    const handleTabKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        if (e.shiftKey) {
          if (document.activeElement === firstFocusable) {
            e.preventDefault();
            lastFocusable?.focus();
          }
        } else {
          if (document.activeElement === lastFocusable) {
            e.preventDefault();
            firstFocusable?.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleTabKey);
    firstFocusable?.focus();

    return () => {
      window.removeEventListener('keydown', handleTabKey);
      document.body.style.overflow = '';
    };
  }, [modalPost]);

  // ML System: Track user interactions
  const trackInteraction = async (resultId: string, action: string, metadata: any = {}) => {
    try {
      await fetch('/api/interaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          query: currentQuery,
          resultId,
          action,
          metadata
        })
      });
    } catch (error) {
      console.warn('Failed to track interaction:', error);
    }
  };


  // --- Helper: domini ammessi e scelta link migliore ---
  const doSearch = async (searchQuery: string, retryAttempt = 0) => {
    if (!searchQuery.trim()) return;
    
    setLoading(true);
    setError(null);
    setSearchProgress('Inizializzazione ricerca...');
    setRetryCount(retryAttempt);
    
    try {
      // Manual-only mode: usa manual-cards.json al posto di Reddit
      const qLower = searchQuery.toLowerCase();
      // Se le regole manuali non sono ancora caricate, caricale ora
      let rules: any[] = manualRules;
      if (!rules || rules.length === 0) {
        try {
          const resApi = await fetch('/api/manual-cards');
          if (resApi.ok) {
            const data = await resApi.json();
            if (data && Array.isArray(data.rules)) rules = data.rules;
          }
        } catch {}
        if (!rules || rules.length === 0) {
          const res = await fetch('/manual-cards.json');
          if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.rules)) rules = data.rules;
          }
        }
      }
      const matchedCards = rules
        .filter((r:any) => {
          const queries = Array.isArray(r.keywords) ? r.keywords : (Array.isArray(r.query_contains) ? r.query_contains : []);
          const keys = queries.map((t:string) => String(t).toLowerCase().trim()).filter(Boolean);
          // match robusto: include parziale o esatto su parole della query
          const qTokens = qLower.split(/\s+/).filter(Boolean);
          return keys.some((k: string) => qLower.includes(k) || qTokens.includes(k));
        })
        .flatMap((r:any) => Array.isArray(r.cards) ? r.cards : []);
      // Mostra solo card pertinenti alla query; se nessuna corrispondenza, mostra feedback chiaro
      if (matchedCards.length === 0) {
        setSearchProgress('');
        // Fake loading per UX coerente
        await new Promise(res => setTimeout(res, 500));
        setBest([]);
        setWarning(null);
        setDidSearch(true);
        setRetryCount(0);
        setLoading(false);
        return;
      }
      const chosen = matchedCards;
      setSearchProgress('Caricamento risultati manuali...');
      const now = Math.floor(Date.now()/1000);
      const manualPosts: Post[] = chosen.map((c:any) => {
        const imgs = Array.isArray(c.images) ? c.images.filter((u:string) => !!u) : (c.image ? [c.image] : []);
        return ({
        id: `manual_${now}_${Math.random().toString(36).slice(2)}`,
        title: c.title || 'Manual Card',
        subreddit: 'manual',
        url: '#manual',
        score: 0,
        num_comments: 0,
        created_utc: now,
        author: 'manual',
        image_preview: imgs[0] || null,
        images: imgs,
        is_image: imgs.length > 0,
        is_text: false,
        is_link: false,
        rank_score: 1,
        quality_score: 1,
        extracted_links: [],
        shopping_links: (Array.isArray(c.mulebuy) ? c.mulebuy : (c.mulebuy ? [c.mulebuy] : [])).map((u:string) => ({ mulebuy_link: u })),
        is_manual: true,
        selftext: ''
      })});
      // Fake loading per UX coerente
      await new Promise(res => setTimeout(res, 600));
      setBest(manualPosts);
      setWarning(null);
      setDidSearch(true);
      setSearchProgress('');
      setRetryCount(0);
      setLoading(false);
      return;

      // --- Reddit disattivato temporaneamente ---
      // setSearchProgress('Connessione al server...');
      
      // Codice di fallback rimosso: Reddit disattivato temporaneamente
    } catch (err: any) {
      console.error('Search error:', err);
      
      if (err.name === 'AbortError') {
        setError('Ricerca interrotta per timeout. Il server potrebbe essere sovraccarico.');
      } else if (err.message.includes('fetch')) {
        setError('Errore di connessione. Controlla la tua connessione internet.');
      } else {
        setError(err.message || 'Errore durante la ricerca.');
      }
      
      setSearchProgress('');
      setWarning(null);
      
      // Auto-retry logic for network errors
      if (retryAttempt < 2 && (err.name === 'AbortError' || err.message.includes('fetch'))) {
        setTimeout(() => {
          doSearch(searchQuery, retryAttempt + 1);
        }, 2000 * (retryAttempt + 1));
      }
    } finally {
      setLoading(false);
    }
  };


  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      const trimmedQuery = query.trim();
      setCurrentQuery(trimmedQuery); // Set current query for ML tracking
      addToSearchHistory(trimmedQuery);
      setShowSuggestions(false);
      doSearch(trimmedQuery);
    }
  };

  // Handle suggestion selection
  const selectSuggestion = (suggestion: string) => {
    setQuery(suggestion);
    setCurrentQuery(suggestion); // Set current query for ML tracking
    setShowSuggestions(false);
    addToSearchHistory(suggestion);
    doSearch(suggestion);
  };

  // Funzioni per modale prodotto
  const openModal = (post: Post) => {
    setModalPost(post);
    setModalError(null);
    
    // Track modal open interaction
    trackInteraction(post.id, 'modal_open', {
      subreddit: post.subreddit,
      score: post.score,
      quality_score: post.quality_score
    });
  };
  const closeModal = () => { setModalPost(null); };
  const extractLinksModal = async (post: Post) => {
    setModalExtracting(true);
    setModalError(null);
    setModalConverted([] as any);
    
    // Track link extraction interaction
    trackInteraction(post.id, 'extract_links', {
      subreddit: post.subreddit,
      score: post.score
    });
    
    try {
      // Se post manuale, usa direttamente i link forniti
      if (post.is_manual || post.subreddit === 'manual') {
        setModalConverted(Array.isArray(post.shopping_links) ? post.shopping_links : []);
        setModalExtracting(false);
        return;
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000); // Aumentato timeout a 20 secondi

      const q = (currentQuery || '').trim();
      const url = new URL(`/api/extract`, window.location.origin);
      url.searchParams.set('url', post.url);
      if (q && q.length >= 3) url.searchParams.set('q', q);
      const response = await fetch(url.toString(), {
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error(' Post non trovato o rimosso da Reddit.');
        } else if (response.status === 429) {
          throw new Error('⏱️ Troppe richieste. Attendi prima di riprovare.');
        } else if (response.status === 400) {
          throw new Error('📝 URL del post non valido o non supportato.');
        } else {
          throw new Error(`❌ Errore durante l'estrazione (${response.status}).`);
        }
      }

      const data = await response.json();
      
      // Gestisce il nuovo formato di risposta con statistiche
      if (data.links && Array.isArray(data.links)) {
        if (Array.isArray(data.converted_links)) {
          setModalConverted(data.converted_links);
        }
        
        // Log delle statistiche per debugging
        if (data.stats) {
          console.log('Extraction stats:', data.stats);
        }
      } else if (Array.isArray(data)) {
        // Compatibilità con il formato precedente
        // nessuna azione necessaria
      } else {
        throw new Error('📊 Formato dati non valido ricevuto dal server.');
      }

    } catch (err: any) {
      console.error('Extract error:', err);
      
      if (err.name === 'AbortError') {
        setModalError('Estrazione interrotta per timeout (20s).');
      } else {
        setModalError(err.message || '❌ Errore durante l\'estrazione dei link.');
      }
    } finally {
      setModalExtracting(false);
    }
  };


  return (
    <div className="app">
      <div className="container">
        <header className="hero">
          <h1 className="brand brand-strong">
            <span className="brand-accent">TiagoX</span> Finder
          </h1>
          <p className="tagline">TiagoX Ai Finds Searcher </p>
          <form className="searchbar-modern" onSubmit={onSubmit}>
            <div className="search-container">
              <input
                ref={inputRef}
                className="search-input-modern"
                value={query}
                onChange={(e) => handleInputChange(e.target.value)}
                onFocus={() => {
                  if (query.trim()) {
                    const suggestions = generateSuggestions(query);
                    setSearchSuggestions(suggestions);
                    setShowSuggestions(suggestions.length > 0);
                  }
                }}
                onBlur={() => {
                  // Delay hiding suggestions to allow clicking
                  setTimeout(() => setShowSuggestions(false), 200);
                }}
                placeholder="Cerca prodotti, modelli, brand, scarpe, borse, accessori..."
                aria-label="Cerca nei subreddit FashionReps"
                autoComplete="off"
                inputMode="search"
                enterKeyHint="search"
                style={{
                  touchAction: 'manipulation',
                  WebkitTapHighlightColor: 'transparent'
                }}
              />
              
              {showSuggestions && searchSuggestions.length > 0 && (
                <div className="search-suggestions-modern" role="listbox" aria-label="Suggerimenti di ricerca">
                  {searchSuggestions.map((suggestion, index) => (
                    <button
                      key={index}
                      type="button"
                      className="suggestion-item-modern"
                      onClick={() => selectSuggestion(suggestion)}
                      onMouseDown={(e) => e.preventDefault()} // Prevent blur
                      role="option"
                      aria-selected="false"
                    >
                      <span className="suggestion-icon-modern">▪️</span>
                      <span className="suggestion-text-modern">{suggestion}</span>
                      {searchHistory.includes(suggestion) && (
                        <span className="suggestion-badge-modern">Recente</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            
            <button className="search-btn-modern" disabled={loading || !query.trim()} style={{touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent'}}>
              {loading ? ' Cercando...' : ' Cerca'}
            </button>
          </form>
          {/* Admin UI rimossa daAlla pagina principale; usa /admin */}
          
          <div className="subnote">I prodotti vengono ricercati dall’AI su Reddit; l’AI può sbagliare, ma i prodotti che trova sono tra i migliori.</div>
          <div className="divider" aria-hidden="true" />
        </header>

        <main className="content" role="main">
          {!isOnline && (
            <div className="error-banner" style={{ backgroundColor: '#ff6b35', color: 'white' }}>
               Connessione internet non disponibile
            </div>
          )}

          {warning && (
            <div className="error-banner" style={{ backgroundColor: '#ffb703', color: '#1a1a1a' }} role="status" aria-live="polite">
              ⚠️ {warning} {best.length === 0 ? 'Stiamo tentando con risultati recenti in cache.' : 'Mostriamo risultati affidabili, anche in caso di limiti temporanei.'}
            </div>
          )}

          {error && (
            <div className="error-banner">
              {error}
              {(error.includes('connessione') || error.includes('timeout') || error.includes('NetworkError')) && (
                <button 
                  className="retry-btn"
                  onClick={() => doSearch(query)}
                  style={{ 
                    marginLeft: '12px', 
                    padding: '4px 12px', 
                    backgroundColor: 'rgba(255,255,255,0.2)', 
                    border: '1px solid rgba(255,255,255,0.3)', 
                    borderRadius: '4px', 
                    color: 'white', 
                    cursor: 'pointer',
                    fontSize: '12px'
                  }}
                >
                   Riprova
                </button>
              )}
            </div>
          )}

          {didSearch && !loading && best.length === 0 && (
            <div className="empty" role="status" aria-live="polite">Nessun risultato per la tua query. Prova con termini diversi.</div>
          )}

          {best.length > 0 && (
            <section className="section" aria-label="Risultati di ricerca">
              <div className="section-header">
                <h2 className="section-title">Migliori risultati ({best.length})</h2>
              </div>
              <div className="grid enhanced-grid" role="grid" aria-label="Griglia risultati di ricerca">
                {sortedAndFilteredResults.map((item, index) => (
                  <article 
                    key={item.id} 
                    className="card-premium"
                    role="gridcell"
                    ref={(el) => (cardRefs.current[index] = el)}
                    tabIndex={focusedCardIndex === index ? 0 : -1}
                    aria-label={`Risultato ${index + 1} di ${sortedAndFilteredResults.length}: ${item.title}`}
                    onFocus={() => setFocusedCardIndex(index)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openModal(item);
                        extractLinksModal(item);
                      }
                    }}
                    onTouchStart={(e) => {
                      // Mobile touch feedback
                      e.currentTarget.style.transform = 'scale(0.98)';
                    }}
                    onTouchEnd={(e) => {
                      // Reset touch feedback
                      e.currentTarget.style.transform = '';
                    }}
                    style={{
                      touchAction: 'manipulation',
                      WebkitTapHighlightColor: 'transparent',
                      userSelect: 'none'
                    }}
                  >
                      {/* Header con badge premium */}
                      <header className="card-premium-header">
                        <div className="card-premium-badges">
                          {!item.is_manual && (
                            <span className="badge-premium badge-subreddit" aria-label={`Subreddit: ${item.subreddit}`}>
                              <span className="badge-icon">📱</span>
                              <span className="badge-text">{item.subreddit}</span>
                            </span>
                          )}
                          {!item.is_manual && (
                            <span className="badge-premium badge-quality" aria-label={`Qualità: ${(Math.round((item.quality_score || 0)*50)/10).toFixed(1)} stelle su 5`}>
                              <span className="badge-icon">⭐</span>
                              <span className="badge-text">{(Math.round((item.quality_score || 0)*50)/10).toFixed(1)}</span>
                            </span>
                          )}
                          {item.shopping_links_count > 0 && (
                            <span className="badge-premium badge-shop" aria-label={`Link shopping trovati: ${item.shopping_links_count}`}>
                              <span className="badge-icon">🛍️</span>
                              <span className="badge-text">{item.shopping_links_count}</span>
                            </span>
                          )}
                          {item.extracted_links_count > 0 && (
                            <span className="badge-premium badge-links" aria-label={`Link estratti complessivi: ${item.extracted_links_count}`}>
                              <span className="badge-icon">🔗</span>
                              <span className="badge-text">{item.extracted_links_count}</span>
                            </span>
                          )}
                        </div>
                      </header>

                      {/* Immagine premium */}
                      <div className="card-premium-image-wrapper">
                        <button
                          className="card-premium-image-btn"
                          onClick={() => { openModal(item); extractLinksModal(item); }}
                          aria-label={`Apri dettaglio per: ${item.title}`}
                          style={{
                            touchAction: 'manipulation',
                            WebkitTapHighlightColor: 'transparent'
                          }}
                        >
                          {(() => {
                            const previewSrc = item.image_preview || (Array.isArray(item.images) && item.images.length > 0 ? item.images[0] : null);
                            if (previewSrc) {
                              return (
                                <div className="card-premium-image-container">
                                  <img
                                    src={previewSrc as string}
                                    alt={`Immagine di anteprima per ${item.title}`}
                                    loading="lazy"
                                    decoding="async"
                                    className="card-premium-image"
                                    onClick={(e) => { 
                                      e.preventDefault(); 
                                      e.stopPropagation(); 
                                      if(previewSrc) setZoom(previewSrc as string); 
                                    }}
                                    style={{cursor:'zoom-in'}}
                                    draggable="false"
                                    onDragStart={(e) => e.preventDefault()}
                                  />
                                  <div className="card-premium-image-overlay">
                                    <div className="overlay-premium-content">
                                      <span className="overlay-premium-icon">🔍</span>
                                      <span className="overlay-premium-text">Zoom</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <div className="card-premium-fallback" aria-label={`Nessuna immagine disponibile per ${item.subreddit}`}>
                                <div className="fallback-premium-icon">📱</div>
                                <div className="fallback-premium-text">{item.subreddit}</div>
                              </div>
                            );
                          })()}
                        </button>
                      </div>

                      {/* Contenuto premium */}
                      <div className="card-premium-content">
                        <div className="card-premium-title-wrapper">
                          <h3 className="card-premium-title" title={item.title}>{item.title}</h3>
                          {!item.is_manual && (
                            <div className="card-premium-stats">
                              <span className="stat-premium stat-score" aria-label={`Punteggio: ${item.score}`}>
                                <span className="stat-icon">▲</span>
                                <span className="stat-value">{item.score}</span>
                              </span>
                              <span className="stat-premium stat-comments" aria-label={`Commenti: ${item.num_comments}`}>
                                <span className="stat-icon">💬</span>
                                <span className="stat-value">{item.num_comments}</span>
                              </span>
                              <span className="stat-premium stat-time" aria-label={`Pubblicato ${timeAgo(item.created_utc)}`}>
                                <span className="stat-icon">🕒</span>
                                <span className="stat-value">{timeAgo(item.created_utc)}</span>
                              </span>
                            </div>
                          )}
                        </div>

                        {item.selftext && (
                          <div className="card-premium-preview">
                            <p className="preview-premium-text">
                              {item.selftext.substring(0, 150)}
                              {item.selftext.length > 150 && '...'}
                            </p>
                          </div>
                        )}

                        {/* Action button */}
                        <button
                          className="card-premium-action"
                          onClick={() => { openModal(item); extractLinksModal(item); }}
                          aria-label={`Visualizza dettagli completi per: ${item.title}`}
                          style={{
                            touchAction: 'manipulation',
                            WebkitTapHighlightColor: 'transparent'
                          }}
                        >
                          <span className="action-text">Scopri di più</span>
                          <span className="action-icon">→</span>
                        </button>
                      </div>
                </article>
              ))}
            </div>
            </section>
          )}

        </main>
      </div>

      {zoom && (
        <div 
          className="lightbox-enhanced" 
          role="dialog" 
          aria-modal="true"
          aria-label="Visualizzazione ingrandita immagine"
          onClick={() => setZoom(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setZoom(null);
            }
          }}
          tabIndex={0}
        >
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            <img src={zoom} alt="Immagine ingrandita" className="lightbox-image" />
            <button
              className="lightbox-close"
              onClick={() => setZoom(null)}
              aria-label="Chiudi visualizzazione ingrandita"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {loading && (
        <div 
          className="search-popup" 
          role="dialog" 
          aria-modal="true"
          aria-label="Ricerca in corso"
          aria-live="polite"
        >
          <div className="search-popup-content">
            <div className="search-spinner" aria-hidden="true"></div>
            <p className="search-message" aria-live="polite">
              {searchProgress || 'Ricerca in corso...'}
            </p>
            <p className="search-submessage" aria-live="polite">
              {retryCount > 0 ? `Tentativo ${retryCount + 1}/3` : 'Filtrando solo post con link utili (Weidian, Taobao, 1688, ecc.).'}
            </p>
            <div className="progress-bar" role="progressbar" aria-label="Progresso ricerca">
              <div className="progress-fill"></div>
            </div>
          </div>
        </div>
      )}

      {/* Modale Prodotto */}
      {modalPost && (
        <div 
          className="product-modal" 
          role="dialog" 
          aria-modal="true"
          aria-labelledby="modal-title"
          onClick={closeModal}
        >
          <div 
            className="product-modal-content" 
            onClick={(e) => e.stopPropagation()}
            ref={modalRef}
          >
            <div className="product-modal-header">
              <div className="pm-title">
                <h3 id="modal-title" title={modalPost.title}>{modalPost.title}</h3>
                {!modalPost.is_manual && (
                  <div className="pm-meta" role="group" aria-label="Metadati del post">
                    <span className="pill" aria-label={`Subreddit: ${modalPost.subreddit}`}>r/{modalPost.subreddit}</span>
                    <span className="pill" aria-label={`Punteggio: ${modalPost.score}`}>▲ {modalPost.score}</span>
                    <span className="pill" aria-label={`Qualità: ${(Math.round((modalPost.quality_score || 0)*50)/10).toFixed(1)} stelle su 5`}>
                      {(Math.round((modalPost.quality_score || 0)*50)/10).toFixed(1)}★
                    </span>
                  </div>
                )}
              </div>
              <div className="pm-actions">
                {!modalPost.is_manual && (
                  <a 
                    className="btn btn-ghost" 
                    href={modalPost.url} 
                    target="_blank" 
                    rel="noreferrer"
                    aria-label="Apri post originale su Reddit in una nuova scheda"
                  >
                    Apri su Reddit
                  </a>
                )}
                <button 
                  className="btn btn-ghost" 
                  aria-label="Chiudi finestra di dialogo" 
                  onClick={() => setModalPost(null)}
                >
                  Chiudi
                </button>
              </div>
            </div>
              <div className="product-modal-body">
              <div className="pm-gallery" style={{ position: 'relative' }}>
                {Array.isArray(modalPost.images) && modalPost.images.length > 1 ? (
                  <ModalImageCarousel images={modalPost.images} title={modalPost.title} onZoom={(src) => setZoom(src)} />
                ) : (
                  modalPost.image_preview ? (
                    <img 
                      src={modalPost.image_preview} 
                      alt={`Immagine del prodotto: ${modalPost.title}`}
                      onClick={() => setZoom(modalPost.image_preview || null)} 
                      style={{cursor:'zoom-in'}}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setZoom(modalPost.image_preview || null);
                        }
                      }}
                      tabIndex={0}
                      aria-label="Clicca per ingrandire l'immagine"
                    />
                  ) : (
                    <div 
                      className="thumb-fallback" 
                      style={{height:240, display:'flex', alignItems:'center', justifyContent:'center'}}
                      aria-label={`Nessuna immagine disponibile`}
                    >
                      Nessuna immagine
                    </div>
                  )
                )}
              </div>
              <aside className="pm-sidebar">
                <div className="pm-block">
                  <h4>Link utili</h4>
                  {(() => {
                    const fromPost = Array.isArray(modalPost.shopping_links)
                      ? modalPost.shopping_links.filter((c:any)=>!!c?.mulebuy_link).map((c:any)=>c.mulebuy_link)
                      : [];
                    const fromConverted = Array.isArray(modalConverted)
                      ? modalConverted.filter((c:any)=>!!c?.mulebuy_link).map((c:any)=>c.mulebuy_link)
                      : [];
                    const seen = new Set<string>();
                    const mulebuyAll = [...fromPost, ...fromConverted].filter((u) => { if (!u || seen.has(u)) return false; seen.add(u); return true; });

                    if (modalError) {
                      return (
                        <div 
                          className="error-banner" 
                          style={{margin: '0 0 12px 0', padding: '8px 12px', fontSize: '14px'}}
                          role="alert"
                          aria-live="polite"
                        >
                          {modalError}
                          <button 
                            className="retry-btn"
                            onClick={() => extractLinksModal(modalPost)}
                            aria-label="Riprova estrazione link"
                            style={{ marginLeft: '8px', padding: '2px 8px', backgroundColor: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: '3px', color: 'white', cursor: 'pointer', fontSize: '11px' }}
                          >
                            Riprova
                          </button>
                        </div>
                      );
                    }
                    if (modalExtracting) {
                      return (
                        <div className="empty" style={{padding:0, display: 'flex', alignItems: 'center', gap: '8px'}} role="status" aria-live="polite">
                          <div className="search-spinner" style={{width: '16px', height: '16px'}} aria-hidden="true"></div>
                          Analisi in corso…
                        </div>
                      );
                    }
                    if (mulebuyAll.length === 0) {
                      return (
                        <div className="empty" style={{padding:0}} role="status">Nessun link trovato tra le fonti supportate.</div>
                      );
                    }
                    return (
                      <div className="pm-links" aria-label="Link Mulebuy disponibili">
                        {/* CTA primaria sul primo link */}
                        <div className="link-card" style={{marginTop:6}}>
                          <div className="converted-row" style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                            <span className="pill accent" aria-label="Link Mulebuy">Mulebuy</span>
                          </div>
                          <div className="converted-actions" style={{ display:'flex', gap:8, marginTop:8 }}>
                            <button className="btn btn-primary" onClick={() => window.open(mulebuyAll[0], '_blank')} aria-label="Apri Mulebuy in una nuova pagina">Apri in un’altra pagina</button>
                            <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(mulebuyAll[0])} aria-label="Copia link Mulebuy">Copia link</button>
                          </div>
                        </div>
                        {/* Altri link, se presenti */}
                        {mulebuyAll.slice(1).map((u, idx) => (
                          <div key={idx} className="link-card" role="listitem" style={{marginTop:6}}>
                            <div className="converted-row" style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
                              <span className="pill accent" aria-label={`Link Mulebuy ${idx+2}`}>Mulebuy {idx+2}</span>
                            </div>
                            <div className="converted-actions" style={{ display:'flex', gap:8, marginTop:8 }}>
                              <button className="btn btn-ghost" onClick={() => window.open(u, '_blank')} aria-label={`Apri Mulebuy ${idx+2}`}>Apri</button>
                              <button className="btn btn-ghost" onClick={() => navigator.clipboard.writeText(u)} aria-label={`Copia Mulebuy ${idx+2}`}>Copia</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
