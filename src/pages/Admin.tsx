import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

type ManualCard = {
  title: string
  image?: string
  images?: string[]
  mulebuy: string | string[]
}

type ManualRule = {
  keywords: string[]
  cards: ManualCard[]
}

export default function Admin() {
  const [rules, setRules] = useState<ManualRule[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ r: number, c: number } | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editImagesText, setEditImagesText] = useState('')
  const [editMulebuyText, setEditMulebuyText] = useState('')

  // Form fields
  const [keywordsText, setKeywordsText] = useState('')
  const [title, setTitle] = useState('')
  const [imagesText, setImagesText] = useState('')
  const [mulebuyText, setMulebuyText] = useState('')
  const [imageOk, setImageOk] = useState<boolean>(false)

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch('/api/manual-cards')
        if (!res.ok) throw new Error('Errore caricamento manual-cards')
        const data = await res.json()
        setRules(Array.isArray(data?.rules) ? data.rules : [])
      } catch (e: any) {
        setError(e?.message || 'Errore nel caricamento')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const rulesCount = rules?.length || 0
  const cardsCount = useMemo(() => {
    return (rules || []).reduce((acc, r) => acc + (r.cards?.length || 0), 0)
  }, [rules])

  const parsedKeywords = useMemo(() => {
    return keywordsText
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }, [keywordsText])

  const parsedMulebuy = useMemo(() => {
    const items = mulebuyText
      .split(/\n|,/)
      .map(s => s.trim())
      .filter(Boolean)
    if (items.length <= 1) return items[0] || ''
    return items
  }, [mulebuyText])

  const parsedImages = useMemo(() => {
    return imagesText
      .split(/\n|,/)
      .map(s => s.trim())
      .filter(Boolean)
  }, [imagesText])

  const editParsedImages = useMemo(() => {
    return editImagesText
      .split(/\n|,/)
      .map(s => s.trim())
      .filter(Boolean)
  }, [editImagesText])

  const editParsedMulebuy = useMemo(() => {
    const items = editMulebuyText
      .split(/\n|,/)
      .map(s => s.trim())
      .filter(Boolean)
    return items
  }, [editMulebuyText])

  const canSubmit = useMemo(() => {
    const hasKeywords = parsedKeywords.length > 0
    const hasTitle = title.trim().length > 0
    const hasLinks = Array.isArray(parsedMulebuy)
      ? parsedMulebuy.length > 0
      : (parsedMulebuy as string).length > 0
    return hasKeywords && hasTitle && hasLinks
  }, [parsedKeywords, title, parsedMulebuy])

  const submit = async () => {
    setError(null)
    setSuccess(null)
    if (!canSubmit) {
      setError('Compila keywords, titolo e almeno un link Mulebuy.')
      return
    }
    try {
      setLoading(true)
      const body = {
        keywords: parsedKeywords,
        card: {
          title: title.trim(),
          ...(parsedImages.length > 1 ? { images: parsedImages } : {}),
          ...(parsedImages.length === 1 ? { image: parsedImages[0] } : {}),
          mulebuy: parsedMulebuy,
        } as ManualCard,
      }
      const res = await fetch('/api/manual-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || 'Errore salvataggio')
      }
      const saved = await res.json()
      setSuccess('Card aggiunta con successo.')
      setRules(Array.isArray(saved?.rules) ? saved.rules : rules)
      setKeywordsText('')
      setTitle('')
      setImagesText('')
      setMulebuyText('')
      setImageOk(false)
    } catch (e: any) {
      setError(e?.message || 'Errore sconosciuto')
    } finally {
      setLoading(false)
    }
  }

  const removeCard = async (ruleIndex: number, cardIndex: number) => {
    setError(null)
    setSuccess(null)
    try {
      setLoading(true)
      const res = await fetch('/api/manual-cards', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleIndex, cardIndex })
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || 'Errore cancellazione card')
      }
      const data = await res.json()
      setRules(Array.isArray(data?.data?.rules) ? data.data.rules : rules)
      setSuccess('Card rimossa.')
    } catch (e:any) {
      setError(e?.message || 'Errore cancellazione')
    } finally {
      setLoading(false)
    }
  }

  const removeRule = async (ruleIndex: number) => {
    setError(null)
    setSuccess(null)
    try {
      setLoading(true)
      const res = await fetch('/api/manual-cards', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ruleIndex, deleteRule: true })
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || 'Errore cancellazione regola')
      }
      const data = await res.json()
      setRules(Array.isArray(data?.data?.rules) ? data.data.rules : rules)
      setSuccess('Regola rimossa.')
    } catch (e:any) {
      setError(e?.message || 'Errore cancellazione regola')
    } finally {
      setLoading(false)
    }
  }

  const startEditCard = (rIdx: number, cIdx: number, card: ManualCard) => {
    setEditing({ r: rIdx, c: cIdx })
    setEditTitle(card.title || '')
    setEditImagesText(Array.isArray(card.images) ? card.images.join('\n') : (card.image || ''))
    setEditMulebuyText(Array.isArray(card.mulebuy) ? card.mulebuy.join('\n') : (card.mulebuy as string || ''))
  }

  const cancelEdit = () => {
    setEditing(null)
    setEditTitle('')
    setEditImagesText('')
    setEditMulebuyText('')
  }

  const saveEditCard = async () => {
    if (!editing) return
    setError(null)
    setSuccess(null)
    try {
      setLoading(true)
      const body: any = {
        ruleIndex: editing.r,
        cardIndex: editing.c,
        card: {
          title: editTitle.trim(),
          ...(editParsedImages.length > 1 ? { images: editParsedImages } : {}),
          ...(editParsedImages.length === 1 ? { image: editParsedImages[0] } : {}),
          mulebuy: editParsedMulebuy.length > 1 ? editParsedMulebuy : (editParsedMulebuy[0] || '')
        }
      }
      const res = await fetch('/api/manual-cards', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (!res.ok) {
        const t = await res.text()
        throw new Error(t || 'Errore aggiornamento')
      }
      const data = await res.json()
      setRules(Array.isArray(data?.data?.rules) ? data.data.rules : rules)
      setSuccess('Card aggiornata.')
      cancelEdit()
    } catch (e:any) {
      setError(e?.message || 'Errore aggiornamento')
    } finally {
      setLoading(false)
    }
  }

  const AdminCardCarousel = ({ imgs, title }: { imgs: string[], title: string }) => {
    const [idx, setIdx] = useState(0)
    const total = imgs.length
    const current = imgs[Math.max(0, Math.min(idx, total - 1))]
    const goPrev = () => setIdx((i) => (i - 1 + total) % total)
    const goNext = () => setIdx((i) => (i + 1) % total)
    return (
      <div style={{ width: '100%', height: 150, background: '#f7f7f7', display: 'flex', alignItems: 'center', justifyContent: 'center', position:'relative' }}>
        <img src={current} alt={`${title} ${idx+1}`} style={{ maxHeight: '100%', objectFit: 'contain', borderRadius: 6 }} />
        <button type="button" onClick={goPrev} title="Precedente" aria-label="Precedente" style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', background:'rgba(0,0,0,0.5)', color:'#fff', border:'none', borderRadius:'50%', width:26, height:26, cursor:'pointer' }}>‹</button>
        <button type="button" onClick={goNext} title="Successiva" aria-label="Successiva" style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'rgba(0,0,0,0.5)', color:'#fff', border:'none', borderRadius:'50%', width:26, height:26, cursor:'pointer' }}>›</button>
        <div style={{ position:'absolute', bottom:8, right:10, background:'rgba(0,0,0,0.5)', color:'#fff', borderRadius:6, fontSize:12, padding:'2px 6px' }}>{idx+1}/{total}</div>
      </div>
    )
  }

  return (
    <div className="admin-container">
      <header className="admin-header">
        <h1 className="admin-title">Admin Panel</h1>
        <Link to="/" className="admin-btn admin-btn-secondary">← Home</Link>
      </header>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '14px' }}>
          Gestione Manual Cards: inserimento rapido, preview, elenco e cancellazione.
        </p>
        <div className="admin-stats">
          📊 Regole: {rulesCount} · Card totali: {cardsCount}
        </div>
      </div>

      <section className="admin-section">
        <h3>➕ Aggiungi card manuale</h3>
        <div className="admin-form-group">
          <label className="admin-label">Keywords (separate da virgola)</label>
          <input
            className="admin-input"
            value={keywordsText}
            onChange={e => setKeywordsText(e.target.value)}
            placeholder="es. borsa, gucci"
          />
        </div>

        <div className="admin-form-group">
          <label className="admin-label">Titolo</label>
          <input
            className="admin-input"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Titolo della card"
          />
        </div>

        <div className="admin-form-group">
          <label className="admin-label">URL immagini (una per riga oppure separati da virgola)</label>
          <textarea
            className="admin-input admin-textarea"
            rows={3}
            value={imagesText}
            onChange={e => {
              setImagesText(e.target.value)
              setImageOk(false)
            }}
            placeholder={"https://...\nhttps://..."}
          />
          {parsedImages.length > 0 && (
            <div className="admin-preview-container">
              <div className="admin-preview-title">🖼️ Preview immagini</div>
              <div className="admin-preview-grid">
                {parsedImages.map((src, idx) => (
                  <img
                    key={idx}
                    src={src}
                    alt={`Preview ${idx+1}`}
                    className="admin-preview-image"
                    onLoad={() => setImageOk(true)}
                    onError={() => setImageOk(false)}
                  />
                ))}
              </div>
              {!imageOk && (
                <div className="admin-error">
                  ⚠️ Alcune immagini non sono state caricate. Controlla gli URL.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="admin-form-group">
          <label className="admin-label">Link Mulebuy (uno per riga oppure separati da virgola)</label>
          <textarea
            className="admin-input admin-textarea"
            rows={5}
            value={mulebuyText}
            onChange={e => setMulebuyText(e.target.value)}
            placeholder="https://mulebuy.com/product/?shop_type=...\nhttps://mulebuy.com/product/?shop_type=..."
          />
        </div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 24 }}>
          <button className="admin-btn admin-btn-primary" type="button" disabled={!canSubmit || loading} onClick={submit}>
            {loading ? '💾 Salvataggio...' : '➕ Aggiungi card'}
          </button>
          {error && <span className="admin-error">❌ {error}</span>}
          {success && <span className="admin-success">✅ {success}</span>}
        </div>
      </section>

      <section className="admin-section">
        <h3>📋 Elenco manual cards</h3>
        {!rules || rules.length === 0 ? (
          <div className="admin-empty-state">Nessuna regola presente.</div>
        ) : (
          <div className="admin-rules-grid">
            {rules.map((rule, rIdx) => (
              <div key={rIdx} className="admin-rule-card">
                <div className="admin-rule-header">
                  <div className="admin-keywords">
                    {(rule.keywords || []).map((k, i) => (
                      <span key={i} className="admin-keyword">{k}</span>
                    ))}
                  </div>
                  <button className="admin-btn admin-btn-danger" type="button" onClick={() => removeRule(rIdx)} title="Elimina regola">🗑️ Elimina</button>
                </div>
                <div className="admin-cards-grid">
                  {(rule.cards || []).map((c, cIdx) => (
                    <div key={cIdx} className="admin-card">
                      {Array.isArray(c.images) && c.images.length > 1 ? (
                        <AdminCardCarousel imgs={c.images} title={c.title} />
                      ) : Array.isArray(c.images) && c.images.length === 1 ? (
                        <div className="admin-card-image-container">
                          <img src={c.images[0]} alt={c.title} className="admin-card-main-image" />
                        </div>
                      ) : c.image ? (
                        <div className="admin-card-image-container">
                          <img src={c.image} alt={c.title} className="admin-card-main-image" />
                        </div>
                      ) : (
                        <div className="admin-card-no-image">
                          🖼️ Nessuna immagine
                        </div>
                      )}
                      <div className="admin-card-content">
                        <div className="admin-card-title">{editing?.r === rIdx && editing?.c === cIdx ? (
                          <input className="admin-input" value={editTitle} onChange={e=>setEditTitle(e.target.value)} placeholder="Titolo" />
                        ) : c.title}</div>
                        <div className="admin-card-links">
                          {editing?.r === rIdx && editing?.c === cIdx ? (
                            <textarea className="admin-input admin-textarea" rows={4} value={editMulebuyText} onChange={e=>setEditMulebuyText(e.target.value)} placeholder="Link Mulebuy (uno per riga)" />
                          ) : (
                            Array.isArray(c.mulebuy) ? c.mulebuy.map((u, i) => (
                              <a key={i} href={u} target="_blank" rel="noreferrer" className="admin-link">{u}</a>
                            )) : (
                              <a href={c.mulebuy} target="_blank" rel="noreferrer" className="admin-link">{c.mulebuy}</a>
                            )
                          )}
                        </div>
                        {editing?.r === rIdx && editing?.c === cIdx && (
                          <div className="admin-edit-images">
                            <div className="admin-label">Immagini (una per riga)</div>
                            <textarea className="admin-input admin-textarea" rows={3} value={editImagesText} onChange={e=>setEditImagesText(e.target.value)} placeholder="https://..." />
                            {editParsedImages.length > 0 && (
                              <div className="admin-edit-preview">
                                {editParsedImages.map((src, i) => (
                                  <img key={i} src={src} alt={`Preview ${i+1}`} className="admin-edit-image" />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        <div className="admin-card-actions">
                          <div className="admin-action-group">
                            {!editing || editing.r !== rIdx || editing.c !== cIdx ? (
                              <>
                                <button className="admin-btn admin-btn-secondary" type="button" onClick={() => startEditCard(rIdx, cIdx, c)}>✏️ Modifica</button>
                                <button className="admin-btn admin-btn-danger" type="button" onClick={() => removeCard(rIdx, cIdx)}>🗑️ Elimina</button>
                              </>
                            ) : (
                              <>
                                <button className="admin-btn admin-btn-primary" type="button" onClick={saveEditCard} disabled={loading}>💾 Salva</button>
                                <button className="admin-btn admin-btn-secondary" type="button" onClick={cancelEdit} disabled={loading}>❌ Annulla</button>
                              </>
                            )}
                          </div>
                          <div className="admin-link-group">
                            <button className="admin-btn admin-btn-secondary" type="button" onClick={() => navigator.clipboard.writeText(Array.isArray(c.mulebuy) ? c.mulebuy.join('\n') : (c.mulebuy || ''))}>📋 Copia</button>
                            {Array.isArray(c.mulebuy) ? (
                              <button className="admin-btn admin-btn-primary" type="button" onClick={() => { const first = c.mulebuy[0]; if (first) window.open(first, '_blank'); }}>🔗 Apri</button>
                            ) : (
                              <button className="admin-btn admin-btn-primary" type="button" onClick={() => { if (c.mulebuy) window.open(c.mulebuy as string, '_blank'); }}>🔗 Apri</button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}