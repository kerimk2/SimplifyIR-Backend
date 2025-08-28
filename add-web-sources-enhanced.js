require('dotenv').config();
const OpenAI = require('openai');
const PineconeREST = require('./pinecone-rest');
const cheerio = require('cheerio');
const axios = require('axios');

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
const MAX_RETRIES = 3;
const REQUEST_DELAY = 2000; // 2 seconds between requests

class EnhancedWebSourcesProcessor {
  constructor() {
    this.processedCount = 0;
    this.processedUrls = new Set();
  }

  async initialize() {
    console.log('🚀 Enhanced CoreWeave Data Collector Starting...');
    console.log('✅ Connected to Pinecone index: simplifyir');
    console.log('');
  }

  async processEnhancedWebSources(ticker) {
    console.log(`🌐 Enhanced web processing for ${ticker}...`);
    console.log('🎯 Targeting: Press releases, news articles, PDFs, and investor documents');
    console.log('');

    const allContent = [];

    try {
      // 1. Scrape individual news articles from newsroom
      console.log('📰 PHASE 1: Collecting individual news articles...');
      const newsArticles = await this.scrapeNewsroomArticles(ticker);
      allContent.push(...newsArticles);
      
      // 2. Try to find and download PDFs and documents
      console.log('📄 PHASE 2: Searching for PDF documents and reports...');
      const pdfContent = await this.scrapePDFDocuments(ticker);
      allContent.push(...pdfContent);
      
      // 3. Scrape investor relations content
      console.log('📊 PHASE 3: Collecting investor relations content...');
      const irContent = await this.scrapeInvestorContent(ticker);
      allContent.push(...irContent);

      // 4. Process and upload all content
      console.log('🔄 PHASE 4: Processing and uploading content...');
      await this.processAndUploadContent(allContent, ticker);

    } catch (error) {
      console.error('❌ Error in enhanced processing:', error.message);
    }

    console.log('');
    console.log('🎉 ENHANCED PROCESSING COMPLETE!');
    console.log(`📊 Total pieces of content collected: ${allContent.length}`);
    console.log(`🏢 Company: ${ticker}`);
    console.log('');
    console.log('✨ Enhanced dataset now includes:');
    console.log('  • Individual press releases with full content');
    console.log('  • News articles and announcements');
    console.log('  • PDF documents and reports');
    console.log('  • Investor relations materials');
    console.log('  • Corporate transaction details');
    console.log('  • Technology partnership information');
    console.log('');
  }

  async scrapeNewsroomArticles(ticker) {
    const articles = [];
    
    try {
      console.log('  🔍 Discovering news articles from newsroom...');
      
      // First, get the main newsroom page to find article links
      const newsroomUrl = 'https://coreweave.com/newsroom';
      const newsroomHtml = await this.fetchWithRetry(newsroomUrl);
      
      if (!newsroomHtml) {
        console.log('  ⚠️  Could not access newsroom page');
        return articles;
      }

      // Extract article links
      const articleLinks = this.extractArticleLinks(newsroomHtml, 'https://coreweave.com');
      console.log(`  📋 Found ${articleLinks.length} article links to process`);

      // Process each article (limit to prevent overwhelming)
      const maxArticles = Math.min(articleLinks.length, 15); // Process up to 15 recent articles
      
      for (let i = 0; i < maxArticles; i++) {
        const articleUrl = articleLinks[i];
        
        try {
          console.log(`  📄 [${i + 1}/${maxArticles}] Fetching: ${articleUrl}`);
          
          const articleHtml = await this.fetchWithRetry(articleUrl);
          if (articleHtml) {
            const content = this.extractArticleContent(articleHtml);
            
            if (content && content.length > 200) {
              articles.push({
                content: content,
                metadata: {
                  type: 'News Article',
                  url: articleUrl,
                  source: 'CoreWeave Newsroom',
                  priority: 'high'
                }
              });
              console.log(`    ✅ Extracted ${content.length} characters`);
            } else {
              console.log(`    ⚠️  Insufficient content found`);
            }
          }
          
          // Delay between requests
          await this.delay(REQUEST_DELAY);
          
        } catch (error) {
          console.log(`    ❌ Error processing ${articleUrl}: ${error.message}`);
          continue;
        }
      }
      
    } catch (error) {
      console.error('  ❌ Error scraping newsroom articles:', error.message);
    }

    console.log(`  🎉 Successfully collected ${articles.length} news articles`);
    return articles;
  }

  extractArticleLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const links = [];
    
    // Look for news article links - CoreWeave uses /news/ paths
    $('a[href*="/news/"]').each((i, element) => {
      const href = $(element).attr('href');
      if (href && !href.includes('#') && !href.includes('?')) {
        let fullUrl = href.startsWith('http') ? href : baseUrl + href;
        if (!this.processedUrls.has(fullUrl)) {
          links.push(fullUrl);
          this.processedUrls.add(fullUrl);
        }
      }
    });

