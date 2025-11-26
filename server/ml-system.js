// Sistema di Machine Learning per migliorare i risultati nel tempo
import fs from 'fs/promises';
import path from 'path';

class MLSystem {
  constructor() {
    this.dataPath = './ml-data.json';
    this.userInteractions = new Map();
    this.queryPatterns = new Map();
    this.clickThroughRates = new Map();
    this.qualityFeedback = new Map();
    this.loadData();
  }

  // Carica i dati di apprendimento salvati
  async loadData() {
    try {
      const data = await fs.readFile(this.dataPath, 'utf8');
      const parsed = JSON.parse(data);
      
      this.userInteractions = new Map(parsed.userInteractions || []);
      this.queryPatterns = new Map(parsed.queryPatterns || []);
      this.clickThroughRates = new Map(parsed.clickThroughRates || []);
      this.qualityFeedback = new Map(parsed.qualityFeedback || []);
      
      console.log('ML data loaded successfully');
    } catch (error) {
      console.log('No existing ML data found, starting fresh');
      this.initializeDefaults();
    }
  }

  // Salva i dati di apprendimento
  async saveData() {
    try {
      const data = {
        userInteractions: Array.from(this.userInteractions.entries()),
        queryPatterns: Array.from(this.queryPatterns.entries()),
        clickThroughRates: Array.from(this.clickThroughRates.entries()),
        qualityFeedback: Array.from(this.qualityFeedback.entries()),
        lastUpdated: Date.now()
      };
      
      await fs.writeFile(this.dataPath, JSON.stringify(data, null, 2));
      console.log('ML data saved successfully');
    } catch (error) {
      console.error('Error saving ML data:', error);
    }
  }

  // Inizializza valori predefiniti basati su conoscenza del dominio
  initializeDefaults() {
    // Pattern di query comuni nel fashion/streetwear
    const defaultPatterns = [
      { query: 'jordan', boost: 1.2, keywords: ['sneakers', 'shoes', 'basketball'] },
      { query: 'yeezy', boost: 1.3, keywords: ['adidas', 'kanye', 'boost'] },
      { query: 'supreme', boost: 1.1, keywords: ['streetwear', 'box logo', 'drop'] },
      { query: 'qc', boost: 1.4, keywords: ['quality', 'check', 'review'] },
      { query: 'w2c', boost: 1.5, keywords: ['where', 'cop', 'buy', 'link'] }
    ];

    defaultPatterns.forEach(pattern => {
      this.queryPatterns.set(pattern.query, {
        boost: pattern.boost,
        keywords: pattern.keywords,
        frequency: 1,
        successRate: 0.7
      });
    });
  }

  // Registra un'interazione dell'utente
  recordInteraction(sessionId, query, resultId, action, metadata = {}) {
    const interaction = {
      timestamp: Date.now(),
      query: query.toLowerCase().trim(),
      resultId,
      action, // 'click', 'bookmark', 'extract_links', 'modal_open'
      metadata
    };

    if (!this.userInteractions.has(sessionId)) {
      this.userInteractions.set(sessionId, []);
    }
    
    this.userInteractions.get(sessionId).push(interaction);
    
    // Aggiorna i pattern di query
    this.updateQueryPatterns(query, action, metadata);
    
    // Aggiorna i click-through rates
    this.updateClickThroughRates(query, resultId, action);
    
    // Salva periodicamente (ogni 10 interazioni)
    if (this.getTotalInteractions() % 10 === 0) {
      this.saveData();
    }
  }

  // Aggiorna i pattern di query basati sulle interazioni
  updateQueryPatterns(query, action, metadata) {
    const normalizedQuery = query.toLowerCase().trim();
    const words = normalizedQuery.split(/\s+/).filter(w => w.length > 2);
    
    words.forEach(word => {
      if (!this.queryPatterns.has(word)) {
        this.queryPatterns.set(word, {
          boost: 1.0,
          keywords: [],
          frequency: 0,
          successRate: 0.5
        });
      }
      
      const pattern = this.queryPatterns.get(word);
      pattern.frequency += 1;
      
      // Aumenta il boost per azioni positive
      if (['click', 'bookmark', 'extract_links'].includes(action)) {
        pattern.successRate = Math.min(1.0, pattern.successRate + 0.05);
        pattern.boost = Math.min(2.0, pattern.boost + 0.02);
      }
      
      // Estrai keywords dal metadata
      if (metadata.subreddit) {
        if (!pattern.keywords.includes(metadata.subreddit)) {
          pattern.keywords.push(metadata.subreddit);
        }
      }
    });
  }

  // Aggiorna i click-through rates
  updateClickThroughRates(query, resultId, action) {
    const key = `${query}:${resultId}`;
    
    if (!this.clickThroughRates.has(key)) {
      this.clickThroughRates.set(key, {
        impressions: 0,
        clicks: 0,
        bookmarks: 0,
        extractions: 0
      });
    }
    
    const ctr = this.clickThroughRates.get(key);
    ctr.impressions += 1;
    
    if (action === 'click') ctr.clicks += 1;
    if (action === 'bookmark') ctr.bookmarks += 1;
    if (action === 'extract_links') ctr.extractions += 1;
  }

  // Calcola il boost per una query basato sull'apprendimento
  getQueryBoost(query) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let totalBoost = 1.0;
    let matchedWords = 0;
    
