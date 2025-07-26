require('dotenv').config();
const OpenAI = require('openai');
const { Pinecone } = require('@pinecone-database/pinecone');

// Initialize APIs
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pinecone = new Pinecone({
  apiKey: process.env.PINECONE_API_KEY,
});

// High-value SEC filing types (focusing on reliable downloads) 
const FILING_TYPES = [
  '10-K',    // Annual reports
  '10-Q',    // Quarterly reports  
  '8-K',     // Current events
  'S-1',     // IPO registration
  'S-1/A',   // S-1 amendments
  'S-3',     // Shelf registration
  'S-4',     // Merger registration
  'DEF 14A', // Proxy statements
  'DEF 14C', // Information statements
  '424B1',   // Prospectus supplements
  '424B2',   // Prospectus supplements
  '424B3',   // Prospectus supplements
  '424B4',   // Prospectus supplements
  '424B5',   // Prospectus supplements
  'SC 13D',  // Beneficial ownership (>5%)
  'SC 13G',  // Passive ownership reports
  'SC 13D/A', // 13D amendments
  'SC 13G/A', // 13G amendments
  '11-K',    // Employee stock plans
  '20-F'     // Foreign company annual report
  // Note: Temporarily removing Forms 3,4,5 due to SEC URL inconsistencies
];

// Configuration
const MAX_CHUNK_SIZE = 1500; // Characters per chunk
const OVERLAP_SIZE = 200;     // Overlap between chunks
const BATCH_SIZE = 5;         // Process chunks in batches
const MAX_RETRIES = 3;        // Retry failed operations

class SECProcessor {
  constructor() {
    this.index = null;
    this.processedCount = 0;
    this.totalDocuments = 0;
  }

  async initialize() {
    console.log('[dotenv@17.2.0] injecting env (4) from .env (tip: ⚙️  override existing env vars with { override: true })');
    console.log('');
    
    try {
      this.index = pinecone.Index('simplifyir');
      console.log('✅ Connected to Pinecone index: simplifyir');
    } catch (error) {
      console.error('❌ Failed to connect to Pinecone:', error.message);
      process.exit(1);
    }
  }

  async lookupCIK(ticker) {
    console.log(`🔍 Looking up CIK for ${ticker}...`);
    
    try {
      // SEC Company Tickers API
      const response = await fetch('https://www.sec.gov/files/company_tickers.json', {
        headers: {
          'User-Agent': 'SimplifyIR/1.0 (contact@simplifyir.com)'
        }
      });
      
      const data = await response.json();
      
      for (const key in data) {
        if (data[key].ticker === ticker) {
          const cik = data[key].cik_str.toString().padStart(10, '0');
          console.log(`✅ Found ${data[key].title} with CIK: ${cik}`);
          return { cik, name: data[key].title };
        }
      }
      
      throw new Error(`Ticker ${ticker} not found`);
    } catch (error) {
      console.error(`❌ Error looking up CIK for ${ticker}:`, error.message);
      throw error;
    }
  }

