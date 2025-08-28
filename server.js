require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const PineconeREST = require('./pinecone-rest');

// File processing libraries
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// Competitive analysis
const CompetitiveAnalysis = require('./comp-analysis');

// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());

// Serve static files (for our upload interface)
app.use(express.static('public'));

// Initialize APIs
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Initialize Competitive Analysis
let compAnalysis = null;
if (process.env.FMP_API_KEY) {
  compAnalysis = new CompetitiveAnalysis(process.env.FMP_API_KEY);
  console.log('📊 Competitive Analysis initialized with FMP API');
} else {
  console.log('⚠️  FMP_API_KEY not found - Competitive Analysis disabled');
}

console.log('🔍 Pinecone Configuration Debug:');
console.log('API Key exists:', !!process.env.PINECONE_API_KEY);
console.log('Environment:', process.env.PINECONE_ENVIRONMENT);

const pinecone = new PineconeREST({
  apiKey: process.env.PINECONE_API_KEY,
  environment: process.env.PINECONE_ENVIRONMENT,
});

console.log('✅ Pinecone client created without projectId');

let index = pinecone; // Use the REST client directly

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: function (req, file, cb) {
    // Allowed file types
    const allowedTypes = ['.pdf', '.docx', '.doc', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: PDF, DOCX, DOC, TXT'));
    }
  }
});

// Initialize Pinecone connection
async function initializePinecone() {
  try {
    // Test connection with REST API
    const stats = await pinecone.describeIndexStats();
    console.log('✅ Connected to Pinecone index: simplifyir');
    console.log(`📊 Total vectors: ${stats.totalVectorCount}`);
  } catch (error) {
    console.error('❌ Failed to connect to Pinecone:', error);
    process.exit(1);
  }
}

// Document Processing Class
class DocumentProcessor {
  constructor() {
    this.maxChunkSize = 1500;
    this.overlapSize = 200;
  }

  async extractTextFromFile(filePath, originalName) {
    const ext = path.extname(originalName).toLowerCase();
    
    try {
      switch (ext) {
        case '.pdf':
          return await this.extractFromPDF(filePath);
        case '.docx':
          return await this.extractFromDOCX(filePath);
        case '.txt':
          return await this.extractFromTXT(filePath);
        default:
          throw new Error(`Unsupported file type: ${ext}`);
      }
    } catch (error) {
      console.error(`Error extracting text from ${originalName}:`, error.message);
      throw error;
    }
  }

  async extractFromPDF(filePath) {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text;
  }

  async extractFromDOCX(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  async extractFromTXT(filePath) {
    return fs.readFileSync(filePath, 'utf8');
  }

  createChunks(content, metadata) {
    const chunks = [];
    let position = 0;
    
    while (position < content.length) {
      const end = Math.min(position + this.maxChunkSize, content.length);
      let chunk = content.slice(position, end);
      
      // Try to break at sentence boundary
      if (end < content.length) {
        const lastSentence = chunk.lastIndexOf('. ');
        const lastNewline = chunk.lastIndexOf('\n');
        const breakPoint = Math.max(lastSentence, lastNewline);
        
        if (breakPoint > position + this.maxChunkSize * 0.7) {
          chunk = content.slice(position, breakPoint + 1);
          position = breakPoint + 1;
        } else {
          position = end - this.overlapSize;
        }
      } else {
        position = end;
      }
      
      if (chunk.trim().length > 100) {
        chunks.push({
          content: chunk.trim(),
          metadata: {
            ...metadata,
            content: chunk.trim()
          }
        });
      }
    }
    
    return chunks;
  }

  async generateEmbedding(text) {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-ada-002',
        input: text,
      });
      
      return response.data[0].embedding;
    } catch (error) {
      console.error('Error generating embedding:', error.message);
      throw error;
    }
  }

  anonymizeSellSideResearch(content) {
    // Remove analyst names, firm identifiers, and contact information
    let anonymizedContent = content;
    
    // Remove common sell-side patterns
    const patterns = [
      // Analyst names and titles
      /(?:Analyst|Research Analyst|Senior Analyst|Managing Director|VP|Director):\s*[A-Za-z\s,.]+ \([^)]+\)/gi,
      /Contact:\s*[A-Za-z\s,.]+ at [^\n]+/gi,
      /(?:For questions|Questions|Contact).*?analyst.*?[^\n]+/gi,
      
      // Firm identifiers and disclaimers
      /This report (?:is prepared by|was prepared by|has been prepared by) [A-Za-z\s&,.]+ (?:LLC|Inc|Ltd|LLP|LP)/gi,
      /(?:Goldman Sachs|Morgan Stanley|J\.P\. Morgan|Barclays|Deutsche Bank|Credit Suisse|UBS|Citigroup|Bank of America|Wells Fargo|Jefferies|Piper Sandler|Cowen|Stifel|Raymond James|KeyBanc|Oppenheimer|Wedbush|Needham|Craig-Hallum|Roth Capital|Lake Street)/gi,
      
      // Phone numbers and emails
      /(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      
      // Research disclaimers and legal text
      /This research report[^.]*\./gi,
      /(?:Important disclosures|Legal disclaimer|Risk disclosure)[^.]*\./gi,
      /The information contained herein[^.]*\./gi,
    ];
    
    patterns.forEach(pattern => {
      anonymizedContent = anonymizedContent.replace(pattern, '[REDACTED]');
    });
    
    // Clean up multiple redactions
    anonymizedContent = anonymizedContent.replace(/\[REDACTED\]\s*\[REDACTED\]/g, '[REDACTED]');
    anonymizedContent = anonymizedContent.replace(/\[REDACTED\]\s*\n\s*\[REDACTED\]/g, '[REDACTED]');
    
    return anonymizedContent;
  }

  async processAndStore(filePath, originalName, company, documentType, description, incognitoMode = false, customSource = '', sellSideMode = false) {
    console.log(`📄 Processing uploaded document: ${originalName}`);
    
    try {
      // Extract text from file
      let content = await this.extractTextFromFile(filePath, originalName);
      console.log(`✅ Extracted ${content.length} characters from ${originalName}`);
      
      // Apply sell-side anonymization if requested
      const isSellSide = sellSideMode === 'true' || sellSideMode === true;
      if (isSellSide) {
        content = this.anonymizeSellSideResearch(content);
        console.log(`🔒 Applied sell-side research anonymization`);
      }
      
      if (content.length < 100) {
        throw new Error('Document contains insufficient text content');
      }

      // Create metadata
      const isIncognito = incognitoMode === 'true' || incognitoMode === true;
      let sourceLabel = `Internal Document - ${originalName}`;
      let sourceType = 'internal-document';
      let filename = originalName;
      
      if (isSellSide) {
        sourceLabel = 'Anonymized Sell-Side Research';
        sourceType = 'external-research';
        filename = 'Anonymized Research Report';
      } else if (isIncognito && customSource) {
        sourceLabel = customSource;
        sourceType = 'external-research';
        filename = 'Anonymized';
      } else if (isIncognito) {
        filename = 'Anonymized';
      }
      
      const baseMetadata = {
        company: company.toUpperCase(),
        source: sourceLabel,
        sourceType: sourceType,
        documentType: documentType || 'document',
        description: description || '',
        uploadDate: new Date().toISOString().split('T')[0],
        originalFilename: filename,
        incognito: isIncognito,
        sellSideAnonymized: isSellSide
      };

      // Create chunks
      const chunks = this.createChunks(content, baseMetadata);
      console.log(`📝 Created ${chunks.length} chunks`);

      if (chunks.length === 0) {
        throw new Error('No processable chunks created from document');
      }

      // Generate embeddings and store
      const vectors = [];
      for (let i = 0; i < chunks.length; i++) {
        try {
          const embedding = await this.generateEmbedding(chunks[i].content);
          
          let idPrefix = 'INTERNAL';
          if (isSellSide) {
            idPrefix = 'SELLSIDE';
          } else if (isIncognito) {
            idPrefix = 'EXTERNAL';
          }
          vectors.push({
            id: `${company.toUpperCase()}-${idPrefix}-${Date.now()}-${i}`,
            values: embedding,
            metadata: chunks[i].metadata
          });

          // Show progress for large documents
          if (chunks.length > 10 && (i + 1) % 5 === 0) {
            console.log(`  ⏳ Processed ${i + 1}/${chunks.length} chunks`);
          }
          
        } catch (error) {
          console.error(`❌ Error processing chunk ${i + 1}:`, error.message);
          continue;
        }
      }

      // Upload to Pinecone
      if (vectors.length > 0) {
        await index.upsert(vectors);
        console.log(`🎉 Successfully stored ${vectors.length} chunks for ${originalName}`);
      }

      // Clean up uploaded file
      fs.unlinkSync(filePath);

      return {
        success: true,
        chunksProcessed: vectors.length,
        originalChunks: chunks.length,
        content: content.substring(0, 500) + '...' // Preview
      };

    } catch (error) {
      // Clean up file on error
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw error;
    }
  }
}

// Production-Ready Query Intelligence System
class ProductionQueryIntelligence {
  constructor() {
    // Enhanced intent recognition
    this.intentPatterns = {
      // Management commentary intents
      managementCommentary: [
        'management said', 'management discussed', 'ceo said', 'executives said',
        'leadership commented', 'management commentary', 'management perspective',
        'what did management', 'according to management', 'management stated'
      ],
      
      // Financial performance intents  
      financialPerformance: [
        'earnings', 'financial results', 'quarterly results', 'performance',
        'revenue', 'profit', 'income', 'financial performance', 'results'
      ],
      
      // Strategic/forward-looking intents
      strategy: [
        'strategy', 'strategic', 'plans', 'outlook', 'guidance', 'future',
        'direction', 'priorities', 'goals', 'vision', 'roadmap', 'expansion'
      ],
      
      // Competitive/market intents
      competitive: [
        'competitive', 'competition', 'market position', 'advantages',
        'differentiation', 'vs competitors', 'market share', 'positioning'
      ],
      
      // Risk/challenges intents
      risks: [
        'risks', 'challenges', 'concerns', 'threats', 'uncertainties',
        'headwinds', 'obstacles', 'difficulties', 'problems'
      ]
    };

    // Time period normalization
    this.timePeriods = {
      latest: ['latest', 'most recent', 'current', 'this quarter', 'this year'],
      q1: ['Q1', 'first quarter', 'quarter 1', 'three months ended March'],
      q2: ['Q2', 'second quarter', 'quarter 2', 'three months ended June'],
      q3: ['Q3', 'third quarter', 'quarter 3', 'three months ended September'],
      q4: ['Q4', 'fourth quarter', 'quarter 4', 'three months ended December'],
      annual: ['annual', 'yearly', 'year ended', 'full year', 'fiscal year']
    };
  }

