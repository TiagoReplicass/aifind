import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import '../App.css';

type Post = {
  id: string;
  title: string;
  subreddit: string;
  url: string;
  score: number;
  author: string;
  image_preview?: string | null;
};

type ExtractedLink = {
  url: string;
  source: 'post' | 'comment';
  author?: string;
  score?: number;
  keywords?: string[];
  domain?: string;
};

type GalleryImage = { src: string; w?: number; h?: number; };


export default function ProductDetail(){
  const nav = useNavigate();
  const { id } = useParams();
  const loc = useLocation() as any;
  const post: Post | undefined = loc?.state?.post;

  const [title, setTitle] = useState(post?.title || 'Dettaglio prodotto');
  const [permalink, setPermalink] = useState(post?.url || (id ? `https://www.reddit.com/comments/${id}/` : ''));
  const [desc, setDesc] = useState<string>('');
  const [gallery, setGallery] = useState<GalleryImage[]>(post?.image_preview ? [{ src: post.image_preview }] : []);
  const [links, setLinks] = useState<ExtractedLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);

  const redditJsonUrl = useMemo(() => permalink ? (permalink.endsWith('.json') ? permalink : `${permalink.replace(/\/$/, '')}.json`) : (id ? `https://www.reddit.com/comments/${id}.json` : ''), [permalink, id]);

  useEffect(() => {
    document.title = `${post?.title || title} · TiagoX Finder`;
  }, [post?.title, title]);

  useEffect(() => {
    let cancel = false;
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        if (redditJsonUrl) {
          const r = await fetch(redditJsonUrl, { headers: { 'User-Agent': 'TiagoSearch/1.0' } });
          if (r.ok) {
            const j = await r.json();
            const p = j?.[0]?.data?.children?.[0]?.data;
            if (p) {
              if (!cancel) {
                setTitle(p.title || title);
                setPermalink(`https://www.reddit.com${p.permalink}`);
                setDesc(p.selftext || '');
                const imgs: GalleryImage[] = [];
                try {
                  if (p.preview?.images?.[0]?.source?.url) {
                    imgs.push({ src: p.preview.images[0].source.url.replace(/&amp;/g,'&') });
                    const res = p.preview.images[0].resolutions || [];
                    res.forEach((ri: any) => imgs.push({ src: ri.url.replace(/&amp;/g,'&'), w: ri.width, h: ri.height }));
                  }
                  if (p.is_gallery && p.gallery_data?.items?.length && p.media_metadata) {
                    p.gallery_data.items.forEach((it: any) => {
                      const meta = p.media_metadata[it.media_id];
                      const url = meta?.s?.u || meta?.p?.[meta?.p?.length-1]?.u;
                      if (url) imgs.push({ src: url.replace(/&amp;/g,'&') });
                    });
                  }
                } catch {}
                if (!cancel && imgs.length) setGallery(imgs);
              }
            }
          }
        }
        if (id || permalink) {
          const params = new URLSearchParams();
          if (id) params.set('id', id);
          else if (permalink) params.set('permalink', permalink);
          const er = await fetch(`/api/extract?${params.toString()}`);
          const ej = await er.json();
          if (!er.ok) throw new Error(ej?.error || 'Estrazione fallita');
          if (!cancel) {
            setLinks(ej.links || []);
          }
        }
      } catch (e: any) {
        if (!cancel) setError(e.message || 'Errore di caricamento');
      } finally {
        if (!cancel) setLoading(false);
      }
    };
    load();
    return () => { cancel = true; };
  }, [id, permalink, redditJsonUrl]);

  return (
    <div className="app">
      <div className="container">
        <header className="hero">
          <h1 className="brand brand-strong"><span className="brand-accent">Dettaglio</span> Prodotto</h1>
          <p className="tagline" title={title}>{title}</p>
          <div className="divider" aria-hidden="true" />
        </header>

        <main className="content" role="main">
          <section className="section" aria-label="Galleria fotografica">
            {gallery.length > 0 ? (
              <div className="gallery">
                <div className="gallery-track">
                  {gallery.map((g, i) => (
                    <button key={i} className="gallery-item" onClick={() => setZoom(g.src)} aria-label={`Zoom immagine ${i+1}`}>
                      <img src={g.src} alt={`Foto ${i+1}`} loading="lazy" decoding="async" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="empty">Nessuna immagine disponibile.</div>
            )}
          </section>

          <section className="section" aria-label="Dettagli e specifiche">
            <h2 className="section-title">Descrizione</h2>
            {desc ? (
              <article style={{whiteSpace:'pre-wrap', color:'#e9edf1', opacity:.95}}>{desc}</article>
            ) : (
              <div className="empty">Nessuna descrizione testuale trovata nel post.</div>
            )}

            <h2 className="section-title" style={{marginTop:24}}>Specifiche tecniche</h2>
            <div className="empty">Le specifiche non sono strutturate in Reddit; aggiungiamo qui quando disponibili.</div>
          </section>

          <section className="section" aria-label="Opzioni di acquisto">
            <h2 className="section-title">Opzioni di acquisto</h2>
            {error && <div className="error-banner">{error}</div>}
            {!error && links.length === 0 && loading && <div className="empty">Carico opzioni…</div>}
            {!error && links.length === 0 && !loading && <div className="empty">Nessun link rilevato.</div>}
            {links.length > 0 && (
              <div className="extracted">
                {links.map((l, idx) => (
                  <div key={idx} className={`xrow ${l.keywords && l.keywords.length>0 ? 'hit' : ''}`}>
                    <div className="xmeta">
                      <span className="pill">{l.domain || 'link'}</span>
                      <span className="pill muted">{l.source}</span>
                      {l.keywords && l.keywords.length>0 && <span className="pill accent">match: {l.keywords.join(', ')}</span>}
                    </div>
                    <a className="xlink" href={l.url} target="_blank" rel="noreferrer">{l.url}</a>
                    <button className="copy" onClick={() => navigator.clipboard.writeText(l.url)}>Copia</button>
                  </div>
                ))}
              </div>
            )}

            {}

            <div className="product-actions" style={{display:'flex', gap:12, marginTop:18}}>
              <button className="copy" onClick={() => nav(-1)}>Torna alla ricerca</button>
              {permalink && <a className="open-link" href={permalink} target="_blank" rel="noreferrer">Apri su Reddit</a>}
            </div>
          </section>
        </main>
      </div>

      {zoom && (
        <div className="lightbox" role="dialog" aria-modal onClick={() => setZoom(null)}>
          <img src={zoom} alt="Zoom immagine" />
        </div>
      )}

      <footer className="foot" />
    </div>
  );
}