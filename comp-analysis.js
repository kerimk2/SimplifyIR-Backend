const axios = require('axios');

// Financial Modeling Prep API client
class CompetitiveAnalysis {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseURL = 'https://financialmodelingprep.com/api/v3';
    this.cache = new Map(); // Simple cache for API responses
    this.cacheTimeout = 3600000; // 1 hour in milliseconds
  }

  // CoreWeave competitor universe
  getCompetitorTickers(company) {
    const competitors = {
      'CRWV': {
        direct: ['DOCN', 'NET'], // DigitalOcean, Cloudflare
        cloudInfra: ['AMZN', 'GOOGL', 'MSFT'], // AWS, Google Cloud, Azure
        aiGpu: ['NVDA', 'AMD'], // NVIDIA, AMD
        all: ['DOCN', 'NET', 'AMZN', 'GOOGL', 'MSFT', 'NVDA', 'AMD']
      }
    };
    
    return competitors[company] || { all: [] };
  }

  // Get current stock price and basic metrics
  async getStockQuote(ticker) {
    const cacheKey = `quote_${ticker}`;
    const cached = this.getCachedData(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(
        `${this.baseURL}/quote/${ticker}?apikey=${this.apiKey}`
      );
      
      const data = response.data[0];
      const result = {
        symbol: data.symbol,
        name: data.name,
        price: data.price,
        marketCap: data.marketCap,
        pe: data.pe,
        eps: data.eps,
        change: data.change,
        changesPercentage: data.changesPercentage
      };

      this.setCachedData(cacheKey, result);
      return result;
    } catch (error) {
      console.error(`Error fetching quote for ${ticker}:`, error.message);
      return null;
    }
  }

  // Get key financial metrics
  async getKeyMetrics(ticker) {
    const cacheKey = `metrics_${ticker}`;
    const cached = this.getCachedData(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(
        `${this.baseURL}/key-metrics/${ticker}?apikey=${this.apiKey}&limit=1`
      );
      
      const data = response.data[0];
      const result = {
        symbol: ticker,
        peRatio: data.peRatio,
        priceToBookRatio: data.priceToBookRatio,
        priceToSalesRatio: data.priceToSalesRatio,
        enterpriseValueMultiple: data.enterpriseValueMultiple,
        evToRevenue: data.evToRevenue,
        evToEbitda: data.evToEbitda,
        marketCap: data.marketCap,
        enterpriseValue: data.enterpriseValue
      };

      this.setCachedData(cacheKey, result);
      return result;
    } catch (error) {
      console.error(`Error fetching metrics for ${ticker}:`, error.message);
      return null;
    }
  }

  // Get financial growth rates
  async getFinancialGrowth(ticker) {
    const cacheKey = `growth_${ticker}`;
    const cached = this.getCachedData(cacheKey);
    if (cached) return cached;

    try {
      const response = await axios.get(
        `${this.baseURL}/financial-growth/${ticker}?apikey=${this.apiKey}&limit=1`
      );
      
      const data = response.data[0];
      const result = {
        symbol: ticker,
        revenueGrowth: data.revenueGrowth,
        grossProfitGrowth: data.grossProfitGrowth,
        operatingIncomeGrowth: data.operatingIncomeGrowth,
        netIncomeGrowth: data.netIncomeGrowth,
        epsgrowth: data.epsgrowth
      };

      this.setCachedData(cacheKey, result);
      return result;
    } catch (error) {
      console.error(`Error fetching growth for ${ticker}:`, error.message);
      return null;
    }
  }

  // Generate comprehensive competitor comparison
  async generateCompAnalysis(company, metric = 'all') {
    const competitors = this.getCompetitorTickers(company);
    const allTickers = [company, ...competitors.all];
    
    console.log(`🔍 Analyzing ${metric} for ${company} vs competitors: ${competitors.all.join(', ')}`);

    const results = {
      company: company,
      competitors: [],
      analysis: {},
      timestamp: new Date().toISOString()
    };

    // Fetch data for all tickers in parallel
    const promises = allTickers.map(async (ticker) => {
      const [quote, metrics, growth] = await Promise.all([
        this.getStockQuote(ticker),
        this.getKeyMetrics(ticker),
        this.getFinancialGrowth(ticker)
      ]);

      return {
        ticker,
        quote,
        metrics,
        growth,
        isCompany: ticker === company
      };
    });

    const allData = await Promise.all(promises);
    
    // Separate company data from competitor data
    const companyData = allData.find(d => d.isCompany);
    const competitorData = allData.filter(d => !d.isCompany && d.quote);

    results.company = companyData;
    results.competitors = competitorData;

    // Generate comparative analysis
    results.analysis = this.generateComparativeInsights(companyData, competitorData, metric);

    return results;
  }

  // Generate insights comparing company to competitors
  generateComparativeInsights(companyData, competitors, metric) {
    const insights = {
      valuation: {},
      growth: {},
      summary: []
    };

    if (!companyData.quote || competitors.length === 0) {
      insights.summary.push("Insufficient data for comparison");
      return insights;
    }

    // Valuation comparison
    const companyPE = companyData.quote.pe;
    const competitorPEs = competitors.map(c => c.quote.pe).filter(pe => pe && pe > 0);
    
    if (companyPE && competitorPEs.length > 0) {
      const avgCompetitorPE = competitorPEs.reduce((a, b) => a + b, 0) / competitorPEs.length;
      insights.valuation.peComparison = {
        company: companyPE,
        competitorAverage: avgCompetitorPE.toFixed(2),
        premium: ((companyPE / avgCompetitorPE - 1) * 100).toFixed(1)
      };
      
      if (companyPE > avgCompetitorPE) {
        insights.summary.push(`Trading at ${insights.valuation.peComparison.premium}% premium to peer average P/E`);
      } else {
        insights.summary.push(`Trading at discount to peer average P/E`);
      }
    }

    // Market cap comparison
    const companyMarketCap = companyData.quote.marketCap;
    if (companyMarketCap) {
      const competitorMarketCaps = competitors.map(c => c.quote.marketCap).filter(mc => mc);
      const avgMarketCap = competitorMarketCaps.reduce((a, b) => a + b, 0) / competitorMarketCaps.length;
      
      insights.valuation.marketCapPosition = companyMarketCap > avgMarketCap ? 'above average' : 'below average';
    }

    return insights;
  }

  // Cache management
  getCachedData(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached.data;
    }
    return null;
  }

  setCachedData(key, data) {
    this.cache.set(key, {
      data: data,
      timestamp: Date.now()
    });
  }

  // Clear cache
  clearCache() {
    this.cache.clear();
  }
}

module.exports = CompetitiveAnalysis;