  // Main query processing pipeline
  async processQuery(originalQuery, company) {
    // Step 1: Analyze intent and extract key components
    const analysis = this.analyzeQueryIntent(originalQuery);
    
    // Step 2: Generate diversified search strategies
    const searchStrategies = this.generateSearchStrategies(originalQuery, analysis);
    
    // Step 3: Execute multi-source search
    const results = await this.executeMultiSourceSearch(searchStrategies, company);
    
    // Step 4: Ensure source diversity and quality
    const balancedResults = this.balanceSourceTypes(results, analysis);
    
    return {
      originalQuery,
      analysis,
      strategies: searchStrategies.map(s => s.query), // For debugging
      results: balancedResults
    };
  }

  analyzeQueryIntent(query) {
    const queryLower = query.toLowerCase();
    
    const analysis = {
      intents: [],
      timePeriod: null,
      isFinancial: false,
      needsInternal: false,
      needsForwardLooking: false,
      confidence: 0
    };

    // Detect intents
    for (const [intent, patterns] of Object.entries(this.intentPatterns)) {
      const matches = patterns.filter(pattern => queryLower.includes(pattern));
      if (matches.length > 0) {
        analysis.intents.push(intent);
        analysis.confidence += matches.length * 0.1;
      }
    }

    // Detect time period
    for (const [period, terms] of Object.entries(this.timePeriods)) {
      if (terms.some(term => queryLower.includes(term))) {
        analysis.timePeriod = period;
        break;
      }
    }

    // Special flags
    analysis.isFinancial = queryLower.match(/(revenue|profit|income|earnings|financial|results)/);
    analysis.needsInternal = queryLower.match(/(management|said|commentary|call|presentation|guidance)/);
    analysis.needsForwardLooking = queryLower.match(/(guidance|outlook|future|plans|strategy|goals)/);

    return analysis;
  }

  generateSearchStrategies(originalQuery, analysis) {
    const strategies = [];
    
    // Strategy 1: Original query (always include)
    strategies.push({
      type: 'original',
      query: originalQuery,
      weight: 1.0
    });

    // Strategy 2: SEC-focused queries
    if (analysis.isFinancial) {
      strategies.push({
        type: 'sec-financial',
        query: this.buildSecQuery(originalQuery, analysis),
        weight: 0.8,
        sourceHint: 'sec'
      });
    }

    // Strategy 3: Internal document queries
    if (analysis.needsInternal) {
      strategies.push({
        type: 'internal-docs',
        query: this.buildInternalQuery(originalQuery, analysis),
        weight: 0.9,
        sourceHint: 'internal'
      });
    }

    // Strategy 4: Web/market intelligence queries
    if (analysis.intents.includes('competitive') || analysis.intents.includes('strategy')) {
      strategies.push({
        type: 'market-intelligence',
        query: this.buildMarketQuery(originalQuery, analysis),
        weight: 0.7,
        sourceHint: 'web'
      });
    }

    // Strategy 5: Intent-specific queries
    analysis.intents.forEach(intent => {
      strategies.push({
        type: `intent-${intent}`,
        query: this.buildIntentQuery(originalQuery, intent, analysis),
        weight: 0.6
      });
    });

    // Strategy 6: Broad fallback query
    strategies.push({
      type: 'broad-fallback',
      query: this.buildBroadQuery(originalQuery, analysis),
      weight: 0.5
    });

    return strategies.slice(0, 6); // Limit to 6 strategies
  }

  buildSecQuery(query, analysis) {
    const base = query.toLowerCase();
    const currentYear = new Date().getFullYear();
    
    if (analysis.isFinancial && analysis.timePeriod) {
      if (analysis.timePeriod === 'latest' || analysis.timePeriod === 'q1') {
        return `total revenue operating income three months ended March ${currentYear} consolidated statements`;
      }
    }
    
    return `${base} SEC filing 10-Q 10-K financial statements`;
  }

  buildInternalQuery(query, analysis) {
    const base = query.toLowerCase();
    
    if (analysis.intents.includes('managementCommentary')) {
      return `earnings call transcript management discussion commentary Q&A`;
    }
    
    if (analysis.needsForwardLooking) {
      return `earnings presentation guidance outlook management commentary`;
    }
    
    return `${base} earnings call presentation management discussion`;
  }

  buildMarketQuery(query, analysis) {
    const base = query.toLowerCase();
    
    if (analysis.intents.includes('competitive')) {
      return `competitive position market differentiation advantages strategy`;
    }
    
    return `${base} market position strategy business model`;
  }

  buildIntentQuery(query, intent, analysis) {
    const intentMappings = {
      managementCommentary: 'management said discussed commentary earnings call',
      financialPerformance: 'revenue income earnings financial results performance',
      strategy: 'strategy strategic plans outlook guidance future direction',
      competitive: 'competitive advantages market position differentiation',
      risks: 'risk factors challenges concerns uncertainties'
    };

    return intentMappings[intent] || query;
  }

  buildBroadQuery(query, analysis) {
    // Extract key terms and create a broad search
    const words = query.toLowerCase().split(/\s+/);
    const importantWords = words.filter(word => 
      word.length > 3 && 
      !['what', 'how', 'when', 'where', 'does', 'said', 'the', 'and', 'for', 'with'].includes(word)
    );
    
    return importantWords.slice(0, 4).join(' ');
  }

  async executeMultiSourceSearch(strategies, company) {
    const allResults = [];
    
    for (const strategy of strategies) {
      try {
        // Generate embedding for this strategy
        const queryEmbedding = await openai.embeddings.create({
          model: 'text-embedding-ada-002',
          input: strategy.query,
        });

        // Search with source hints if available
        const searchResponse = await index.query(
          queryEmbedding.data[0].embedding,
          4, // topK 
          { company: company }
        );
        
        // Tag results with strategy info
        searchResponse.matches.forEach(match => {
          match.strategyType = strategy.type;
          match.strategyWeight = strategy.weight;
          match.sourceQuery = strategy.query;
        });

        allResults.push(...searchResponse.matches);
        
      } catch (error) {
        console.error(`Strategy ${strategy.type} failed:`, error.message);
        continue;
      }
    }

    return allResults;
  }

  balanceSourceTypes(results, analysis) {
    // Group results by source type
    const bySourceType = {
      sec: [],
      internal: [],
      web: [],
      other: []
    };

    results.forEach(result => {
      if (result.metadata.source?.includes('Filing')) {
        bySourceType.sec.push(result);
      } else if (result.metadata.sourceType === 'internal-document' || result.metadata.source?.includes('Internal')) {
        bySourceType.internal.push(result);
      } else if (result.metadata.sourceType?.includes('web')) {
        bySourceType.web.push(result);
      } else {
        bySourceType.other.push(result);
      }
    });

    // Ensure balanced representation
    const balanced = [];
    const targetTotal = 6;

    // Priority based on query analysis
    if (analysis.needsInternal) {
      // Prioritize internal documents
      balanced.push(...bySourceType.internal.slice(0, 3));
      balanced.push(...bySourceType.sec.slice(0, 2));
      balanced.push(...bySourceType.web.slice(0, 1));
    } else if (analysis.isFinancial) {
      // Prioritize SEC filings for financial queries
      balanced.push(...bySourceType.sec.slice(0, 3));
      balanced.push(...bySourceType.internal.slice(0, 2));
      balanced.push(...bySourceType.web.slice(0, 1));
    } else {
      // Balanced mix for general queries
      balanced.push(...bySourceType.internal.slice(0, 2));
      balanced.push(...bySourceType.sec.slice(0, 2));
      balanced.push(...bySourceType.web.slice(0, 2));
    }

    // Fill remaining slots with best results
    const remaining = targetTotal - balanced.length;
    if (remaining > 0) {
      const allRemaining = [
        ...bySourceType.sec.slice(balanced.filter(r => bySourceType.sec.includes(r)).length),
        ...bySourceType.internal.slice(balanced.filter(r => bySourceType.internal.includes(r)).length),
        ...bySourceType.web.slice(balanced.filter(r => bySourceType.web.includes(r)).length),
        ...bySourceType.other
      ];
      
      balanced.push(...allRemaining.slice(0, remaining));
    }

    // Remove duplicates and sort by relevance
    const unique = balanced.filter((result, index, self) => 
      index === self.findIndex(r => r.id === result.id)
    );

    return unique.slice(0, targetTotal).sort((a, b) => (b.score || 0) - (a.score || 0));
  }
}

// Production search function with enhanced intelligence
async function productionSearchWithIntelligence(question, company) {
  const querySystem = new ProductionQueryIntelligence();
  
  console.log(`🧠 Production Query Processing: "${question}"`);
  
  try {
    const result = await querySystem.processQuery(question, company);
    
    console.log(`🎯 Query Analysis:`);
    console.log(`   Intents: ${result.analysis.intents.join(', ') || 'general'}`);
    console.log(`   Time Period: ${result.analysis.timePeriod || 'unspecified'}`);
    console.log(`   Needs Internal: ${result.analysis.needsInternal}`);
    console.log(`   Is Financial: ${result.analysis.isFinancial}`);
    console.log(`   Confidence: ${result.analysis.confidence.toFixed(2)}`);
    
    console.log(`🔍 Search Strategies Used:`);
    result.strategies.forEach((strategy, i) => {
      console.log(`   ${i + 1}. ${strategy}`);
    });

    console.log(`📊 Source Balance in Results:`);
    const sourceTypes = {};
    result.results.forEach(r => {
      const type = r.metadata.sourceType || 'sec';
      sourceTypes[type] = (sourceTypes[type] || 0) + 1;
    });
    Object.entries(sourceTypes).forEach(([type, count]) => {
      console.log(`   ${type}: ${count} documents`);
    });

    console.log(`✅ Found ${result.results.length} balanced results`);
    
    return result.results;
    
  } catch (error) {
    console.error('❌ Production query processing failed:', error);
    // Fallback to basic search if production system fails
    return await basicSearch(question, company);
  }
}

// Basic fallback search function
async function basicSearch(question, company) {
  try {
    const queryEmbedding = await openai.embeddings.create({
      model: 'text-embedding-ada-002',
      input: question,
    });

    const searchResponse = await index.query({
      vector: queryEmbedding.data[0].embedding,
      filter: { company: company },
      topK: 6,
      includeMetadata: true,
    });

    return searchResponse.matches;
  } catch (error) {
    console.error('❌ Basic search failed:', error);
    return [];
  }
}

// AI Response Generation (enhanced for internal documents)
// Detect if question is asking for competitive analysis
function detectCompetitiveQuery(question) {
  const compKeywords = [
    'competitors', 'competition', 'competitive', 'compare', 'comparison', 'vs', 'versus',
    'peer', 'peers', 'industry', 'market position', 'relative to', 'against',
    'p/e ratio', 'pe ratio', 'valuation', 'multiple', 'market cap', 
    'better than', 'worse than', 'outperform', 'underperform'
  ];
  
  const lowerQuestion = question.toLowerCase();
  return compKeywords.some(keyword => lowerQuestion.includes(keyword));
}

