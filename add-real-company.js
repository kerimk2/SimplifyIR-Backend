const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const axios = require('axios');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Initialize services
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
});

// Generate embeddings
async function generateEmbedding(text) {
    try {
        const response = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: text
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error('Error generating embedding:', error);
        throw error;
    }
}

// Split text into chunks
function splitIntoChunks(text, chunkSize = 800) {
    const words = text.split(' ');
    const chunks = [];
    
    for (let i = 0; i < words.length; i += chunkSize) {
        const chunk = words.slice(i, i + chunkSize).join(' ');
        if (chunk.trim().length > 0) {
            chunks.push(chunk);
        }
    }
    
    return chunks;
}

// Fetch SEC company data
async function fetchSECCompanyFacts(ticker) {
    try {
        console.log(`🔍 Fetching SEC data for ${ticker}...`);
        
        // First, get company CIK (Central Index Key) from SEC company tickers file
        const tickerResponse = await axios.get('https://www.sec.gov/files/company_tickers.json', {
            headers: {
                'User-Agent': 'SimplifyIR Demo contact@simplifyir.com'
            }
        });
        
        const companies = Object.values(tickerResponse.data);
        const company = companies.find(c => c.ticker === ticker);
        
        if (!company) {
            console.log(`❌ Company ${ticker} not found in SEC database`);
            return null;
        }
        
        const cik = company.cik_str.toString().padStart(10, '0');
        console.log(`📋 Found CIK: ${cik} for ${ticker} - ${company.title}`);
        
        // Get company facts (financial data)
        const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
        const factsResponse = await axios.get(factsUrl, {
            headers: {
                'User-Agent': 'SimplifyIR Demo contact@simplifyir.com'
            }
        });
        
        return {
            ticker: ticker,
            name: company.title,
            cik: cik,
            facts: factsResponse.data
        };
        
    } catch (error) {
        console.error(`❌ Error fetching SEC data for ${ticker}:`, error.message);
        return null;
    }
}

// Process SEC facts into readable format
function processSECFacts(companyData) {
    try {
        const facts = companyData.facts;
        let content = `${companyData.name} (${companyData.ticker}) - SEC Filing Data\n\n`;
        
        console.log(`📊 Processing financial data for ${companyData.name}...`);
        
        // Key financial metrics to extract
        const keyMetrics = [
            { key: 'Revenues', label: 'Revenue' },
            { key: 'RevenueFromContractWithCustomerExcludingAssessedTax', label: 'Revenue' },
            { key: 'NetIncomeLoss', label: 'Net Income' },
            { key: 'Assets', label: 'Total Assets' },
            { key: 'AssetsCurrent', label: 'Current Assets' },
            { key: 'Liabilities', label: 'Total Liabilities' },
            { key: 'StockholdersEquity', label: 'Stockholders Equity' },
            { key: 'CashAndCashEquivalentsAtCarryingValue', label: 'Cash and Cash Equivalents' },
            { key: 'OperatingIncomeLoss', label: 'Operating Income' },
            { key: 'GrossProfit', label: 'Gross Profit' }
        ];
        
        if (facts['us-gaap']) {
            for (const metric of keyMetrics) {
                if (facts['us-gaap'][metric.key]) {
                    const data = facts['us-gaap'][metric.key];
                    content += `\n${metric.label}:\n`;
                    
                    // Get recent data (prioritize annual reports)
                    const units = data.units.USD || data.units;
                    if (units) {
                        const recentData = units
                            .filter(item => item.form === '10-K' || item.form === '10-Q')
                            .filter(item => item.val !== null && item.val !== undefined)
                            .sort((a, b) => new Date(b.end) - new Date(a.end))
                            .slice(0, 8); // Get last 8 filings
                        
                        recentData.forEach(item => {
                            const value = item.val;
                            const formattedValue = value >= 1000000000 ? 
                                `$${(value / 1000000000).toFixed(1)}B` :
                                value >= 1000000 ? 
                                `$${(value / 1000000).toFixed(1)}M` :
                                `$${value.toLocaleString()}`;
                            
                            content += `  ${item.end} (${item.form}): ${formattedValue}\n`;
                        });
                    }
                }
            }
        }
        
        // Add company description from entityInformation
        if (facts.entityInformation) {
            content += `\nCompany Information:\n`;
            content += `Entity Name: ${facts.entityInformation.entityName}\n`;
            if (facts.entityInformation.entityDescription) {
                content += `Business Description: ${facts.entityInformation.entityDescription}\n`;
            }
        }
        
        console.log(`✅ Generated ${content.length} characters of content for ${companyData.name}`);
        return content;
        
    } catch (error) {
        console.error('Error processing SEC facts:', error);
        return `${companyData.name} (${companyData.ticker}) - Error processing financial data`;
    }
}