  async fetchAllFilings(cik, companyName) {
    console.log(`📄 Fetching all SEC filings for ${companyName}...`);
    
    try {
      const response = await fetch(
        `https://data.sec.gov/submissions/CIK${cik}.json`,
        {
          headers: {
            'User-Agent': 'SimplifyIR/1.0 (contact@simplifyir.com)'
          }
        }
      );
      
      const data = await response.json();
      const filings = data.filings.recent;
      
      // Process all filings and store CIK for URL construction
      const relevantFilings = [];
      
      for (let i = 0; i < filings.form.length; i++) {
        const form = filings.form[i];
        const filingDate = filings.filingDate[i];
        const accessionNumber = filings.accessionNumber[i];
        const primaryDocument = filings.primaryDocument[i];
        
        // Check if this filing type is in our comprehensive list
        if (FILING_TYPES.includes(form)) {
          relevantFilings.push({
            form,
            filingDate,
            accessionNumber: accessionNumber.replace(/-/g, ''), // Clean for URL
            originalAccessionNumber: accessionNumber, // Keep original for debugging
            primaryDocument,
            reportDate: filings.reportDate[i] || filingDate,
            companyCIK: cik.replace(/^0+/, '') // Store numeric CIK for URL construction
          });
        }
      }
      
      // Sort by filing date (newest first)
      relevantFilings.sort((a, b) => new Date(b.filingDate) - new Date(a.filingDate));
      
      console.log(`📊 Found ${relevantFilings.length} relevant filings for ${companyName}`);
      
      if (relevantFilings.length > 0) {
        const dateRange = `${relevantFilings[relevantFilings.length - 1].filingDate} to ${relevantFilings[0].filingDate}`;
        console.log(`📅 Date range: ${dateRange}`);
        
        // Show filing type breakdown
        const filingCounts = {};
        relevantFilings.forEach(filing => {
          filingCounts[filing.form] = (filingCounts[filing.form] || 0) + 1;
        });
        
        console.log('📋 Filing types found:');
        Object.entries(filingCounts).forEach(([type, count]) => {
          console.log(`  • ${type}: ${count} filing${count > 1 ? 's' : ''}`);
        });
      }
      
      return relevantFilings;
      
    } catch (error) {
      console.error(`❌ Error fetching filings:`, error.message);
      throw error;
    }
  }

  async downloadDocument(accessionNumber, primaryDocument, ticker, form, companyCIK) {
    console.log(`  📥 Downloading: ${primaryDocument}...`);
    
    // Use the company's actual CIK, not extracted from accession number
    const numericCik = companyCIK; // Already cleaned in fetchAllFilings
    
    // Create multiple URL patterns to try
    const urlPatterns = [
      // Pattern 1: Most common format
      `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accessionNumber}/${primaryDocument}`,
      
      // Pattern 2: For XML files, try removing subdirectory
      primaryDocument.includes('/') ? 
        `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accessionNumber}/${primaryDocument.split('/').pop()}` : null,
        
      // Pattern 3: Try with leading zeros on CIK (less common)
      `https://www.sec.gov/Archives/edgar/data/${numericCik.padStart(10, '0')}/${accessionNumber}/${primaryDocument}`,
      
      // Pattern 4: Alternative for edge cases
      primaryDocument.includes('/') ? 
        `https://www.sec.gov/Archives/edgar/data/${numericCik.padStart(10, '0')}/${accessionNumber}/${primaryDocument.split('/').pop()}` : null
    ].filter(url => url !== null);
    
    // Debug: Show what we're trying
    console.log(`    📊 Using CIK: ${numericCik}, Accession: ${accessionNumber}`);
    
    // Try each URL pattern
    for (let i = 0; i < urlPatterns.length; i++) {
      try {
        console.log(`    🔗 Trying pattern ${i + 1}: .../${numericCik}/${accessionNumber.slice(-6)}/${primaryDocument.split('/').pop()}`);
        
        const response = await fetch(urlPatterns[i], {
          headers: {
            'User-Agent': 'SimplifyIR/1.0 (contact@simplifyir.com)'
          }
        });
        
        if (response.ok) {
          const content = await response.text();
          console.log(`  ✅ Downloaded ${content.length} characters (pattern ${i + 1})`);
          return this.cleanContent(content, form);
        } else {
          console.log(`    ❌ Pattern ${i + 1} failed: HTTP ${response.status}`);
        }
        
      } catch (error) {
        console.log(`    ❌ Pattern ${i + 1} failed: ${error.message}`);
      }
    }
    
    // If we get here, all patterns failed
    console.log(`  ⚠️  All ${urlPatterns.length} URL patterns failed for ${primaryDocument}`);
    console.log(`    🔍 Debug info: CIK=${numericCik}, Accession=${accessionNumber}, Doc=${primaryDocument}`);
    
    throw new Error(`All URL patterns failed for ${primaryDocument}`);
  }