// Generate AI response using competitive analysis data
async function generateCompetitiveResponse(question, compData, company) {
  try {
    const context = JSON.stringify(compData, null, 2);
    
    const prompt = `You are an expert financial analyst providing competitive analysis for ${company}.

REAL-TIME COMPETITIVE DATA:
${context}

INVESTOR QUESTION: ${question}

Using the real-time competitive data above, provide a comprehensive analysis that:

1. **Direct Answer**: Address the specific question with current market data
2. **Competitive Context**: Compare ${company} to relevant peers using actual metrics
3. **Key Insights**: Highlight notable competitive advantages or disadvantages
4. **Market Position**: Explain where ${company} stands in its competitive landscape

Guidelines:
- Use specific numbers and metrics from the data
- Be objective and data-driven
- Explain what the metrics mean in practical terms
- Reference specific competitors by name when relevant
- If data is limited, acknowledge limitations

Provide your competitive analysis:`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
      temperature: 0.7,
    });

    // Generate sources from the competitive data
    const sources = ['Real-time Market Data (Financial Modeling Prep)'];
    if (compData.competitors && compData.competitors.length > 0) {
      const competitorNames = compData.competitors.map(c => c.quote?.name || c.ticker).filter(Boolean);
      sources.push(`Competitive Set: ${competitorNames.join(', ')}`);
    }

    return {
      content: completion.choices[0].message.content,
      sources: sources
    };

  } catch (error) {
    console.error('Error generating competitive response:', error);
    throw error;
  }
}

// Generate professional communication templates
async function generateCommunicationTemplate(params) {
  try {
    const { company, category, situation, audience, tone, contextData } = params;
    
    // Build context from relevant company data
    const context = contextData && contextData.length > 0 
      ? contextData.map(doc => doc.metadata.content).join('\n\n').substring(0, 3000)
      : '';

    // Define tone characteristics
    const toneStyles = {
      professional: 'formal, respectful, and business-appropriate',
      conversational: 'warm, approachable, and friendly while maintaining professionalism',
      confident: 'assertive, positive, and demonstrating strong leadership',
      cautious: 'measured, careful, and diplomatically worded'
    };

    // Define audience characteristics
    const audienceStyles = {
      institutional: 'sophisticated investors who understand complex financial metrics and strategic nuances',
      analysts: 'financial professionals who need detailed data and clear explanations of business drivers',
      retail: 'individual investors who need accessible explanations and clear takeaways',
      media: 'journalists who need quotable statements and newsworthy angles',
      general: 'broad stakeholders who need balanced, informative communication'
    };

    const prompt = `You are an expert investor relations professional drafting a communication for ${company}.

SITUATION: ${situation}

COMPANY CONTEXT:
${context}

COMMUNICATION REQUIREMENTS:
- Category: ${category}
- Audience: ${audienceStyles[audience]}
- Tone: ${toneStyles[tone]}

Generate a professional communication that:

1. **Professional Format**: Use proper email structure with subject, greeting, body, and closing
2. **Situation-Specific**: Directly address the specific situation described
3. **Data-Driven**: Include relevant company information and context when available
4. **Audience-Appropriate**: Match the sophistication level and interests of the ${audience}
5. **Tone-Consistent**: Maintain a ${tone} tone throughout
6. **Actionable**: Provide clear next steps or contact information when appropriate

EMAIL STRUCTURE:
- Subject: [Compelling, specific subject line]
- Greeting: [Appropriate salutation]
- Body: [2-4 well-structured paragraphs addressing the situation]
- Closing: [Professional sign-off with contact information]

Generate the complete email communication:`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1000,
      temperature: 0.7,
    });

    return {
      content: completion.choices[0].message.content
    };

  } catch (error) {
    console.error('Error generating communication template:', error);
    throw error;
  }
}

// Generate management-focused responses for earnings prep
async function generateManagementResponse(question, documents, company) {
  try {
    const context = documents.map(doc => doc.metadata.content).join('\n\n');
    const sources = [...new Set(documents.map(doc => {
      if (doc.metadata.source && doc.metadata.source.includes('SEC')) return 'SEC Filing';
      if (doc.metadata.source && doc.metadata.source.includes('web')) return 'Company Website/News';
      if (doc.metadata.source && doc.metadata.source.includes('External Research')) return 'Research Report (Anonymized)';
      return doc.metadata.sourceType === 'internal-document' 
        ? `Internal: ${doc.metadata.originalFilename || doc.metadata.source}`
        : doc.metadata.source || 'Company Document';
    }))];

    const prompt = `You are a senior advisor helping ${company} management prepare for earnings calls and investor meetings. 

CONTEXT DOCUMENTS:
${context}

MANAGEMENT QUESTION: ${question}

As a management advisor, provide strategic, actionable guidance that helps prepare for investor interactions. Your response should:

1. **Be Management-Focused**: Frame responses from the company's perspective, not as an external observer
2. **Strategic Thinking**: Consider both immediate responses and strategic implications
3. **Anticipate Follow-ups**: Think about what follow-up questions might arise
4. **Practical Guidance**: Provide specific talking points, key messages, or response strategies
5. **Risk Awareness**: Highlight potential challenges or sensitive areas

Response Guidelines:
- Use a professional, advisory tone
- Structure responses clearly with headers if needed
- Focus on actionable insights for management
- Consider both defensive and offensive strategic positioning
- Be specific about key metrics, trends, or competitive dynamics when relevant

Provide your management advisory response:`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1000,
      temperature: 0.7,
    });

    return {
      content: completion.choices[0].message.content,
      sources: sources
    };

  } catch (error) {
    console.error('Error generating management response:', error);
    throw error;
  }
}

async function generateAIResponse(documents, question, company) {
  const context = documents.map(doc => {
    const sourceLabel = doc.metadata.sourceType === 'internal-document' 
      ? `Internal Document: ${doc.metadata.originalFilename || doc.metadata.source}`
      : doc.metadata.source;
    return `Source: ${sourceLabel}\nContent: ${doc.metadata.content}`;
  }).join('\n\n---\n\n');
  
  const systemPrompt = `You are a professional financial analyst with access to comprehensive company information including SEC filings, public sources, and internal company documents. 

FORMATTING REQUIREMENTS:
- Write in a natural, conversational tone suitable for investors
- Break up information into clear, digestible paragraphs
- Use bullet points for multiple items or key highlights
- Include specific details like dates, amounts, and percentages when available
- Structure responses logically with main points first, then supporting details
- Keep paragraphs to 2-3 sentences maximum for readability

CONTENT GUIDELINES:
- Provide accurate, professional responses based solely on the provided documents
- When referencing internal documents, note: "According to internal documents..." or "Based on company materials..."
- Include relevant context and implications for investors
- If multiple aspects are covered, organize them clearly with subheadings or clear transitions

CONTEXT FROM COMPANY DOCUMENTS:
${context}`;

  const userPrompt = `Please answer this question about ${company} in a well-formatted, investor-friendly way: ${question}

Structure your response with:
1. A clear, direct answer to the question
2. Key details and specifics (dates, amounts, parties involved)
3. Additional context or implications if relevant
4. Use natural paragraph breaks and bullet points where appropriate`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 1200,
      temperature: 0.1,
    });

    // Post-process the response to ensure good formatting
    let formattedResponse = response.choices[0].message.content;
    
    // Ensure proper line breaks between sentences for readability
    formattedResponse = formattedResponse.replace(/\. ([A-Z][a-z])/g, '.\n\n$1');
    
    // Ensure proper line breaks before numbered lists
    formattedResponse = formattedResponse.replace(/(\d+\. )/g, '\n$1');
    
    // Ensure proper spacing around bullet points
    formattedResponse = formattedResponse.replace(/• /g, '\n• ');
    
    // Clean up excessive line breaks
    formattedResponse = formattedResponse.replace(/\n{3,}/g, '\n\n');
    
    // Remove leading line breaks
    formattedResponse = formattedResponse.replace(/^\n+/, '');
    
    return formattedResponse.trim();
    
  } catch (error) {
    console.error('❌ Error generating AI response:', error);
    throw error;
  }
}

// ROUTES

// Health check
// Competitive Analysis API Endpoints
app.get('/api/comp-analysis/:company', async (req, res) => {
  try {
    if (!compAnalysis) {
      return res.status(503).json({ 
        error: 'Competitive analysis not available',
        message: 'FMP API key not configured' 
      });
    }

    const { company } = req.params;
    const { metric } = req.query; // Optional: 'valuation', 'growth', 'all'
    
    console.log(`📊 Comp analysis request: ${company}, metric: ${metric || 'all'}`);
    
    const analysis = await compAnalysis.generateCompAnalysis(company.toUpperCase(), metric);
    
    res.json({
      success: true,
      data: analysis
    });

  } catch (error) {
    console.error('❌ Comp analysis error:', error);
    res.status(500).json({ 
      error: 'Failed to generate competitive analysis',
      details: error.message 
    });
  }
});

app.post('/api/generate-template', async (req, res) => {
  try {
    const { company, category, situation, audience, tone } = req.body;
    
    if (!company || !situation) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Company and situation are required' 
      });
    }

    console.log(`📧 Template generation request: ${category} for ${audience}`);
    
    // Get relevant company data for context
    const enhancedResults = await productionSearchWithIntelligence(situation, company);
    
    // Generate the communication template
    const template = await generateCommunicationTemplate({
      company,
      category: category || 'general',
      situation,
      audience: audience || 'institutional',
      tone: tone || 'professional',
      contextData: enhancedResults
    });
    
    console.log('✅ Template generated successfully');
    
    res.json({
      success: true,
      template: template.content,
      category: category,
      audience: audience,
      tone: tone
    });

  } catch (error) {
    console.error('❌ Template generation error:', error);
    res.status(500).json({ 
      error: 'Failed to generate template',
      details: error.message 
    });
  }
});

app.get('/api/stock-quote/:ticker', async (req, res) => {
  try {
    if (!compAnalysis) {
      return res.status(503).json({ 
        error: 'Stock quotes not available',
        message: 'FMP API key not configured' 
      });
    }

    const { ticker } = req.params;
    const quote = await compAnalysis.getStockQuote(ticker.toUpperCase());
    
    if (!quote) {
      return res.status(404).json({ error: 'Stock not found' });
    }

    res.json({
      success: true,
      data: quote
    });

  } catch (error) {
    console.error('❌ Stock quote error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch stock quote',
      details: error.message 
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    features: ['sec-filings', 'web-sources', 'document-uploads', 'production-query-intelligence']
  });
});