// Add processed document to database
async function addDocumentToDatabase(content, company, docType, source) {
    try {
        console.log(`📄 Adding ${source} to database for ${company}...`);
        
        const index = pinecone.index('simplifyir');
        
        // Split content into chunks
        const chunks = splitIntoChunks(content);
        console.log(`📝 Created ${chunks.length} chunks`);
        
        // Process chunks in batches to avoid rate limits
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            
            // Generate embedding
            const embedding = await generateEmbedding(chunk);
            
            // Create unique ID
            const id = `${company}-${docType}-${Date.now()}-${i}`;
            
            // Store in Pinecone
            await index.upsert([{
                id: id,
                values: embedding,
                metadata: {
                    company: company,
                    content: chunk,
                    document_type: docType,
                    source: source,
                    created_at: new Date().toISOString()
                }
            }]);
            
            console.log(`✅ Processed chunk ${i + 1}/${chunks.length}`);
            
            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        console.log(`🎉 Successfully added ${source} for ${company}`);
        return true;
        
    } catch (error) {
        console.error(`❌ Error adding document for ${company}:`, error);
        return false;
    }
}

// Main function to add a real company
async function addRealCompany(ticker) {
    try {
        console.log(`🚀 Adding real company data for ${ticker}...`);
        
        // Fetch SEC data
        const companyData = await fetchSECCompanyFacts(ticker);
        if (!companyData) {
            console.log(`❌ Could not fetch data for ${ticker}`);
            return false;
        }
        
        // Process the data
        const processedContent = processSECFacts(companyData);
        
        // Add to database
        const success = await addDocumentToDatabase(
            processedContent,
            ticker,
            'SEC-Facts',
            `SEC Company Facts - ${companyData.name}`
        );
        
        if (success) {
            console.log(`🎉 Successfully added ${ticker} to AI system!`);
            console.log(`\n🧪 Test with questions like:`);
            console.log(`• "What was ${ticker}'s latest revenue?"`);
            console.log(`• "What are ${ticker}'s total assets?"`);
            console.log(`• "What is ${ticker}'s cash position?"`);
            return true;
        } else {
            console.log(`❌ Failed to add ${ticker} to AI system`);
            return false;
        }
        
    } catch (error) {
        console.error(`❌ Error adding ${ticker}:`, error);
        return false;
    }
}

// Command line interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log(`
🏢 Real Company Data Processor

Usage:
  node add-real-company.js TICKER

Examples:
  node add-real-company.js AAPL
  node add-real-company.js MSFT
  node add-real-company.js GOOGL
  node add-real-company.js TSLA

Popular tickers to try:
  AAPL - Apple Inc.
  MSFT - Microsoft Corporation  
  GOOGL - Alphabet Inc.
  AMZN - Amazon.com Inc.
  TSLA - Tesla Inc.
  NVDA - NVIDIA Corporation
  META - Meta Platforms Inc.
        `);
        return;
    }
    
    const ticker = args[0].toUpperCase();
    console.log(`\n🎯 Starting to add ${ticker} to your AI system...\n`);
    
    await addRealCompany(ticker);
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = { addRealCompany };