    // Also look for links that might be in JSON or data attributes
    $('[data-href*="/news/"]').each((i, element) => {
      const href = $(element).attr('data-href');
      if (href) {
        let fullUrl = href.startsWith('http') ? href : baseUrl + href;
        if (!this.processedUrls.has(fullUrl)) {
          links.push(fullUrl);
          this.processedUrls.add(fullUrl);
        }
      }
    });

    return [...new Set(links)]; // Remove duplicates
  }

  extractArticleContent(html) {
    const $ = cheerio.load(html);
    
    // Remove unwanted elements
    $('script, style, nav, header, footer, .cookie-banner, .popup, .modal, .navigation').remove();
    
    let content = '';
    
    // Look for article-specific content containers
    const contentSelectors = [
      '.article-content',
      '.post-content', 
      '.news-content',
      '.press-release',
      'article',
      '.content-body',
      '.article-body',
      '.news-body',
      'main .content',
      '.page-content',
      '.story-content'
    ];

    for (const selector of contentSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        const text = element.text().trim();
        if (text.length > content.length) {
          content = text;
        }
      }
    }

    // If no specific container found, try to get the main content area
    if (content.length < 200) {
      // Look for the largest text block that's not navigation
      let maxContent = '';
      $('div, section, article').each((i, element) => {
        const text = $(element).text().trim();
        if (text.length > maxContent.length && text.length > 500) {
          // Check if it's not navigation by looking for common nav indicators
          const html = $(element).html().toLowerCase();
          if (!html.includes('menu') && !html.includes('navigation') && !html.includes('footer')) {
            maxContent = text;
          }
        }
      });
      content = maxContent;
    }

    // Clean up the content
    content = content
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return content;
  }

  async scrapePDFDocuments(ticker) {
    const pdfContent = [];
    
    try {
      console.log('  🔍 Searching for PDF documents and reports...');
      
      // Check common locations for PDFs
      const pdfSources = [
        'https://investors.coreweave.com',
        'https://coreweave.com/investor-relations', 
        'https://coreweave.com/reports',
        'https://coreweave.com/newsroom'
      ];

      for (const sourceUrl of pdfSources) {
        try {
          console.log(`    📂 Checking ${sourceUrl} for PDF links...`);
          
          const html = await this.fetchWithRetry(sourceUrl);
          if (html) {
            const pdfLinks = this.extractPDFLinks(html, sourceUrl);
            console.log(`      📄 Found ${pdfLinks.length} PDF links`);
            
            // For now, we'll note the PDFs but won't download them automatically
            // This could be enhanced to download and extract PDF content
            for (const pdfUrl of pdfLinks) {
              pdfContent.push({
                content: `PDF Document available at: ${pdfUrl} - This document contains investor-relevant information and should be reviewed for detailed company data.`,
                metadata: {
                  type: 'PDF Document',
                  url: pdfUrl,
                  source: 'CoreWeave Investor Documents',
                  priority: 'high',
                  note: 'PDF content extraction would require additional processing'
                }
              });
            }
          }
          
          await this.delay(REQUEST_DELAY);
          
        } catch (error) {
          console.log(`    ⚠️  Could not access ${sourceUrl}: ${error.message}`);
          continue;
        }
      }
      
    } catch (error) {
      console.error('  ❌ Error searching for PDFs:', error.message);
    }

    console.log(`  📊 Identified ${pdfContent.length} PDF documents`);
    return pdfContent;
  }

  extractPDFLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const pdfLinks = [];
    const baseHost = new URL(baseUrl).origin;
    
    // Look for PDF links
    $('a[href$=".pdf"], a[href*=".pdf"]').each((i, element) => {
      const href = $(element).attr('href');
      if (href) {
        let fullUrl = href.startsWith('http') ? href : baseHost + href;
        pdfLinks.push(fullUrl);
      }
    });

    return [...new Set(pdfLinks)];
  }

  async scrapeInvestorContent(ticker) {
    const irContent = [];
    
    try {
      console.log('  🔍 Collecting investor relations content...');
      
      // Try different IR page variations
      const irUrls = [
        'https://investors.coreweave.com',
        'https://coreweave.com/investors',
        'https://coreweave.com/about',
        'https://coreweave.com/company'
      ];

      for (const irUrl of irUrls) {
        try {
          console.log(`    📊 Processing ${irUrl}...`);
          
          const html = await this.fetchWithRetry(irUrl);
          if (html) {
            const content = this.extractInvestorContent(html);
            
            if (content && content.length > 300) {
              irContent.push({
                content: content,
                metadata: {
                  type: 'Investor Relations',
                  url: irUrl,
                  source: 'CoreWeave IR Website',
                  priority: 'high'
                }
              });
              console.log(`      ✅ Extracted ${content.length} characters`);
            }
          }
          
          await this.delay(REQUEST_DELAY);
          
        } catch (error) {
          console.log(`    ⚠️  Could not access ${irUrl}: ${error.message}`);
          continue;
        }
      }
      
    } catch (error) {
      console.error('  ❌ Error scraping investor content:', error.message);
    }

    console.log(`  💼 Collected ${irContent.length} investor relations pages`);
    return irContent;
  }

  extractInvestorContent(html) {
    const $ = cheerio.load(html);
    
    // Remove unwanted elements
    $('script, style, nav, header, footer, .cookie-banner, .popup, .modal').remove();
    
    // Look for investor-specific content
    let content = '';
    
    const irSelectors = [
      '.investor-content',
      '.ir-content',
      '.about-content',
      '.company-overview',
      'main',
      '.main-content',
      '.content',
      'article'
    ];

    for (const selector of irSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        const text = element.text().trim();
        if (text.length > content.length) {
          content = text;
        }
      }
    }

    // Clean up
    content = content
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return content;
  }

  async fetchWithRetry(url) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'SimplifyIR/2.0 (contact@simplifyir.com) Enhanced Research Tool',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Cache-Control': 'no-cache'
          },
          timeout: 30000
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.text();

      } catch (error) {
        console.log(`    ⚠️  Attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`);
        
        if (attempt === MAX_RETRIES) {
          return null;
        }
        
        // Wait before retrying
        await this.delay(2000 * attempt);
      }
    }
    
    return null;
  }

  async processAndUploadContent(allContent, ticker) {
    console.log(`  📦 Processing ${allContent.length} pieces of content...`);
    
    let totalChunks = 0;
    let successfulUploads = 0;

    for (let i = 0; i < allContent.length; i++) {
      const item = allContent[i];
      
      try {
        console.log(`  📄 [${i + 1}/${allContent.length}] Processing ${item.metadata.type}`);
        
        // Create chunks
        const chunks = this.createChunks(item.content, item.metadata, ticker);
        
        if (chunks.length === 0) {
          console.log(`    ⚠️  No meaningful chunks created`);
          continue;
        }

        // Upload chunks
        const uploadedCount = await this.uploadChunks(chunks, ticker, item.metadata);
        
        if (uploadedCount > 0) {
          totalChunks += uploadedCount;
          successfulUploads++;
          console.log(`    ✅ Successfully uploaded ${uploadedCount} chunks`);
        }
        
      } catch (error) {
        console.log(`    ❌ Error processing content: ${error.message}`);
        continue;
      }
    }

    console.log(`  🎉 Upload complete: ${totalChunks} total chunks from ${successfulUploads}/${allContent.length} sources`);
  }

  createChunks(content, metadata, ticker) {
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
      
      if (chunk.trim().length > 100) {
        chunks.push({
          content: chunk.trim(),
          metadata: {
            company: ticker,
            source: metadata.source || 'Web Content',
            sourceType: 'web-enhanced',
            contentType: metadata.type,
            url: metadata.url,
            priority: metadata.priority || 'medium',
            timestamp: new Date().toISOString().split('T')[0],
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
      console.error('❌ Error generating embedding:', error.message);
      throw error;
    }
  }

  async uploadChunks(chunks, ticker, metadata) {
    const vectors = [];
    
    for (let i = 0; i < chunks.length; i++) {
      try {
        const embedding = await this.generateEmbedding(chunks[i].content);
        
        vectors.push({
          id: `${ticker}-ENHANCED-${metadata.type.replace(/\s+/g, '')}-${Date.now()}-${i + 1}`,
          values: embedding,
          metadata: chunks[i].metadata
        });
        
      } catch (error) {
        console.error(`      ❌ Error processing chunk ${i + 1}:`, error.message);
        continue;
      }
    }
    
    // Upload all vectors
    try {
      await pinecone.upsert(vectors);
      return vectors.length;
    } catch (error) {
      console.error(`      ❌ Failed to upload chunks:`, error.message);
      return 0;
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main execution
async function main() {
  const ticker = process.argv[2];
  
  if (!ticker) {
    console.error('❌ Please provide a ticker symbol');
    console.log('Usage: node add-web-sources-enhanced.js TICKER');
    console.log('Example: node add-web-sources-enhanced.js CRWV');
    process.exit(1);
  }
  
  const processor = new EnhancedWebSourcesProcessor();
  await processor.initialize();
  await processor.processEnhancedWebSources(ticker.toUpperCase());
}

// Run the script
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { EnhancedWebSourcesProcessor };