// Get companies
app.get('/api/companies', async (req, res) => {
  try {
    console.log('🔍 Attempting to describe index stats...');
    const stats = await index.describeIndexStats();
    console.log('✅ Index stats retrieved:', stats);
    
    res.json({
      totalVectors: stats.totalVectorCount,
      companies: ['DEMO', 'AAPL', 'SNOW', 'CRWV'],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error in companies endpoint:', error);
    console.error('❌ Error details:', error.message);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Failed to fetch companies',
      details: error.message 
    });
  }
});

// Document upload endpoint
app.post('/api/upload-document', upload.single('document'), async (req, res) => {
  try {
    const { company, documentType, description, incognitoMode, customSource, sellSideMode } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    if (!company) {
      return res.status(400).json({ error: 'Company ticker is required' });
    }

    console.log('=== DOCUMENT UPLOAD ===');
    console.log(`📄 File: ${req.file.originalname}`);
    console.log(`🏢 Company: ${company}`);
    console.log(`📝 Type: ${documentType || 'General Document'}`);
    console.log(`📋 Description: ${description || 'No description'}`);

    const processor = new DocumentProcessor();
    const result = await processor.processAndStore(
      req.file.path,
      req.file.originalname,
      company,
      documentType,
      description,
      incognitoMode,
      customSource,
      sellSideMode
    );

    console.log('✅ Document upload completed successfully');

    res.json({
      success: true,
      message: 'Document processed successfully',
      filename: req.file.originalname,
      company: company.toUpperCase(),
      chunksProcessed: result.chunksProcessed,
      preview: result.content
    });

  } catch (error) {
    console.error('❌ Error processing uploaded document:', error);
    res.status(500).json({ 
      error: 'Document processing failed',
      message: error.message
    });
  }
});