    words.forEach(word => {
      if (this.queryPatterns.has(word)) {
        const pattern = this.queryPatterns.get(word);
        totalBoost += (pattern.boost - 1.0) * pattern.successRate;
        matchedWords++;
      }
    });
    
    // Normalizza il boost
    return matchedWords > 0 ? totalBoost / matchedWords : 1.0;
  }

  // Calcola il punteggio di rilevanza migliorato con ML
  calculateEnhancedRelevance(post, query, baseScore) {
    const queryBoost = this.getQueryBoost(query);
    const ctrBoost = this.getCTRBoost(query, post.id);
    const qualityBoost = this.getQualityBoost(post);
    
    // Combina i boost con pesi ottimizzati
    const mlScore = baseScore * (
      0.4 * queryBoost +
      0.3 * ctrBoost +
      0.2 * qualityBoost +
      0.1 // baseline
    );
    
    return Math.min(10, Math.max(0, mlScore));
  }

  // Ottieni boost basato sui click-through rates
  getCTRBoost(query, resultId) {
    const key = `${query}:${resultId}`;
    
    if (!this.clickThroughRates.has(key)) {
      return 1.0; // Nessun dato, usa baseline
    }
    
    const ctr = this.clickThroughRates.get(key);
    if (ctr.impressions === 0) return 1.0;
    
    const clickRate = ctr.clicks / ctr.impressions;
    const engagementRate = (ctr.bookmarks + ctr.extractions) / ctr.impressions;
    
    // Boost basato su engagement
    return 1.0 + (clickRate * 0.5) + (engagementRate * 0.8);
  }

  // Ottieni boost basato sulla qualità storica
  getQualityBoost(post) {
    const subredditKey = `subreddit:${post.subreddit}`;
    const authorKey = `author:${post.author}`;
    
    let boost = 1.0;
    
    // Boost per subreddit di qualità
    if (this.qualityFeedback.has(subredditKey)) {
      const feedback = this.qualityFeedback.get(subredditKey);
      boost += feedback.averageRating * 0.1;
    }
    
    // Boost per autori di qualità
    if (this.qualityFeedback.has(authorKey)) {
      const feedback = this.qualityFeedback.get(authorKey);
      boost += feedback.averageRating * 0.05;
    }
    
    return Math.min(1.5, boost);
  }

  // Registra feedback sulla qualità
  recordQualityFeedback(type, identifier, rating) {
    const key = `${type}:${identifier}`;
    
    if (!this.qualityFeedback.has(key)) {
      this.qualityFeedback.set(key, {
        ratings: [],
        averageRating: 0,
        totalFeedback: 0
      });
    }
    
    const feedback = this.qualityFeedback.get(key);
    feedback.ratings.push(rating);
    feedback.totalFeedback += 1;
    
    // Mantieni solo gli ultimi 50 rating per evitare memory leak
    if (feedback.ratings.length > 50) {
      feedback.ratings = feedback.ratings.slice(-50);
    }
    
    // Calcola la media pesata (rating più recenti hanno più peso)
    const weights = feedback.ratings.map((_, i) => Math.pow(0.95, feedback.ratings.length - 1 - i));
    const weightedSum = feedback.ratings.reduce((sum, rating, i) => sum + rating * weights[i], 0);
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    
    feedback.averageRating = weightedSum / weightSum;
  }

  // Ottieni statistiche del sistema ML
  getMLStats() {
    return {
      totalInteractions: this.getTotalInteractions(),
      uniqueQueries: this.queryPatterns.size,
      trackedResults: this.clickThroughRates.size,
      qualityFeedbackItems: this.qualityFeedback.size,
      topQueries: this.getTopQueries(5),
      systemHealth: this.getSystemHealth()
    };
  }

  getTotalInteractions() {
    return Array.from(this.userInteractions.values())
      .reduce((total, interactions) => total + interactions.length, 0);
  }

  getTopQueries(limit = 10) {
    return Array.from(this.queryPatterns.entries())
      .sort((a, b) => b[1].frequency - a[1].frequency)
      .slice(0, limit)
      .map(([query, data]) => ({
        query,
        frequency: data.frequency,
        successRate: data.successRate,
        boost: data.boost
      }));
  }

  getSystemHealth() {
    const totalInteractions = this.getTotalInteractions();
    const avgSuccessRate = Array.from(this.queryPatterns.values())
      .reduce((sum, pattern) => sum + pattern.successRate, 0) / this.queryPatterns.size;
    
    return {
      status: totalInteractions > 100 ? 'healthy' : 'learning',
      confidence: Math.min(1.0, totalInteractions / 1000),
      avgSuccessRate: avgSuccessRate || 0.5
    };
  }

  // Pulisci dati vecchi per mantenere performance
  cleanup() {
    const oneMonthAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    
    // Rimuovi interazioni vecchie
    for (const [sessionId, interactions] of this.userInteractions.entries()) {
      const recentInteractions = interactions.filter(i => i.timestamp > oneMonthAgo);
      if (recentInteractions.length === 0) {
        this.userInteractions.delete(sessionId);
      } else {
        this.userInteractions.set(sessionId, recentInteractions);
      }
    }
    
    console.log('ML system cleanup completed');
  }
}

// Esporta un'istanza singleton
export const mlSystem = new MLSystem();

// Cleanup automatico ogni 24 ore
setInterval(() => {
  mlSystem.cleanup();
}, 24 * 60 * 60 * 1000);