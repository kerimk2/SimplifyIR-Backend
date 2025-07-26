require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const OpenAI = require('openai');
const { Pinecone } = require('@pinecone-database/pinecone');

// File processing libraries
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

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

console.log('🔍 Pinecone Configuration Debug:');
console.log('API Key exists:', !!process.env.PINECONE_API_KEY);
console.log('API Key first 10 chars:', process.env.PINECONE_API_KEY?.substring(0, 10));
console.log('Environment:', process.env.PINECONE_ENVIRONMENT);
console.log('Project ID:', process.env.PINECONE_PROJECT_ID);
console.log('Project ID exists:', !!process.env.PINECONE_PROJECT_ID);

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
  environment: process.env.PINECONE_ENVIRONMENT,
});

let index;

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
    index = pinecone.Index('simplifyir');
    console.log('✅ Connected to Pinecone index: simplifyir');
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

  async processAndStore(filePath, originalName, company, documentType, description) {
    console.log(`📄 Processing uploaded document: ${originalName}`);
    
    try {
      // Extract text from file
      const content = await this.extractTextFromFile(filePath, originalName);
      console.log(`✅ Extracted ${content.length} characters from ${originalName}`);
      
      if (content.length < 100) {
        throw new Error('Document contains insufficient text content');
      }

      // Create metadata
      const baseMetadata = {
        company: company.toUpperCase(),
        source: `Internal Document - ${originalName}`,
        sourceType: 'internal-document',
        documentType: documentType || 'document',
        description: description || '',
        uploadDate: new Date().toISOString().split('T')[0],
        originalFilename: originalName
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
          
          vectors.push({
            id: `${company.toUpperCase()}-INTERNAL-${Date.now()}-${i}`,
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
        const searchOptions = {
          vector: queryEmbedding.data[0].embedding,
          filter: { company: company },
          topK: 4, // Fewer per strategy to get more diversity
          includeMetadata: true,
        };

        const searchResponse = await index.query(searchOptions);
        
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
async function generateAIResponse(documents, question, company) {
  const context = documents.map(doc => {
    const sourceLabel = doc.metadata.sourceType === 'internal-document' 
      ? `Internal Document: ${doc.metadata.originalFilename || doc.metadata.source}`
      : doc.metadata.source;
    return `Source: ${sourceLabel}\nContent: ${doc.metadata.content}`;
  }).join('\n\n---\n\n');
  
  const systemPrompt = `You are a financial analyst with access to comprehensive company information including SEC filings, public sources, and internal company documents. 

Provide accurate, professional responses based on the provided documents. When referencing internal documents, note that this information may be proprietary or forward-looking.

For internal documents, use phrases like "According to internal documents..." or "Based on company materials..."

CONTEXT FROM COMPANY DOCUMENTS:
${context}`;

  const userPrompt = `Answer this question about ${company}: ${question}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 1000,
      temperature: 0.1,
    });

    return response.choices[0].message.content;
    
  } catch (error) {
    console.error('❌ Error generating AI response:', error);
    throw error;
  }
}

// ROUTES

// Health check
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
    const { company, documentType, description } = req.body;
    
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
      description
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
    const { company, documentType, description } = req.body;
    
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
          description
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