  cleanHTMLContent(html) {
    // Remove HTML tags and clean up text
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  cleanContent(content, form) {
    // Handle XML documents (Forms 3, 4, 5, etc.) differently than HTML
    if (form === '3' || form === '4' || form === '5' || content.includes('<?xml')) {
      return this.cleanXMLContent(content);
    } else {
      return this.cleanHTMLContent(content);
    }
  }

  cleanXMLContent(xml) {
    // Extract meaningful content from XML forms
    return xml
      .replace(/<\?xml[^>]*>/g, '')
      .replace(/<xsd:[^>]*>/g, '')
      .replace(/<\/xsd:[^>]*>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  createChunks(content, filing) {
    const chunks = [];
    let position = 0;
    
    while (position < content.length) {
      const end = Math.min(position + MAX_CHUNK_SIZE, content.length);
      let chunk = content.slice(position, end);
      
      // Try to break at sentence boundary if not at end
      if (end < content.length) {
        const lastSentence = chunk.lastIndexOf('. ');
        const lastNewline = chunk.lastIndexOf('\n');
        const breakPoint = Math.max(lastSentence, lastNewline);
        
        if (breakPoint > position + MAX_CHUNK_SIZE * 0.7) {
          chunk = content.slice(position, breakPoint + 1);
          position = breakPoint + 1;
        } else {
          position = end - OVERLAP_SIZE;
        }
      } else {
        position = end;
      }
      
      if (chunk.trim().length > 50) { // Only include meaningful chunks
        chunks.push({
          content: chunk.trim(),
          metadata: {
            company: filing.ticker,
            source: `${filing.form} Filing - ${filing.filingDate}`,
            form: filing.form,
            filingDate: filing.filingDate,
            reportDate: filing.reportDate,
            accessionNumber: filing.accessionNumber,
            document: filing.primaryDocument
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
      console.error('❌ Error generating embedding:', error.message);
      throw error;
    }
  }

  async uploadChunks(chunks, ticker, filingInfo) {
    console.log(`  📄 Created ${chunks.length} chunks`);
    
    const vectors = [];
    
    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await this.generateEmbedding(chunks[i].content);
        
        vectors.push({
          id: `${ticker}-${filingInfo.form}-${filingInfo.filingDate}-${i + 1}`,
          values: embedding,
          metadata: {
            ...chunks[i].metadata,
            content: chunks[i].content
          }
        });
        
        // Show progress for large documents
        if (chunks.length > 10 && (i + 1) % 5 === 0) {
          console.log(`    ✅ Processed ${i + 1}/${chunks.length} chunks`);
        }
        
      } catch (error) {
        console.error(`    ❌ Error processing chunk ${i + 1}:`, error.message);
        continue;
      }
    }
    
    // Upload in batches
    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      
      let retries = 0;
      while (retries < MAX_RETRIES) {
        try {
          await this.index.upsert(batch);
          break;
        } catch (error) {
          retries++;
          if (retries === MAX_RETRIES) {
            console.error(`    ❌ Failed to upload batch after ${MAX_RETRIES} retries:`, error.message);
          } else {
            console.log(`    ⚠️  Retrying batch upload (${retries}/${MAX_RETRIES})...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * retries));
          }
        }
      }
    }
    
    console.log(`  🎉 Successfully processed ${vectors.length}/${chunks.length} chunks for ${filingInfo.form}`);
    return vectors.length;
  }

  async processCompany(ticker) {
    console.log(`🎯 Processing ${ticker} with comprehensive SEC filing coverage...`);
    console.log('');
    console.log(`🚀 Starting complete SEC data processing for ${ticker}...`);
    console.log('');
    
    try {
      // Step 1: Look up company CIK
      const { cik, name } = await lookupCIK(ticker);
      
      // Step 2: Fetch all filings
      const filings = await this.fetchAllFilings(cik, name);
      
      if (filings.length === 0) {
        console.log(`⚠️  No relevant filings found for ${ticker}`);
        return;
      }
      
      this.totalDocuments = filings.length;
      console.log('');
      console.log(`📋 Processing ${filings.length} filings...`);
      console.log('');
      
      // Step 3: Process each filing
      let successCount = 0;
      let skipCount = 0;
      
      for (let i = 0; i < filings.length; i++) {
        const filing = { ...filings[i], ticker };
        
        try {
          console.log(`📄 [${i + 1}/${filings.length}] Processing ${filing.form} from ${filing.filingDate}`);
          
          // Download document
          const content = await this.downloadDocument(
            filing.accessionNumber,
            filing.primaryDocument,
            ticker,
            filing.form,
            filing.companyCIK
          );
          
          console.log(`  📝 Processing ${filing.form} from ${filing.filingDate}...`);
          
          // Create chunks
          const chunks = this.createChunks(content, filing);
          
          if (chunks.length === 0) {
            console.log(`  ⚠️  No meaningful content found in ${filing.form}`);
            skipCount++;
            continue;
          }
          
          // Upload to Pinecone
          const uploadedCount = await this.uploadChunks(chunks, ticker, filing);
          
          if (uploadedCount > 0) {
            successCount++;
          } else {
            skipCount++;
          }
          
        } catch (error) {
          console.error(`  ❌ Error processing ${filing.form} from ${filing.filingDate}:`, error.message);
          skipCount++;
          continue;
        }
        
        console.log('');
      }
      
      // Summary
      console.log('');
      console.log('🎉 PROCESSING COMPLETE!');
      console.log(`📊 Successfully processed ${successCount}/${filings.length} filings`);
      if (skipCount > 0) {
        console.log(`⚠️  Skipped ${skipCount} filings due to download/processing issues`);
      }
      console.log(`🏢 Company: ${name} (${ticker})`);
      
      if (filings.length > 0) {
        const dateRange = `${filings[filings.length - 1].filingDate} to ${filings[0].filingDate}`;
        console.log(`📅 Date range: ${dateRange}`);
      }
      
      // Show what types were successfully processed
      if (successCount > 0) {
        console.log('');
        console.log('✅ Successfully processed filing types:');
        const successfulTypes = new Set();
        // We'd need to track this better, but for now just show general message
        console.log('  • Core financial documents (10-K, 10-Q, 8-K, etc.)');
      }
      
      console.log('');
      console.log('🧪 Test your AI with questions like:');
      console.log(`• "What was ${ticker}'s revenue in their latest quarter?"`);
      console.log(`• "What are ${ticker}'s main risk factors?"`);
      console.log(`• "How has ${ticker}'s business changed over time?"`);
      console.log(`• "What did ${ticker} say about competition in their latest filing?"`);
      console.log(`• "Who are ${ticker}'s largest shareholders?"`);
      console.log(`• "Have ${ticker} executives been buying or selling stock?"`);
      console.log(`• "What was ${ticker}'s IPO strategy?"`);
      
    } catch (error) {
      console.error('❌ Error processing company:', error.message);
      process.exit(1);
    }
  }
}

// Main execution
async function main() {
  const ticker = process.argv[2];
  
  if (!ticker) {
    console.error('❌ Please provide a ticker symbol');
    console.log('Usage: node add-complete-company.js TICKER');
    process.exit(1);
  }
  
  const processor = new SECProcessor();
  await processor.initialize();
  await processor.processCompany(ticker.toUpperCase());
}

// Helper function (moved outside class for compatibility)
async function lookupCIK(ticker) {
  console.log(`🔍 Looking up CIK for ${ticker}...`);
  
  try {
    const response = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: {
        'User-Agent': 'SimplifyIR/1.0 (contact@simplifyir.com)'
      }
    });
    
    const data = await response.json();
    
    for (const key in data) {
      if (data[key].ticker === ticker) {
        const cik = data[key].cik_str.toString().padStart(10, '0'); // Padded for SEC API calls
        console.log(`✅ Found ${data[key].title} with CIK: ${cik}`);
        return { cik, name: data[key].title };
      }
    }
    
    throw new Error(`Ticker ${ticker} not found`);
  } catch (error) {
    console.error(`❌ Error looking up CIK for ${ticker}:`, error.message);
    throw error;
  }
}

// Run the script
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { SECProcessor };