// Enhanced Multi-File Upload Endpoint
app.post('/api/upload-documents', upload.array('documents', 10), async (req, res) => {
  try {
    const { company, documentType, description, incognitoMode, customSource, sellSideMode } = req.body;
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    
    if (!company) {
      return res.status(400).json({ error: 'Company ticker is required' });
    }

    console.log('=== MULTI-DOCUMENT UPLOAD ===');
    console.log(`📄 Files: ${req.files.length} documents`);
    console.log(`🏢 Company: ${company}`);
    console.log(`📝 Type: ${documentType || 'General Documents'}`);

    const processor = new DocumentProcessor();
    const results = [];
    const errors = [];

    // Process each file
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      console.log(`📄 Processing ${i + 1}/${req.files.length}: ${file.originalname}`);
      
      try {
        const result = await processor.processAndStore(
          file.path,
          file.originalname,
          company,
          documentType,
          description,
          incognitoMode,
          customSource,
          sellSideMode
        );

        results.push({
          filename: file.originalname,
          success: true,
          chunksProcessed: result.chunksProcessed,
          preview: result.content.substring(0, 200) + '...'
        });

        console.log(`✅ Completed ${file.originalname}: ${result.chunksProcessed} chunks`);

      } catch (error) {
        console.error(`❌ Error processing ${file.originalname}:`, error.message);
        
        errors.push({
          filename: file.originalname,
          error: error.message
        });

        // Clean up failed file
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }

    const successCount = results.length;
    const totalChunks = results.reduce((sum, r) => sum + r.chunksProcessed, 0);

    console.log(`🎉 Multi-upload completed: ${successCount}/${req.files.length} files successful, ${totalChunks} total chunks`);

    res.json({
      success: true,
      message: `Successfully processed ${successCount} of ${req.files.length} documents`,
      company: company.toUpperCase(),
      summary: {
        totalFiles: req.files.length,
        successfulFiles: successCount,
        failedFiles: errors.length,
        totalChunksProcessed: totalChunks
      },
      results: results,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('❌ Error in multi-document upload:', error);
    
    // Clean up any remaining files
    if (req.files) {
      req.files.forEach(file => {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      });
    }

    res.status(500).json({ 
      error: 'Multi-document upload failed',
      message: error.message
    });
  }
});

// Batch upload status endpoint
app.get('/api/upload-status/:company', async (req, res) => {
  try {
    const { company } = req.params;
    
    // Get document count for this company
    const stats = await index.describeIndexStats();
    
    // You could enhance this to query Pinecone for actual document counts
    // For now, return basic stats
    
    res.json({
      company: company.toUpperCase(),
      status: 'ready',
      totalDocuments: 'Available via database query',
      lastUpload: new Date().toISOString(),
      systemStatus: 'operational'
    });

  } catch (error) {
    res.status(500).json({ error: 'Failed to get upload status' });
  }
});

// Enhanced chat endpoint with production query intelligence
// Management chat endpoint for earnings prep
app.post('/api/management-chat', async (req, res) => {
  try {
    const { question, company } = req.body;
    
    if (!question) {
      return res.status(400).json({ error: 'Question is required' });
    }

    console.log('=== MANAGEMENT PREP REQUEST ===');
    console.log(`💼 Management Question: "${question}"`);
    console.log(`🏢 Company: "${company}"`);

    // Use the same enhanced search logic as the main chat
    const enhancedResults = await productionSearchWithIntelligence(question, company);
    
    if (enhancedResults.length === 0) {
      return res.json({
        answer: `I couldn't find any relevant information about ${company} for management prep.`,
        sources: []
      });
    }
    
    console.log(`📄 Found ${enhancedResults.length} relevant documents`);

    // Generate management-focused AI response
    const aiResponse = await generateManagementResponse(question, enhancedResults, company);
    
    console.log('✅ Management prep request completed successfully');
    
    res.json({
      answer: aiResponse.content,
      sources: aiResponse.sources
    });

  } catch (error) {
    console.error('❌ Management chat error:', error);
    res.status(500).json({ 
      error: 'Failed to process management question',
      details: error.message 
    });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { question, company } = req.body;
    
    if (!question || !company) {
      return res.status(400).json({ 
        error: 'Missing required fields',
        message: 'Both question and company are required' 
      });
    }

    console.log('=== NEW CHAT REQUEST ===');
    console.log(`💬 Question: "${question}"`);
    console.log(`🏢 Company: "${company}"`);

    // Check if this is a competitive analysis question
    const isCompQuestion = detectCompetitiveQuery(question);
    
    if (isCompQuestion && compAnalysis) {
      console.log('🔍 Detected competitive analysis question - fetching real-time data');
      
      try {
        const compData = await compAnalysis.generateCompAnalysis(company);
        const compResponse = await generateCompetitiveResponse(question, compData, company);
        
        return res.json({
          answer: compResponse.content,
          sources: compResponse.sources,
          type: 'competitive-analysis'
        });
      } catch (error) {
        console.log('⚠️  Comp analysis failed, falling back to document search');
      }
    }

    // Use production query intelligence system
    const enhancedResults = await productionSearchWithIntelligence(question, company);
    
    if (enhancedResults.length === 0) {
      return res.json({
        answer: `I couldn't find any relevant information about ${company} in the database.`,
        sources: [],
        confidence: 'low'
      });
    }

    console.log(`📄 Found ${enhancedResults.length} relevant documents`);

    const aiResponse = await generateAIResponse(enhancedResults, question, company);
    const sources = [...new Set(enhancedResults.map(doc => {
      return doc.metadata.sourceType === 'internal-document' 
        ? `Internal: ${doc.metadata.originalFilename || doc.metadata.source}`
        : doc.metadata.source;
    }))];
    
    console.log('✅ Chat request completed successfully');

    res.json({
      answer: aiResponse,
      sources: sources,
      confidence: 'high'
    });

  } catch (error) {
    console.error('❌ Error in chat endpoint:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Something went wrong processing your request'
    });
  }
});

// Investor-facing chat interface
// Management Earnings Prep Interface
// Investor Communication Templates Interface
// Meeting Notes & Follow-up Automation Interface
app.get('/meetings', (req, res) => {
  const company = req.query.company || 'CRWV';
  const companyName = req.query.name || 'CoreWeave';
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${companyName} Meeting Management</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
                min-height: 100vh;
                padding: 20px;
            }

            .meetings-container {
                max-width: 1400px;
                margin: 0 auto;
                background: white;
                border-radius: 16px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.15);
                overflow: hidden;
                min-height: 90vh;
                display: flex;
                flex-direction: column;
            }

            .meetings-header {
                background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
                color: white;
                padding: 32px;
                text-align: center;
            }

            .meetings-header h1 {
                font-size: 2rem;
                font-weight: 600;
                margin-bottom: 8px;
            }

            .meetings-header p {
                opacity: 0.9;
                font-size: 1.1rem;
            }

            .main-content {
                flex: 1;
                display: flex;
                min-height: 0;
            }

            .upload-section {
                flex: 1;
                padding: 32px;
                border-right: 1px solid #e1e5e9;
                background: #f8f9fa;
            }

            .analysis-section {
                flex: 1.2;
                padding: 32px;
                background: white;
                overflow-y: auto;
            }

            .section-title {
                font-size: 1.3rem;
                font-weight: 600;
                color: #2c3e50;
                margin-bottom: 24px;
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .upload-area {
                border: 3px dashed #3498db;
                border-radius: 12px;
                padding: 40px;
                text-align: center;
                background: white;
                margin-bottom: 24px;
                transition: all 0.3s ease;
                cursor: pointer;
            }

            .upload-area:hover {
                border-color: #2980b9;
                background: #f0f8ff;
            }

            .upload-area.dragover {
                border-color: #27ae60;
                background: #f0fff0;
            }

            .upload-icon {
                font-size: 3rem;
                color: #3498db;
                margin-bottom: 16px;
            }

            .upload-text {
                font-size: 1.1rem;
                color: #2c3e50;
                margin-bottom: 8px;
            }

            .upload-subtext {
                color: #7f8c8d;
                font-size: 0.9rem;
            }

            .form-group {
                margin-bottom: 20px;
            }

            .form-label {
                display: block;
                font-weight: 600;
                color: #2c3e50;
                margin-bottom: 8px;
                font-size: 1rem;
            }

            .form-input, .form-textarea, .form-select {
                width: 100%;
                padding: 12px;
                border: 2px solid #e1e5e9;
                border-radius: 8px;
                font-size: 1rem;
                font-family: inherit;
                outline: none;
                transition: border-color 0.3s ease;
                background: white;
            }

            .form-input:focus, .form-textarea:focus, .form-select:focus {
                border-color: #3498db;
            }

            .form-textarea {
                min-height: 120px;
                resize: vertical;
                font-family: 'Courier New', monospace;
            }

            .form-row {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 16px;
            }

            .analyze-button {
                background: linear-gradient(135deg, #2c3e50 0%, #3498db 100%);
                color: white;
                border: none;
                border-radius: 8px;
                padding: 14px 28px;
                font-size: 1rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.3s ease;
                width: 100%;
            }

            .analyze-button:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(52, 152, 219, 0.3);
            }

            .analyze-button:disabled {
                background: #bdc3c7;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }

            .analysis-card {
                background: #f8f9fa;
                border: 1px solid #e1e5e9;
                border-radius: 8px;
                padding: 20px;
                margin-bottom: 20px;
            }

            .analysis-card h3 {
                color: #2c3e50;
                margin-bottom: 12px;
                font-size: 1.1rem;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .analysis-content {
                color: #444;
                line-height: 1.6;
            }

            .action-item {
                background: white;
                border: 1px solid #f39c12;
                border-left: 4px solid #f39c12;
                border-radius: 4px;
                padding: 12px;
                margin-bottom: 8px;
            }

            .action-item strong {
                color: #e67e22;
            }

            .sentiment-indicator {
                display: inline-block;
                padding: 4px 12px;
                border-radius: 20px;
                font-size: 0.9rem;
                font-weight: 600;
                text-transform: uppercase;
            }

            .sentiment-positive { background: #d5f4e6; color: #27ae60; }
            .sentiment-neutral { background: #fef9e7; color: #f39c12; }
            .sentiment-negative { background: #fadbd8; color: #e74c3c; }

            .loading-spinner {
                display: none;
                justify-content: center;
                align-items: center;
                height: 200px;
            }

            .spinner {
                width: 40px;
                height: 40px;
                border: 4px solid #e1e5e9;
                border-top: 4px solid #3498db;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }

            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            .file-input {
                display: none;
            }

            @media (max-width: 768px) {
                .main-content {
                    flex-direction: column;
                }
                
                .upload-section {
                    border-right: none;
                    border-bottom: 1px solid #e1e5e9;
                }

                .form-row {
                    grid-template-columns: 1fr;
                }
            }
        </style>
    </head>
    <body>
        <div class="meetings-container">
            <div class="meetings-header">
                <h1>🤝 ${companyName} Meeting Management</h1>
                <p>Analyze investor meetings and automate follow-ups</p>
            </div>
            
            <div class="main-content">
                <div class="upload-section">
                    <div class="section-title">
                        📝 Meeting Input
                    </div>
                    
                    <div class="upload-area" id="uploadArea">
                        <div class="upload-icon">📄</div>
                        <div class="upload-text">Upload Meeting Notes or Transcript</div>
                        <div class="upload-subtext">Drag & drop files here or click to browse</div>
                        <input type="file" id="fileInput" class="file-input" accept=".txt,.pdf,.docx" multiple>
                    </div>

                    <form id="meetingForm">
                        <div class="form-row">
                            <div class="form-group">
                                <label class="form-label" for="meetingDate">Meeting Date</label>
                                <input type="date" id="meetingDate" class="form-input" required>
                            </div>
                            <div class="form-group">
                                <label class="form-label" for="meetingType">Meeting Type</label>
                                <select id="meetingType" class="form-select">
                                    <option value="earnings">Earnings Call Follow-up</option>
                                    <option value="roadshow">Roadshow Meeting</option>
                                    <option value="conference">Conference Meeting</option>
                                    <option value="one-on-one">One-on-One Meeting</option>
                                    <option value="group">Group Meeting</option>
                                    <option value="other">Other</option>
                                </select>
                            </div>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="attendees">Attendees</label>
                            <input type="text" id="attendees" class="form-input" 
                                   placeholder="John Smith (Goldman Sachs), Jane Doe (Fidelity)..." required>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="meetingNotes">Meeting Notes/Transcript</label>
                            <textarea id="meetingNotes" class="form-textarea" 
                                      placeholder="Paste meeting transcript or notes here..." required></textarea>
                        </div>

                        <button type="submit" class="analyze-button" id="analyzeBtn">
                            🔍 Analyze Meeting & Generate Follow-ups
                        </button>
                    </form>
                </div>
                
                <div class="analysis-section">
                    <div class="section-title">
                        📊 Meeting Analysis
                    </div>
                    
                    <div class="loading-spinner" id="loadingSpinner">
                        <div class="spinner"></div>
                    </div>
                    
                    <div id="analysisResults" style="display: none;">
                        <div class="analysis-card" id="summaryCard">
                            <h3>📋 Meeting Summary</h3>
                            <div class="analysis-content" id="summaryContent"></div>
                        </div>

                        <div class="analysis-card" id="sentimentCard">
                            <h3>😊 Investor Sentiment</h3>
                            <div class="analysis-content" id="sentimentContent"></div>
                        </div>

                        <div class="analysis-card" id="topicsCard">
                            <h3>💡 Key Topics Discussed</h3>
                            <div class="analysis-content" id="topicsContent"></div>
                        </div>

                        <div class="analysis-card" id="actionItemsCard">
                            <h3>✅ Action Items & Follow-ups</h3>
                            <div class="analysis-content" id="actionItemsContent"></div>
                        </div>

                        <div class="analysis-card" id="followUpCard">
                            <h3>📧 Suggested Follow-up Communication</h3>
                            <div class="analysis-content" id="followUpContent"></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            const company = '${company}';
            const companyName = '${companyName}';

            // File upload handling
            const uploadArea = document.getElementById('uploadArea');
            const fileInput = document.getElementById('fileInput');
            const meetingNotes = document.getElementById('meetingNotes');

            uploadArea.addEventListener('click', () => fileInput.click());

            uploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                uploadArea.classList.add('dragover');
            });

            uploadArea.addEventListener('dragleave', () => {
                uploadArea.classList.remove('dragover');
            });

            uploadArea.addEventListener('drop', (e) => {
                e.preventDefault();
                uploadArea.classList.remove('dragover');
                handleFiles(e.dataTransfer.files);
            });

            fileInput.addEventListener('change', (e) => {
                handleFiles(e.target.files);
            });

            async function handleFiles(files) {
                if (files.length > 0) {
                    const file = files[0];
                    const formData = new FormData();
                    formData.append('file', file);

                    try {
                        const response = await fetch('/api/extract-meeting-text', {
                            method: 'POST',
                            body: formData
                        });

                        if (response.ok) {
                            const data = await response.json();
                            meetingNotes.value = data.text;
                            uploadArea.innerHTML = '<div class="upload-icon">✅</div><div class="upload-text">File uploaded successfully</div>';
                        } else {
                            alert('Error uploading file. Please try again.');
                        }
                    } catch (error) {
                        alert('Error uploading file. Please try again.');
                    }
                }
            }

            // Form submission
            document.getElementById('meetingForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                
                const meetingDate = document.getElementById('meetingDate').value;
                const meetingType = document.getElementById('meetingType').value;
                const attendees = document.getElementById('attendees').value.trim();
                const notes = document.getElementById('meetingNotes').value.trim();
                
                if (!meetingDate || !attendees || !notes) {
                    alert('Please fill in all required fields');
                    return;
                }

                // Show loading
                document.getElementById('loadingSpinner').style.display = 'flex';
                document.getElementById('analysisResults').style.display = 'none';
                document.getElementById('analyzeBtn').disabled = true;

                try {
                    const response = await fetch('/api/analyze-meeting', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            company: company,
                            meetingDate: meetingDate,
                            meetingType: meetingType,
                            attendees: attendees,
                            notes: notes
                        })
                    });

                    const data = await response.json();
                    
                    // Hide loading
                    document.getElementById('loadingSpinner').style.display = 'none';
                    
                    if (response.ok) {
                        displayAnalysisResults(data);
                    } else {
                        alert('Error analyzing meeting. Please try again.');
                    }
                } catch (error) {
                    document.getElementById('loadingSpinner').style.display = 'none';
                    alert('Error connecting to server. Please try again.');
                } finally {
                    document.getElementById('analyzeBtn').disabled = false;
                }
            });

            function displayAnalysisResults(data) {
                document.getElementById('analysisResults').style.display = 'block';
                
                // Meeting Summary
                document.getElementById('summaryContent').innerHTML = data.summary || 'No summary available';
                
                // Sentiment
                const sentimentClass = 'sentiment-' + (data.sentiment?.overall || 'neutral');
                document.getElementById('sentimentContent').innerHTML = 
                    '<span class="sentiment-indicator ' + sentimentClass + '">' + 
                    (data.sentiment?.overall || 'Neutral') + '</span><br><br>' +
                    (data.sentiment?.analysis || 'No sentiment analysis available');
                
                // Key Topics
                if (data.topics && data.topics.length > 0) {
                    document.getElementById('topicsContent').innerHTML = 
                        data.topics.map(topic => '• ' + topic).join('<br>');
                } else {
                    document.getElementById('topicsContent').innerHTML = 'No key topics identified';
                }
                
                // Action Items
                if (data.actionItems && data.actionItems.length > 0) {
                    document.getElementById('actionItemsContent').innerHTML = 
                        data.actionItems.map(item => 
                            '<div class="action-item"><strong>Action:</strong> ' + item + '</div>'
                        ).join('');
                } else {
                    document.getElementById('actionItemsContent').innerHTML = 'No action items identified';
                }
                
                // Follow-up Communication
                document.getElementById('followUpContent').innerHTML = 
                    '<pre style="white-space: pre-wrap; font-family: inherit;">' + 
                    (data.followUpEmail || 'No follow-up suggested') + '</pre>';
            }

            // Set today's date as default
            document.getElementById('meetingDate').valueAsDate = new Date();
        </script>
    </body>
    </html>
  `);
});

app.get('/templates', (req, res) => {
  const company = req.query.company || 'CRWV';
  const companyName = req.query.name || 'CoreWeave';
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${companyName} Communication Templates</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                padding: 20px;
            }

            .templates-container {
                max-width: 1200px;
                margin: 0 auto;
                background: white;
                border-radius: 16px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.15);
                overflow: hidden;
                min-height: 90vh;
                display: flex;
                flex-direction: column;
            }

            .templates-header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 32px;
                text-align: center;
            }

            .templates-header h1 {
                font-size: 2rem;
                font-weight: 600;
                margin-bottom: 8px;
            }

            .templates-header p {
                opacity: 0.9;
                font-size: 1.1rem;
            }

            .main-content {
                flex: 1;
                display: flex;
                min-height: 0;
            }

            .input-section {
                flex: 1;
                padding: 32px;
                border-right: 1px solid #e1e5e9;
                background: #f8f9fa;
            }

            .output-section {
                flex: 1;
                padding: 32px;
                background: white;
                position: relative;
            }

            .section-title {
                font-size: 1.3rem;
                font-weight: 600;
                color: #2c3e50;
                margin-bottom: 24px;
                display: flex;
                align-items: center;
                gap: 12px;
            }

            .template-categories {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                gap: 16px;
                margin-bottom: 32px;
            }

            .template-category {
                background: white;
                border: 2px solid #e1e5e9;
                border-radius: 12px;
                padding: 20px;
                cursor: pointer;
                transition: all 0.3s ease;
                text-align: left;
            }

            .template-category:hover {
                border-color: #667eea;
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(102, 126, 234, 0.15);
            }

            .template-category.selected {
                border-color: #667eea;
                background: #f0f4ff;
            }

            .template-category h4 {
                color: #2c3e50;
                font-size: 1.1rem;
                margin-bottom: 8px;
            }

            .template-category p {
                color: #666;
                font-size: 0.9rem;
                line-height: 1.4;
            }

            .form-group {
                margin-bottom: 24px;
            }

            .form-label {
                display: block;
                font-weight: 600;
                color: #2c3e50;
                margin-bottom: 8px;
                font-size: 1rem;
            }

            .form-input, .form-textarea {
                width: 100%;
                padding: 16px;
                border: 2px solid #e1e5e9;
                border-radius: 12px;
                font-size: 1rem;
                font-family: inherit;
                outline: none;
                transition: border-color 0.3s ease;
                background: white;
            }

            .form-input:focus, .form-textarea:focus {
                border-color: #667eea;
            }

            .form-textarea {
                min-height: 120px;
                resize: vertical;
            }

            .form-select {
                width: 100%;
                padding: 16px;
                border: 2px solid #e1e5e9;
                border-radius: 12px;
                font-size: 1rem;
                font-family: inherit;
                outline: none;
                background: white;
                cursor: pointer;
            }

            .generate-button {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 12px;
                padding: 16px 32px;
                font-size: 1.1rem;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.3s ease;
                width: 100%;
            }

            .generate-button:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(102, 126, 234, 0.3);
            }

            .generate-button:disabled {
                background: #bdc3c7;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }

            .output-content {
                background: #f8f9fa;
                border: 2px solid #e1e5e9;
                border-radius: 12px;
                padding: 24px;
                min-height: 400px;
                font-family: 'Georgia', serif;
                line-height: 1.6;
                color: #2c3e50;
            }

            .output-content.empty {
                display: flex;
                align-items: center;
                justify-content: center;
                color: #7f8c8d;
                font-style: italic;
            }

            .copy-button {
                position: absolute;
                top: 32px;
                right: 32px;
                background: #27ae60;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 8px 16px;
                font-size: 0.9rem;
                cursor: pointer;
                transition: all 0.3s ease;
            }

            .copy-button:hover {
                background: #229954;
            }

            .loading-spinner {
                display: none;
                justify-content: center;
                align-items: center;
                height: 400px;
            }

            .spinner {
                width: 40px;
                height: 40px;
                border: 4px solid #e1e5e9;
                border-top: 4px solid #667eea;
                border-radius: 50%;
                animation: spin 1s linear infinite;
            }

            @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }

            @media (max-width: 768px) {
                .main-content {
                    flex-direction: column;
                }
                
                .input-section {
                    border-right: none;
                    border-bottom: 1px solid #e1e5e9;
                }

                .template-categories {
                    grid-template-columns: 1fr;
                }
            }
        </style>
    </head>
    <body>
        <div class="templates-container">
            <div class="templates-header">
                <h1>📧 ${companyName} Communication Templates</h1>
                <p>Generate professional investor communications instantly</p>
            </div>
            
            <div class="main-content">
                <div class="input-section">
                    <div class="section-title">
                        ⚙️ Template Generator
                    </div>
                    
                    <div class="template-categories">
                        <div class="template-category" data-category="earnings">
                            <h4>📊 Earnings & Financial</h4>
                            <p>Quarterly results, guidance updates, financial metrics discussions</p>
                        </div>
                        <div class="template-category" data-category="strategy">
                            <h4>🎯 Strategic Updates</h4>
                            <p>Business strategy, market positioning, competitive responses</p>
                        </div>
                        <div class="template-category" data-category="operations">
                            <h4>⚡ Operations & Performance</h4>
                            <p>Operational metrics, efficiency improvements, capacity updates</p>
                        </div>
                        <div class="template-category" data-category="general">
                            <h4>💬 General Inquiries</h4>
                            <p>Follow-ups, meeting requests, information sharing</p>
                        </div>
                    </div>

                    <form id="templateForm">
                        <div class="form-group">
                            <label class="form-label" for="situation">Situation Description</label>
                            <textarea 
                                id="situation" 
                                class="form-textarea" 
                                placeholder="Describe the investor inquiry or situation you need to respond to..."
                                required
                            ></textarea>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="audience">Audience Type</label>
                            <select id="audience" class="form-select">
                                <option value="institutional">Institutional Investors</option>
                                <option value="analysts">Sell-Side Analysts</option>
                                <option value="retail">Retail Investors</option>
                                <option value="media">Media/Press</option>
                                <option value="general">General Stakeholders</option>
                            </select>
                        </div>

                        <div class="form-group">
                            <label class="form-label" for="tone">Communication Tone</label>
                            <select id="tone" class="form-select">
                                <option value="professional">Professional & Formal</option>
                                <option value="conversational">Conversational & Warm</option>
                                <option value="confident">Confident & Assertive</option>
                                <option value="cautious">Cautious & Measured</option>
                            </select>
                        </div>

                        <button type="submit" class="generate-button" id="generateBtn">
                            ✨ Generate Communication
                        </button>
                    </form>
                </div>
                
                <div class="output-section">
                    <div class="section-title">
                        📝 Generated Communication
                    </div>
                    
                    <button class="copy-button" id="copyBtn" style="display: none;">
                        📋 Copy to Clipboard
                    </button>
                    
                    <div class="loading-spinner" id="loadingSpinner">
                        <div class="spinner"></div>
                    </div>
                    
                    <div class="output-content empty" id="outputContent">
                        Select a template category and describe your situation to generate a professional communication.
                    </div>
                </div>
            </div>
        </div>

        <script>
            const company = '${company}';
            const companyName = '${companyName}';
            let selectedCategory = '';

            // Category selection
            document.querySelectorAll('.template-category').forEach(category => {
                category.addEventListener('click', function() {
                    document.querySelectorAll('.template-category').forEach(c => c.classList.remove('selected'));
                    this.classList.add('selected');
                    selectedCategory = this.dataset.category;
                });
            });

            // Form submission
            document.getElementById('templateForm').addEventListener('submit', async function(e) {
                e.preventDefault();
                
                const situation = document.getElementById('situation').value.trim();
                const audience = document.getElementById('audience').value;
                const tone = document.getElementById('tone').value;
                
                if (!situation) {
                    alert('Please describe the situation');
                    return;
                }

                // Show loading
                document.getElementById('loadingSpinner').style.display = 'flex';
                document.getElementById('outputContent').style.display = 'none';
                document.getElementById('copyBtn').style.display = 'none';
                document.getElementById('generateBtn').disabled = true;

                try {
                    const response = await fetch('/api/generate-template', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            company: company,
                            category: selectedCategory || 'general',
                            situation: situation,
                            audience: audience,
                            tone: tone
                        })
                    });

                    const data = await response.json();
                    
                    // Hide loading
                    document.getElementById('loadingSpinner').style.display = 'none';
                    document.getElementById('outputContent').style.display = 'block';
                    document.getElementById('copyBtn').style.display = 'block';
                    
                    if (response.ok) {
                        document.getElementById('outputContent').innerHTML = data.template.replace(/\\n/g, '<br>');
                        document.getElementById('outputContent').classList.remove('empty');
                    } else {
                        document.getElementById('outputContent').innerHTML = 'Error generating template. Please try again.';
                    }
                } catch (error) {
                    // Hide loading
                    document.getElementById('loadingSpinner').style.display = 'none';
                    document.getElementById('outputContent').style.display = 'block';
                    document.getElementById('outputContent').innerHTML = 'Error connecting to server. Please try again.';
                } finally {
                    document.getElementById('generateBtn').disabled = false;
                }
            });

            // Copy to clipboard
            document.getElementById('copyBtn').addEventListener('click', function() {
                const content = document.getElementById('outputContent').innerText;
                navigator.clipboard.writeText(content).then(() => {
                    this.textContent = '✅ Copied!';
                    setTimeout(() => {
                        this.textContent = '📋 Copy to Clipboard';
                    }, 2000);
                });
            });
        </script>
    </body>
    </html>
  `);
});

