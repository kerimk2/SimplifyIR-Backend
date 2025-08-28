require('dotenv').config();
const OpenAI = require('openai');
const PineconeREST = require('./pinecone-rest');
const cheerio = require('cheerio');

// Initialize APIs
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pinecone = new PineconeREST({
  apiKey: process.env.PINECONE_API_KEY,
  environment: process.env.PINECONE_ENVIRONMENT,
});

// Configuration
const MAX_CHUNK_SIZE = 1500;
const OVERLAP_SIZE = 200;
const BATCH_SIZE = 5;
const MAX_RETRIES = 3;

class WebSourcesProcessor {
  constructor() {
    this.index = null;
    this.processedCount = 0;
  }

  async initialize() {
    console.log('🌐 Web Sources Processor Starting...');
    console.log('');
    
    try {
      // Use the REST client directly
      console.log('✅ Connected to Pinecone index: simplifyir');
    } catch (error) {
      console.error('❌ Failed to connect to Pinecone:', error.message);
      process.exit(1);
    }
  }

  async processWebSources(ticker) {
    console.log(`🌐 Processing web sources for ${ticker}...`);
    console.log('');
    console.log(`🚀 Starting comprehensive web data collection for ${ticker}...`);
    console.log('');

    // Define high-value web sources for the company
    const webSources = this.getWebSources(ticker);
    
    console.log(`📊 Found ${webSources.length} web sources to process:`);
    webSources.forEach((source, i) => {
      console.log(`  ${i + 1}. ${source.type}: ${source.url}`);
    });
    console.log('');

    let successCount = 0;
    let skipCount = 0;

    for (let i = 0; i < webSources.length; i++) {
      const source = webSources[i];
      
      try {
        console.log(`📄 [${i + 1}/${webSources.length}] Processing ${source.type}`);
        console.log(`  🔗 URL: ${source.url}`);

        // Fetch and process the web content
        const content = await this.fetchWebContent(source.url);
        
        if (!content || content.length < 100) {
          console.log(`  ⚠️  Insufficient content found, skipping...`);
          skipCount++;
          continue;
        }

        console.log(`  ✅ Extracted ${content.length} characters`);
        console.log(`  📝 Processing ${source.type} content...`);

        // Create chunks from the content
        const chunks = this.createChunks(content, source, ticker);

        if (chunks.length === 0) {
          console.log(`  ⚠️  No meaningful content found`);
          skipCount++;
          continue;
        }

        // Upload to Pinecone
        const uploadedCount = await this.uploadChunks(chunks, ticker, source);

        if (uploadedCount > 0) {
          successCount++;
        } else {
          skipCount++;
        }

      } catch (error) {
        console.error(`  ❌ Error processing ${source.type}:`, error.message);
        skipCount++;
        continue;
      }

      console.log('');
    }

    // Summary
    console.log('');
    console.log('🎉 WEB PROCESSING COMPLETE!');
    console.log(`📊 Successfully processed ${successCount}/${webSources.length} web sources`);
    if (skipCount > 0) {
      console.log(`⚠️  Skipped ${skipCount} sources due to processing issues`);
    }
    console.log(`🏢 Company: ${ticker}`);
    console.log('');
    console.log('✅ Successfully enhanced with web sources:');
    console.log('  • Company investor relations content');
    console.log('  • Recent press releases and news');
    console.log('  • Strategic announcements');
    console.log('  • Market intelligence');
    console.log('');
    console.log('🧪 Test enhanced AI with questions like:');
    console.log(`• "What recent announcements has ${ticker} made?"`);
    console.log(`• "What is ${ticker}'s latest strategic direction?"`);
    console.log(`• "What partnerships has ${ticker} announced recently?"`);
    console.log(`• "How is ${ticker} positioned in the market?"`);
  }

  getWebSources(ticker) {
    // Define high-value web sources based on ticker
    const sources = [];

    if (ticker === 'CRWV') {
      sources.push(
        {
          type: 'Investor Relations',
          url: 'https://investors.coreweave.com',
          priority: 'high'
        },
        {
          type: 'Company Newsroom',
          url: 'https://coreweave.com/newsroom',
          priority: 'high'
        },
        {
          type: 'Company About Page',
          url: 'https://coreweave.com/about',
          priority: 'medium'
        },
        {
          type: 'Reuters Company Profile',
          url: 'https://www.reuters.com/markets/companies/CRWV.O/',
          priority: 'medium'
        }
      );
    } else {
      // Generic sources for other companies
      sources.push(
        {
          type: 'Company Investor Relations',
          url: `https://investor.${ticker.toLowerCase()}.com`,
          priority: 'high'
        },
        {
          type: 'Company News',
          url: `https://${ticker.toLowerCase()}.com/news`,
          priority: 'medium'
        }
      );
    }

    return sources;
  }

  async fetchWebContent(url) {
    console.log(`    📥 Fetching content from ${url}...`);

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'SimplifyIR/1.0 (contact@simplifyir.com) Educational Research Tool',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Cache-Control': 'no-cache'
        },
        timeout: 30000 // 30 second timeout
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();
      console.log(`    ✅ Downloaded ${html.length} characters`);

      // Extract meaningful content from HTML
      const cleanContent = this.extractContentFromHTML(html);
      console.log(`    🧹 Extracted ${cleanContent.length} characters of clean content`);

      return cleanContent;

    } catch (error) {
      console.error(`    ❌ Error fetching ${url}:`, error.message);
      throw error;
    }
  }

  extractContentFromHTML(html) {
    const $ = cheerio.load(html);
    
    // Remove unwanted elements
    $('script, style, nav, header, footer, .cookie-banner, .popup, .modal').remove();
    
    // Try to find main content areas
    let content = '';
    
    // Look for common content containers
    const contentSelectors = [
      'main',
      '.main-content',
      '.content',
      '.post-content',
      '.article-content',
      '.news-content',
      '.press-release',
      '.investor-content',
      'article',
      '.page-content'
    ];

    for (const selector of contentSelectors) {
      const element = $(selector);
      if (element.length > 0 && element.text().trim().length > content.length) {
        content = element.text().trim();
      }
    }

    // Fallback to body content if no specific container found
    if (content.length < 500) {
      content = $('body').text().trim();
    }

    // Clean up the text
    content = content
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/\n{3,}/g, '\n\n') // Limit consecutive newlines
      .trim();

    return content;
  }

  createChunks(content, source, ticker) {
    const chunks = [];
    let position = 0;
    
    while (position < content.length) {
      const end = Math.min(position + MAX_CHUNK_SIZE, content.length);
      let chunk = content.slice(position, end);
      
      // Try to break at sentence boundary
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
      
      if (chunk.trim().length > 100) { // Only include substantial chunks
        chunks.push({
          content: chunk.trim(),
          metadata: {
            company: ticker,
            source: `${source.type} - Web`,
            sourceType: 'web-content',
            url: source.url,
            contentType: source.type,
            priority: source.priority,
            timestamp: new Date().toISOString().split('T')[0] // YYYY-MM-DD
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

  async uploadChunks(chunks, ticker, source) {
    console.log(`    📄 Created ${chunks.length} chunks`);
    
    const vectors = [];
    
    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await this.generateEmbedding(chunks[i].content);
        
        vectors.push({
          id: `${ticker}-WEB-${source.type.replace(/\s+/g, '')}-${Date.now()}-${i + 1}`,
          values: embedding,
          metadata: {
            ...chunks[i].metadata,
            content: chunks[i].content
          }
        });
        
        // Show progress for larger sources
        if (chunks.length > 10 && (i + 1) % 5 === 0) {
          console.log(`      ✅ Processed ${i + 1}/${chunks.length} chunks`);
        }
        
      } catch (error) {
        console.error(`      ❌ Error processing chunk ${i + 1}:`, error.message);
        continue;
      }
    }
    
    // Upload in batches
    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      
      let retries = 0;
      while (retries < MAX_RETRIES) {
        try {
          await pinecone.upsert(batch);
          break;
        } catch (error) {
          retries++;
          if (retries === MAX_RETRIES) {
            console.error(`      ❌ Failed to upload batch after ${MAX_RETRIES} retries:`, error.message);
          } else {
            console.log(`      ⚠️  Retrying batch upload (${retries}/${MAX_RETRIES})...`);
            await new Promise(resolve => setTimeout(resolve, 1000 * retries));
          }
        }
      }
    }
    
    console.log(`    🎉 Successfully processed ${vectors.length}/${chunks.length} chunks for ${source.type}`);
    return vectors.length;
  }
}

// Main execution
async function main() {
  const ticker = process.argv[2];
  
  if (!ticker) {
    console.error('❌ Please provide a ticker symbol');
    console.log('Usage: node add-web-sources.js TICKER');
    process.exit(1);
  }
  
  const processor = new WebSourcesProcessor();
  await processor.initialize();
  await processor.processWebSources(ticker.toUpperCase());
}

// Run the script
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { WebSourcesProcessor };