app.get('/management', (req, res) => {
  const company = req.query.company || 'CRWV';
  const companyName = req.query.name || 'CoreWeave';
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${companyName} Management Prep Tool</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }

            .management-container {
                background: white;
                border-radius: 12px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.15);
                width: 100%;
                max-width: 1000px;
                height: 85vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            .management-header {
                background: linear-gradient(135deg, #2c3e50 0%, #34495e 100%);
                color: white;
                padding: 24px 32px;
                text-align: center;
                border-bottom: 3px solid #3498db;
            }

            .management-header h1 {
                font-size: 1.6rem;
                font-weight: 600;
                margin-bottom: 8px;
            }

            .management-header p {
                opacity: 0.9;
                font-size: 0.95rem;
            }

            .security-notice {
                background: #e74c3c;
                color: white;
                padding: 8px 16px;
                text-align: center;
                font-size: 0.85rem;
                font-weight: 500;
            }

            .chat-area {
                flex: 1;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            .chat-messages {
                flex: 1;
                overflow-y: auto;
                padding: 24px;
                background: #f8f9fa;
            }

            .welcome-message {
                text-align: center;
                color: #2c3e50;
                margin: 40px 0;
                padding: 0 20px;
            }

            .welcome-message h3 {
                color: #2c3e50;
                margin-bottom: 12px;
                font-size: 1.3rem;
            }

            .prep-categories {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                gap: 16px;
                margin-top: 24px;
            }

            .prep-category {
                background: white;
                border: 2px solid #e1e5e9;
                border-radius: 12px;
                padding: 20px;
                cursor: pointer;
                transition: all 0.3s ease;
                text-align: left;
            }

            .prep-category:hover {
                border-color: #3498db;
                transform: translateY(-2px);
                box-shadow: 0 8px 25px rgba(52, 152, 219, 0.15);
            }

            .prep-category h4 {
                color: #2c3e50;
                font-size: 1.1rem;
                margin-bottom: 8px;
            }

            .prep-category p {
                color: #666;
                font-size: 0.9rem;
                line-height: 1.4;
            }

            .message {
                display: flex;
                margin-bottom: 20px;
                align-items: flex-start;
            }

            .message.user {
                justify-content: flex-end;
            }

            .message-content {
                max-width: 75%;
                padding: 16px 20px;
                border-radius: 16px;
                font-size: 0.95rem;
                line-height: 1.5;
                white-space: pre-wrap;
            }

            .message.user .message-content {
                background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
                color: white;
                border-bottom-right-radius: 4px;
            }

            .message.bot .message-content {
                background: white;
                color: #2c3e50;
                border: 1px solid #e1e5e9;
                border-bottom-left-radius: 4px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.08);
            }

            .message-time {
                font-size: 0.75rem;
                color: #7f8c8d;
                margin-top: 6px;
                text-align: right;
            }

            .message.user .message-time {
                text-align: right;
                margin-right: 8px;
            }

            .message.bot .message-time {
                text-align: left;
                margin-left: 8px;
            }

            .input-container {
                padding: 24px 32px;
                background: white;
                border-top: 2px solid #e1e5e9;
                display: flex;
                gap: 16px;
                align-items: flex-end;
            }

            .input-wrapper {
                flex: 1;
                position: relative;
            }

            #messageInput {
                width: 100%;
                min-height: 50px;
                max-height: 120px;
                padding: 14px 18px;
                border: 2px solid #e1e5e9;
                border-radius: 25px;
                font-size: 1rem;
                font-family: inherit;
                resize: none;
                outline: none;
                transition: border-color 0.3s ease;
            }

            #messageInput:focus {
                border-color: #3498db;
            }

            #sendButton {
                background: linear-gradient(135deg, #3498db 0%, #2980b9 100%);
                color: white;
                border: none;
                border-radius: 50%;
                width: 50px;
                height: 50px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.3s ease;
                flex-shrink: 0;
            }

            #sendButton:hover {
                transform: scale(1.05);
                box-shadow: 0 6px 20px rgba(52, 152, 219, 0.3);
            }

            #sendButton:disabled {
                background: #bdc3c7;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }

            .typing-indicator {
                display: none;
                align-items: center;
                padding: 16px 20px;
                background: white;
                border: 1px solid #e1e5e9;
                border-radius: 16px;
                border-bottom-left-radius: 4px;
                max-width: 80px;
                margin-bottom: 20px;
            }

            .typing-dots {
                display: flex;
                gap: 4px;
            }

            .typing-dot {
                width: 8px;
                height: 8px;
                background: #7f8c8d;
                border-radius: 50%;
                animation: typing 1.4s infinite ease-in-out;
            }

            .typing-dot:nth-child(1) { animation-delay: -0.32s; }
            .typing-dot:nth-child(2) { animation-delay: -0.16s; }

            @keyframes typing {
                0%, 80%, 100% { 
                    transform: scale(0.8);
                    opacity: 0.5;
                }
                40% { 
                    transform: scale(1);
                    opacity: 1;
                }
            }
        </style>
    </head>
    <body>
        <div class="management-container">
            <div class="management-header">
                <h1>${companyName} Management Prep Tool</h1>
                <p>Confidential earnings call and investor meeting preparation</p>
            </div>
            
            <div class="security-notice">
                🔒 INTERNAL USE ONLY - Confidential Management Tool
            </div>
            
            <div class="chat-area">
                <div class="chat-messages" id="chatMessages">
                    <div class="welcome-message">
                        <h3>Management Earnings Call Prep</h3>
                        <p>This secure internal tool helps you prepare for earnings calls, analyst meetings, and investor questions. Ask about potential analyst questions, talking points, or strategic responses.</p>
                        
                        <div class="prep-categories">
                            <div class="prep-category" onclick="askQuestion('What difficult questions might analysts ask about our Q3 performance?')">
                                <h4>📊 Anticipated Questions</h4>
                                <p>Generate likely analyst questions based on recent performance and market conditions</p>
                            </div>
                            <div class="prep-category" onclick="askQuestion('Help me prepare talking points for margin compression concerns')">
                                <h4>💬 Talking Points</h4>
                                <p>Develop clear, consistent messaging for key topics and concerns</p>
                            </div>
                            <div class="prep-category" onclick="askQuestion('How should we address competitive threats in the earnings call?')">
                                <h4>🎯 Strategic Responses</h4>
                                <p>Craft responses to challenging questions about strategy and competition</p>
                            </div>
                            <div class="prep-category" onclick="askQuestion('What follow-up questions might come after discussing our growth guidance?')">
                                <h4>🔄 Follow-up Prep</h4>
                                <p>Anticipate second and third-level questions on complex topics</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <div class="typing-indicator" id="typingIndicator">
                    <div class="typing-dots">
                        <div class="typing-dot"></div>
                        <div class="typing-dot"></div>
                        <div class="typing-dot"></div>
                    </div>
                </div>
                
                <div class="input-container">
                    <div class="input-wrapper">
                        <textarea 
                            id="messageInput" 
                            placeholder="Ask about analyst questions, talking points, or strategic responses..."
                            rows="1"
                        ></textarea>
                    </div>
                    <button id="sendButton">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22,2 15,22 11,13 2,9"></polygon>
                        </svg>
                    </button>
                </div>
            </div>
        </div>

        <script>
            const chatMessages = document.getElementById('chatMessages');
            const messageInput = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            const typingIndicator = document.getElementById('typingIndicator');
            
            const company = '${company}';
            const companyName = '${companyName}';

            function formatTime() {
                return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }

            function addMessage(content, isUser) {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + (isUser ? 'user' : 'bot');
                
                const messageContent = document.createElement('div');
                messageContent.className = 'message-content';
                messageContent.textContent = content;
                
                const timeElement = document.createElement('div');
                timeElement.className = 'message-time';
                timeElement.textContent = formatTime();
                
                messageDiv.appendChild(messageContent);
                messageDiv.appendChild(timeElement);
                
                const welcomeMessage = document.querySelector('.welcome-message');
                if (welcomeMessage) {
                    welcomeMessage.remove();
                }
                
                chatMessages.appendChild(messageDiv);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }

            function showTyping() {
                typingIndicator.style.display = 'flex';
                chatMessages.appendChild(typingIndicator);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }

            function hideTyping() {
                typingIndicator.style.display = 'none';
            }

            async function sendMessage() {
                const message = messageInput.value.trim();
                if (!message) return;

                addMessage(message, true);
                messageInput.value = '';
                sendButton.disabled = true;
                showTyping();

                try {
                    const response = await fetch('/api/management-chat', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            question: message,
                            company: company
                        })
                    });

                    const data = await response.json();
                    hideTyping();
                    
                    if (response.ok) {
                        addMessage(data.answer, false);
                    } else {
                        addMessage('I apologize, but I encountered an error processing your question. Please try again.', false);
                    }
                } catch (error) {
                    hideTyping();
                    addMessage('I apologize, but I am having trouble connecting right now. Please try again in a moment.', false);
                } finally {
                    sendButton.disabled = false;
                    messageInput.focus();
                }
            }

            function askQuestion(question) {
                messageInput.value = question;
                sendMessage();
            }

            messageInput.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            });

            sendButton.addEventListener('click', function() {
                sendMessage();
            });

            messageInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });

            messageInput.focus();
        </script>
    </body>
    </html>
  `);
});

app.get('/investor', (req, res) => {
  // Default company or get from URL parameter: /investor?company=CRWV
  const company = req.query.company || 'CRWV';
  const companyName = req.query.name || 'CoreWeave';
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${companyName} - Investor Relations</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }

            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
                min-height: 100vh;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 20px;
            }

            .chat-container {
                background: white;
                border-radius: 16px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.1);
                width: 100%;
                max-width: 800px;
                height: 80vh;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }

            .header {
                background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
                color: white;
                padding: 24px;
                text-align: center;
                border-radius: 16px 16px 0 0;
            }

            .header h1 {
                font-size: 1.8rem;
                font-weight: 600;
                margin-bottom: 8px;
            }

            .header p {
                opacity: 0.9;
                font-size: 1rem;
            }

            .chat-messages {
                flex: 1;
                padding: 24px;
                overflow-y: auto;
                background: #fafbfc;
            }

            .message {
                margin-bottom: 20px;
                display: flex;
                flex-direction: column;
            }

            .message.user {
                align-items: flex-end;
            }

            .message.bot {
                align-items: flex-start;
            }

            .message-content {
                max-width: 80%;
                padding: 16px 20px;
                border-radius: 18px;
                font-size: 0.95rem;
                line-height: 1.5;
            }

            .message.user .message-content {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border-bottom-right-radius: 4px;
            }

            .message.bot .message-content {
                background: white;
                color: #333;
                border: 1px solid #e1e5e9;
                border-bottom-left-radius: 4px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                white-space: pre-wrap;
            }

            .message.bot .message-content p {
                margin: 0 0 12px 0;
            }

            .message.bot .message-content p:last-child {
                margin-bottom: 0;
            }

            .message.bot .message-content strong {
                color: #2c3e50;
                font-weight: 600;
            }

            .message.bot .message-content br {
                display: block;
                margin: 8px 0;
                line-height: 1;
            }

            .sources-container {
                margin-top: 12px;
                padding-top: 12px;
                border-top: 1px solid #e1e5e9;
            }

            .sources-toggle {
                background: #f8f9fa;
                border: 1px solid #e1e5e9;
                border-radius: 6px;
                padding: 8px 12px;
                font-size: 0.85rem;
                color: #666;
                cursor: pointer;
                transition: all 0.2s ease;
                outline: none;
            }

            .sources-toggle:hover {
                background: #e9ecef;
                border-color: #667eea;
                color: #333;
            }

            .sources-list {
                margin-top: 8px;
                padding: 8px 0;
            }

            .source-item {
                font-size: 0.8rem;
                color: #666;
                margin: 4px 0;
                padding-left: 8px;
                line-height: 1.4;
            }

            .message-time {
                font-size: 0.8rem;
                color: #666;
                margin-top: 4px;
                padding: 0 8px;
            }

            .sources {
                margin-top: 12px;
                padding-top: 12px;
                border-top: 1px solid #eee;
                font-size: 0.85rem;
                color: #666;
            }

            .sources-title {
                font-weight: 600;
                margin-bottom: 6px;
            }

            .source-item {
                margin-bottom: 2px;
                padding-left: 8px;
            }

            .input-container {
                padding: 20px 24px;
                background: white;
                border-top: 1px solid #e1e5e9;
                display: flex;
                gap: 12px;
                align-items: flex-end;
            }

            .input-wrapper {
                flex: 1;
                position: relative;
            }

            #messageInput {
                width: 100%;
                min-height: 44px;
                max-height: 120px;
                padding: 12px 16px;
                border: 2px solid #e1e5e9;
                border-radius: 22px;
                font-size: 1rem;
                font-family: inherit;
                resize: none;
                outline: none;
                transition: border-color 0.3s ease;
            }

            #messageInput:focus {
                border-color: #667eea;
            }

            #sendButton {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 50%;
                width: 44px;
                height: 44px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.3s ease;
                flex-shrink: 0;
            }

            #sendButton:hover {
                transform: scale(1.05);
                box-shadow: 0 6px 20px rgba(102, 126, 234, 0.3);
            }

            #sendButton:disabled {
                background: #ccc;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }

            .typing-indicator {
                display: none;
                align-items: center;
                padding: 16px 20px;
                background: white;
                border: 1px solid #e1e5e9;
                border-radius: 18px;
                border-bottom-left-radius: 4px;
                max-width: 80px;
                margin-bottom: 20px;
            }

            .typing-dots {
                display: flex;
                gap: 4px;
            }

            .typing-dot {
                width: 8px;
                height: 8px;
                background: #999;
                border-radius: 50%;
                animation: typing 1.4s infinite ease-in-out;
            }

            .typing-dot:nth-child(1) { animation-delay: -0.32s; }
            .typing-dot:nth-child(2) { animation-delay: -0.16s; }

            @keyframes typing {
                0%, 80%, 100% { 
                    transform: scale(0.8);
                    opacity: 0.5;
                }
                40% { 
                    transform: scale(1);
                    opacity: 1;
                }
            }

            .welcome-message {
                text-align: center;
                color: #666;
                margin: 40px 0;
                padding: 0 20px;
            }

            .welcome-message h3 {
                color: #333;
                margin-bottom: 8px;
                font-size: 1.2rem;
            }

            .example-questions {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                justify-content: center;
                margin-top: 20px;
            }

            .example-question {
                background: #f0f2f5;
                border: 1px solid #e1e5e9;
                border-radius: 20px;
                padding: 8px 16px;
                font-size: 0.9rem;
                cursor: pointer;
                transition: all 0.3s ease;
                color: #555;
            }

            .example-question:hover {
                background: #667eea;
                color: white;
                transform: translateY(-1px);
            }

            @media (max-width: 768px) {
                .chat-container {
                    height: 95vh;
                    max-width: 100%;
                    border-radius: 0;
                }
                
                .message-content {
                    max-width: 90%;
                }
                
                .header {
                    border-radius: 0;
                }
            }
        </style>
    </head>
    <body>
        <div class="chat-container">
            <div class="header">
                <h1>${companyName} Investor Relations</h1>
                <p>Ask questions about our company, financials, and strategy</p>
            </div>
            
            <div class="chat-messages" id="chatMessages">
                <div class="welcome-message">
                    <h3>Welcome to ${companyName} IR Assistant</h3>
                    <p>I can help you find information about our financial performance, strategy, and business operations. Try asking about our latest earnings, growth plans, or competitive position.</p>
                    
                    <div class="example-questions">
                        <div class="example-question" onclick="askQuestion('What was ${companyName} revenue in the latest quarter?')">Latest Revenue</div>
                        <div class="example-question" onclick="askQuestion('What are the main growth drivers for ${companyName}?')">Growth Strategy</div>
                        <div class="example-question" onclick="askQuestion('What are the biggest risks facing ${companyName}?')">Risk Factors</div>
                        <div class="example-question" onclick="askQuestion('How does ${companyName} compete in its market?')">Competitive Position</div>
                    </div>
                </div>
            </div>
            
            <div class="typing-indicator" id="typingIndicator">
                <div class="typing-dots">
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                </div>
            </div>
            
            <div class="input-container">
                <div class="input-wrapper">
                    <textarea 
                        id="messageInput" 
                        placeholder="Ask about ${companyName}'s financials, strategy, or business..."
                        rows="1"
                    ></textarea>
                </div>
                <button id="sendButton">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="22" y1="2" x2="11" y2="13"></line>
                        <polygon points="22,2 15,22 11,13 2,9"></polygon>
                    </svg>
                </button>
            </div>
        </div>

        <script>
            const chatMessages = document.getElementById('chatMessages');
            const messageInput = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            const typingIndicator = document.getElementById('typingIndicator');
            
            const company = '${company}';
            const companyName = '${companyName}';

            function formatTime() {
                return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }

            function addMessage(content, isUser) {
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message ' + (isUser ? 'user' : 'bot');
                
                const messageContent = document.createElement('div');
                messageContent.className = 'message-content';
                messageContent.textContent = content;
                
                const timeElement = document.createElement('div');
                timeElement.className = 'message-time';
                timeElement.textContent = formatTime();
                
                messageDiv.appendChild(messageContent);
                messageDiv.appendChild(timeElement);
                
                const welcomeMessage = document.querySelector('.welcome-message');
                if (welcomeMessage) {
                    welcomeMessage.remove();
                }
                
                chatMessages.appendChild(messageDiv);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }

            function showTyping() {
                typingIndicator.style.display = 'flex';
                chatMessages.appendChild(typingIndicator);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }

            function hideTyping() {
                typingIndicator.style.display = 'none';
            }

            async function sendMessage() {
                const message = messageInput.value.trim();
                if (!message) return;

                // Add user message
                addMessage(message, true);
                
                // Clear input and disable send button
                messageInput.value = '';
                sendButton.disabled = true;
                
                // Show typing indicator
                showTyping();

                try {
                    const response = await fetch('/api/chat', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            question: message,
                            company: company
                        })
                    });

                    const data = await response.json();
                    
                    // Hide typing indicator
                    hideTyping();
                    
                    if (response.ok) {
                        addMessage(data.answer, false);
                    } else {
                        addMessage('I apologize, but I encountered an error processing your question. Please try again.', false);
                    }
                } catch (error) {
                    hideTyping();
                    addMessage('I apologize, but I am having trouble connecting right now. Please try again in a moment.', false);
                } finally {
                    sendButton.disabled = false;
                    messageInput.focus();
                }
            }

            function askQuestion(question) {
                messageInput.value = question;
                sendMessage();
            }

            // Auto-resize textarea
            messageInput.addEventListener('input', function() {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            });

            // Send button click event
            sendButton.addEventListener('click', function() {
                sendMessage();
            });

            // Send on Enter (but not Shift+Enter)
            messageInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                }
            });

            // Focus input on load
            messageInput.focus();
        </script>
    </body>
    </html>
  `);
});

// Meeting analysis endpoints
app.post('/api/analyze-meeting', async (req, res) => {
  try {
    const { company, meetingDate, meetingType, attendees, notes } = req.body;
    
    if (!notes || !company || !attendees) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    console.log(`🔍 Analyzing meeting for ${company}...`);
    
    // Generate meeting analysis using AI
    const analysis = await analyzeMeetingContent(notes, company, meetingType, attendees);
    
    console.log('✅ Meeting analysis completed');
    
    res.json({
      success: true,
      analysis: analysis,
      ...analysis
    });

  } catch (error) {
    console.error('❌ Error analyzing meeting:', error);
    res.status(500).json({ 
      error: 'Meeting analysis failed',
      message: error.message
    });
  }
});

app.post('/api/extract-meeting-text', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`📄 Extracting text from ${req.file.originalname}...`);
    
    const extractedText = await extractTextFromFile(req.file.path, req.file.mimetype);
    
    // Clean up uploaded file
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    console.log(`✅ Extracted ${extractedText.length} characters`);
    
    res.json({
      success: true,
      text: extractedText,
      filename: req.file.originalname
    });

  } catch (error) {
    console.error('❌ Error extracting text:', error);
    
    // Clean up file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      error: 'Text extraction failed',
      message: error.message
    });
  }
});

// Meeting analysis AI functions
async function analyzeMeetingContent(notes, company, meetingType, attendees) {
  const analysisPrompt = `You are an expert investor relations analyst. Analyze this meeting transcript/notes and provide comprehensive insights.

MEETING DETAILS:
- Company: ${company}
- Type: ${meetingType}
- Attendees: ${attendees}

MEETING CONTENT:
${notes}

Provide a detailed analysis in JSON format with the following structure:
{
  "summary": "A concise 2-3 sentence summary of the key discussion points and outcomes",
  "sentiment": {
    "overall": "positive|neutral|negative",
    "analysis": "Detailed explanation of investor sentiment and tone"
  },
  "topics": ["List of key topics discussed"],
  "actionItems": ["List of specific action items and commitments made"],
  "followUpEmail": "Professional follow-up email template addressing key points and next steps"
}

Focus on:
1. Investor concerns and questions
2. Management responses and commitments
3. Strategic direction and outlook
4. Financial performance discussions
5. Risk factors mentioned
6. Specific action items requiring follow-up`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: analysisPrompt }],
      temperature: 0.3,
    });

    const analysisText = completion.choices[0].message.content;
    
    // Try to parse JSON response
    try {
      return JSON.parse(analysisText);
    } catch (parseError) {
      // If JSON parsing fails, return structured fallback
      return {
        summary: analysisText.substring(0, 500) + '...',
        sentiment: { overall: 'neutral', analysis: 'Analysis completed' },
        topics: ['Meeting analysis completed'],
        actionItems: ['Review meeting outcomes'],
        followUpEmail: `Subject: Follow-up on ${meetingType} Meeting

Dear ${attendees.split(',')[0]?.trim() || 'Team'},

Thank you for the productive ${meetingType} discussion. We will follow up on the key points discussed and provide updates as needed.

Best regards,
Investor Relations Team`
      };
    }
  } catch (error) {
    console.error('❌ Error in AI analysis:', error);
    throw error;
  }
}

async function extractTextFromFile(filePath, mimeType) {
  try {
    let extractedText = '';
    
    if (mimeType === 'application/pdf') {
      // Use pdf-parse for PDF files
      const pdf = require('pdf-parse');
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdf(dataBuffer);
      extractedText = pdfData.text;
      
    } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      // Use mammoth for DOCX files
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      extractedText = result.value;
      
    } else if (mimeType === 'text/plain') {
      // Read plain text files
      extractedText = fs.readFileSync(filePath, 'utf8');
      
    } else {
      throw new Error(`Unsupported file type: ${mimeType}`);
    }
    
    // Clean and validate extracted text
    extractedText = extractedText
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    
    if (extractedText.length < 50) {
      throw new Error('Insufficient text content extracted from file');
    }
    
    return extractedText;
    
  } catch (error) {
    console.error(`❌ Error extracting text from ${filePath}:`, error);
    throw error;
  }
}

// Start server
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    await initializePinecone();
    
    app.listen(PORT, () => {
      console.log('🚀 SimplifyIR Production Server Starting...');
      console.log('📊 Production Query Intelligence System Enabled...');
      console.log('📁 Document Upload Portal Ready...');
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Connected to Pinecone index: simplifyir`);
      console.log('');
      console.log('Available endpoints:');
      console.log(`  GET  http://localhost:${PORT}/api/health`);
      console.log(`  GET  http://localhost:${PORT}/api/companies`);
      console.log(`  POST http://localhost:${PORT}/api/chat`);
      console.log(`  POST http://localhost:${PORT}/api/upload-document`);
      console.log('');
      console.log('🎯 Production Features:');
      console.log('  • Multi-strategy query processing');
      console.log('  • Intent recognition and analysis');
      console.log('  • Source type balancing (SEC + Internal + Web)');
      console.log('  • Comprehensive document intelligence');
      console.log('  • PDF/DOCX document processing');
      console.log('  • Natural language query handling');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
